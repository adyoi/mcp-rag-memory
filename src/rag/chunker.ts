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
    const codeBoundary = /^\s*(```|~~~|---)/.test(line.trim());
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

function splitIntoSentences(block: string): string[] {
  const sentences = block.match(/[^.!?。！？\n]+[.!?。！？]?/g) ?? [];
  return sentences.map((s) => s.trim()).filter((s) => s.length > 0);
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
    const pos = cut > Math.floor(max * 0.6) ? cut + 1 : max;
    parts.push(rest.slice(0, pos).trim());
    rest = rest.slice(pos);
  }
  if (rest.trim()) parts.push(rest.trim());
  return parts;
}

export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX;
  const overlapChars = options.overlapChars ?? DEFAULT_OVERLAP;
  const chunks: Chunk[] = [];
  let cursor = 0;

  const emit = (content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    chunks.push({
      text: trimmed,
      index: cursor++,
      tokenCount: estimateTokens(trimmed),
    });
  };

  const paragraphs = splitIntoParagraphs(text);

  let window = "";
  for (const para of paragraphs) {
    let pieces: string[] = [];
    if (para.length > maxChars) {
      pieces = splitLongText(para, maxChars);
    } else {
      const sents = splitIntoSentences(para);
      pieces = sents.length > 0 ? sents : [para];
    }

    for (const piece of pieces) {
      if (piece.length > maxChars) {
        // Rare pathological case: keep as-is, hard split.
        for (const hard of splitLongText(piece, maxChars)) emit(hard);
        continue;
      }
      if (window.length + piece.length + 1 > maxChars && window.length >= overlapChars) {
        emit(window);
        window = window.slice(-overlapChars);
      }
      window += (window ? " " : "") + piece;
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