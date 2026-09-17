import { getDB, newId, nowMs, packVector, unpackVector } from "../db/database.js";
import { dotProduct } from "../rag/embedder.js";
import { estimateTokens } from "../rag/chunker.js";
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

/** Half-life in days for the recall decay curve. */
const DECAY_HALF_LIFE_DAYS = Number(process.env.RAG_MEMORY_HALF_LIFE_DAYS ?? 14);

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
  const db = getDB();
  const id = newId();
  const ts = nowMs();
  const type = input.type ?? "fact";
  const importance = clampImportance(input.importance ?? 0.5);
  const tags = JSON.stringify(input.tags ?? []);

  const vec = await embedText(input.content);
  db.prepare(
    `INSERT INTO memories (id, type, content, importance, embedding, tags, recall_count, last_recalled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`
  ).run(id, type, input.content, importance, packVector(vec), tags, ts, ts);
  invalidateVectorCache();

  return getMemory(id)!;
}

export async function recall(query: string, topK = 8, minScore = 0.1): Promise<MemoryRecallHit[]> {
  const db = getDB();
  const q = await embedText(query);
  const hits = vectorSearch(q, { topK: topK * 2, minScore, collection: "memories" });

  const ts = nowMs();
  const bump = db.prepare("UPDATE memories SET recall_count = recall_count + 1, last_recalled = ? WHERE id = ?");
  const results: MemoryRecallHit[] = [];
  for (const h of hits) {
    const rec = getMemory(h.key);
    if (!rec) continue;
    bump.run(ts, rec.id);
    const ageMs = ts - (rec.lastRecalled ?? rec.createdAt);
    const decay = Math.pow(0.5, ageMs / (DECAY_HALF_LIFE_DAYS * 86_400_000));
    results.push({
      ...rec,
      recallCount: rec.recallCount + 1,
      lastRecalled: ts,
      score: h.score * decay,
      decay,
    });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
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
    clauses.push("EXISTS (SELECT 1 FROM json_each(memories.tags) AS _tg WHERE _tg.value = ?)");
    params.push(opts.tag);
  }
  if (opts.minImportance !== undefined) {
    clauses.push("importance >= ?");
    params.push(opts.minImportance);
  }

  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(opts.limit ?? 100, 500);
  const rows = db
    .prepare(`SELECT id FROM memories${where} ORDER BY updated_at DESC LIMIT ${limit}`)
    .all(...params) as Array<{ id: string }>;

  return rows.map((r) => getMemory(r.id)).filter(Boolean) as MemoryRecord[];
}

