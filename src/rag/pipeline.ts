import * as fs from "fs";
import * as path from "path";
import { contentHash, getDB, newId, nowMs, packVector } from "../db/database.js";
import { chunkText } from "./chunker.js";
import { embedText } from "./embeddings.js";
import { searchChunks, vectorSearch, invalidateVectorCache } from "./vector-search.js";
import type { SearchHit, SearchChunkFilters } from "./vector-search.js";

export interface SearchOptions {
  topK?: number;
  minScore?: number;
  filters?: SearchChunkFilters;
}

export interface IngestResult {
  docId: string;
  title: string;
  chunks: number;
  tokens: number;
  deduplicated: boolean;
}

export interface RetrievedContext {
  chunks: Array<{ docTitle: string; chunkIndex: number; content: string; score: number; tokenCount: number }>;
  totalTokens: number;
}

export interface IngestFileOptions {
  source?: string;
  contentType?: string;
  metadata?: Record<string, unknown>;
  /** Namespace the dedup hash, so equal text from different scopes is kept apart. */
  dedupScope?: string;
}

export interface IngestDirectoryOptions {
  extensions?: string[];
  recursive?: boolean;
  metadata?: Record<string, unknown>;
}

let ftsWarned = false;

/** Insert a FTS row. Only a genuinely missing FTS5 backend degrades silently —
 * any other failure (disk full, corruption, SQLITE_BUSY) must surface, because
 * swallowing it left every chunk permanently invisible to the keyword leg with
 * no diagnostic and no rebuild path. */
function insertFtsRow(rowid: number, text: string): void {
  try {
    getDB().prepare("INSERT INTO chunks_fts(rowid, content) VALUES (?, ?)").run(rowid, text);
  } catch (e) {
    const msg = (e as Error).message;
    // Match only "the FTS table is not there". A looser /chunks_fts/ test also
    // swallowed UNIQUE and corruption errors, which are exactly the failures
    // this change exists to surface.
    if (!/no such table: chunks_fts|no such module: fts5/i.test(msg)) throw e;
    if (!ftsWarned) {
      ftsWarned = true;
      process.stderr.write("rag: chunks_fts unavailable — hybrid search degraded to vector-only\n");
    }
  }
}

/** SQLite UNIQUE violation, which node:sqlite surfaces as errcode 2067. */
function isUniqueViolation(e: unknown, column: string): boolean {
  const err = e as { errcode?: number; message?: string };
  const msg = err?.message ?? "";
  // "." must be escaped or it matches any character.
  return err?.errcode === 2067 || msg.includes(`UNIQUE constraint failed: ${column}`);
}

/** Max content accepted from a tool call or CLI, so one payload cannot stall the server for a minute. */
export const MAX_INGEST_CHARS = 1_000_000;

