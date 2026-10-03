#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as path from "path";
import { createRequire } from "node:module";
import { STORAGE_DIR, closeDB, getEmbedState } from "../db/database.js";
import { embeddingInfo } from "../rag/embeddings.js";
import { reindex } from "../rag/reindex.js";
import {
  ingestText,
  ingestFile,
  ingestDirectory,
  searchDocs,
  retrieve,
  listDocuments,
  deleteDocument,
  documentStats,
  MAX_INGEST_CHARS,
} from "../rag/pipeline.js";
import {
  ingestSession as syncSession,
  ingestLatest as syncLatest,
} from "../session/transcript.js";
import {
  remember,
  recall,
  listMemories,
  getMemory,
  updateMemory,
  forget,
  consolidate,
  memoryStats,
  contextPrompt,
  MEMORY_TYPES,
} from "../memory/memory.js";
import type { MemoryType } from "../memory/memory.js";

const require = createRequire(import.meta.url);
const serverVersion = require("../../package.json").version as string;

/**
 * Input bounds for every tool schema.
 *
 * These were all unbounded `z.string().min(1)`, which meant a single tool call
 * could push a megabyte of text straight into the chunker and embedder (a
 * synchronous CPU spin that blocks the whole stdio server), or a path long
 * enough to be a denial of service. The caps sit above any realistic input and
 * well below anything that would stall the process.
 */
const MAX_ID = 200;
const MAX_QUERY = 2_000;
const MAX_PATH = 4_096;
const MAX_TITLE = 500;
const MAX_TAG = 64;
const MAX_TAGS = 64;
const MAX_TOPIC = 500;
/** A memory is a self-contained statement, not a document. */
const MAX_MEMORY_CONTENT = 20_000;

const server = new McpServer({
  name: "rag-memory-server",
  version: serverVersion,
});

/* ------------------------------------------------------------------ */
/* System                                                              */
/* ------------------------------------------------------------------ */

