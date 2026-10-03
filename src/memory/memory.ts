import { getDB, newId, nowMs, packVector, unpackVector } from "../db/database.js";
import { dotProduct } from "../rag/embedder.js";
import { estimateTokensFromChars } from "../rag/chunker.js";
import { embedText } from "../rag/embeddings.js";
import { vectorSearch, invalidateVectorCache } from "../rag/vector-search.js";

export const MEMORY_TYPES = [
  "fact",
  "preference",
  "decision",
  "instruction",
  "task",
  "insight",
  "conversation",
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

/** Half-life in days for the recall decay curve (invalid values fall back to 14). */
const DECAY_HALF_LIFE_DAYS = numEnv("RAG_MEMORY_HALF_LIFE_DAYS", 14, (n) => n > 0);

function numEnv(name: string, fallback: number, valid: (n: number) => boolean): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && valid(n) ? n : fallback;
}

export interface MemoryInput {
  content: string;
  type?: MemoryType;
  importance?: number;
  tags?: string[];
}

export interface MemoryRecord {
  id: string;
  type: MemoryType;
  content: string;
  importance: number;
  tags: string[];
  recallCount: number;
  lastRecalled: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryRecallHit extends MemoryRecord {
  score: number;
  /** Exponential decay factor applied to the raw similarity (0..1, based on staleness). */
  decay: number;
}

export async function remember(input: MemoryInput): Promise<MemoryRecord> {
  const id = newId();
  const ts = nowMs();
  const type = input.type ?? "fact";
  const importance = clampImportance(input.importance ?? 0.5);
  const tags = JSON.stringify(input.tags ?? []);

  const vec = await embedText(input.content);
  // Re-acquire after the await: nothing below should use a handle captured
  // before a yield point, where closeDB() could have invalidated it.
  const db = getDB();
  db.prepare(
    `INSERT INTO memories (id, type, content, importance, embedding, tags, recall_count, last_recalled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`
  ).run(id, type, input.content, importance, packVector(vec), tags, ts, ts);
  invalidateVectorCache();

  const rec = getMemory(id);
  if (!rec) throw new Error("Memory insert failed: row disappeared immediately after write");
  return rec;
}

interface MemoryRow {
  id: string;
  type: string;
  content: string;
  importance: number;
  tags: string;
  recall_count: number;
  last_recalled: number | null;
  created_at: number;
  updated_at: number;
}

const MEMORY_TYPE_SET: ReadonlySet<string> = new Set<string>(MEMORY_TYPES);

/** One query for the whole page — getMemory() per row used to be an N+1. */
function toRecords(rows: MemoryRow[]): MemoryRecord[] {
  return rows.map((row) => ({
    id: row.id,
    type: MEMORY_TYPE_SET.has(row.type) ? (row.type as MemoryType) : "fact",
    content: row.content,
    importance: typeof row.importance === "number" && Number.isFinite(row.importance) ? row.importance : 0.5,
    tags: parseTags(row.tags),
    recallCount: row.recall_count,
    lastRecalled: row.last_recalled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

const MEMORY_COLUMNS =
  "id, type, content, importance, tags, recall_count, last_recalled, created_at, updated_at";

/** Never let a malformed row break every read path. */
function parseTags(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((t) => String(t)) : [];
  } catch {
    return [];
  }
}

export async function recall(query: string, topK = 8, minScore = 0.1): Promise<MemoryRecallHit[]> {
  const db = getDB();
  const q = await embedText(query);
  const hits = vectorSearch(q, { topK: topK * 2, minScore, collection: "memories" });
  if (hits.length === 0) return [];

  const ts = nowMs();
  const rows = db
    .prepare(
      `SELECT ${MEMORY_COLUMNS} FROM memories WHERE id IN (${hits.map(() => "?").join(", ")})`
    )
    .all(...hits.map((h) => h.key)) as unknown as MemoryRow[];
  const byId = new Map(toRecords(rows).map((r) => [r.id, r]));

  const scored: MemoryRecallHit[] = [];
  for (const h of hits) {
    const rec = byId.get(h.key);
    if (!rec) continue;
    const ageMs = ts - (rec.lastRecalled ?? rec.createdAt);
    const decay = Math.pow(0.5, ageMs / (DECAY_HALF_LIFE_DAYS * 86_400_000));
    // min_score gates the raw cosine inside vectorSearch; decay shrinks the
    // score afterwards, so a stale-but-perfect match could come back at ~0.
    // Re-apply the floor to the score the caller actually receives.
    const score = h.score * decay;
    if (score < minScore) continue;
    scored.push({ ...rec, score, decay });
  }
  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, topK);

  // Bump only what is actually returned: a memory nobody saw is not "recalled",
  // and phantom bumps used to feed decay and the promotion threshold.
  const bump = db.prepare("UPDATE memories SET recall_count = recall_count + 1, last_recalled = ? WHERE id = ?");
  for (const r of results) bump.run(ts, r.id);
  return results.map((r) => ({ ...r, recallCount: r.recallCount + 1, lastRecalled: ts }));
}

export function listMemories(opts: { type?: MemoryType; tag?: string; minImportance?: number; limit?: number } = {}): MemoryRecord[] {
  const db = getDB();
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (opts.type) {
    clauses.push("type = ?");
    params.push(opts.type);
  }
  if (opts.tag) {
    // json_each() raises "malformed JSON" on a corrupted column, which would
    // break the whole listing. Feed it a guaranteed-valid array instead.
    clauses.push(
      "EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(memories.tags) THEN memories.tags ELSE '[]' END) AS _tg WHERE _tg.value = ?)"
    );
    params.push(opts.tag);
  }
  if (opts.minImportance !== undefined) {
    clauses.push("importance >= ?");
    params.push(opts.minImportance);
  }

  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const rawLimit = opts.limit;
  const limit = rawLimit === undefined || !Number.isFinite(rawLimit)
    ? 100
    : Math.min(Math.max(Math.trunc(rawLimit), 1), 500);
  // id as tiebreaker: updated_at is millisecond-resolution, so a bulk write
  // leaves large tie groups and LIMIT would pick an arbitrary subset.
  const rows = db
    .prepare(`SELECT ${MEMORY_COLUMNS} FROM memories${where} ORDER BY updated_at DESC, id DESC LIMIT ${limit}`)
    .all(...params) as unknown as MemoryRow[];
  return toRecords(rows);
}

export function getMemory(id: string): MemoryRecord | null {
  const db = getDB();
  const row = db
    .prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = ?`)
    .get(id) as unknown as MemoryRow | undefined;
  if (!row) return null;
  return toRecords([row])[0];
}

export async function updateMemory(
  id: string,
  patch: { content?: string; type?: MemoryType; importance?: number; tags?: string[] }
): Promise<MemoryRecord | null> {
  const existing = getMemory(id);
  if (!existing) return null;

  // Build the SET list from the patch only. Rewriting every column from a
  // pre-read snapshot made this a lost-update: two concurrent patches (CLI +
  // server, or two sessions) each wrote back the other's stale values.
  const sets: string[] = [];
  const params: Array<string | number | Uint8Array> = [];

  if (patch.content !== undefined) {
    sets.push("content = ?");
    params.push(patch.content);
  }
  if (patch.type !== undefined) {
    sets.push("type = ?");
    params.push(patch.type);
  }
  if (patch.importance !== undefined) {
    sets.push("importance = ?");
    params.push(clampImportance(patch.importance));
  }
  if (patch.tags !== undefined) {
    sets.push("tags = ?");
    params.push(JSON.stringify(patch.tags));
  }
  // An all-undefined patch must not touch the row (or re-embed) at all.
  if (sets.length === 0) return existing;

  // Only a real text edit needs the model; metadata-only patches stay cheap.
  if (patch.content !== undefined && patch.content !== existing.content) {
    const vec = await embedText(patch.content);
    sets.push("embedding = ?");
    params.push(packVector(vec));
    invalidateVectorCache();
  }

  sets.push("updated_at = ?");
  params.push(nowMs());
  // Re-acquire after the await above: the handle could have been closed.
  const db = getDB();
  const res = db
    .prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`)
    .run(...params, id);
  return Number(res.changes) > 0 ? getMemory(id) : null;
}

export function forget(id: string): { deleted: boolean } {
  const db = getDB();
  const res = db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  const deleted = Number(res.changes) > 0;
  // A mistyped id used to force a full vector re-read on the next search.
  if (deleted) invalidateVectorCache();
  return { deleted };
}

export interface ConsolidationReport {
  removedDuplicates: number;
  promoted: number;
  pruned: number;
  skippedDedup: boolean;
  totals: { memories: number; tokens: number };
}

/** Above this many vectors the O(n^2) dedup pass is skipped (event-loop budget). */
const DEDUP_MAX_VECTORS = 500;
const DEDUP_SIMILARITY = 0.92;
const DEDUP_TOKEN_OVERLAP = 0.8;

function tokenSet(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1)
  );
}

