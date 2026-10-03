/**
 * Re-embed every stored vector in place.
 *
 * The embedding guard (`ensureDim`) treats mixing two vector spaces as a hard
 * error, which is correct but leaves the operator with a manual chore: point
 * `RAG_DB_DIR` at an empty directory and re-ingest every document from scratch.
 * For a memory store holding months of session history that is not a migration,
 * it is data loss with extra steps.
 *
 * `reindex` performs the migration in place instead:
 *   1. Mark the store `reindexing`, which makes every search and ingest fail
 *      loudly (`assertEmbedStateReady`). A partially migrated store would
 *      otherwise mix old and new vectors and return confident nonsense.
 *   2. Re-embed chunks, then memories, in batches, committing as it goes so an
 *      interrupted run leaves a resumable store rather than a lost one.
 *   3. Rewrite `embed_dim` / `embed_model` and clear the flag.
 *
 * Running it again after an interruption is always safe: the whole store is
 * rewritten from the documents' text, which is the authoritative copy.
 */
import {
  getDB,
  packVector,
  unpackVector,
  getEmbedDim,
  getEmbedModel,
  setEmbedMeta,
  setEmbedState,
} from "../db/database.js";
import { embedTextUnguarded, modelName } from "./embeddings.js";
import { invalidateVectorCache } from "./vector-search.js";

export const REINDEX_BATCH = 32;
/** Yield to the event loop this often so a stdio server stays responsive mid-run. */
const YIELD_EVERY = 4;

export type ReindexPhase = "chunks" | "memories" | "finalize";

export interface ReindexProgress {
  phase: ReindexPhase;
  done: number;
  total: number;
}

export interface ReindexResult {
  chunks: number;
  memories: number;
  dimBefore: number;
  dimAfter: number;
  modelBefore: string;
  modelAfter: string;
  ms: number;
  changed: boolean;
}

export interface ReindexOptions {
  batchSize?: number;
  onProgress?: (p: ReindexProgress) => void;
}

function resolveBatch(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw < 1) return REINDEX_BATCH;
  return Math.min(200, Math.max(1, Math.trunc(raw)));
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * Re-embed one table. Uses `iterate()` so content is streamed from disk in
 * batches rather than materialising every row, and the UPDATE is parameterized
 * so document text can never be interpreted as SQL.
 */
async function reembedTable(
  table: "chunks" | "memories",
  batchSize: number,
  onProgress?: (p: ReindexProgress) => void
): Promise<number> {
  const db = getDB();
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
  ).n;
  const reader = db
    .prepare(`SELECT id, content FROM ${table}`)
    .iterate() as IterableIterator<{ id: string; content: string }>;
  const update = db.prepare(`UPDATE ${table} SET embedding = ? WHERE id = ?`);

  let done = 0;
  let pending: Array<{ id: string; vec: Float64Array }> = [];
  let sinceYield = 0;

  const flush = (): void => {
    if (pending.length === 0) return;
    // One transaction per batch: a crash mid-run loses at most a batch, and the
    // `reindexing` flag stays set so nothing can read the half-updated store.
    db.exec("BEGIN");
    try {
      for (const row of pending) update.run(packVector(row.vec), row.id);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    done += pending.length;
    pending = [];
    onProgress?.({ phase: table, done, total });
  };

  for (const row of reader) {
    pending.push({ id: row.id, vec: await embedTextUnguarded(row.content) });
    if (pending.length >= batchSize) {
      flush();
      if (++sinceYield >= YIELD_EVERY) {
        sinceYield = 0;
        await tick();
      }
    }
  }
  flush();
  onProgress?.({ phase: table, done, total });
  return done;
}

/**
 * Migrate the store to the currently configured `EMBEDDING_PROVIDER` /
 * `EMBEDDING_MODEL`. Embedding is deterministic per model, so this is idempotent.
 */
export async function reindex(opts: ReindexOptions = {}): Promise<ReindexResult> {
  const started = Date.now();
  const batchSize = resolveBatch(opts.batchSize);
  const dimBefore = getEmbedDim();
  const modelBefore = getEmbedModel();
  const modelAfter = modelName();

  const chunksRow = getDB().prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number };
  const memoriesRow = getDB().prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number };
  if (chunksRow.n === 0 && memoriesRow.n === 0) {
    // Nothing to migrate. Still normalise the metadata so a fresh store records
    // the model it is about to start writing.
    setEmbedMeta(dimBefore || 0, modelAfter);
    return {
      chunks: 0,
      memories: 0,
      dimBefore,
      dimAfter: dimBefore,
      modelBefore,
      modelAfter,
      ms: Date.now() - started,
      changed: false,
    };
  }

  setEmbedState("reindexing");
  try {
    const chunks = await reembedTable("chunks", batchSize, opts.onProgress);
    const memories = await reembedTable("memories", batchSize, opts.onProgress);

    // Read the dimension the provider actually produced rather than trusting
    // expectedDim(), which is 0 for an unrecognised model name.
    const first = getDB().prepare("SELECT embedding FROM chunks WHERE embedding IS NOT NULL LIMIT 1").get() as
      | { embedding: Uint8Array }
      | undefined;
    const dimAfter = (unpackVector(first?.embedding ?? null)?.length ?? dimBefore) || dimBefore;

    opts.onProgress?.({ phase: "finalize", done: chunks + memories, total: chunks + memories });
    setEmbedMeta(dimAfter, modelAfter);
    invalidateVectorCache();

    return {
      chunks,
      memories,
      dimBefore,
      dimAfter,
      modelBefore,
      modelAfter,
      ms: Date.now() - started,
      changed: modelBefore !== modelAfter || dimBefore !== dimAfter,
    };
  } catch (err) {
    // Leave the flag set on purpose: the store is genuinely inconsistent now and
    // must not look usable. The message tells the operator to simply re-run.
    throw new Error(
      `Reindex failed partway (${chunksRow.n} chunks / ${memoriesRow.n} memories pending): ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `The store is still flagged as reindexing and will refuse searches until you re-run 'reindex'.`
    );
  }
}