import { getDB, unpackVector, getEmbedDim } from "../db/database.js";
import { dotProduct } from "./embedder.js";

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
  tokenCount: number;
}

export interface SearchOptions {
  topK?: number;
  minScore?: number;
  collection?: "chunks" | "memories";
}

type SearchMode = "hybrid" | "vector" | "keyword";
const SEARCH_MODE: SearchMode =
  process.env.SEARCH_MODE === "vector" || process.env.SEARCH_MODE === "keyword"
    ? (process.env.SEARCH_MODE as SearchMode)
    : "hybrid";

const RRF_K = 60;
const LIST_CAP = 60;

/* In-memory vector cache — invalidated on every write. */
let cacheChunks: Array<{ id: string; id2: string; vec: Float64Array }> | null = null;
let cacheMemories: Array<{ id: string; vec: Float64Array }> | null = null;

export function invalidateVectorCache(): void {
  cacheChunks = null;
  cacheMemories = null;
}

function loadVectors(table: "chunks" | "memories"): Array<{ id: string; vec: Float64Array }> {
  const db = getDB();
  if (table === "memories") {
    if (cacheMemories) return cacheMemories;
    const rows = db.prepare("SELECT id, embedding FROM memories").all() as Array<{ id: string; embedding: Uint8Array | null }>;
    const out: Array<{ id: string; vec: Float64Array }> = [];
    for (const r of rows) {
      const vec = unpackVector(r.embedding);
      if (vec) out.push({ id: r.id, vec });
    }
    cacheMemories = out;
    return out;
  }
  // chunks keep their implicit rowid too, for FTS bookkeeping.
  if (cacheChunks) return cacheChunks;
  const rows = db
    .prepare("SELECT id, rowid AS rid, embedding FROM chunks")
    .all() as Array<{ id: string; rid: number; embedding: Uint8Array | null }>;
  const out: Array<{ id: string; id2: string; vec: Float64Array }> = [];
  for (const r of rows) {
    const vec = unpackVector(r.embedding);
    if (vec) out.push({ id: r.id, id2: String(r.rid), vec });
  }
  cacheChunks = out;
  return out;
}

function dimGuard(queryVec: Float64Array): void {
  const stored = getEmbedDim();
  if (stored && stored !== queryVec.length) {
    throw new Error(
      `Query vector dimension ${queryVec.length} does not match stored embedding dimension ${stored}. ` +
        `Set EMBEDDING_PROVIDER consistent with the DB or wipe the store.`
    );
  }
}

/** Brute-force vector search over stored vectors (uses the in-memory cache). */
export function vectorSearch(
  queryVec: Float64Array,
  options: SearchOptions = {}
): Array<{ key: string; score: number }> {
  const topK = options.topK ?? 10;
  const minScore = options.minScore ?? 0.08;
  const table = options.collection === "memories" ? "memories" : "chunks";
  dimGuard(queryVec);

  const rows = loadVectors(table);
  const scored: Array<{ key: string; score: number }> = [];
  for (const r of rows) {
    const score = dotProduct(queryVec, r.vec);
    if (score >= minScore) scored.push({ key: r.id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/** BM25 keyword hits via FTS5, best-first. Returns empty when the query has no terms. */
function ftsHits(queryText: string, limit: number): Array<{ key: string }> {
  const tokens = queryText
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 10);
  if (tokens.length === 0) return [];
  const db = getDB();
  try {
    const rows = db
      .prepare(
        `SELECT c.id
           FROM chunks_fts
           JOIN chunks c ON c.rowid = chunks_fts.rowid
          WHERE chunks_fts MATCH ?
          ORDER BY bm25(chunks_fts)
          LIMIT ?`
      )
      .all(tokens.join(" "), limit) as Array<{ id: string }>;
    return rows.map((r) => ({ key: r.id }));
  } catch {
    // FTS5 unavailable or unsupported query syntax — degrade to vector-only.
    return [];
  }
}

/** Reciprocal-rank fusion over multiple ranked lists of {key}. */
function rrfMerge(lists: Array<Array<{ key: string }>>): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((item, rank) => {
      scores.set(item.key, (scores.get(item.key) ?? 0) + 1 / (RRF_K + rank + 1));
    });
  }
  return scores;
}

export interface SearchChunkOptions {
  queryText?: string;
  topK: number;
  minScore: number;
}

/**
 * Hybrid search: FTS5 BM25 keyword + vector, fused with RRF.
 * Controlled by SEARCH_MODE=hybrid|vector|keyword (default hybrid).
 */
export function searchChunks(queryVec: Float64Array, opts: SearchChunkOptions): SearchHit[] {
  const { queryText = "", topK, minScore } = opts;
  const db = getDB();
  const cap = Math.max(topK * 2, LIST_CAP);

  let vectorHits: Array<{ key: string; score: number }> = [];
  if (SEARCH_MODE !== "keyword") {
    vectorHits = vectorSearch(queryVec, { topK: cap, minScore, collection: "chunks" });
  }
  let kwHits: Array<{ key: string }> = [];
  if (SEARCH_MODE !== "vector") {
    kwHits = ftsHits(queryText, cap);
  }

  let finalIds: Array<{ key: string; score: number }>;
  if (SEARCH_MODE === "vector") {
    finalIds = vectorHits.slice(0, topK);
  } else if (SEARCH_MODE === "keyword") {
    finalIds = kwHits.slice(0, topK).map((h, i) => ({ key: h.key, score: 1 - i * 1e-6 }));
  } else {
    const fused = rrfMerge([vectorHits, kwHits]);
    finalIds = [...fused.entries()]
      .map(([key, score]) => ({ key, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  if (finalIds.length === 0) return [];
  const ids = finalIds.map((f) => f.key);
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT c.id, c.doc_id, c.idx, c.content, c.token_count, d.title AS doc_title
         FROM chunks c
         JOIN documents d ON d.id = c.doc_id
        WHERE c.id IN (${placeholders})`
    )
    .all(...ids) as unknown as Array<{
    id: string;
    doc_id: string;
    idx: number;
    content: string;
    token_count: number;
    doc_title: string;
  }>;
  const byId = new Map(rows.map((r) => [r.id, r]));

  return finalIds.flatMap((f) => {
    const row = byId.get(f.key);
    if (!row) return [];
    return [
      {
        id: row.id,
        docId: row.doc_id,
        docTitle: row.doc_title,
        chunkIndex: row.idx,
        content: row.content,
        score: f.score,
        tokenCount: row.token_count,
      },
    ];
  });
}