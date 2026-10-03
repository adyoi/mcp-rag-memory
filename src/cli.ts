#!/usr/bin/env node
/**
 * CLI for the RAG + Context Management engine.
 *
 * Usage:  npm run cli -- <command> [args]
 *         npx mcp-rag-memory-cli <command> [args]
 *
 * Commands:
 *   ingest-text  <title> <file|->              Ingest text (from file or stdin)
 *   ingest-file  <path>                        Ingest a single file
 *   ingest-dir   <dir>                         Ingest a directory
 *   search       <query>                       Semantic search over documents
 *   retrieve     <query>                       Retrieve context block
 *   docs                                      List documents
 *   doc-stats                                 Document stats
 *   rm-doc       <doc_id>                      Delete a document
 *   remember     <content> [--type fact] [--importance 0.5] [--tag x]
 *   recall       <query>
 *   memory-list  [--type fact] [--tag x]
 *   memory-get   <id>
 *   memory-update <id> [--content ...] [--importance 0.8] [--type fact] [--tag x]
 *   forget       <id>
 *   consolidate
 *   memory-stats
 *   mem-context  <topic>
 *   stats                                       Everything
 *   reindex    [--batch N]                      Re-embed all vectors for the current model
 *   sessions                                    List opencode sessions (recent first)
 *   sync-session <sessionId> [--limit N]        Ingest a session's user inputs to RAG
 *   sync-latest   [--limit N] [--dir PATH]      Ingest the most recent session (workspace-aware)
 *   sync-logs    [dir]                          Ingest .session-logs/*.jsonl to RAG
 *   ingest-jsonl <file>                         Ingest one jsonl log file
 */
import "./env.js";
import { ingestText, ingestFile, ingestDirectory, searchDocs, retrieve, listDocuments, deleteDocument, documentStats } from "./rag/pipeline.js";
import { remember, recall, listMemories, getMemory, updateMemory, forget, consolidate, memoryStats, contextPrompt, MEMORY_TYPES } from "./memory/memory.js";
import { ingestSession, ingestJsonlFile, ingestLogDir, ingestLatest, listOpenCodeSessions } from "./session/transcript.js";
import { reindex } from "./rag/reindex.js";
import { closeDB, STORAGE_DIR } from "./db/database.js";
import * as fs from "fs";

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd) {
    console.error("Usage: npm run cli -- <command> ...");
    console.error(helpText());
    process.exit(1);
  }
  await run(cmd, rest);
  closeDB();
}

function helpText(): string {
  return `Commands: ingest-text|ingest-file|ingest-dir|search|retrieve|docs|doc-stats|rm-doc|remember|recall|memory-list|memory-get|memory-update|forget|consolidate|memory-stats|mem-context|stats|reindex|sessions|sync-session|sync-latest|sync-logs|ingest-jsonl`;
}

function assertMemoryType(type: string): asserts type is (typeof MEMORY_TYPES)[number] {
  if (!MEMORY_TYPES.includes(type as (typeof MEMORY_TYPES)[number])) {
    throw new Error(`Invalid memory type "${type}". Valid: ${MEMORY_TYPES.join(", ")}`);
  }
}

function requireArg(value: string | undefined, usage: string): string {
  if (!value || value.startsWith("--")) throw new Error(`Missing argument — usage: ${usage}`);
  return value;
}

