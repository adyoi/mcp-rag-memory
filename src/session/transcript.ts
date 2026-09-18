/**
 * Sync opencode session inputs into the RAG store.
 *
 * Two sources feed the same long-term store (dedup makes re-runs idempotent):
 *   - "opencode-db"  : read user messages straight from opencode's DB (source of truth).
 *   - "session-log"  : read *.jsonl files written by the session-logger plugin
 *                      (.session-logs/<session>.jsonl).
 *
 * Every user input becomes one small document (title "<session>-<ts>") so it is
 * searchable via rag_search / rag_retrieve — while curated long-term memories
 * stay separate and clean.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import { ingestText } from "../rag/pipeline.js";

export interface SessionEntry {
  sessionId: string;
  ts: number;
  content: string;
}

export interface SyncResult {
  messages: number;
  newDocs: number;
  deduplicated: number;
  skipped: number;
}

export type SessionSource = "opencode-db" | "session-log";

/** Where opencode keeps its session/message history. Override via OPENCODE_DB. */
export const OPENCODE_DB: string =
  process.env.OPENCODE_DB ?? path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");

/** Desktop/local-mode db (per-project sessions) used as a fallback source. */
export const OPENCODE_DB_LOCAL: string =
  process.env.OPENCODE_DB_LOCAL ?? path.join(os.homedir(), ".local", "share", "opencode", "opencode-local.db");

export function opencodeDbs(): string[] {
  return [OPENCODE_DB, OPENCODE_DB_LOCAL].filter((p) => fs.existsSync(p));
}

function normalizeDir(d: string): string {
  return d.replace(/\\/g, "/").replace(/\/+$/, "");
}

function dbMatches(directory?: string): (r: { directory: string | null }) => boolean {
  const dir = directory ? normalizeDir(directory) : null;
  return (r) => !dir || (!!r.directory && normalizeDir(r.directory) === dir);
}

interface SessionRow {
  id: string;
  title: string;
  directory: string;
  time_updated: number;
}

