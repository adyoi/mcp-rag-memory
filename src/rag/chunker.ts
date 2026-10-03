/**
 * Smart text chunking with paragraph / code-block awareness and overlap.
 */

export interface Chunk {
  text: string;
  index: number;
  tokenCount: number;
}

export interface ChunkOptions {
  maxChars?: number;
  overlapChars?: number;
}

const DEFAULT_MAX = 900;
const DEFAULT_OVERLAP = 120;

function isCodeLine(line: string): boolean {
  const t = line.trim();
  if (/^(```|---|\+\+\+|\{\{\{|<\/?(table|script|style|pre|code)>)/.test(t)) return true;
  if (/^[a-zA-Z_$][\w$]*\s*(\([^)]*\)\s*)?\{$/.test(t)) return true;
  if (/^(import|export|const|let|var|function|class|def|func|public|private|package|using|include)\b/.test(t)) return true;
  return false;
}

function splitIntoParagraphs(text: string): string[] {
  const blocks: string[] = [];
  let current = "";
  let inCode = false;

  for (const line of text.split(/\r?\n/)) {
    // Only real fences toggle code mode — `---` is a thematic break / front
    // matter delimiter, and one stray `---` used to swallow the whole document.
    const codeBoundary = /^\s*(```|~~~)/.test(line.trim());
    if (codeBoundary) inCode = !inCode;

    if (inCode || isCodeLine(line)) {
      current += line + "\n";
      continue;
    }

    if (line.trim() === "") {
      if (current.trim()) {
        blocks.push(current.trimEnd());
        current = "";
      }
      continue;
    }

    current += line + "\n";
  }

  if (current.trim()) blocks.push(current.trimEnd());
  return blocks.filter((b) => b.trim().length > 0);
}

/**
 * Sentence split that keeps decimals and version numbers intact
 * ("pip 24.0.1" stays one sentence) and keeps fenced code blocks whole,
 * because newlines are never treated as terminators.
 */
