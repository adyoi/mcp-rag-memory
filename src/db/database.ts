import { DatabaseSync } from "node:sqlite";
import * as path from "path";
import * as fs from "fs";
import { randomUUID } from "node:crypto";

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
  `);
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