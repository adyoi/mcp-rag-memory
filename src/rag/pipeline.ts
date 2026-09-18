import * as fs from "fs";
import * as path from "path";
import { contentHash, getDB, newId, nowMs, packVector } from "../db/database.js";
import { chunkText } from "./chunker.js";
import { embedText } from "./embeddings.js";
import { searchChunks, vectorSearch, invalidateVectorCache } from "./vector-search.js";
import type { SearchHit } from "./vector-search.js";

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
}

export interface IngestDirectoryOptions {
  extensions?: string[];
  recursive?: boolean;
  metadata?: Record<string, unknown>;
}

/** Insert a FTS row, tolerating an unavailable FTS5 backend. */
function insertFtsRow(docId: string, rowid: number, text: string): void {
  try {
    getDB().prepare("INSERT INTO chunks_fts(rowid, content) VALUES (?, ?)").run(rowid, text);
  } catch {
    // FTS missing — hybrid degrades to vector-only.
  }
}

export async function ingestText(
  content: string,
  title: string,
  opts: IngestFileOptions = {}
): Promise<IngestResult> {
  const db = getDB();
  const ts = nowMs();

  // Content-hash dedup: identical documents are never re-embedded.
  const hash = contentHash(content);
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

  let tokens = 0;
  const insertChunk = db.prepare(
    `INSERT INTO chunks (id, doc_id, idx, content, embedding, token_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const vec = await embedText(chunk.text);
    tokens += chunk.tokenCount;
    const res = insertChunk.run(newId(), docId, chunk.index, chunk.text, packVector(vec), chunk.tokenCount, ts);
    insertFtsRow(docId, Number(res.lastInsertRowid), chunk.text);
  }
  invalidateVectorCache();

  return { docId, title, chunks: chunks.length, tokens, deduplicated: false };
}

function assertAllowedPath(abs: string): void {
  const raw = process.env.RAG_ALLOWED_DIRS;
  if (!raw) return;
  const roots = raw
    .split(/[;|,]/)
    .map((p) => path.resolve(p.trim()))
    .filter(Boolean);
  if (roots.length === 0) return;
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

  const maxMb = Number(process.env.RAG_MAX_FILE_MB ?? 10);
  const maxBytes = Math.max(1024, Math.floor(maxMb * 1024 * 1024));
  if (st.size > maxBytes) {
    throw new Error(
      `File too large (${st.size} bytes > limit ${maxBytes}): ${abs}. Raise RAG_MAX_FILE_MB to allow bigger files.`
    );
  }
  assertAllowedPath(abs);

  const content = fs.readFileSync(abs, "utf-8");
  const title = path.basename(abs);
  return ingestText(content, title, {
    source: abs,
    contentType: opts.contentType ?? guessContentType(abs),
    metadata: opts.metadata ?? { path: abs },
  });
}

/** Let the event loop breathe every N files during large directory ingests. */
function yieldLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function ingestDirectory(
  dirPath: string,
  opts: IngestDirectoryOptions = {}
): Promise<{ ingested: IngestResult[]; skipped: string[] }> {
  const root = path.resolve(dirPath);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Not a directory: ${dirPath}`);
  }
  assertAllowedPath(root);

  const exts = opts.extensions?.map((e) => (e.startsWith(".") ? e : `.${e}`)) ?? [
    ".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".txt", ".py", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".html", ".css",
  ];
  const skipDirs = new Set([".git", "dist", "node_modules", ".rag-data", ".test-data", ".venv"]);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (opts.recursive && !skipDirs.has(entry.name) && !entry.name.startsWith(".")) walk(full);
      } else if (entry.isFile() && exts.some((e) => full.endsWith(e))) {
        files.push(full);
      }
    }
  };
  walk(root);

  const ingested: IngestResult[] = [];
  const skipped: string[] = [];
  for (let i = 0; i < files.sort().length; i++) {
    const f = files[i];
    try {
      ingested.push(await ingestFile(f, { metadata: opts.metadata ?? { ingestDir: root } }));
    } catch (e) {
      skipped.push(`${f} (${(e as Error).message})`);
    }
    if (i % 10 === 9) await yieldLoop();
  }
  return { ingested, skipped };
}

export async function searchDocs(query: string, topK = 10, minScore = 0.08): Promise<SearchHit[]> {
  const q = await embedText(query);
  return searchChunks(q, { queryText: query, topK, minScore });
}

export async function retrieve(query: string, topK = 6, minScore = 0.08): Promise<RetrievedContext> {
  const hits = await searchDocs(query, topK, minScore);
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

export function listDocuments(): Array<Record<string, unknown>> {
  const db = getDB();
  const rows = db
    .prepare(
      `SELECT id, title, source, content_type, chunk_count, created_at, updated_at, metadata FROM documents ORDER BY updated_at DESC`
    )
    .all() as unknown as Array<Record<string, unknown>>;
  return rows;
}

export function deleteDocument(docId: string): { deleted: boolean } {
  const db = getDB();
  db.prepare("DELETE FROM chunks_fts WHERE rowid IN (SELECT rowid FROM chunks WHERE doc_id = ?)").run(docId);
  const res = db.prepare("DELETE FROM documents WHERE id = ?").run(docId);
  invalidateVectorCache();
  return { deleted: Number(res.changes) > 0 };
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