function splitIntoSentences(block: string): string[] {
  const out: string[] = [];
  const TERMINATORS = ".!?。！？";
  let start = 0;
  for (let i = 0; i < block.length; i++) {
    const ch = block[i];
    if (!TERMINATORS.includes(ch)) continue;
    // A period between two digits is a decimal point, not a sentence end.
    if (ch === "." && /\d/.test(block[i - 1] ?? "") && /\d/.test(block[i + 1] ?? "")) continue;
    let end = i + 1;
    while (end < block.length && /["')\]}»”]/.test(block[end])) end++;
    const piece = block.slice(start, end).trim();
    if (piece) out.push(piece);
    start = end;
    i = end - 1;
  }
  const tail = block.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * Trim an overlap tail so a chunk never starts with a partial word: when the cut
 * landed inside a word (last char before the cut and first char of the tail are
 * both word characters), the leading fragment is dropped.
 */
function snapToWordStart(tail: string, charBeforeCut: string): string {
  const at = tail.search(/\S/);
  const body = at <= 0 ? tail : tail.slice(at);
  if (!body) return body;
  const startsMidWord = /[\p{L}\p{N}_]/u.test(charBeforeCut) && /[\p{L}\p{N}_]/u.test(body[0]);
  if (!startsMidWord) return body;
  const space = body.search(/\s/);
  return space === -1 ? body : body.slice(space).trimStart();
}

/** Last whitespace break inside the budget, so a hard cut avoids mid-word cuts. */
function lastBreak(candidate: string, max: number): number {
  for (let i = Math.min(candidate.length, max) - 1; i > Math.floor(max * 0.6); i--) {
    if (/\s/.test(candidate[i])) return i + 1;
  }
  return max;
}

function splitLongText(text: string, max: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const candidate = rest.slice(0, max);
    const cut = Math.max(
      candidate.lastIndexOf(". "),
      candidate.lastIndexOf(".\n"),
      candidate.lastIndexOf("。"),
      candidate.lastIndexOf("\n"),
      candidate.lastIndexOf(", ")
    );
    const pos = cut > Math.floor(max * 0.6) ? cut + 1 : lastBreak(candidate, max);
    parts.push(rest.slice(0, pos).trim());
    rest = rest.slice(pos);
  }
  if (rest.trim()) parts.push(rest.trim());
  return parts;
}

/** Separator that never mangles code: newline if either side has one. */
function joiner(left: string, right: string): string {
  if (!left) return "";
  if (left.endsWith("\n") || right.startsWith("\n")) return "";
  return left.includes("\n") || right.includes("\n") ? "\n" : " ";
}

export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX;
  const overlapChars = options.overlapChars ?? DEFAULT_OVERLAP;
  if (!Number.isFinite(maxChars) || maxChars < 1) throw new RangeError("chunkText: maxChars must be >= 1");
  if (!Number.isFinite(overlapChars) || overlapChars < 0) throw new RangeError("chunkText: overlapChars must be >= 0");
  const chunks: Chunk[] = [];
  let cursor = 0;

  const emit = (content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    // Backstop for maxChars. The window is normally kept under budget, but
    // carry() (up to maxChars/2) plus a full-size piece could still land at
    // ~1.5x, and an over-budget chunk blows the embedder's context for no
    // benefit. Split rather than silently shipping an oversized chunk.
    if (trimmed.length > maxChars) {
      for (const part of splitLongText(trimmed, maxChars)) {
        const t = part.trim();
        if (!t) continue;
        chunks.push({ text: t, index: cursor++, tokenCount: estimateTokens(t) });
      }
      return;
    }
    chunks.push({
      text: trimmed,
      index: cursor++,
      tokenCount: estimateTokens(trimmed),
    });
  };

  const paragraphs = splitIntoParagraphs(text);
  const overlap = Math.min(overlapChars, Math.floor(maxChars / 2));
  /** The tail carried into the next chunk; "" when overlapChars is 0. */
  const carry = (emitted: string) =>
    overlap > 0 ? snapToWordStart(emitted.slice(-overlap), emitted.slice(-overlap - 1, -overlap)) : "";

  let window = "";
  for (const para of paragraphs) {
    let pieces: string[];
    if (para.length > maxChars) {
      pieces = splitLongText(para, maxChars);
    } else {
      const sents = splitIntoSentences(para);
      pieces = sents.length > 0 ? sents : [para];
    }

    for (const piece of pieces) {
      if (piece.length > maxChars) {
        // A single sentence longer than maxChars: hard-split it. The pending
        // window must be flushed first, otherwise the text collected so far is
        // emitted twice (once here, once with the next piece appended).
        const hards = splitLongText(piece, maxChars);
        if (window) {
          emit(window);
          window = carry(window);
        }
        for (const hard of hards) {
          const projectedHard = window.length + joiner(window, hard).length + hard.length;
          if (window && projectedHard > maxChars) {
            emit(window);
            window = carry(window);
          }
          window += joiner(window, hard) + hard;
        }
        continue;
      }
      const projected = window.length + joiner(window, piece).length + piece.length;
      if (window && projected > maxChars) {
        emit(window);
        // Overlap carries the tail of the previous chunk. overlap === 0 must
        // reset the window: slice(-0) returns the whole string, which used to
        // duplicate the previous chunk and grow it without bound.
        window = carry(window);
      }
      window += joiner(window, piece) + piece;
    }
  }

  if (window.trim()) emit(window);

  return chunks;
}

/** Rough token estimate: ~4 chars per token for latin, ~1.5 for CJK. */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk * 1.5) + Math.ceil(rest / 4);
}

/**
 * Same estimate for an already-known character count. Lets a caller total
 * LENGTH() across many rows in SQL instead of materialising each content
 * blob just to re-count its characters. Assumes no CJK in the total, which
 * under-counts CJK-heavy stores — the same tradeoff the SQL path already made.
 */
export function estimateTokensFromChars(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / 4);
}