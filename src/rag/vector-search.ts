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
  /** Which retrieval legs surfaced this chunk. Always populated; cheap and useful. */
  legs: SearchLeg[];
  /** Per-leg diagnostics. Populated only when `explain` is requested. */
  explain?: SearchExplain;
}

export type SearchLeg = "vector" | "keyword";

export interface SearchExplain {
  /** Cosine similarity in [-1, 1]; absent when the chunk is keyword-only. */
  vectorScore?: number;
  /** BM25 relevance mapped to 0..1; absent when the chunk is vector-only. */
  keywordScore?: number;
  /** Reciprocal-rank-fusion contribution used to order the fused list. */
  rrfScore: number;
  /** Zero-based rank within each leg that contributed, for tie diagnosis. */
  vectorRank?: number;
  keywordRank?: number;
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

/**
 * Warn once per cache build when the in-memory vector cache is large enough to
 * threaten the host process.
 *
 * The cache is deliberately uncapped and complete: truncating it would silently
 * change which documents are searchable, which is far worse than being slow. So
 * the honest options are to say so, or to OOM. At 1024 dims the cache costs 8 KB
 * per row, so 100k chunks is ~800 MB — the failure mode arrives suddenly, with
 * no diagnostic until the process is already dying.
 */
const VECTOR_CACHE_WARN_MB_DEFAULT = 256;
let cacheWarned = false;

/** Read at call time so the threshold can be tuned without a rebuild. */
function vectorCacheWarnMb(): number {
  const raw = Number(process.env.RAG_VECTOR_CACHE_WARN_MB);
  return Number.isFinite(raw) && raw > 0 ? raw : VECTOR_CACHE_WARN_MB_DEFAULT;
}

function warnIfLargeCache(table: string, rows: number, dim: number): void {
  if (cacheWarned || dim <= 0) return;
  const limitMb = vectorCacheWarnMb();
  const mb = (rows * dim * 8) / (1024 * 1024);
  if (mb < limitMb) return;
  cacheWarned = true;
  process.stderr.write(
    `rag: vector cache for ${table} holds ${rows} rows (${dim}-dim) ≈ ${mb.toFixed(0)} MB in RAM ` +
      `(threshold ${limitMb} MB). Search stays correct, but memory grows with the store; consider ` +
      `pruning old documents, or set RAG_VECTOR_CACHE_WARN_MB to tune this warning.\n`
  );
}

function loadVectors(table: "chunks" | "memories"): Array<{ id: string; vec: Float64Array }> {
  const db = getDB();
  dropStaleCache();
  if (table === "memories") {
    if (cacheMemories) return cacheMemories;
    const out: Array<{ id: string; vec: Float64Array }> = [];
    // iterate(), not all(): .all() materialised every embedding blob as a
    // Uint8Array first, so peak memory held the packed store AND the unpacked
    // Float64Array copies at once. Streaming keeps one blob alive at a time.
    // Nothing inside the loop touches the DB, so the open statement is safe.
    for (const r of db
      .prepare("SELECT id, embedding FROM memories")
      .iterate() as IterableIterator<{ id: string; embedding: Uint8Array | null }>) {
      const vec = unpackVector(r.embedding);
      if (vec) out.push({ id: r.id, vec });
    }
    cacheMemories = out;
    warnIfLargeCache("memories", out.length, out[0]?.vec.length ?? 0);
    cacheDataVersion = dataVersion();
    return out;
  }
  // chunks keep their implicit rowid too, for FTS bookkeeping.
  if (cacheChunks) return cacheChunks;
  const out: Array<{ id: string; id2: string; docId: string; vec: Float64Array }> = [];
  for (const r of db
    .prepare("SELECT id, doc_id, rowid AS rid, embedding FROM chunks")
    .iterate() as IterableIterator<{
    id: string;
    doc_id: string;
    rid: number;
    embedding: Uint8Array | null;
  }>) {
    const vec = unpackVector(r.embedding);
    if (vec) out.push({ id: r.id, id2: String(r.rid), docId: r.doc_id, vec });
  }
  cacheChunks = out;
  warnIfLargeCache("chunks", out.length, out[0]?.vec.length ?? 0);
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
 *
 * The raw BM25 value is carried through. bm25() returns a negative number that
 * becomes more negative as relevance rises, so it is negated into a positive
 * relevance figure for reporting; without it the keyword leg had no observable
 * strength at all, making it impossible to tell a bad ranking from a weak match.
 */
function ftsHits(
  queryText: string,
  limit: number,
  filters?: SearchChunkFilters
): Array<{ key: string; bm25: number }> {
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
        `SELECT c.id, bm25(chunks_fts) AS bm25
           FROM chunks_fts
           JOIN chunks c ON c.rowid = chunks_fts.rowid
           JOIN documents d ON d.id = c.doc_id
          WHERE chunks_fts MATCH ?${filterClause}
          ORDER BY bm25(chunks_fts)
          LIMIT ?`
      )
      .all(quoteFtsQuery(tokens), ...params, limit) as Array<{ id: string; bm25: number }>;
    return rows.map((r) => ({ key: r.id, bm25: Number(r.bm25) }));
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
  /** Attach per-leg scores to every hit. Costs nothing extra, but only populated on request. */
  explain?: boolean;
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
  const { queryText = "", topK, minScore, filters, explain = false } = opts;
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
  let kwHits: Array<{ key: string; bm25: number }> = [];
  if (mode !== "vector") {
    kwHits = allowedDocIds && allowedDocIds.size === 0 ? [] : ftsHits(queryText, cap, filters);
  }

  // Rank-decayed keyword relevance in 0..1, so keyword-only hits still carry a
  // comparable score instead of the old flat 1.0 / RRF value.
  const kwScore = new Map<string, number>();
  kwHits.forEach((h, rank) => kwScore.set(h.key, 1 - rank / (kwHits.length + 1)));
  const vectorScore = new Map<string, number>();
  for (const h of vectorHits) vectorScore.set(h.key, h.score);

  // Per-leg ranks and true BM25 strength, kept for `explain` and for `legs`.
  const vectorRank = new Map<string, number>();
  vectorHits.forEach((h, rank) => vectorRank.set(h.key, rank));
  const keywordRank = new Map<string, number>();
  kwHits.forEach((h, rank) => keywordRank.set(h.key, rank));
  const bm25Raw = new Map<string, number>();
  for (const h of kwHits) bm25Raw.set(h.key, -h.bm25);

  // Strongest BM25 in this result set defines the top of the 0..1 keyword scale,
  // so keyword relevance is comparable between queries instead of being an
  // absolute number that drifts with corpus size and term frequency.
  const bm25Max = bm25Raw.size === 0 ? 0 : Math.max(...bm25Raw.values());
  const bm25Norm = new Map<string, number>();
  for (const [key, v] of bm25Raw) bm25Norm.set(key, bm25Max > 0 ? v / bm25Max : 0);

  let ordered: string[];
  let rrf: Map<string, number> = new Map();
  if (mode === "vector") {
    ordered = vectorHits.slice(0, topK).map((h) => h.key);
  } else if (mode === "keyword") {
    ordered = kwHits.slice(0, topK).map((h) => h.key);
  } else {
    rrf = rrfMerge([vectorHits, kwHits]);
    ordered = [...rrf.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key).slice(0, topK);
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

  return finalIds.flatMap((f): SearchHit[] => {
    const row = byId.get(f.key);
    if (!row) return [];
    const vRank = vectorRank.get(f.key);
    const kRank = keywordRank.get(f.key);
    const legs: SearchLeg[] = [];
    if (vRank !== undefined) legs.push("vector");
    if (kRank !== undefined) legs.push("keyword");
    const hit: SearchHit = {
      id: row.id,
      docId: row.doc_id,
      docTitle: row.doc_title,
      chunkIndex: row.idx,
      content: row.content,
      score: f.score,
      tokenCount: row.token_count,
      legs,
    };
    if (explain) {
      hit.explain = {
        rrfScore: Number((rrf.get(f.key) ?? 0).toFixed(6)),
        // The raw per-leg values, never `f.score`: that is max(cosine, keyword),
        // so reporting it as the vector score would overstate the vector leg
        // precisely when the keyword leg carried the hit.
        ...(vRank !== undefined ? { vectorScore: vectorScore.get(f.key) as number, vectorRank: vRank } : {}),
        ...(kRank !== undefined ? { keywordScore: bm25Norm.get(f.key) ?? 0, keywordRank: kRank } : {}),
      };
    }
    return [hit];
  });
}