function querySessions(dbPath: string, limit: number): SessionRow[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, title, directory, time_updated FROM session
          WHERE time_archived IS NULL AND parent_id IS NULL
          ORDER BY time_updated DESC LIMIT ?`
      )
      .all(limit) as unknown as SessionRow[];
    return rows.map((r) => ({ ...r, title: r.title ?? "", directory: r.directory ?? "" }));
  } finally {
    db.close();
  }
}

/** Merge top-level sessions from the global + local opencode DBs, newest first. */
export function listOpenCodeSessions(
  limit = 15,
  opts: { directory?: string } = {}
): Array<{ id: string; title: string; directory: string; timeUpdated: number }> {
  const rows = opencodeDbs().flatMap((p) => querySessions(p, Math.max(limit, 50)));
  const seen = new Set<string>();
  const merged = rows
    .filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    })
    .sort((a, b) => b.time_updated - a.time_updated);
  const filtered = merged.filter(dbMatches(opts.directory));
  return (opts.directory ? filtered : merged).slice(0, limit).map((r) => ({
    id: r.id,
    title: r.title,
    directory: r.directory,
    timeUpdated: r.time_updated,
  }));
}

/** Newest session, optionally pinned to a workspace directory and recency window. */
export function latestSession(opts: { directory?: string; maxAgeMs?: number } = {}): { id: string; title: string; directory: string } | null {
  const age = opts.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000;
  const recent = Date.now() - age;
  const all = listOpenCodeSessions(50, { directory: opts.directory });
  const hit = all.find((s) => s.timeUpdated >= recent);
  return hit ? { id: hit.id, title: hit.title, directory: hit.directory } : (all[0] ?? null);
}

/** Ingest whatever session is most recently active (what the user is typing in now). */
export async function ingestLatest(
  opts: { limit?: number; directory?: string; source?: SessionSource } = {}
): Promise<{ found: boolean; sessionId?: string; entries: number } & SyncResult> {
  const hit = latestSession({ directory: opts.directory });
  if (!hit) return { found: false, sessionId: undefined, entries: 0, messages: 0, newDocs: 0, deduplicated: 0, skipped: 0 };
  const res = await ingestSession(hit.id, { limit: opts.limit, source: opts.source });
  return { found: true, sessionId: hit.id, entries: res.entries, messages: res.messages, newDocs: res.newDocs, deduplicated: res.deduplicated, skipped: res.skipped };
}

/** Extract user-typed text from one session, oldest first. */
export function getSessionTranscript(sessionId: string, limit = 0): SessionEntry[] {
  if (!fs.existsSync(OPENCODE_DB)) throw new Error(`opencode DB not found: ${OPENCODE_DB}`);
  const db = new DatabaseSync(OPENCODE_DB, { readOnly: true });
  const entries: SessionEntry[] = [];
  try {
    const msgs = db
      .prepare(
        `SELECT id, time_created, data FROM message
          WHERE session_id = ? AND json_extract(data, '$.role') = 'user'
          ORDER BY time_created ASC`
      )
      .all(sessionId) as Array<{ id: string; time_created: number; data: string }>;
    const partsStatement = db.prepare("SELECT data FROM part WHERE message_id = ?");

    for (const m of msgs) {
      if (limit > 0 && entries.length >= limit) break;
      const parts = partsStatement.all(m.id) as Array<{ data: string }>;
      const texts: string[] = [];
      for (const p of parts) {
        try {
          const d = JSON.parse(p.data) as { type?: string; text?: string };
          if (d.type === "text" && d.text) texts.push(String(d.text));
        } catch {
          /* unparseable part — skip */
        }
      }
      if (texts.length > 0) entries.push({ sessionId, ts: m.time_created, content: texts.join("\n") });
    }
    return entries;
  } finally {
    db.close();
  }
}

/** Read entries from a plugin-written .jsonl file. */
export function readJsonl(file: string): SessionEntry[] {
  if (!fs.existsSync(file)) throw new Error(`Not found: ${file}`);
  const raw = fs.readFileSync(file, "utf8");
  const base = path.basename(file).replace(/\.jsonl$/, "");
  const entries: SessionEntry[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as { session?: string; sessionId?: string; ts?: number; time?: number; content?: string; text?: string };
      const content = String(o.content ?? o.text ?? "").trim();
      if (!content) continue;
      entries.push({
        sessionId: o.session ?? o.sessionId ?? base,
        ts: o.ts ?? o.time ?? Date.now(),
        content,
      });
    } catch {
      /* malformed line — skip */
    }
  }
  return entries;
}

/** Ingest entries into the RAG store. Dedup (content-hash) makes this idempotent. */
export async function ingestEntries(entries: SessionEntry[], source: SessionSource): Promise<SyncResult> {
  let newDocs = 0;
  let deduplicated = 0;
  let skipped = 0;
  for (const e of entries) {
    const content = e.content.trim();
    if (!content) {
      skipped++;
      continue;
    }
    const res = await ingestText(content, `${e.sessionId.slice(-12)}-${e.ts}`, {
      source,
      contentType: "text",
      metadata: { source, session_id: e.sessionId, ts: e.ts },
    });
    if (res.deduplicated) deduplicated++;
    else newDocs++;
  }
  return { messages: entries.length, newDocs, deduplicated, skipped };
}

export async function ingestSession(
  sessionId: string,
  opts: { limit?: number; source?: SessionSource } = {}
): Promise<{ sessionId: string; entries: number } & SyncResult> {
  const entries = getSessionTranscript(sessionId, opts.limit ?? 0);
  const res = await ingestEntries(entries, opts.source ?? "opencode-db");
  return { sessionId, entries: entries.length, ...res };
}

export async function ingestJsonlFile(file: string, opts: { source?: SessionSource } = {}): Promise<{ file: string } & SyncResult> {
  const entries = readJsonl(file);
  const res = await ingestEntries(entries, opts.source ?? "session-log");
  return { file, ...res };
}

export async function ingestLogDir(
  dir = ".session-logs",
  opts: { source?: SessionSource } = {}
): Promise<{ files: number } & SyncResult> {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    return { files: 0, messages: 0, newDocs: 0, deduplicated: 0, skipped: 0 };
  }
  const files = fs
    .readdirSync(abs)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => path.join(abs, f))
    .sort();
  let messages = 0;
  let newDocs = 0;
  let deduplicated = 0;
  let skipped = 0;
  for (const f of files) {
    const r = await ingestJsonlFile(f, opts);
    messages += r.messages;
    newDocs += r.newDocs;
    deduplicated += r.deduplicated;
    skipped += r.skipped;
  }
  return { files: files.length, messages, newDocs, deduplicated, skipped };
}