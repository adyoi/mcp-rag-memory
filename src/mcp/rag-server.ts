import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as path from "path";
import { STORAGE_DIR } from "../db/database.js";
import {
  ingestText,
  ingestFile,
  ingestDirectory,
  searchDocs,
  retrieve,
  listDocuments,
  deleteDocument,
  documentStats,
} from "../rag/pipeline.js";
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

const server = new McpServer({
  name: "rag-memory-server",
  version: "2.0.0",
});

/* ------------------------------------------------------------------ */
/* System                                                              */
/* ------------------------------------------------------------------ */

server.registerTool(
  "system_stats",
  {
    description: "Get overall system stats: DB location, documents, chunks, memories, tokens",
    inputSchema: {},
  },
  async () => {
    const docs = documentStats();
    const mem = memoryStats();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { dbDir: STORAGE_DIR, documents: docs, memories: mem },
            null,
            2
          ),
        },
      ],
    };
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
      content: z.string().min(1),
      title: z.string().describe("Document title"),
      contentType: z.string().optional().describe("e.g. markdown, typescript, text, json"),
      metadata: z.record(z.string(), z.unknown()).optional(),
    },
  },
  async (args: { content: string; title: string; contentType?: string; metadata?: Record<string, unknown> }) => {
    const res = ingestText(args.content, args.title, {
      contentType: args.contentType,
      metadata: args.metadata,
    });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  }
);

server.registerTool(
  "rag_ingest_file",
  {
    description: "Read a file and store it as a knowledge document",
    inputSchema: {
      path: z.string().describe("Absolute path to the file"),
      metadata: z.record(z.string(), z.unknown()).optional(),
    },
  },
  async (args: { path: string; metadata?: Record<string, unknown> }) => {
    const res = ingestFile(args.path, { metadata: args.metadata });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  }
);

server.registerTool(
  "rag_ingest_dir",
  {
    description: "Recursively ingest supported source files from a directory",
    inputSchema: {
      path: z.string().describe("Absolute path to the directory"),
      recursive: z.boolean().optional().default(true),
      extensions: z.array(z.string()).optional().describe("File extensions to include, e.g. ['.ts', '.md']"),
    },
  },
  async (args: { path: string; recursive?: boolean; extensions?: string[] }) => {
    const res = ingestDirectory(args.path, { recursive: args.recursive, extensions: args.extensions });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  }
);

/* ------------------------------------------------------------------ */
/* RAG: search / retrieve                                              */
/* ------------------------------------------------------------------ */

server.registerTool(
  "rag_search",
  {
    description: "Semantic search over stored documents. Returns chunks ranked by relevance with scores.",
    inputSchema: {
      query: z.string().min(1),
      top_k: z.number().int().min(1).max(50).optional().default(10),
      min_score: z.number().min(0).max(1).optional().default(0.08),
    },
  },
  async (args: { query: string; top_k?: number; min_score?: number }) => {
    const hits = searchDocs(args.query, args.top_k ?? 10, args.min_score ?? 0.08);
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
      query: z.string().min(1),
      top_k: z.number().int().min(1).max(20).optional().default(6),
      min_score: z.number().min(0).max(1).optional().default(0.08),
    },
  },
  async (args: { query: string; top_k?: number; min_score?: number }) => {
    const res = retrieve(args.query, args.top_k ?? 6, args.min_score ?? 0.08);
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
    description: "List all stored knowledge documents",
    inputSchema: {},
  },
  async () => {
    const docs = listDocuments();
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
      doc_id: z.string().min(1),
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
  "memory_remember",
  {
    description:
      "Store a piece of long-term memory (fact, decision, preference, instruction, task, insight, conversation). Use this to persist things that should be remembered across sessions.",
    inputSchema: {
      content: z.string().min(1).describe("The memory content, written as a self-contained statement"),
      type: z.enum(MEMORY_TYPES).optional().default("fact"),
      importance: z.number().min(0).max(1).optional().default(0.5).describe("0..1, higher = keep longer"),
      tags: z.array(z.string()).optional().describe("Tags for filtering"),
    },
  },
  async (args: { content: string; type?: string; importance?: number; tags?: string[] }) => {
    const rec = remember({
      content: args.content,
      type: args.type as never,
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
      query: z.string().min(1),
      top_k: z.number().int().min(1).max(30).optional().default(8),
      min_score: z.number().min(0).max(1).optional().default(0.1),
    },
  },
  async (args: { query: string; top_k?: number; min_score?: number }) => {
    const hits = recall(args.query, args.top_k ?? 8, args.min_score ?? 0.1);
    return { content: [{ type: "text", text: JSON.stringify(hits, null, 2) }] };
  }
);

server.registerTool(
  "memory_list",
  {
    description: "List memories, optionally filtered by type, tag, or minimum importance",
    inputSchema: {
      type: z.enum(MEMORY_TYPES).optional(),
      tag: z.string().optional(),
      min_importance: z.number().min(0).max(1).optional(),
      limit: z.number().int().min(1).max(500).optional().default(100),
    },
  },
  async (args: { type?: string; tag?: string; min_importance?: number; limit?: number }) => {
    const recs = listMemories({
      type: args.type as never,
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
      id: z.string().min(1),
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
      id: z.string().min(1),
      content: z.string().optional(),
      type: z.enum(MEMORY_TYPES).optional(),
      importance: z.number().min(0).max(1).optional(),
      tags: z.array(z.string()).optional(),
    },
  },
  async (args: { id: string; content?: string; type?: string; importance?: number; tags?: string[] }) => {
    const rec = updateMemory(args.id, {
      content: args.content,
      type: args.type as never,
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
      id: z.string().min(1),
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
    description: "Deduplicate near-identical memories and boost importance of frequently-used ones",
    inputSchema: {},
  },
  async () => {
    const res = consolidate();
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
      topic: z.string().min(1),
      top_k: z.number().int().min(1).max(20).optional().default(6),
    },
  },
  async (args: { topic: string; top_k?: number }) => {
    const { context, sources } = contextPrompt(args.topic, args.top_k ?? 6);
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