server.registerTool(
  "system_stats",
  {
    description: "Get overall system stats: DB location, documents, chunks, memories, tokens, embedding backend",
    inputSchema: {},
  },
  async () => {
    const docs = documentStats();
    const mem = memoryStats();
    // Surface the embed_state too: a store stuck mid-reindex refuses every search,
    // and system_stats is the first thing anyone calls when a tool starts failing.
    const state = getEmbedState();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              dbDir: STORAGE_DIR,
              embedding: embeddingInfo(),
              storeState: state === "" || state === "ready" ? "ready" : state,
              ...(state !== "" && state !== "ready"
                ? { remediation: "Run 'rag_reindex' to finish the interrupted migration." }
                : {}),
              documents: docs,
              memories: mem,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

/* ------------------------------------------------------------------ */
/* Maintenance                                                         */
/* ------------------------------------------------------------------ */

server.registerTool(
  "rag_reindex",
  {
    description:
      "Re-embed every stored vector for the currently configured EMBEDDING_PROVIDER/MODEL. " +
      "Use after changing the embedding model or dimension to migrate the existing store in place " +
      "instead of wiping and re-ingesting. Searches are blocked while it runs; re-run to resume " +
      "after an interruption.",
    inputSchema: {
      batch_size: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(32)
        .describe("Chunks embedded per transaction. Lower uses less memory, higher is faster."),
    },
  },
  async (args: { batch_size?: number }) => {
    const res = await reindex({
      batchSize: args.batch_size ?? 32,
      onProgress: (p) => {
        if (p.total > 0) process.stderr.write(`reindex ${p.phase}: ${p.done}/${p.total}\n`);
      },
    });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  }
);

/* ------------------------------------------------------------------ */
/* RAG: ingest                                                         */
/* ------------------------------------------------------------------ */

server.registerTool(
  "rag_ingest_text",
  {
    description: "Store raw text as a knowledge document (chunked + embedded for later retrieval)",
    inputSchema: {
      content: z.string().min(1).max(MAX_INGEST_CHARS),
      title: z.string().max(MAX_TITLE).describe("Document title"),
      contentType: z.string().max(64).optional().describe("e.g. markdown, typescript, text, json"),
      metadata: z.record(z.string().max(MAX_TAG), z.unknown()).optional(),
    },
  },
  async (args: { content: string; title: string; contentType?: string; metadata?: Record<string, unknown> }) => {
    const res = await ingestText(args.content, args.title, {
      contentType: args.contentType,
      metadata: args.metadata,
    });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  }
);

server.registerTool(
  "rag_ingest_file",
  {
    description: "Read a file and store it as a knowledge document. Honours RAG_ALLOWED_DIRS when set.",
    inputSchema: {
      path: z.string().min(1).max(MAX_PATH).describe("Absolute path to the file"),
      metadata: z.record(z.string().max(MAX_TAG), z.unknown()).optional(),
    },
  },
  async (args: { path: string; metadata?: Record<string, unknown> }) => {
    const res = await ingestFile(args.path, { metadata: args.metadata });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  }
);

server.registerTool(
  "rag_ingest_dir",
  {
    description: "Recursively ingest supported source files from a directory",
    inputSchema: {
      path: z.string().min(1).max(MAX_PATH).describe("Absolute path to the directory"),
      recursive: z.boolean().optional().default(true),
      extensions: z.array(z.string().min(1).max(16)).min(1).max(64).optional().describe("File extensions to include, e.g. ['.ts', '.md']"),
    },
  },
  async (args: { path: string; recursive?: boolean; extensions?: string[] }) => {
    const res = await ingestDirectory(args.path, { recursive: args.recursive, extensions: args.extensions });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  }
);

/* ------------------------------------------------------------------ */
/* RAG: search / retrieve                                              */
/* ------------------------------------------------------------------ */

server.registerTool(
  "rag_search",
  {
    description: "Hybrid semantic + keyword search over stored documents. Returns chunks ranked by relevance with scores. Set explain to see per-leg scores (vector cosine, keyword BM25, RRF contribution) and diagnose ranking.",
    inputSchema: {
      query: z.string().min(1).max(MAX_QUERY),
      top_k: z.number().int().min(1).max(50).optional().default(10),
      min_score: z.number().min(0).max(1).optional().default(0.08),
      doc_id: z.string().max(MAX_ID).optional().describe("Only search within this document"),
      source: z.string().max(MAX_ID).optional().describe("Only search documents with this source (e.g. 'opencode-db', 'session-log')"),
      explain: z.boolean().optional().default(false).describe("Include per-leg vector/keyword/RRF scores on every hit"),
    },
  },
  async (args: { query: string; top_k?: number; min_score?: number; doc_id?: string; source?: string; explain?: boolean }) => {
    const hits = await searchDocs(
      args.query,
      args.top_k ?? 10,
      args.min_score ?? 0.08,
      {
        docId: args.doc_id,
        source: args.source,
      },
      args.explain ?? false
    );
    return {
      content: [{ type: "text", text: JSON.stringify(hits, null, 2) }],
    };
  }
);

server.registerTool(
  "rag_retrieve",
  {
    description:
      "Retrieve relevant context chunks as a ready-to-inject context block for the LLM. Prefer this over rag_search when the result will be used as context.",
    inputSchema: {
      query: z.string().min(1).max(MAX_QUERY),
      top_k: z.number().int().min(1).max(20).optional().default(6),
      min_score: z.number().min(0).max(1).optional().default(0.08),
      doc_id: z.string().max(MAX_ID).optional().describe("Only retrieve within this document"),
      source: z.string().max(MAX_ID).optional().describe("Only retrieve documents with this source"),
    },
  },
  async (args: { query: string; top_k?: number; min_score?: number; doc_id?: string; source?: string }) => {
    const res = await retrieve(args.query, args.top_k ?? 6, args.min_score ?? 0.08, {
      docId: args.doc_id,
      source: args.source,
    });
    if (res.chunks.length === 0) {
      return { content: [{ type: "text", text: "No relevant context found." }] };
    }
    const lines = res.chunks.map((c) => `--- [${c.docTitle}#${c.chunkIndex}] (score ${c.score.toFixed(3)}) ---\n${c.content}`);
    return {
      content: [
        {
          type: "text",
          text: `[Context block: ${res.chunks.length} chunks, ~${res.totalTokens} tokens]\n\n${lines.join("\n\n")}`,
        },
      ],
    };
  }
);

/* ------------------------------------------------------------------ */
/* RAG: document management                                            */
/* ------------------------------------------------------------------ */

server.registerTool(
  "rag_list_documents",
  {
    description: "List stored knowledge documents (newest first, paginated)",
    inputSchema: {
      limit: z.number().int().min(1).max(1000).optional().default(100).describe("Max documents to return"),
      offset: z.number().int().min(0).optional().default(0).describe("Skip this many documents"),
    },
  },
  async (args: { limit?: number; offset?: number }) => {
    const docs = listDocuments({ limit: args.limit, offset: args.offset });
    return { content: [{ type: "text", text: JSON.stringify(docs, null, 2) }] };
  }
);

server.registerTool(
  "rag_document_stats",
  {
    description: "Document storage statistics",
    inputSchema: {},
  },
  async () => {
    return { content: [{ type: "text", text: JSON.stringify(documentStats(), null, 2) }] };
  }
);

server.registerTool(
  "rag_delete_document",
  {
    description: "Delete a document and all its chunks by ID",
    inputSchema: {
      doc_id: z.string().min(1).max(MAX_ID),
    },
  },
  async (args: { doc_id: string }) => {
    const res = deleteDocument(args.doc_id);
    return { content: [{ type: "text", text: JSON.stringify(res) }] };
  }
);

/* ------------------------------------------------------------------ */
/* Context Management: memory                                          */
/* ------------------------------------------------------------------ */

server.registerTool(
  "rag_sync_session",
  {
    description:
      "Ingest an opencode session's user inputs (or the latest active session) into the RAG store as searchable documents. Use with the session id from opencode, or omit session_id and pass directory to auto-pick the most recent session in that workspace.",
    inputSchema: {
      session_id: z.string().min(1).max(MAX_ID).optional().describe("opencode session id; omit to use the latest active session"),
      directory: z.string().min(1).max(MAX_PATH).optional().describe("Workspace path used to pick the latest session when session_id is omitted (defaults to the server's working directory)"),
      limit: z.number().int().min(1).max(2000).optional().describe("Only ingest the first N user messages"),
    },
  },
  async (args: { session_id?: string; directory?: string; limit?: number }) => {
    const res = args.session_id
      ? await syncSession(args.session_id, { limit: args.limit })
      : await syncLatest({ limit: args.limit, directory: args.directory ?? process.cwd() });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  }
);

server.registerTool(
  "memory_remember",
  {
    description:
      "Store a piece of long-term memory (fact, decision, preference, instruction, task, insight, conversation). Use this to persist things that should be remembered across sessions.",
    inputSchema: {
      content: z.string().min(1).max(MAX_MEMORY_CONTENT).describe("The memory content, written as a self-contained statement"),
      type: z.enum(MEMORY_TYPES).optional().default("fact"),
      importance: z.number().min(0).max(1).optional().default(0.5).describe("0..1, higher = keep longer"),
      tags: z.array(z.string().max(MAX_TAG)).max(MAX_TAGS).optional().describe("Tags for filtering"),
    },
  },
  async (args: { content: string; type?: MemoryType; importance?: number; tags?: string[] }) => {
    const rec = await remember({
      content: args.content,
      type: args.type,
      importance: args.importance,
      tags: args.tags,
    });
    return { content: [{ type: "text", text: JSON.stringify(rec, null, 2) }] };
  }
);

server.registerTool(
  "memory_recall",
  {
    description: "Semantically search long-term memories relevant to a query. This is how you remember past context.",
    inputSchema: {
      query: z.string().min(1).max(MAX_QUERY),
      top_k: z.number().int().min(1).max(30).optional().default(8),
      min_score: z.number().min(0).max(1).optional().default(0.1),
    },
  },
  async (args: { query: string; top_k?: number; min_score?: number }) => {
    const hits = await recall(args.query, args.top_k ?? 8, args.min_score ?? 0.1);
    return { content: [{ type: "text", text: JSON.stringify(hits, null, 2) }] };
  }
);

server.registerTool(
  "memory_list",
  {
    description: "List memories, optionally filtered by type, tag, or minimum importance",
    inputSchema: {
      type: z.enum(MEMORY_TYPES).optional(),
      tag: z.string().max(MAX_TAG).optional(),
      min_importance: z.number().min(0).max(1).optional(),
      limit: z.number().int().min(1).max(500).optional().default(100),
    },
  },
  async (args: { type?: MemoryType; tag?: string; min_importance?: number; limit?: number }) => {
    const recs = listMemories({
      type: args.type,
      tag: args.tag,
      minImportance: args.min_importance,
      limit: args.limit,
    });
    return { content: [{ type: "text", text: JSON.stringify(recs, null, 2) }] };
  }
);

server.registerTool(
  "memory_get",
  {
    description: "Get a single memory by ID",
    inputSchema: {
      id: z.string().min(1).max(MAX_ID),
    },
  },
  async (args: { id: string }) => {
    const rec = getMemory(args.id);
    if (!rec) return { content: [{ type: "text", text: `No memory found with id ${args.id}` }] };
    return { content: [{ type: "text", text: JSON.stringify(rec, null, 2) }] };
  }
);

server.registerTool(
  "memory_update",
  {
    description: "Update content / type / importance / tags of an existing memory",
    inputSchema: {
      id: z.string().min(1).max(MAX_ID),
      content: z.string().max(MAX_MEMORY_CONTENT).optional(),
      type: z.enum(MEMORY_TYPES).optional(),
      importance: z.number().min(0).max(1).optional(),
      tags: z.array(z.string().max(MAX_TAG)).max(MAX_TAGS).optional(),
    },
  },
  async (args: { id: string; content?: string; type?: MemoryType; importance?: number; tags?: string[] }) => {
    // An all-undefined patch used to re-embed the text and bump updated_at,
    // silently reordering the store.
    if (args.content === undefined && args.type === undefined && args.importance === undefined && args.tags === undefined) {
      return { content: [{ type: "text", text: "Nothing to update: provide content, type, importance and/or tags." }] };
    }
    const rec = await updateMemory(args.id, {
      content: args.content,
      type: args.type,
      importance: args.importance,
      tags: args.tags,
    });
    if (!rec) return { content: [{ type: "text", text: `No memory found with id ${args.id}` }] };
    return { content: [{ type: "text", text: JSON.stringify(rec, null, 2) }] };
  }
);

server.registerTool(
  "memory_forget",
  {
    description: "Delete a memory by ID",
    inputSchema: {
      id: z.string().min(1).max(MAX_ID),
    },
  },
  async (args: { id: string }) => {
    const res = forget(args.id);
    return { content: [{ type: "text", text: JSON.stringify(res) }] };
  }
);

server.registerTool(
  "memory_consolidate",
  {
    description: "Deduplicate near-identical memories, boost frequently-used ones, and optionally prune stale memories (enable with env RAG_PRUNE=1)",
    inputSchema: {},
  },
  async () => {
    const res = await consolidate();
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  }
);

server.registerTool(
  "memory_stats",
  {
    description: "Long-term memory statistics (count, tokens, importance, by type)",
    inputSchema: {},
  },
  async () => {
    return { content: [{ type: "text", text: JSON.stringify(memoryStats(), null, 2) }] };
  }
);

server.registerTool(
  "memory_context",
  {
    description: "Build a compact context block from the most relevant memories for a given topic. Best for injecting memory into prompts.",
    inputSchema: {
      topic: z.string().min(1).max(MAX_TOPIC),
      top_k: z.number().int().min(1).max(20).optional().default(6),
    },
  },
  async (args: { topic: string; top_k?: number }) => {
    const { context, sources } = await contextPrompt(args.topic, args.top_k ?? 6);
    if (!context) return { content: [{ type: "text", text: "No relevant memories found." }] };
    return {
      content: [
        {
          type: "text",
          text: `[Memory context: ${sources.length} sources]\n\n${context}`,
        },
      ],
    };
  }
);

/* ------------------------------------------------------------------ */

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`RAG + Context Management MCP server running (db: ${path.resolve(STORAGE_DIR)})`);

/**
 * Close the SQLite handle before the process exits.
 *
 * SQLite in DELETE journal mode rolls back on an abrupt exit, so a hard kill is
 * safe, but it leaves the `-journal` file behind and skips any WAL checkpoint.
 * On a stdio MCP server the host closing the pipe is the normal way this
 * process dies, so an explicit shutdown keeps the store tidy and lets a WAL
 * database truncate instead of growing.
 *
 * Exit is forced after a grace period because the host may not respond to
 * `server.close()`, and a server that refuses to die is worse than one that
 * drops an unflushed log line.
 */
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`RAG memory: ${signal} received, closing database.`);
  try {
    closeDB();
  } catch (err) {
    console.error(`RAG memory: database close failed: ${String(err)}`);
  }
  void server.close().finally(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));