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
 *   memory-update <id> [--content ...] [--importance 0.8]
 *   forget       <id>
 *   consolidate
 *   memory-stats
 *   mem-context  <topic>
 *   stats                                       Everything
 */
import { ingestText, ingestFile, ingestDirectory, searchDocs, retrieve, listDocuments, deleteDocument, documentStats } from "./rag/pipeline.js";
import { remember, recall, listMemories, getMemory, updateMemory, forget, consolidate, memoryStats, contextPrompt } from "./memory/memory.js";
import { closeDB, STORAGE_DIR } from "./db/database.js";
import * as fs from "fs";

function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd) {
    console.error("Logging with npm run cli -- <command> ...");
    console.error(helpText());
    process.exit(1);
  }
  run(cmd, rest);
}

function helpText(): string {
  return `Commands: ingest-text|ingest-file|ingest-dir|search|retrieve|docs|doc-stats|rm-doc|remember|recall|memory-list|memory-get|memory-update|forget|consolidate|memory-stats|mem-context|stats`;
}

function run(cmd: string, args: string[]) {
  let out: unknown;
  try {
    switch (cmd) {
      case "ingest-text": {
        const [title, fileOrDash] = args;
        const content = fileOrDash === "-" ? fs.readFileSync(0, "utf-8") : fs.readFileSync(fileOrDash, "utf-8");
        out = ingestText(content, title ?? fileOrDash ?? "untitled");
        break;
      }
      case "ingest-file":
        out = ingestFile(args[0]);
        break;
      case "ingest-dir":
        out = ingestDirectory(args[0], { recursive: true });
        break;
      case "search":
        out = searchDocs(args.join(" "));
        break;
      case "retrieve":
        out = retrieve(args.join(" "));
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
        out = remember({
          content: parsed.positional.join(" "),
          type: (parsed.opts.type as never) ?? "fact",
          importance: parsed.opts.importance !== undefined ? Number(parsed.opts.importance) : 0.5,
          tags: parsed.opts.tag ? [parsed.opts.tag] : undefined,
        });
        break;
      }
      case "recall":
        out = recall(args.join(" "));
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
        out = updateMemory(id, {
          content: parsed.positional.length ? parsed.positional.join(" ") : undefined,
          importance: parsed.opts.importance !== undefined ? Number(parsed.opts.importance) : undefined,
          type: parsed.opts.type as never,
        });
        break;
      }
      case "forget":
        out = forget(args[0]);
        break;
      case "consolidate":
        out = consolidate();
        break;
      case "memory-stats":
        out = memoryStats();
        break;
      case "mem-context":
        out = contextPrompt(args.join(" "));
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
  closeDB();
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

main();