export async function ingestText(
  content: string,
  title: string,
  opts: IngestFileOptions = {}
): Promise<IngestResult> {
  const db = getDB();
  const ts = nowMs();
  // trim(): whitespace-only content produced a permanent 0-chunk document that
  // could never be searched yet still occupied the content_hash unique index.
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("Ingest content must be a non-empty string");
  }
  if (content.length > MAX_INGEST_CHARS) {
    throw new Error(
      `Ingest content too large (${content.length} chars > limit ${MAX_INGEST_CHARS}). ` +
        `Split it, or use ingest_file / ingest_dir for large sources.`
    );
  }

  // Content-hash dedup: identical documents are never re-embedded. `dedupScope`
  // keeps sources that legitimately repeat the same text apart (e.g. "ok" typed
  // in two different sessions).
  const hash = contentHash(`${opts.dedupScope ? `${opts.dedupScope}\u0000` : ""}${content}`);
  const existing = db
    .prepare("SELECT id, title, chunk_count FROM documents WHERE content_hash = ?")
    .get(hash) as { id: string; title: string; chunk_count: number } | undefined;
  if (existing) {
    const tokens = db
      .prepare("SELECT COALESCE(SUM(token_count), 0) AS t FROM chunks WHERE doc_id = ?")
      .get(existing.id) as { t: number };
    return {
      docId: existing.id,
      title: existing.title,
      chunks: existing.chunk_count,
      tokens: tokens.t,
      deduplicated: true,
    };
  }

  const docId = newId();
  const chunks = chunkText(content);
  if (chunks.length === 0) {
    throw new Error("Ingest produced no indexable content (no non-whitespace text)");
  }
  let tokens = 0;

  // Embed BEFORE opening the transaction. The MCP SDK does not serialize tool
  // calls, so awaiting inside a transaction let a concurrent request's writes
  // join this one — and a failure here rolled back that other request's work.
  // The yield keeps the event loop responsive: a 10 MB file is ~11k chunks and
  // the local embedder is synchronous, so without it the stdio server could not
  // answer any other tool call for the whole ingest.
  const vectors: Float64Array[] = [];
  for (let i = 0; i < chunks.length; i++) {
    vectors.push(await embedText(chunks[i].text));
    if ((i & 15) === 15) await new Promise<void>((resolve) => setImmediate(resolve));
  }

  // All writes for one document are atomic, and the block below is fully
  // synchronous, so no other request can interleave inside it.
  db.exec("BEGIN IMMEDIATE;");
  try {
    db.prepare(
      `INSERT INTO documents (id, title, source, content_type, metadata, content_hash, chunk_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      docId,
      title,
      opts.source ?? null,
      opts.contentType ?? "text",
      JSON.stringify(opts.metadata ?? {}),
      hash,
      chunks.length,
      ts,
      ts
    );

    const insertChunk = db.prepare(
      `INSERT INTO chunks (id, doc_id, idx, content, embedding, token_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      tokens += chunk.tokenCount;
      const res = insertChunk.run(newId(), docId, chunk.index, chunk.text, packVector(vectors[i]), chunk.tokenCount, ts);
      insertFtsRow(Number(res.lastInsertRowid), chunk.text);
    }
    db.exec("COMMIT;");
  } catch (e) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      /* transaction already closed */
    }
    // Two identical ingests can both pass the dedup SELECT above: the check and
    // this INSERT are separated by chunking + embedding, and MCP tool calls are
    // not serialized. Let the unique index arbitrate and report a dedup hit
    // rather than failing the caller with a raw driver error.
    if (isUniqueViolation(e, "documents.content_hash")) {
      const again = getDB()
        .prepare("SELECT id, title, chunk_count FROM documents WHERE content_hash = ?")
        .get(hash) as { id: string; title: string; chunk_count: number } | undefined;
      if (again) {
        return {
          docId: again.id,
          title: again.title,
          chunks: again.chunk_count,
          tokens: 0,
          deduplicated: true,
        };
      }
    }
    throw e;
  }
  invalidateVectorCache();

  return { docId, title, chunks: chunks.length, tokens, deduplicated: false };
}

/** Roots are realpath'd too, so a junction/symlinked allowlist entry still matches. */
function allowedRoots(): string[] {
  const raw = process.env.RAG_ALLOWED_DIRS;
  if (!raw) return [];
  return raw
    .split(/[;|,]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const abs = path.resolve(p);
      try {
        return fs.realpathSync(abs);
      } catch {
        return abs;
      }
    });
}

let warnedOpenAllowlist = false;

/**
 * RAG_ALLOWED_DIRS is opt-in, so by default any readable path can be ingested
 * and then stays retrievable from every future session sharing this store. Warn
 * once instead of silently widening the blast radius of an agent-driven tool.
 */
function assertAllowedPath(abs: string): void {
  const roots = allowedRoots();
  if (roots.length === 0) {
    if (!warnedOpenAllowlist) {
      warnedOpenAllowlist = true;
      process.stderr.write(
        "rag: RAG_ALLOWED_DIRS is not set — any readable path can be ingested and stays " +
          `retrievable from this store. Set RAG_ALLOWED_DIRS to restrict it.\n`
      );
    }
    return;
  }
  const real = fs.realpathSync(abs);
  if (!roots.some((r) => real === r || real.startsWith(r + path.sep))) {
    throw new Error(`Path not allowed by RAG_ALLOWED_DIRS: ${abs}`);
  }
}

