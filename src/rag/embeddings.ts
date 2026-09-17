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

export function embeddingInfo(): { provider: EmbeddingProvider; dim: number; model: string } {
  return {
    provider: EMBEDDING_PROVIDER,
    dim: getEmbedDim() || expectedDim() || EMBED_DIM_LOCAL,
    model: modelName(),
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let extractorPromise: Promise<any> | null = null;

async function getExtractor(): Promise<any> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      // @ts-expect-error — @huggingface/transformers is an optional dependency
      const mod = await import("@huggingface/transformers");
      const { pipeline } = mod as { pipeline?: (task: string, model: string, opts?: Record<string, unknown>) => Promise<any> };
      if (typeof pipeline !== "function") {
        throw new Error("@huggingface/transformers did not expose a pipeline() function");
      }
      return pipeline("feature-extraction", EMBEDDING_MODEL, { quantized: true });
    })();
  }
  return extractorPromise;
}

/** Embed text into a normalized Float64Array. Async for provider parity. */
export async function embedText(text: string): Promise<Float64Array> {
  if (EMBEDDING_PROVIDER === "local") {
    const vec = embed(text);
    ensureDim(vec, modelName());
    return vec;
  }
  const extractor = await getExtractor();
  const out = await extractor(text, { pooling: "mean", normalize: true });
  const data = out?.data ?? (Array.isArray(out) ? out[0]?.data : undefined);
  if (!data || typeof data.length !== "number") {
    throw new Error("transformers embed returned an unexpected shape");
  }
  const vec = Float64Array.from(data as ArrayLike<number>);
  ensureDim(vec, modelName());
  return vec;
}