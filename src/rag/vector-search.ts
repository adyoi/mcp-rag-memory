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
  onlyKeys?: Set<string>;
  /** Restrict to chunks of these documents (cheap: doc ids, not chunk ids). */
  onlyDocIds?: Set<string>;
}

type SearchMode = "hybrid" | "vector" | "keyword";

/** Read at call time (not frozen at import) so the mode can change per process/test. */
function searchMode(): SearchMode {
  const raw = process.env.SEARCH_MODE;
  return raw === "vector" || raw === "keyword" ? raw : "hybrid";
}

const RRF_K = 60;
const LIST_CAP = 60;

/* In-memory vector cache — invalidated on local writes and whenever another
 * process commits to the shared store (CLI, auto-save plugin, second server). */
let cacheChunks: Array<{ id: string; id2: string; docId: string; vec: Float64Array }> | null = null;
let cacheMemories: Array<{ id: string; vec: Float64Array }> | null = null;
let cacheDataVersion: number | null = null;

export function invalidateVectorCache(): void {
  cacheChunks = null;
  cacheMemories = null;
  // Re-arm the watch: the version we recorded describes the store *before* the
  // local write, so the next load must not treat our own commit as a foreign one.
  cacheDataVersion = null;
}

/** PRAGMA data_version changes when another connection commits; ours never does. */
function dataVersion(): number {
  const row = getDB().prepare("PRAGMA data_version").get() as { data_version: number } | undefined;
  return row ? Number(row.data_version) : 0;
}

function dropStaleCache(): void {
  if (cacheDataVersion === null) return;
  const current = dataVersion();
  if (current !== cacheDataVersion) invalidateVectorCache();
}