export async function ingestFile(filePath: string, opts: IngestFileOptions = {}): Promise<IngestResult> {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error(`Not a file: ${abs}`);

  const maxMbRaw = Number(process.env.RAG_MAX_FILE_MB ?? 10);
  const maxMb = Number.isFinite(maxMbRaw) && maxMbRaw > 0 ? maxMbRaw : 10;
  const maxBytes = Math.max(1024, Math.floor(maxMb * 1024 * 1024));
  if (st.size > maxBytes) {
    throw new Error(
      `File too large (${st.size} bytes > limit ${maxBytes}): ${abs}. Raise RAG_MAX_FILE_MB to allow bigger files.`
    );
  }
  assertAllowedPath(abs);

  const content = fs.readFileSync(abs, "utf-8");
  const title = path.basename(abs);
  return ingestText(stripBom(content), title, {
    source: abs,
    contentType: opts.contentType ?? guessContentType(abs),
    metadata: opts.metadata ?? { path: abs },
  });
}

/**
 * Drop a UTF-8 BOM. It survives readFileSync as U+FEFF, so a Windows-authored
 * .md file's first heading indexed as "\ufeff# Title" — the FTS trigram tokenizer
 * keyed on it and the title never matched a plain "Title" query.
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Let the event loop breathe every N files during large directory ingests. */
function yieldLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Cap the payload: a big directory must not return one line per file. */
const DIR_REPORT_LIMIT = 50;

/**
 * Hard ceiling on files actually ingested. DIR_REPORT_LIMIT only truncated the
 * response, so pointing this at a large tree still embedded every file and held
 * the server hostage; the cap is reported explicitly instead of silently
 * dropping the remainder.
 */
const DIR_MAX_FILES = 500;