async function run(cmd: string, args: string[]) {
  let out: unknown;
  try {
    switch (cmd) {
      case "ingest-text": {
        const parsed = parseOpts(args);
        const [title, fileOrDash] = parsed.positional;
        if (!title || !fileOrDash) throw new Error("Missing argument — usage: ingest-text <title> <file|->");
        const content = fileOrDash === "-" ? fs.readFileSync(0, "utf-8") : fs.readFileSync(fileOrDash, "utf-8");
        out = await ingestText(content, title);
        break;
      }
      case "ingest-file":
        out = await ingestFile(requireArg(args[0], "ingest-file <path>"));
        break;
      case "ingest-dir":
        out = await ingestDirectory(requireArg(args[0], "ingest-dir <dir>"), { recursive: true });
        break;
      case "search": {
        const parsed = parseOpts(args);
        out = await searchDocs(
          queryArg(parsed.positional),
          toNum(parsed.opts["top-k"], 10),
          toNum(parsed.opts["min-score"], 0.08),
          {
            docId: parsed.opts["doc-id"],
            source: parsed.opts.source,
          },
          parsed.opts.explain !== undefined
        );
        break;
      }
      case "retrieve": {
        const parsed = parseOpts(args);
        out = await retrieve(queryArg(parsed.positional), toNum(parsed.opts["top-k"], 6), toNum(parsed.opts["min-score"], 0.08), {
          docId: parsed.opts["doc-id"],
          source: parsed.opts.source,
        });
        break;
      }
      case "docs": {
        const parsed = parseOpts(args);
        out = listDocuments({ limit: toNum(parsed.opts.limit, undefined), offset: toNum(parsed.opts.offset, undefined) });
        break;
      }
      case "doc-stats":
        out = documentStats();
        break;
      case "rm-doc":
        out = deleteDocument(requireArg(args[0], "rm-doc <doc_id>"));
        break;
      case "remember": {
        const parsed = parseOpts(args);
        const content = parsed.positional.join(" ");
        if (!content) throw new Error("Missing argument — usage: remember <content> [--type fact] [--importance 0.5] [--tag x]");
        const type = parsed.opts.type ?? "fact";
        assertMemoryType(type);
        out = await remember({
          content,
          type,
          importance: toNum(parsed.opts.importance, 0.5),
          tags: parsed.opts.tag ? [parsed.opts.tag] : undefined,
        });
        break;
      }
      case "recall": {
        const parsed = parseOpts(args);
        out = await recall(queryArg(parsed.positional), toNum(parsed.opts["top-k"], 8), toNum(parsed.opts["min-score"], 0.1));
        break;
      }
      case "memory-list": {
        const parsed = parseOpts(args);
        const type = parsed.opts.type;
        if (type !== undefined) assertMemoryType(type);
        out = listMemories({
          type,
          tag: parsed.opts.tag,
          minImportance: toNum(parsed.opts["min-importance"], undefined),
          limit: toNum(parsed.opts.limit, undefined),
        });
        break;
      }
      case "memory-get":
        out = getMemory(requireArg(args[0], "memory-get <id>"));
        break;
      case "memory-update": {
        const [id, ...restArgs] = args;
        const parsed = parseOpts(restArgs);
        if (!id) throw new Error("Missing argument — usage: memory-update <id> [--content ...] [--importance 0.8] [--type fact] [--tag x]");
        const type = parsed.opts.type;
        if (type !== undefined) assertMemoryType(type);
        // --content=... (or --content <text>) sets the body; leftover positional
        // words are the body too. The old `!== "true"` check silently discarded
        // any content that was literally the word "true".
        const content = parsed.opts.content ?? (parsed.positional.length ? parsed.positional.join(" ") : undefined);
        if (content === undefined && type === undefined && parsed.opts.importance === undefined && parsed.opts.tag === undefined) {
          throw new Error("Nothing to update — pass --content, --type, --importance and/or --tag");
        }
        out = await updateMemory(id, {
          content,
          importance: toNum(parsed.opts.importance, undefined),
          type,
          tags: parsed.opts.tag ? [parsed.opts.tag] : undefined,
        });
        break;
      }
      case "forget":
        out = forget(requireArg(args[0], "forget <id>"));
        break;
      case "consolidate":
        out = await consolidate();
        break;
      case "memory-stats":
        out = memoryStats();
        break;
      case "mem-context": {
        const parsed = parseOpts(args);
        out = await contextPrompt(queryArg(parsed.positional), toNum(parsed.opts["top-k"], 6));
        break;
      }
      case "stats":
        out = { documents: documentStats(), memories: memoryStats(), dbDir: STORAGE_DIR };
        break;
      case "reindex": {
        const parsed = parseOpts(args);
        out = await reindex({
          batchSize: toNum(parsed.opts.batch, undefined),
          onProgress: (p) => {
            if (p.total > 0) {
              process.stderr.write(`reindex ${p.phase}: ${p.done}/${p.total}\r`);
            }
          },
        });
        process.stderr.write("\n");
        break;
      }
      case "sessions": {
        const parsed = parseOpts(args);
        out = listOpenCodeSessions(toNum(parsed.opts.limit, 15) ?? 15, { directory: parsed.opts.dir });
        break;
      }
      case "sync-session": {
        const [id, ...restArgs] = args;
        const parsed = parseOpts(restArgs);
        if (!id) throw new Error("sync-session <sessionId> — run 'cli sessions' to list ids");
        out = await ingestSession(id, { limit: toNum(parsed.opts.limit, 0) ?? 0 });
        break;
      }
      case "sync-latest": {
        const parsed = parseOpts(args);
        out = await ingestLatest({
          limit: toNum(parsed.opts.limit, 0) ?? 0,
          directory: parsed.opts.dir ?? parsed.positional[0],
        });
        break;
      }
      case "sync-logs": {
        const parsed = parseOpts(args);
        out = await ingestLogDir(parsed.positional[0] ?? ".session-logs");
        break;
      }
      case "ingest-jsonl":
        out = await ingestJsonlFile(requireArg(args[0], "ingest-jsonl <file>"));
        break;
      default:
        console.error(`Unknown command: ${cmd}`);
        console.error(helpText());
        process.exit(1);
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    closeDB();
    process.exit(1);
  }
  console.log(JSON.stringify(out, null, 2));
}

/** Query text from positional words — empty input is an error, not a silent []. */
function queryArg(positional: string[]): string {
  const q = positional.join(" ").trim();
  if (!q) throw new Error("Missing query — usage: <command> <query>");
  return q;
}

function parseOpts(args: string[]): { positional: string[]; opts: Record<string, string> } {
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        // --key=value: the value may legitimately start with "--".
        opts[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        opts[key] = next;
        i++;
      } else {
        // Boolean flag. Previously the literal "true" was stored as the value,
        // which then leaked into --content and --dir.
        opts[key] = "true";
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, opts };
}

/** Parse a numeric CLI option; falls back to `fallback` for missing/garbage input. */
function toNum(raw: string | undefined, fallback: number | undefined): number | undefined {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

main().catch((e) => {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
});