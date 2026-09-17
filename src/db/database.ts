import { DatabaseSync } from "node:sqlite";
import * as path from "path";
import * as fs from "fs";
import { createHash, randomUUID } from "node:crypto";

export const STORAGE_DIR = process.env.RAG_DB_DIR
  ? path.resolve(process.env.RAG_DB_DIR)
  : path.resolve(process.cwd(), ".rag-data");

export const DB_PATH = path.join(STORAGE_DIR, "rag.sqlite");

let _db: DatabaseSync | null = null;

function ensureDir() {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
}

export function getDB(): DatabaseSync {
  if (_db) return _db;
  ensureDir();
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  _db = db;
  migrate(db);
  return db;
}

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

function migrate(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id           TEXT PRIMARY KEY,
      title        TEXT NOT NULL,
      source       TEXT,
      content_type TEXT DEFAULT 'text',
      metadata     TEXT DEFAULT '{}',
      chunk_count  INTEGER DEFAULT 0,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id        TEXT PRIMARY KEY,
      doc_id    TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      idx       INTEGER NOT NULL,
      content   TEXT NOT NULL,
      embedding BLOB,
      token_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON chunks(doc_id);

    CREATE TABLE IF NOT EXISTS memories (
      id           TEXT PRIMARY KEY,
      type         TEXT DEFAULT 'fact',
      content      TEXT NOT NULL,
      importance   REAL DEFAULT 0.5,
      embedding    BLOB,
      tags         TEXT DEFAULT '[]',
      recall_count INTEGER DEFAULT 0,
      last_recalled INTEGER,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
    CREATE INDEX IF NOT EXISTS idx_memories_prune ON memories(importance, recall_count, created_at);

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Content-hash dedup for documents (unique partial index — NULLs allowed).
  if (!columnExists(db, "documents", "content_hash")) {
    db.exec("ALTER TABLE documents ADD COLUMN content_hash TEXT;");
  }
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_content_hash ON documents(content_hash) WHERE content_hash IS NOT NULL;"
  );

  // FTS5 full-text index over chunks for hybrid (BM25 + vector) search.
  const hasFts = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunks_fts'")
    .get() as { name: string } | undefined;
  if (!hasFts) {
    db.exec("CREATE VIRTUAL TABLE chunks_fts USING fts5(content, tokenize = 'unicode61');");
  }
}

/** SHA-256 hex of raw content — used for document dedup. */
export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function newId(): string {
  return randomUUID();
}

/** Serialize a Float64Array embedding to a SQLite BLOB. */
export function packVector(v: Float64Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(0));
}

/** Deserialize a BLOB back into a Float64Array. */
export function unpackVector(blob: Uint8Array | null): Float64Array | null {
  if (!blob || blob.byteLength === 0) return null;
  return new Float64Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}

export function nowMs(): number {
  return Date.now();
}

export function closeDB() {
  _db?.close();
  _db = null;
}

/* ------------------------------------------------------------------ */
/* Embedding dimension metadata                                        */
/* ------------------------------------------------------------------ */

export function getEmbedDim(): number {
  const r = getDB().prepare("SELECT value FROM meta WHERE key = 'embed_dim'").get() as
    | { value: string }
    | undefined;
  return r ? Number(r.value) : 0;
}

export function setEmbedMeta(dim: number, model: string) {
  const db = getDB();
  db.prepare(
    "INSERT INTO meta(key, value) VALUES ('embed_dim', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(String(dim));
  db.prepare(
    "INSERT INTO meta(key, value) VALUES ('embed_model', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(model);
}

/**
 * Lock the store to one embedding dimension. Call after producing a vector.
 * Prevents silently mixing vectors of different models/providers.
 */
export function ensureDim(vec: Float64Array, model: string): void {
  const current = getEmbedDim();
  if (current === 0) {
    setEmbedMeta(vec.length, model);
    return;
  }
  if (current !== vec.length) {
    throw new Error(
      `Embedding dimension mismatch: DB stores ${current} (model: ${getEmbedModel()}), ` +
        `new vectors are ${vec.length} (model: ${model}). ` +
        `Use a consistent EMBEDDING_PROVIDER or wipe ${STORAGE_DIR}.`
    );
  }
}

export function getEmbedModel(): string {
  const r = getDB().prepare("SELECT value FROM meta WHERE key = 'embed_model'").get() as
    | { value: string }
    | undefined;
  return r ? r.value : "";
}