export async function ingestDirectory(
  dirPath: string,
  opts: IngestDirectoryOptions = {}
): Promise<{ ingested: IngestResult[]; skipped: string[]; ingestedCount: number; skippedCount: number }> {
  const root = path.resolve(dirPath);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Not a directory: ${dirPath}`);
  }
  assertAllowedPath(root);

  if (opts.extensions !== undefined) {
    if (opts.extensions.length === 0) throw new Error("extensions must not be empty");
    for (const e of opts.extensions) {
      if (typeof e !== "string" || e.trim() === "") throw new Error(`Invalid extension: ${JSON.stringify(e)}`);
    }
  }
  // Lowercase once: `full.endsWith(e)` is case-sensitive, so an explicit
  // extensions: [".TS"] silently matched nothing on a Windows-authored tree
  // (or a request for ".Md" against README.MD).
  const exts = (opts.extensions?.map((e) => (e.startsWith(".") ? e : `.${e}`)) ?? [
    ".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".txt", ".py", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".html", ".css",
  ]).map((e) => e.toLowerCase());
  const skipDirs = new Set([".git", "dist", "node_modules", ".rag-data", ".test-data", ".venv"]);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (opts.recursive && !skipDirs.has(entry.name) && !entry.name.startsWith(".")) walk(full);
      } else if (entry.isFile() && exts.some((e) => full.toLowerCase().endsWith(e))) {
        files.push(full);
      }
    }
  };
  walk(root);

  // Deterministic slice before any work: walk() order is filesystem-dependent,
  // so capping after sorting keeps "which 500" reproducible across machines.
  const sorted = files.sort();
  const truncated = Math.max(0, sorted.length - DIR_MAX_FILES);
  const targets = truncated > 0 ? sorted.slice(0, DIR_MAX_FILES) : sorted;
  const ingested: IngestResult[] = [];
  const skipped: string[] = [];
  let ingestedCount = 0;
  let skippedCount = 0;
  for (let i = 0; i < targets.length; i++) {
    const f = targets[i];
    try {
      const res = await ingestFile(f, { metadata: opts.metadata ?? { ingestDir: root } });
      ingestedCount++;
      if (ingested.length < DIR_REPORT_LIMIT) ingested.push(res);
    } catch (e) {
      skippedCount++;
      if (skipped.length < DIR_REPORT_LIMIT) skipped.push(`${f} (${(e as Error).message})`);
    }
    if (i % 10 === 9) await yieldLoop();
  }
  if (truncated > 0) {
    skippedCount += truncated;
    if (skipped.length < DIR_REPORT_LIMIT) {
      skipped.push(
        `${truncated} more file(s) matched but were not ingested: directory ingest is capped at ${DIR_MAX_FILES} per call`
      );
    }
  }
  return { ingested, skipped, ingestedCount, skippedCount };
}

export async function searchDocs(query: string, topK = 10, minScore = 0.08, filters?: SearchChunkFilters): Promise<SearchHit[]> {
  const q = await embedText(query);
  return searchChunks(q, { queryText: query, topK, minScore, filters });
}

export async function retrieve(
  query: string,
  topK = 6,
  minScore = 0.08,
  filters?: SearchChunkFilters
): Promise<RetrievedContext> {
  const hits = await searchDocs(query, topK, minScore, filters);
  const withTokens = hits.map((h) => ({
    docTitle: h.docTitle,
    chunkIndex: h.chunkIndex,
    content: h.content,
    score: h.score,
    tokenCount: h.tokenCount,
  }));
  return {
    chunks: withTokens,
    totalTokens: withTokens.reduce((acc, c) => acc + c.tokenCount, 0),
  };
}

/** Bounded by default: a big store would otherwise dump every row into one tool result. */
export const LIST_DOCS_DEFAULT = 100;
export const LIST_DOCS_MAX = 1000;

export function listDocuments(opts: { limit?: number; offset?: number } = {}): {
  documents: Array<Record<string, unknown>>;
  total: number;
  limit: number;
  offset: number;
} {
  const db = getDB();
  const limit = Math.min(
    Math.max(Math.trunc(opts.limit ?? LIST_DOCS_DEFAULT), 1),
    LIST_DOCS_MAX
  );
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
  const total = (db.prepare("SELECT COUNT(*) AS c FROM documents").get() as { c: number }).c;
  const rows = db
    .prepare(
      `SELECT id, title, source, content_type, chunk_count, created_at, updated_at, metadata
         FROM documents ORDER BY updated_at DESC LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as unknown as Array<Record<string, unknown>>;
  return { documents: rows, total, limit, offset };
}

export function deleteDocument(docId: string): { deleted: boolean } {
  const db = getDB();
  db.exec("BEGIN IMMEDIATE;");
  let changes = 0;
  try {
    db.prepare("DELETE FROM chunks_fts WHERE rowid IN (SELECT rowid FROM chunks WHERE doc_id = ?)").run(docId);
    changes = Number(db.prepare("DELETE FROM documents WHERE id = ?").run(docId).changes);
    db.exec("COMMIT;");
  } catch (e) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      /* transaction already closed */
    }
    throw e;
  }
  invalidateVectorCache();
  return { deleted: changes > 0 };
}

export function documentStats(): { documents: number; chunks: number; tokens: number } {
  const db = getDB();
  const docs = db.prepare("SELECT COUNT(*) AS c FROM documents").get() as { c: number };
  const chunks = db.prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number };
  const tokens = db.prepare("SELECT COALESCE(SUM(token_count),0) AS c FROM chunks").get() as { c: number };
  return { documents: docs.c, chunks: chunks.c, tokens: tokens.c };
}

function guessContentType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx", ".json": "json",
    ".md": "markdown", ".txt": "text", ".py": "python", ".go": "go", ".rs": "rust", ".toml": "toml",
    ".yaml": "yaml", ".yml": "yaml", ".html": "html", ".css": "css", ".sql": "sql", ".jsonl": "jsonl", ".log": "log",
  };
  return map[ext] ?? "text";
}

/** Raw vector search over chunk keys (used by CLI/tests). */
export { vectorSearch, invalidateVectorCache };