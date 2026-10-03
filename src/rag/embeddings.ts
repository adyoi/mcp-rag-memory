/**
 * Embedding backends.
 *
 * EMBEDDING_PROVIDER:
 *   - "local"       (default) — zero-dependency local hashing embedder (1024-dim).
 *   - "transformers" — offline ONNX model via @huggingface/transformers (higher quality).
 *                      Install the optional dependency yourself: npm i @huggingface/transformers
 *
 * All stored vectors must share one dimension (guarded by ensureDim).
 */
import { embed } from "./embedder.js";
import { ensureDim, getEmbedDim } from "../db/database.js";

export const EMBED_DIM_LOCAL = 1024;

export type EmbeddingProvider = "local" | "transformers";

export const EMBEDDING_PROVIDER: EmbeddingProvider =
  process.env.EMBEDDING_PROVIDER === "transformers" ? "transformers" : "local";

export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "Xenova/all-MiniLM-L6-v2";

/** Known output dims for common models; 0 = unknown (locked after first embed). */
const KNOWN_DIMS: Record<string, number> = {
  "Xenova/all-MiniLM-L6-v2": 384,
  "Xenova/paraphrase-multilingual-MiniLM-L12-v2": 384,
  "Xenova/multilingual-e5-small": 384,
  "Xenova/gte-small": 384,
  "Xenova/bge-small-en-v1.5": 384,
  "Xenova/multilingual-e5-base": 768,
};

export function expectedDim(): number {
  return EMBEDDING_PROVIDER === "local" ? EMBED_DIM_LOCAL : KNOWN_DIMS[EMBEDDING_MODEL] ?? 0;
}

export function modelName(): string {
  return EMBEDDING_PROVIDER === "local" ? "local-hash-1024" : EMBEDDING_MODEL;
}

/**
 * What the vector leg actually measures, reported honestly.
 *
 * `local` is a hashing embedder over character n-grams: it scores lexical and
 * sub-word overlap, not meaning. A query and a document that use entirely
 * different words for the same idea score near zero, no matter how well written
 * either is. `transformers` produces true semantic vectors.
 *
 * Callers should not describe the `local` vector leg as "semantic"; the hybrid
 * score is dominated by the FTS leg in that configuration, and an agent that
 * believes otherwise will trust synonym-blind recall that is not there.
 */
export function vectorLegKind(): "lexical" | "semantic" {
  return EMBEDDING_PROVIDER === "local" ? "lexical" : "semantic";
}

export function vectorLegNote(): string {
  return EMBEDDING_PROVIDER === "local"
    ? "Local hashing embedder: the vector leg scores lexical/sub-word overlap, not meaning. " +
      "Synonym-only queries depend on the FTS5 trigram leg. Set EMBEDDING_PROVIDER=transformers " +
      "(npm i @huggingface/transformers) then run 'rag_reindex' for true semantic recall."
    : `Semantic embeddings from ${EMBEDDING_MODEL}; the vector leg captures meaning, not just overlap.`;
}

export function embeddingInfo(): {
  provider: EmbeddingProvider;
  dim: number;
  model: string;
  vectorLeg: "lexical" | "semantic";
  note: string;
} {
  return {
    provider: EMBEDDING_PROVIDER,
    dim: getEmbedDim() || expectedDim() || EMBED_DIM_LOCAL,
    model: modelName(),
    vectorLeg: vectorLegKind(),
    note: vectorLegNote(),
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let extractorPromise: Promise<any> | null = null;

async function getExtractor(): Promise<any> {
  if (!extractorPromise) {
    // A failed model load must not be cached for the process lifetime: reset on
    // rejection so a transient network/first-download error can be retried.
    extractorPromise = (async () => {
      // @ts-expect-error — @huggingface/transformers is an optional dependency
      const mod = await import("@huggingface/transformers");
      const { pipeline } = mod as { pipeline?: (task: string, model: string, opts?: Record<string, unknown>) => Promise<any> };
      if (typeof pipeline !== "function") {
        throw new Error("@huggingface/transformers did not expose a pipeline() function");
      }
      return pipeline("feature-extraction", EMBEDDING_MODEL, { quantized: true });
    })();
    extractorPromise.catch(() => {
      extractorPromise = null;
    });
  }
  return extractorPromise;
}

/** Embed text into a normalized Float64Array. Async for provider parity. */
export async function embedText(text: string): Promise<Float64Array> {
  const vec = await embedRaw(text);
  ensureDim(vec, modelName());
  return vec;
}

/**
 * Embed without the store-dimension guard.
 *
 * `reindex` is the one operation whose entire purpose is to *replace* the stored
 * vector space, so requiring the new vectors to already match the old ones would
 * make the migration impossible to express. Every other caller must use
 * `embedText`, which enforces the guard.
 */
export async function embedTextUnguarded(text: string): Promise<Float64Array> {
  return embedRaw(text);
}

/** Provider call plus the finite-value check, shared by both entry points. */
async function embedRaw(text: string): Promise<Float64Array> {
  if (EMBEDDING_PROVIDER === "local") {
    return embed(text);
  }
  const extractor = await getExtractor();
  const out = await extractor(text, { pooling: "mean", normalize: true });
  const data = out?.data ?? (Array.isArray(out) ? out[0]?.data : undefined);
  if (!data || typeof data.length !== "number") {
    throw new Error("transformers embed returned an unexpected shape");
  }
  const vec = Float64Array.from(data as ArrayLike<number>);
  // A NaN/Inf from the model poisons every score it touches: dot products become
  // NaN, comparisons go false, and the row silently stops matching anything —
  // an invisible, permanent retrieval hole. Reject it at the boundary instead.
  for (let i = 0; i < vec.length; i++) {
    if (!Number.isFinite(vec[i])) {
      throw new Error(
        `Embedding for this input contains a non-finite value at index ${i}. ` +
          `The input is likely empty or degenerate; retry with more text or set EMBEDDING_PROVIDER=local.`
      );
    }
  }
  return vec;
}