/**
 * Local hashing embedder — no external API, no native deps.
 *
 * Produces a normalized 1024-dimensional vector using the hashing trick:
 * - Tokenize text into character 1/2/3-grams (robust for CJK + Latin mixed text)
 *   plus whole words for ASCII runs.
 * - Map each feature to a bucket via FNV-1a, with a deterministic sign.
 * - Value per bucket = sqrt(feature count) * sign, then L2-normalized.
 *
 * Deterministic across processes and platforms.
 */

export const EMBED_DIM = 1024;

function fnv1a(str: string, seed = 2166136261): number {
  let hash = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function* charNgrams(text: string, n: number): Generator<string> {
  for (let i = 0; i <= text.length - n; i++) {
    yield text.slice(i, i + n);
  }
}

function* tokenize(text: string): Generator<string> {
  const lowered = text.toLowerCase();

  // Whole words for latin/digit runs
  const words = lowered.match(/[a-z0-9_]+/g);
  if (words) for (const w of words) if (w.length >= 2) yield w;

  // Character bigrams + trigrams cover CJK and subword info
  for (const g of charNgrams(lowered, 2)) yield "g2:" + g;
  for (const g of charNgrams(lowered, 3)) yield "g3:" + g;

  // Single CJK characters carry meaning on their own — include the
  // most informative punctuation-safe ones.
  for (const ch of lowered) {
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(ch)) yield "cjk:" + ch;
  }
}

function hashToBucket(feature: string): { bucket: number; sign: number } {
  const h = fnv1a(feature);
  return { bucket: h % EMBED_DIM, sign: h & 1 ? 1 : -1 };
}

/** Embed text into a normalized Float64Array of EMBED_DIM. */
export function embed(text: string): Float64Array {
  const vec = new Float64Array(EMBED_DIM);
  const counts = new Map<number, number>();

  for (const feature of tokenize(text)) {
    const { bucket, sign } = hashToBucket(feature);
    counts.set(bucket, (counts.get(bucket) ?? 0) + sign);
  }

  for (const [bucket, count] of counts) {
    // Signed sqrt preserves direction, damps extreme values
    vec[bucket] = Math.sign(count) * Math.sqrt(Math.abs(count));
  }

  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < EMBED_DIM; i++) vec[i] /= norm;

  return vec;
}

/** Dot product of two same-length vectors. For pre-normalized vectors this equals cosine similarity. */
export function dotProduct(a: Float64Array, b: Float64Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/** Cosine similarity between two normalized vectors. Returns 0 for degenerate inputs. */
export function cosineSimilarity(a: Float64Array, b: Float64Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}