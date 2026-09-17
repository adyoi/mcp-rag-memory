#!/usr/bin/env node
/**
 * CLI for the RAG + Context Management engine.
 *
 * Usage:  npm run cli -- <command> [args]
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
 */
import { ingestText, ingestFile, ingestDirectory, searchDocs, retrieve, listDocuments, deleteDocument, documentStats } from "./rag/pipeline.js";
import { remember, recall, listMemories, getMemory, updateMemory, forget, consolidate, memoryStats, contextPrompt, MEMORY_TYPES } from "./memory/memory.js";
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
  return `Commands: ingest-text|ingest-file|ingest-dir|search|retrieve|docs|doc-stats|rm-doc|remember|recall|memory-list|memory-get|memory-update|forget|consolidate|memory-stats|mem-context|stats`;
}

function assertMemoryType(type: string): asserts type is (typeof MEMORY_TYPES)[number] {
  if (!MEMORY_TYPES.includes(type as (typeof MEMORY_TYPES)[number])) {
    throw new Error(`Invalid memory type "${type}". Valid: ${MEMORY_TYPES.join(", ")}`);
  }
}

async function run(cmd: string, args: string[]) {
  let out: unknown;
  try {
    switch (cmd) {
      case "ingest-text": {
        const [title, fileOrDash] = args;
        const content = fileOrDash === "-" ? fs.readFileSync(0, "utf-8") : fs.readFileSync(fileOrDash, "utf-8");
        out = await ingestText(content, title ?? fileOrDash ?? "untitled");
        break;
      }
      case "ingest-file":
        out = await ingestFile(args[0]);
        break;
      case "ingest-dir":
        out = await ingestDirectory(args[0], { recursive: true });
        break;
      case "search":
        out = await searchDocs(args.join(" "));
        break;
      case "retrieve":
        out = await retrieve(args.join(" "));
        break;
      case "docs":
        out = listDocuments();
        break;
      case "doc-stats":
        out = documentStats();
        break;
      case "rm-doc":
        out = deleteDocument(args[0]);
        break;
      case "remember": {
        const parsed = parseOpts(args);
        const type = parsed.opts.type ?? "fact";
        assertMemoryType(type);
        out = await remember({
          content: parsed.positional.join(" "),
          type,
          importance: parsed.opts.importance !== undefined ? Number(parsed.opts.importance) : 0.5,
          tags: parsed.opts.tag ? [parsed.opts.tag] : undefined,
        });
        break;
      }
      case "recall":
        out = await recall(args.join(" "));
        break;
      case "memory-list": {
        const parsed = parseOpts(args);
        out = listMemories({
          type: parsed.opts.type as never,
          tag: parsed.opts.tag as string,
          minImportance: parsed.opts["min-importance"] !== undefined ? Number(parsed.opts["min-importance"]) : undefined,
        });
        break;
      }
      case "memory-get":
        out = getMemory(args[0]);
        break;
      case "memory-update": {
        const [id, ...restArgs] = args;
        const parsed = parseOpts(restArgs);
        const type = parsed.opts.type ?? "fact";
        assertMemoryType(type);
        out = await updateMemory(id, {
          content: parsed.opts.content && parsed.opts.content !== "true"
            ? parsed.opts.content
            : parsed.positional.length
              ? parsed.positional.join(" ")
              : undefined,
          importance: parsed.opts.importance !== undefined ? Number(parsed.opts.importance) : undefined,
          type,
          tags: parsed.opts.tag ? [parsed.opts.tag] : undefined,
        });
        break;
      }
      case "forget":
        out = forget(args[0]);
        break;
      case "consolidate":
        out = await consolidate();
        break;
      case "memory-stats":
        out = memoryStats();
        break;
      case "mem-context":
        out = await contextPrompt(args.join(" "));
        break;
      case "stats":
        out = { documents: documentStats(), memories: memoryStats(), dbDir: STORAGE_DIR };
        break;
      default:
        console.error(`Unknown command: ${cmd}`);
        console.error(helpText());
        process.exit(1);
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
  console.log(JSON.stringify(out, null, 2));
}

function parseOpts(args: string[]): { positional: string[]; opts: Record<string, string> } {
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = "true";
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, opts };
}

main().catch((e) => {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
});