/** Jaccard overlap of word sets — the second gate before anything is deleted. */
function tokenOverlap(a: string, b: string): number {
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/**
 * - Removes near-duplicate memories (cosine >= 0.92 AND >= 80% word overlap)
 *   keeping the highest-importance one. The text gate matters: templated agent
 *   memories ("The user's X is Y") sit at ~0.95 cosine while being distinct, and
 *   deleting those is unrecoverable.
 * - Promotes importance of frequently-needed memories (recall_count >= 5) by +0.1.
 * - Optionally prunes stale, low-importance, never-recalled memories (RAG_PRUNE=1,
 *   RAG_PRUNE_IMPORTANCE=0.2, RAG_PRUNE_AGE_DAYS=90). Off by default — deletes are irreversible.
 */
export async function consolidate(): Promise<ConsolidationReport> {
  const db = getDB();
  // ORDER BY so the dedup anchor (and therefore the survivor) is deterministic:
  // scan order can change with the query plan and flip which memory survives.
  const rows = db
    .prepare(`SELECT ${MEMORY_COLUMNS}, embedding FROM memories ORDER BY importance DESC, created_at, id`)
    .all() as unknown as Array<MemoryRow & { embedding: Uint8Array | null }>;

  const vectors: Array<{ id: string; vec: Float64Array }> = [];
  for (const r of rows) {
    const vec = unpackVector(r.embedding);
    if (vec) vectors.push({ id: r.id, vec });
  }

  const records = new Map(toRecords(rows).map((r) => [r.id, r]));
  let removedDuplicates = 0;
  const skippedDedup = vectors.length > DEDUP_MAX_VECTORS;
  const toDelete = new Set<string>();
  if (!skippedDedup) {
    for (let i = 0; i < vectors.length; i++) {
      if (toDelete.has(vectors[i].id)) continue;
      for (let j = i + 1; j < vectors.length; j++) {
        if (toDelete.has(vectors[j].id)) continue;
        if (dotProduct(vectors[i].vec, vectors[j].vec) < DEDUP_SIMILARITY) continue;
        const a = records.get(vectors[i].id);
        const b = records.get(vectors[j].id);
        if (!a || !b || tokenOverlap(a.content, b.content) < DEDUP_TOKEN_OVERLAP) continue;
        if (a.importance >= b.importance) {
          toDelete.add(b.id);
        } else {
          toDelete.add(a.id);
          // Swap the WHOLE entry, not just the id: swapping ids alone leaves
          // vectors[i] holding the survivor's id with the *deleted* memory's
          // embedding, so a later comparison gates one memory's cosine on
          // another's vector and deletes distinct memories.
          const tmp = vectors[i];
          vectors[i] = vectors[j];
          vectors[j] = tmp;
        }
        removedDuplicates++;
      }
    }
  }

  const delStmt = db.prepare("DELETE FROM memories WHERE id = ?");

  // One transaction for the whole destructive pass. In autocommit each delete
  // committed on its own, so a SQLITE_BUSY or crash midway left duplicates
  // deleted but promotion (or the prune half) unapplied — unrecoverable and
  // unreported, because the throw propagated instead of the counts.
  db.exec("BEGIN IMMEDIATE;");
  try {
    for (const id of toDelete) delStmt.run(id);

    // One UPDATE for the whole store: the old per-row updateMemory() re-embedded
    // every candidate (a full model inference each) and only saw the newest 100.
    const promoted = Number(
      db
        .prepare(
          "UPDATE memories SET importance = min(1, importance + 0.1) WHERE recall_count >= 5 AND importance < 1"
        )
        .run().changes
    );

    let pruned = 0;
    const pruneEnabled = process.env.RAG_PRUNE === "1" || process.env.RAG_PRUNE === "true";
    if (pruneEnabled) {
      const minImp = numEnv("RAG_PRUNE_IMPORTANCE", 0.2, (n) => n >= 0 && n <= 1);
      const maxAgeDays = numEnv("RAG_PRUNE_AGE_DAYS", 90, (n) => n >= 0);
      const cutoff = nowMs() - maxAgeDays * 86_400_000;
      const stale = db
        // <= so RAG_PRUNE_AGE_DAYS=0 means "everything is stale"; a strict <
        // skipped rows created in the same millisecond as the cutoff, which made
        // the prune silently no-op on a fast machine.
        .prepare("SELECT id FROM memories WHERE importance < ? AND recall_count = 0 AND created_at <= ?")
        .all(minImp, cutoff) as Array<{ id: string }>;
      for (const s of stale) {
        delStmt.run(s.id);
        pruned++;
      }
    }

    db.exec("COMMIT;");
    // Deleted rows must leave the vector cache, or the next search still scores
    // them and can return a memory that no longer exists.
    if (removedDuplicates > 0 || pruned > 0) invalidateVectorCache();
    const stats = memoryStats();
    return {
      removedDuplicates,
      promoted,
      pruned,
      skippedDedup,
      totals: { memories: stats.memories, tokens: stats.tokens },
    };
  } catch (e) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      /* transaction already closed */
    }
    throw e;
  }
}

