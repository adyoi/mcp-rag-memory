import { getDB, packVector, unpackVector, STORAGE_DIR } from "../db/database.js";
import { cosineSimilarity } from "./embedder.js";

export interface ChunkRow {
  id: string;
  doc_id: string;
  idx: number;
  content: string;
  embedding: Uint8Array | null;
  token_count: number;
}

export interface SearchHit {
  id: string;
  docId: string;
  docTitle: string;
  chunkIndex: number;
  content: string;
  score: number;
}

export interface SearchOptions {
  topK?: number;
  minScore?: number;
  collection?: "chunks" | "memories";
}

/** Brute-force cosine search over stored vectors. Optimal up to ~10k rows locally. */
export function vectorSearch(
  queryVec: Float64Array,
  options: SearchOptions = {}
): Array<{ key: string; score: number }> {
  const topK = options.topK ?? 10;
  const minScore = options.minScore ?? 0.08;
  const db = getDB();
  const table = options.collection === "memories" ? "memories" : "chunks";

  const rows = (db.prepare(`SELECT id, embedding FROM ${table}`).all() as Array<{
    id: string;
    embedding: Uint8Array | null;
  }>) ?? [];

  const scored: Array<{ key: string; score: number }> = [];
  for (const row of rows) {
    const vec = unpackVector(row.embedding);
    if (!vec) continue;
    const score = cosineSimilarity(queryVec, vec);
    if (score >= minScore) scored.push({ key: row.id, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

export function searchChunks(queryVec: Float64Array, topK: number, minScore: number): SearchHit[] {
  const hits = vectorSearch(queryVec, { topK, minScore, collection: "chunks" });
  const db = getDB();
  const byDoc = new Map<string, string>();
  const docRows = db.prepare("SELECT id, title FROM documents").all() as Array<{ id: string; title: string }>;
  for (const d of docRows) byDoc.set(d.id, d.title);

  return hits.map((h) => {
    const row = db
      .prepare("SELECT id, doc_id, idx, content, token_count FROM chunks WHERE id = ?")
      .get(h.key) as unknown as ChunkRow;
    return {
      id: row.id,
      docId: row.doc_id,
      docTitle: byDoc.get(row.doc_id) ?? row.doc_id,
      chunkIndex: row.idx,
      content: row.content,
      score: h.score,
    };
  });
}

export { STORAGE_DIR };
export function vectorStats(): { dim: number; dbDir: string } {
  return { dim: 1024, dbDir: STORAGE_DIR };
}

export function packEmbedding(vec: Float64Array): Uint8Array {
  return packVector(vec);
}