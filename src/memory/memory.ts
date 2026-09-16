import { getDB, newId, nowMs, packVector, unpackVector } from "../db/database.js";
import { embed, cosineSimilarity } from "../rag/embedder.js";
import { estimateTokens } from "../rag/chunker.js";
import { vectorSearch } from "../rag/vector-search.js";

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
}

export function remember(input: MemoryInput): MemoryRecord {
  const db = getDB();
  const id = newId();
  const ts = nowMs();
  const type = input.type ?? "fact";
  const importance = clampImportance(input.importance ?? 0.5);
  const tags = JSON.stringify(input.tags ?? []);

  const vec = embed(input.content);
  db.prepare(
    `INSERT INTO memories (id, type, content, importance, embedding, tags, recall_count, last_recalled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`
  ).run(id, type, input.content, importance, packVector(vec), tags, ts, ts);

  return getMemory(id)!;
}

export function recall(query: string, topK = 8, minScore = 0.1): MemoryRecallHit[] {
  const db = getDB();
  const q = embed(query);
  const hits = vectorSearch(q, { topK, minScore, collection: "memories" });

  const results: MemoryRecallHit[] = [];
  const bump = db.prepare("UPDATE memories SET recall_count = recall_count + 1, last_recalled = ? WHERE id = ?");
  for (const h of hits) {
    const rec = getMemory(h.key);
    if (!rec) continue;
    bump.run(nowMs(), rec.id);
    const updated = getMemory(rec.id);
    if (!updated) continue;
    results.push({ ...updated, score: h.score });
  }
  return results;
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
    clauses.push("tags LIKE ?");
    params.push(`%"${opts.tag}"%`);
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

export function updateMemory(
  id: string,
  patch: { content?: string; type?: MemoryType; importance?: number; tags?: string[] }
): MemoryRecord | null {
  const db = getDB();
  const existing = getMemory(id);
  if (!existing) return null;

  const content = patch.content ?? existing.content;
  const type = patch.type ?? existing.type;
  const importance = patch.importance !== undefined ? clampImportance(patch.importance) : existing.importance;
  const tags = patch.tags ?? existing.tags;
  const vec = embed(content);
  const ts = nowMs();

  db.prepare(
    "UPDATE memories SET content = ?, type = ?, importance = ?, tags = ?, embedding = ?, updated_at = ? WHERE id = ?"
  ).run(content, type, importance, JSON.stringify(tags), packVector(vec), ts, id);

  return getMemory(id);
}

export function forget(id: string): { deleted: boolean } {
  const db = getDB();
  const res = db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  return { deleted: Number(res.changes) > 0 };
}

export interface ConsolidationReport {
  removedDuplicates: number;
  promoted: number;
  totals: { memories: number; tokens: number };
}

/**
 * - Removes near-duplicate memories (cosine > 0.92) keeping the highest-importance one.
 * - Promotes importance of frequently-needed memories (recall_count >= 5) by +0.1.
 */
export function consolidate(): ConsolidationReport {
  const db = getDB();
  const rows = db.prepare("SELECT id, embedding FROM memories").all() as Array<{ id: string; embedding: Uint8Array | null }>;
  const vectors = rows
    .map((r) => ({ id: r.id, vec: unpackVector(r.embedding) }))
    .filter((r) => r.vec !== null) as Array<{ id: string; vec: Float64Array }>;

  let removedDuplicates = 0;
  for (let i = 0; i < vectors.length; i++) {
    if (!getMemory(vectors[i].id)) continue; // already removed
    for (let j = i + 1; j < vectors.length; j++) {
      if (!getMemory(vectors[j].id)) continue;
      const a = getMemory(vectors[i].id)!;
      const b = getMemory(vectors[j].id)!;
      const sim = cosineSimilarity(vectors[i].vec, vectors[j].vec);
      if (sim >= 0.92) {
        if (a.importance >= b.importance) {
          forget(b.id);
        } else {
          forget(a.id);
          // swap so we keep comparing the survivor
          const tmpId = vectors[i].id;
          vectors[i].id = vectors[j].id;
          vectors[j].id = tmpId;
        }
        removedDuplicates++;
      }
    }
  }

  let promoted = 0;
  for (const rec of listMemories()) {
    if (rec.recallCount >= 5 && rec.importance < 1) {
      updateMemory(rec.id, { importance: Math.min(1, rec.importance + 0.1) });
      promoted++;
    }
  }

  const stats = memoryStats();
  return {
    removedDuplicates,
    promoted,
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

  const totalTokens = listMemories().reduce((acc, m) => acc + estimateTokens(m.content), 0);

  return { memories: count.c, tokens: totalTokens, avgImportance: avg.a, byType };
}

export function contextPrompt(query: string, topK = 6): { context: string; sources: MemoryRecallHit[] } {
  const hits = recall(query, topK);
  if (hits.length === 0) return { context: "", sources: [] };
  const lines = hits.map((h) => `[${h.type}, importance ${h.importance.toFixed(2)}] ${h.content}`);
  return { context: lines.join("\n"), sources: hits };
}

function clampImportance(v: number): number {
  return Math.min(1, Math.max(0, v));
}