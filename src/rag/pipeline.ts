import * as fs from "fs";
import * as path from "path";
import { getDB, newId, nowMs, packVector } from "../db/database.js";
import { chunkText, estimateTokens } from "./chunker.js";
import { embed } from "./embedder.js";
import { searchChunks, vectorSearch } from "./vector-search.js";

export interface IngestResult {
  docId: string;
  title: string;
  chunks: number;
  tokens: number;
}

export interface RetrievedContext {
  chunks: Array<{ docTitle: string; chunkIndex: number; content: string; score: number; tokenCount: number }>;
  totalTokens: number;
}

export function ingestText(
  content: string,
  title: string,
  opts: { source?: string; contentType?: string; metadata?: Record<string, unknown> } = {}
): IngestResult {
  const db = getDB();
  const docId = newId();
  const ts = nowMs();
  const chunks = chunkText(content);

  db.prepare(
    `INSERT INTO documents (id, title, source, content_type, metadata, chunk_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(docId, title, opts.source ?? null, opts.contentType ?? "text", JSON.stringify(opts.metadata ?? {}), chunks.length, ts, ts);

  let tokens = 0;
  const insertChunk = db.prepare(
    `INSERT INTO chunks (id, doc_id, idx, content, embedding, token_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const chunk of chunks) {
    const vec = embed(chunk.text);
    tokens += chunk.tokenCount;
    insertChunk.run(newId(), docId, chunk.index, chunk.text, packVector(vec), chunk.tokenCount, ts);
  }

  db.prepare("UPDATE documents SET chunk_count = ?, updated_at = ? WHERE id = ?").run(chunks.length, ts, docId);
  return { docId, title, chunks: chunks.length, tokens };
}

export function ingestFile(
  filePath: string,
  opts: { contentType?: string; metadata?: Record<string, unknown> } = {}
): IngestResult {
  const abs = path.resolve(filePath);
  const content = fs.readFileSync(abs, "utf-8");
  const title = path.basename(abs);
  const contentType = opts.contentType ?? guessContentType(abs);
  return ingestText(content, title, { source: abs, contentType, metadata: opts.metadata ?? { path: abs } });
}

export function ingestDirectory(
  dirPath: string,
  opts: { extensions?: string[]; recursive?: boolean; metadata?: Record<string, unknown> } = {}
): { ingested: IngestResult[]; skipped: string[] } {
  const root = path.resolve(dirPath);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Not a directory: ${dirPath}`);
  }
  const exts = opts.extensions?.map((e) => (e.startsWith(".") ? e : `.${e}`)) ?? [
    ".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".txt", ".py", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".html", ".css",
  ];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (opts.recursive && !entry.name.startsWith(".") && entry.name !== "node_modules") walk(full);
      } else if (entry.isFile() && exts.some((e) => full.endsWith(e))) {
        files.push(full);
      }
    }
  };
  walk(root);

  const ingested: IngestResult[] = [];
  const skipped: string[] = [];
  for (const f of files.sort()) {
    try {
      ingested.push(ingestFile(f, { metadata: opts.metadata ?? { ingestDir: root } }));
    } catch (e) {
      skipped.push(`${f} (${(e as Error).message})`);
    }
  }
  return { ingested, skipped };
}

export function searchDocs(query: string, topK = 10, minScore = 0.08) {
  const q = embed(query);
  return searchChunks(q, topK, minScore);
}

export function retrieve(query: string, topK = 6, minScore = 0.08): RetrievedContext {
  const hits = searchDocs(query, topK, minScore);
  const withTokens = hits.map((h) => ({
    docTitle: h.docTitle,
    chunkIndex: h.chunkIndex,
    content: h.content,
    score: h.score,
    tokenCount: estimateTokens(h.content),
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
      `SELECT id, title, source, content_type, chunk_count, created_at, updated_at FROM documents ORDER BY updated_at DESC`
    )
    .all() as unknown as Array<Record<string, unknown>>;
  return rows;
}

export function deleteDocument(docId: string): { deleted: boolean } {
  const db = getDB();
  const res = db.prepare("DELETE FROM documents WHERE id = ?").run(docId);
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
    ".yaml": "yaml", ".yml": "yaml", ".html": "html", ".css": "css", ".sql": "sql",
  };
  return map[ext] ?? "text";
}

/** Helper used by CLI/tests: raw vector search over chunk keys. */
export { vectorSearch };