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
  try {
    // busy_timeout first: every later statement should inherit it.
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    // Migrate BEFORE caching the handle: a failed migration must surface and be
    // retried on the next call, never leave a half-migrated connection cached.
    migrate(db);
  } catch (e) {
    // The handle is NOT cached on failure, so without this close every failed
    // init leaked a file handle — reachable whenever a concurrent writer holds
    // the lock, and it blocked later cleanup of the store directory on Windows.
    try {
      db.close();
    } catch {
      /* already closed */
    }
    throw e;
  }
  _db = db;
  return db;
}

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  // PRAGMA cannot take a bound parameter, so the identifier is interpolated.
  // Only ever called with literals; assert it so a future caller cannot inject.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`Unsafe table name: ${table}`);
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

function migrate(db: DatabaseSync) {
  // One IMMEDIATE transaction for the whole schema step: two processes opening
  // the same fresh store (CLI + MCP server + plugin) must not race and end up
  // with half-applied DDL or a "duplicate column" failure.
  db.exec("BEGIN IMMEDIATE;");
  try {
    createSchema(db);
    db.exec("COMMIT;");
  } catch (e) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      /* transaction already closed */
    }
    throw e;
  }
}

function createSchema(db: DatabaseSync) {
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
    CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents(updated_at DESC);
    -- Filtered searches resolve doc ids via source/doc_id first; without this
    -- every rag_search(source=...) scanned the whole documents table.
    CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source);

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
    CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at DESC);

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
  // 'trigram' tokenizer: indexes every 3-char window → good CJK recall and
  // substring matching (helps inflected languages like Indonesian too). Short
  // terms (<=2 chars) won't match the keyword leg — the vector leg covers them.
  const ftsRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunks_fts'")
    .get() as { sql?: string } | undefined;
  if (ftsRow) {
    // Existing store built with 'unicode61' — recreate with trigram and backfill.
    if (!(ftsRow.sql ?? "").includes("trigram")) rebuildFts(db);
  } else {
    // First run with this schema (or a store whose FTS table was dropped):
    // create AND backfill, otherwise existing chunks silently lose keyword search
    // forever — the next boot sees "trigram" and would skip the rebuild.
    rebuildFts(db);
  }
}

/** Runs inside the migrate() transaction. */
function rebuildFts(db: DatabaseSync): void {
  db.exec("DROP TABLE IF EXISTS chunks_fts;");
  db.exec("CREATE VIRTUAL TABLE chunks_fts USING fts5(content, tokenize = 'trigram');");
  db.exec("INSERT INTO chunks_fts(rowid, content) SELECT rowid, content FROM chunks;");
}

/** SHA-256 hex of raw content — used for document dedup. */
export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function newId(): string {
  return randomUUID();
}

/** Serialize a Float64Array embedding to a SQLite BLOB (view-safe). */
export function packVector(v: Float64Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

/** Deserialize a BLOB back into a Float64Array. Returns null on absent/partial data. */
export function unpackVector(blob: Uint8Array | null): Float64Array | null {
  if (!blob || blob.byteLength === 0 || blob.byteLength % 8 !== 0) return null;
  return new Float64Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}

export function nowMs(): number {
  return Date.now();
}

export function closeDB() {
  _db?.close();
  _db = null;
  cachedDim = null;
}

/* ------------------------------------------------------------------ */
/* Embedding dimension metadata                                        */
/* ------------------------------------------------------------------ */

/** Cached embed_dim: locked on first write, so it is read once per process. */
let cachedDim: number | null = null;

export function getEmbedDim(): number {
  if (cachedDim === null) {
    const r = getDB().prepare("SELECT value FROM meta WHERE key = 'embed_dim'").get() as
      | { value: string }
      | undefined;
    const n = Number(r?.value);
    // A corrupt row must not cache NaN: it would wedge this process with a
    // misleading "dimension mismatch" until restart.
    cachedDim = Number.isInteger(n) && n > 0 ? n : 0;
  }
  return cachedDim;
}

export function setEmbedMeta(dim: number, model: string) {
  const db = getDB();
  db.prepare(
    "INSERT INTO meta(key, value) VALUES ('embed_dim', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(String(dim));
  db.prepare(
    "INSERT INTO meta(key, value) VALUES ('embed_model', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(model);
  cachedDim = dim;
  // A completed migration restores the store to a coherent state.
  setEmbedState("ready");
}

/**
 * Lock the store to one embedding dimension. Call after producing a vector.
 * Prevents silently mixing vectors of different models/providers.
 */
export function ensureDim(vec: Float64Array, model: string): void {
  // A half-migrated store mixes old and new vectors: cosine across two spaces
  // is meaningless and every search silently returns noise. Blocking here stops
  // it at the one chokepoint every search and ingest already passes through,
  // rather than letting a partial reindex look like a working store.
  assertEmbedStateReady();
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
  // Same-dimension model swaps are the dangerous case: blending two vector
  // spaces degrades search to noise with no error anywhere, and the only clue
  // was a stale model name inside a dimension-mismatch message that never fired.
  const currentModel = getEmbedModel();
  if (currentModel && currentModel !== model) {
    throw new Error(
      `Embedding model mismatch: DB stores ${currentModel}, requested ${model} (both ${current}-dim). ` +
        `Point RAG_DB_DIR at a fresh store or re-ingest with a consistent EMBEDDING_MODEL. ` +
        `Current store: ${STORAGE_DIR}.`
    );
  }
}

export function getEmbedModel(): string {
  const r = getDB().prepare("SELECT value FROM meta WHERE key = 'embed_model'").get() as
    | { value: string }
    | undefined;
  return r ? r.value : "";
}

/**
 * `embed_state` is '' (or 'ready') for a coherent store and 'reindexing' while a
 * vector-space migration is in flight.
 */
export function getEmbedState(): string {
  const r = getDB().prepare("SELECT value FROM meta WHERE key = 'embed_state'").get() as
    | { value: string }
    | undefined;
  return r ? r.value : "";
}

export function setEmbedState(state: string): void {
  getDB()
    .prepare("INSERT INTO meta(key, value) VALUES('embed_state', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(state);
}

/** Throws when the store is mid-reindex. Called from ensureDim, the shared gate. */
export function assertEmbedStateReady(): void {
  const state = getEmbedState();
  if (state !== "" && state !== "ready") {
    throw new Error(
      `Store is mid-reindex (embed_state=${state}): vectors from two embedding models are ` +
        `mixed and search results would be meaningless. Run 'reindex' again to finish the ` +
        `migration. Current store: ${STORAGE_DIR}.`
    );
  }
}