export function memoryStats(): { memories: number; tokens: number; avgImportance: number; byType: Record<string, number> } {
  const db = getDB();
  const count = db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number };
  const avg = db.prepare("SELECT COALESCE(AVG(importance),0) AS a FROM memories").get() as { a: number };
  const byTypeRows = db.prepare("SELECT type, COUNT(*) AS c FROM memories GROUP BY type").all() as Array<{ type: string; c: number }>;
  const byType: Record<string, number> = {};
  for (const r of byTypeRows) byType[r.type] = r.c;

  // LENGTH() in SQL: loading every content blob just to count tokens was a full
  // table pull on each system_stats / memory_stats call. Keep the char count in
  // SQL and estimate here — materialising "x".repeat(n) per row re-allocated the
  // very blobs this was meant to avoid.
  let chars = 0;
  for (const r of db.prepare("SELECT LENGTH(content) AS n FROM memories").all() as Array<{ n: number | null }>) {
    chars += Math.max(0, r.n ?? 0);
  }
  const totalTokens = estimateTokensFromChars(chars);

  return { memories: count.c, tokens: totalTokens, avgImportance: avg.a, byType };
}

export async function contextPrompt(query: string, topK = 6): Promise<{ context: string; sources: MemoryRecallHit[] }> {
  const hits = await recall(query, topK);
  if (hits.length === 0) return { context: "", sources: [] };
  const lines = hits.map((h) => `[${h.type}, importance ${h.importance.toFixed(2)}] ${h.content}`);
  return { context: lines.join("\n"), sources: hits };
}

function clampImportance(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return Math.min(1, Math.max(0, v));
}