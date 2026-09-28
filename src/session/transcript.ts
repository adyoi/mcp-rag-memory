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

/**
 * Where opencode keeps its session/message history, in probe order.
 * Read on every call (not frozen at import) so OPENCODE_DB can be pointed at a
 * different store — or a fixture — at any time. Opencode uses the POSIX XDG
 * path on Linux/macOS and %LOCALAPPDATA% on Windows.
 */
export function opencodeDbs(): string[] {
  const home = os.homedir();
  const candidates = [
    process.env.OPENCODE_DB,
    process.env.OPENCODE_DB_LOCAL,
    path.join(home, ".local", "share", "opencode", "opencode.db"),
    path.join(home, ".local", "share", "opencode", "opencode-local.db"),
    process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "opencode", "opencode.db")
      : undefined,
    process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "opencode", "opencode-local.db")
      : undefined,
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of candidates) {
    if (!p) continue;
    const abs = path.resolve(p);
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (fs.existsSync(abs)) out.push(abs);
  }
  return out;
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

/** Column names present on a table (PRAGMA table_info), as a Set. */
function tableColumns(db: DatabaseSync, table: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(rows.map((r) => r.name));
  } catch {
    return new Set();
  }
}

function assertOpencodeSchema(db: DatabaseSync, table: string, required: string[]): void {
  const cols = tableColumns(db, table);
  if (cols.size === 0) {
    throw new Error(
      `opencode DB schema changed: table "${table}" not found. ` +
        "This version of mcp-rag-memory expects the opencode schema; " +
        "update the package or pin OPENCODE_DB to a compatible opencode version."
    );
  }
  const missing = required.filter((c) => !cols.has(c));
  if (missing.length > 0) {
    throw new Error(
      `opencode DB schema changed: table "${table}" is missing columns ${missing.join(", ")}. ` +
        "Update mcp-rag-memory to a version matching your opencode."
    );
  }
}