function loadVectors(table: "chunks" | "memories"): Array<{ id: string; vec: Float64Array }> {
  const db = getDB();
  dropStaleCache();
  if (table === "memories") {
    if (cacheMemories) return cacheMemories;
    const rows = db.prepare("SELECT id, embedding FROM memories").all() as Array<{ id: string; embedding: Uint8Array | null }>;
    const out: Array<{ id: string; vec: Float64Array }> = [];
    for (const r of rows) {
      const vec = unpackVector(r.embedding);
      if (vec) out.push({ id: r.id, vec });
    }
    cacheMemories = out;
    cacheDataVersion = dataVersion();
    return out;
  }
  // chunks keep their implicit rowid too, for FTS bookkeeping.
  if (cacheChunks) return cacheChunks;
  const rows = db
    .prepare("SELECT id, doc_id, rowid AS rid, embedding FROM chunks")
    .all() as Array<{ id: string; doc_id: string; rid: number; embedding: Uint8Array | null }>;
  const out: Array<{ id: string; id2: string; docId: string; vec: Float64Array }> = [];
  for (const r of rows) {
    const vec = unpackVector(r.embedding);
    if (vec) out.push({ id: r.id, id2: String(r.rid), docId: r.doc_id, vec });
  }
  cacheChunks = out;
  cacheDataVersion = dataVersion();
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
  const only = options.onlyKeys;
  const onlyDocs = options.onlyDocIds;
  const scored: Array<{ key: string; score: number }> = [];
  for (const r of rows) {
    if (only && !only.has(r.id)) continue;
    if (onlyDocs) {
      const docId = (r as { docId?: string }).docId;
      if (!docId || !onlyDocs.has(docId)) continue;
    }
    // Clamp to [-1, 1]: these vectors are L2-normalized, but a hand-written or
    // future provider's blob must not leak scores > 1 past min_score clamps.
    const score = Math.max(-1, Math.min(1, dotProduct(queryVec, r.vec)));
    if (score >= minScore) scored.push({ key: r.id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/**
 * BM25 keyword hits via FTS5, best-first. Returns empty when the query has no terms.
 * Filters are pushed into SQL (no id materialization) and every token is quoted as
 * an FTS5 string, so punctuation like "opencode-db" cannot void the keyword leg.
 */
function ftsHits(
  queryText: string,
  limit: number,
  filters?: SearchChunkFilters
): Array<{ key: string }> {
  const tokens = queryText
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 10);
  if (tokens.length === 0) return [];
  const db = getDB();
  const clauses: string[] = [];
  const params: Array<string> = [];
  if (filters?.docId) {
    clauses.push("c.doc_id = ?");
    params.push(filters.docId);
  }
  if (filters?.source) {
    clauses.push("d.source = ?");
    params.push(filters.source);
  }
  const filterClause = clauses.length ? ` AND ${clauses.join(" AND ")}` : "";
  try {
    const rows = db
      .prepare(
        `SELECT c.id
           FROM chunks_fts
           JOIN chunks c ON c.rowid = chunks_fts.rowid
           JOIN documents d ON d.id = c.doc_id
          WHERE chunks_fts MATCH ?${filterClause}
          ORDER BY bm25(chunks_fts)
          LIMIT ?`
      )
      .all(quoteFtsQuery(tokens), ...params, limit) as Array<{ id: string }>;
    return rows.map((r) => ({ key: r.id }));
  } catch (e) {
    // FTS5 unavailable or an unsupported query — degrade to the vector leg
    // instead of failing the whole search, but say so on stderr.
    process.stderr.write(`rag: FTS5 keyword leg unavailable (${(e as Error).message})\n`);
    return [];
  }
}

/** Quote each token as an FTS5 string literal so "-" and other syntax stay literal. */
function quoteFtsQuery(tokens: string[]): string {
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
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
export interface SearchChunkFilters {
  docId?: string;
  source?: string;
}

export interface SearchChunkOptions {
  queryText?: string;
  topK: number;
  minScore: number;
  filters?: SearchChunkFilters;
}

/**
 * Hybrid search: FTS5 BM25 keyword + vector, fused with RRF for ranking.
 * Controlled by SEARCH_MODE=hybrid|vector|keyword (default hybrid).
 *
 * The reported `score` is always on a 0..1 relevance scale — the vector cosine
 * when the chunk has one, otherwise a rank-decayed keyword score — so `minScore`
 * means the same thing in every mode (RRF only decides the order).
 */
export function searchChunks(queryVec: Float64Array, opts: SearchChunkOptions): SearchHit[] {
  const { queryText = "", topK, minScore, filters } = opts;
  const db = getDB();
  const mode = searchMode();

  // Resolve the doc filter BEFORE ranking so unfiltered chunks can never
  // out-rank a filtered one and squeeze it out of the top-K. Document ids, not
  // chunk ids: one row per document instead of one per chunk.
  let allowedDocIds: Set<string> | undefined;
  if (filters && (filters.docId || filters.source)) {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filters.docId) {
      clauses.push("id = ?");
      params.push(filters.docId);
    }
    if (filters.source) {
      clauses.push("source = ?");
      params.push(filters.source);
    }
    const allowed = db
      .prepare(`SELECT id FROM documents WHERE ${clauses.join(" AND ")}`)
      .all(...params) as Array<{ id: string }>;
    allowedDocIds = new Set(allowed.map((r) => r.id));
  }

  const cap = Math.max(topK * 2, LIST_CAP);

  let vectorHits: Array<{ key: string; score: number }> = [];
  if (mode !== "keyword") {
    vectorHits = vectorSearch(queryVec, { topK: cap, minScore, collection: "chunks", onlyDocIds: allowedDocIds });
  }
  let kwHits: Array<{ key: string }> = [];
  if (mode !== "vector") {
    kwHits = allowedDocIds && allowedDocIds.size === 0 ? [] : ftsHits(queryText, cap, filters);
  }

  // Rank-decayed keyword relevance in 0..1, so keyword-only hits still carry a
  // comparable score instead of the old flat 1.0 / RRF value.
  const kwScore = new Map<string, number>();
  kwHits.forEach((h, rank) => kwScore.set(h.key, 1 - rank / (kwHits.length + 1)));
  const vectorScore = new Map<string, number>();
  for (const h of vectorHits) vectorScore.set(h.key, h.score);

  let ordered: string[];
  if (mode === "vector") {
    ordered = vectorHits.slice(0, topK).map((h) => h.key);
  } else if (mode === "keyword") {
    ordered = kwHits.slice(0, topK).map((h) => h.key);
  } else {
    ordered = [...rrfMerge([vectorHits, kwHits]).entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key]) => key)
      .slice(0, topK);
  }

  // Threshold on the final score, in every mode — not just on the vector leg.
  const finalIds = ordered
    .map((key) => ({ key, score: Math.max(vectorScore.get(key) ?? 0, kwScore.get(key) ?? 0) }))
    .filter((f) => f.score >= minScore);

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