export function getMemory(id: string): MemoryRecord | null {
  const db = getDB();
  const row = db
    .prepare("SELECT * FROM memories WHERE id = ?")
    .get(id) as unknown as
    | {
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
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    type: row.type as MemoryType,
    content: row.content,
    importance: row.importance,
    tags: JSON.parse(row.tags) as string[],
    recallCount: row.recall_count,
    lastRecalled: row.last_recalled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function updateMemory(
  id: string,
  patch: { content?: string; type?: MemoryType; importance?: number; tags?: string[] }
): Promise<MemoryRecord | null> {
  const db = getDB();
  const existing = getMemory(id);
  if (!existing) return null;

  const content = patch.content ?? existing.content;
  const type = patch.type ?? existing.type;
  const importance = patch.importance !== undefined ? clampImportance(patch.importance) : existing.importance;
  const tags = patch.tags ?? existing.tags;
  const vec = await embedText(content);
  const ts = nowMs();

  db.prepare(
    "UPDATE memories SET content = ?, type = ?, importance = ?, tags = ?, embedding = ?, updated_at = ? WHERE id = ?"
  ).run(content, type, importance, JSON.stringify(tags), packVector(vec), ts, id);
  invalidateVectorCache();

  return getMemory(id);
}

export function forget(id: string): { deleted: boolean } {
  const db = getDB();
  const res = db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  invalidateVectorCache();
  return { deleted: Number(res.changes) > 0 };
}

export interface ConsolidationReport {
  removedDuplicates: number;
  promoted: number;
  pruned: number;
  totals: { memories: number; tokens: number };
}

/**
 * - Removes near-duplicate memories (dot product > 0.92) keeping the highest-importance one.
 * - Promotes importance of frequently-needed memories (recall_count >= 5) by +0.1.
 * - Optionally prunes stale, low-importance, never-recalled memories (RAG_PRUNE=1,
 *   RAG_PRUNE_IMPORTANCE=0.2, RAG_PRUNE_AGE_DAYS=90). Off by default — deletes are irreversible.
 */
export async function consolidate(): Promise<ConsolidationReport> {
  const db = getDB();
  const rows = db.prepare("SELECT id, embedding FROM memories").all() as Array<{ id: string; embedding: Uint8Array | null }>;
  const records = rows
    .map((r) => ({ id: r.id, rec: getMemory(r.id) }))
    .filter((r) => r.rec !== null && r.rec !== undefined) as Array<{ id: string; rec: MemoryRecord }>;

  const vectors: Array<{ id: string; vec: Float64Array }> = [];
  for (const r of records) {
    const vec = unpackVector(rows.find((row) => row.id === r.id)?.embedding ?? null);
    if (vec) vectors.push({ id: r.id, vec });
  }

  let removedDuplicates = 0;
  const toDelete = new Set<string>();
  for (let i = 0; i < vectors.length; i++) {
    if (toDelete.has(vectors[i].id)) continue;
    for (let j = i + 1; j < vectors.length; j++) {
      if (toDelete.has(vectors[j].id)) continue;
      const sim = dotProduct(vectors[i].vec, vectors[j].vec);
      if (sim >= 0.92) {
        const a = records.find((r) => r.id === vectors[i].id)!.rec;
        const b = records.find((r) => r.id === vectors[j].id)!.rec;
        if (a.importance >= b.importance) {
          toDelete.add(vectors[j].id);
        } else {
          toDelete.add(vectors[i].id);
          const tmpId = vectors[i].id;
          vectors[i].id = vectors[j].id;
          vectors[j].id = tmpId;
        }
        removedDuplicates++;
      }
    }
  }

  const delStmt = db.prepare("DELETE FROM memories WHERE id = ?");
  for (const id of toDelete) delStmt.run(id);

  let promoted = 0;
  const bumpPromotion = async () => {
    for (const rec of listMemories()) {
      if (rec.recallCount >= 5 && rec.importance < 1) {
        await updateMemory(rec.id, { importance: Math.min(1, rec.importance + 0.1) });
        promoted++;
      }
    }
  };

  let pruned = 0;
  const pruneEnabled = process.env.RAG_PRUNE === "1" || process.env.RAG_PRUNE === "true";
  if (pruneEnabled) {
    const minImp = Number(process.env.RAG_PRUNE_IMPORTANCE ?? 0.2);
    const maxAgeDays = Number(process.env.RAG_PRUNE_AGE_DAYS ?? 90);
    const cutoff = nowMs() - maxAgeDays * 86_400_000;
    const stale = db
      .prepare("SELECT id FROM memories WHERE importance < ? AND recall_count = 0 AND created_at < ?")
      .all(minImp, cutoff) as Array<{ id: string }>;
    for (const s of stale) {
      delStmt.run(s.id);
      pruned++;
    }
  }

  await bumpPromotion();
  invalidateVectorCache();

  const stats = memoryStats();
  return {
    removedDuplicates,
    promoted,
    pruned,
    totals: { memories: stats.memories, tokens: stats.tokens },
  };
}

export function memoryStats(): { memories: number; tokens: number; avgImportance: number; byType: Record<string, number> } {
  const db = getDB();
  const count = db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number };
  const avg = db.prepare("SELECT COALESCE(AVG(importance),0) AS a FROM memories").get() as { a: number };
  const byTypeRows = db.prepare("SELECT type, COUNT(*) AS c FROM memories GROUP BY type").all() as Array<{ type: string; c: number }>;
  const byType: Record<string, number> = {};
  for (const r of byTypeRows) byType[r.type] = r.c;

  let totalTokens = 0;
  for (const r of db.prepare("SELECT content FROM memories").all() as Array<{ content: string }>) {
    totalTokens += estimateTokens(r.content);
  }

  return { memories: count.c, tokens: totalTokens, avgImportance: avg.a, byType };
}

export async function contextPrompt(query: string, topK = 6): Promise<{ context: string; sources: MemoryRecallHit[] }> {
  const hits = await recall(query, topK);
  if (hits.length === 0) return { context: "", sources: [] };
  const lines = hits.map((h) => `[${h.type}, importance ${h.importance.toFixed(2)}] ${h.content}`);
  return { context: lines.join("\n"), sources: hits };
}

function clampImportance(v: number): number {
  return Math.min(1, Math.max(0, v));
}