function openReadonly(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  // opencode writes to this DB continuously; without a busy timeout a read taken
  // during a write lock fails instantly with SQLITE_BUSY.
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

function querySessions(dbPath: string, limit: number): SessionRow[] {
  const db = openReadonly(dbPath);
  try {
    assertOpencodeSchema(db, "session", ["id", "directory", "time_updated"]);
    const cols = tableColumns(db, "session");
    const archiveClause = cols.has("time_archived") ? "time_archived IS NULL AND" : "";
    const parentClause = cols.has("parent_id") ? "parent_id IS NULL AND" : "";
    const rows = db
      .prepare(
        `SELECT id, title, directory, time_updated FROM session
          WHERE ${archiveClause} ${parentClause} title IS NOT NULL
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

/** Hard cap on user messages read from one session (a whole session can be huge). */
const DEFAULT_MAX_MESSAGES = 500;

function maxMessages(): number {
  const raw = Number(process.env.RAG_SESSION_MAX_MSGS);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : DEFAULT_MAX_MESSAGES;
}

/** Extract user-typed text from one session, oldest first. Searches the global
 * and local opencode DBs (a session may live in either, depending on mode). */
export function getSessionTranscript(sessionId: string, limit = 0): SessionEntry[] {
  const dbs = opencodeDbs();
  if (dbs.length === 0) {
    throw new Error(
      "opencode DB not found. Set OPENCODE_DB (and/or OPENCODE_DB_LOCAL) to the path of " +
        "opencode's opencode.db, or use 'ingest-dir' / 'ingest-text' instead."
    );
  }
  for (const dbPath of dbs) {
    const entries = transcriptFromDb(dbPath, sessionId, limit);
    if (entries.length > 0) return entries;
  }
  // Nothing anywhere: distinguish "unknown session" from "no user messages".
  for (const dbPath of dbs) {
    if (sessionExists(dbPath, sessionId)) {
      throw new Error(`Session ${sessionId} has no user messages to ingest.`);
    }
  }
  throw new Error(`Session ${sessionId} not found in any opencode DB (${dbs.join(", ")}).`);
}

function sessionExists(dbPath: string, sessionId: string): boolean {
  const db = openReadonly(dbPath);
  try {
    const row = db.prepare("SELECT 1 AS ok FROM session WHERE id = ?").get(sessionId) as
      | { ok: number }
      | undefined;
    return row !== undefined;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

function transcriptFromDb(dbPath: string, sessionId: string, limit: number): SessionEntry[] {
  const db = openReadonly(dbPath);
  const entries: SessionEntry[] = [];
  try {
    assertOpencodeSchema(db, "message", ["id", "session_id", "time_created", "data"]);
    assertOpencodeSchema(db, "part", ["message_id", "data"]);
    const cap = limit > 0 ? limit : maxMessages();
    const msgs = db
      .prepare(
        `SELECT id, time_created, data FROM message
          WHERE session_id = ? AND json_extract(data, '$.role') = 'user'
          ORDER BY time_created ASC
          LIMIT ?`
      )
      .all(sessionId, cap) as Array<{ id: string; time_created: number; data: string }>;
    // Pull only text parts in SQL — a session holds multi-MB image/tool blobs and
    // parsing every one of them just to throw it away was the memory spike.
    const partsStatement = db.prepare(
      `SELECT json_extract(data, '$.text') AS text FROM part
        WHERE message_id = ? AND json_extract(data, '$.type') = 'text'`
    );

    for (const m of msgs) {
      if (limit > 0 && entries.length >= limit) break;
      const texts: string[] = [];
      for (const p of partsStatement.all(m.id) as Array<{ text: string | null }>) {
        if (typeof p.text === "string" && p.text.trim()) texts.push(p.text);
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

/* ------------------------------------------------------------------ */
/* Key-point condensing (extractive, deterministic, zero-LLM)          */
/* ------------------------------------------------------------------ */

const CONDENSE_DEFAULT_MIN_CHARS = 120;
const CONDENSE_DEFAULT_RATIO = 0.35;

function condenseEnabled(): boolean {
  return process.env.RAG_SESSION_CONDENSE !== "0";
}

function condenseMinChars(): number {
  const n = Number(process.env.RAG_SESSION_CONDENSE_MIN_CHARS);
  return Number.isFinite(n) && n >= 50 ? n : CONDENSE_DEFAULT_MIN_CHARS;
}

function condenseRatio(): number {
  const r = Number(process.env.RAG_SESSION_CONDENSE_RATIO);
  return Number.isFinite(r) && r > 0 && r <= 1 ? r : CONDENSE_DEFAULT_RATIO;
}

const STOPWORDS: ReadonlySet<string> = new Set(
  (
    "a an and are as at be but by for from has have he her his i if in is it its " +
    "not of on or our she so that the their them they this to was we were will with " +
    "dan atau yang dari ke di dan untuk pada dengan tidak apakah saya kamu kita ini itu yang " +
    "sudah akan bisa mau apa siapa kapan mana lebih"
  ).split(/\s+/)
);

/** Split text into sentences, keeping their original order. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…:])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Score a sentence by how many meaningful tokens it carries (plus position bias). */
function scoreSentence(s: string): number {
  const tokens = s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const significant = tokens.filter((t) => t.length >= 4 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
  return significant.length + Math.min(tokens.length, 8) / 10;
}

/**
 * Keep only the key points of a long input. Short inputs pass through untouched;
 * long ones are reduced to the most information-dense sentences (deterministic,
 * so re-runs stay idempotent). Pure extractive — no LLM involved.
 */
export function condenseInput(text: string): string {
  const trimmed = text.trim();
  if (!condenseEnabled() || trimmed.length <= condenseMinChars()) return trimmed;

  const sentences = splitSentences(trimmed);
  if (sentences.length <= 1) return trimmed;

  const keepTargetChars = Math.max(Math.round(trimmed.length * condenseRatio()), Math.min(condenseMinChars(), trimmed.length));
  const scored = sentences.map((s, i) => ({ s, i, score: scoreSentence(s) + (i === 0 ? 1 : 0) }));
  scored.sort((a, b) => b.score - a.score);

  const chosen = new Set<number>();
  let kept = 0;
  for (const { i, s } of scored) {
    if (kept >= keepTargetChars) break;
    chosen.add(i);
    kept += s.length;
  }
  if (chosen.size === 0) chosen.add(0);

  return Array.from(chosen)
    .sort((a, b) => a - b)
    .map((i) => sentences[i])
    .join(" ")
    .trim();
}

/** Ingest entries into the RAG store. Dedup (content-hash) makes this idempotent. */
export async function ingestEntries(entries: SessionEntry[], source: SessionSource): Promise<SyncResult> {
  let newDocs = 0;
  let deduplicated = 0;
  let skipped = 0;
  for (const e of entries) {
    const original = e.content.trim();
    if (!original) {
      skipped++;
      continue;
    }
    const content = condenseInput(original);
    // Scope the dedup hash to (source, session, ts): without it, the same short
    // message ("ok", "continue") typed in two sessions collapsed into one
    // document and the second session silently disappeared from the store.
    const res = await ingestText(content, `${e.sessionId.slice(-12)}-${e.ts}`, {
      source,
      contentType: "text",
      metadata: { source, session_id: e.sessionId, ts: e.ts, condensed: content !== original },
      dedupScope: `${source}:${e.sessionId}:${e.ts}`,
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