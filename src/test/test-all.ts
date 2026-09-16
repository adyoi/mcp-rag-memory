import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const TEST_DB = path.join(ROOT, ".test-data");

// Route all db writes into a temp dir, and prep the studio subprocess too.
process.env.RAG_DB_DIR = TEST_DB;

// Track test results
let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: unknown, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Extract the text payload from an MCP tool result, tolerating SDK typing quirks. */
function toolText(res: unknown): string {
  const content = (res as { content?: Array<Record<string, unknown>> } | undefined)?.content;
  const first = content?.[0];
  return first && typeof first.text === "string" ? first.text : "";
}

async function main() {
  console.log("=== RAG + CONTEXT MANAGEMENT TEST SUITE ===\n");

  fs.rmSync(TEST_DB, { recursive: true, force: true });

  // Dynamic imports so the modules bind to TEST_DB.
  const { getDB, packVector, unpackVector, DB_PATH, newId } = await import("../db/database.js");
  const { embed, cosineSimilarity, EMBED_DIM } = await import("../rag/embedder.js");
  const { chunkText } = await import("../rag/chunker.js");
  const { searchChunks, vectorSearch } = await import("../rag/vector-search.js");
  const rag = await import("../rag/pipeline.js");
  const mem = await import("../memory/memory.js");

  /* ================== 1. DB LAYER ================== */
  console.log("\n=== 1. Database Layer ===");
  const db = getDB();
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
  check("tables created", ["documents", "chunks", "memories"].every((t) => tables.includes(t)), tables.join(","));
  check("DB file created on disk", fs.existsSync(DB_PATH));
  check("DB in test dir", DB_PATH.startsWith(TEST_DB));

  const vec = new Float64Array([0.1, 0.2, 0.3, -0.5, 0.9]);
  const packed = packVector(vec);
  const unpacked = unpackVector(packed);
  check("packVector/unpackVector roundtrip", unpacked !== null && unpacked.length === vec.length && unpacked[4] === 0.9);

  /* ================== 2. EMBEDDER ================== */
  console.log("\n=== 2. Embedder (local hashing) ===");
  const e1 = embed("fetch weather data for Jakarta");
  const e2 = embed("fetch weather data for Jakarta");
  const eDiff = embed("buy groceries at the supermarket");
  check("embed is deterministic", Array.from(e1).every((v, i) => v === e2[i]));
  check("embed has correct dim", e1.length === EMBED_DIM);
  check("embed is normalized", Math.abs(1 - (() => { let s = 0; for (const v of e1) s += v * v; return Math.sqrt(s); })()) < 1e-9);
  check("similar text scores higher", cosineSimilarity(e1, e2) > cosineSimilarity(e1, eDiff));
  const cjk1 = embed("该引擎支持中文检索");
  const cjk2 = embed("该引擎支持中文检索");
  check("CJK text embeds", cosineSimilarity(cjk1, cjk2) > 0.99);

  /* ================== 3. CHUNKER ================== */
  console.log("\n=== 3. Chunker ===");
  const longText = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}: The quick brown fox jumps over the lazy dog near the river bank of Jakarta. This sentence provides additional detail for chunking tests.`).join("\n\n");
  const chunks = chunkText(longText);
  check("long text split into multiple chunks", chunks.length > 1, `got ${chunks.length}`);
  check("no chunk is empty", chunks.every((c) => c.text.trim().length > 0));
  check("chunks have overlap context", chunks.some((c) => c.text.includes("river bank")));
  check("each chunk under max size", chunks.every((c) => c.text.length <= 950));
  const sourceReconstruction = chunks.map((c) => c.text).join("");
  check("content preserved", Array.from(sourceReconstruction).length > Array.from(longText).length * 0.9);
  check("indexes sequential", chunks.every((c, i) => c.index === i));
  check("token estimation positive", chunks.every((c) => c.tokenCount > 0));

  /* ================== 4. RAG PIPELINE ================== */
  console.log("\n=== 4. RAG Pipeline ===");
  const doc1 = rag.ingestText(
    "The authentication service uses JWT tokens, RSA signing with a 4096-bit key, and sessions expire after 30 minutes.",
    "Auth architecture"
  );
  const doc2 = rag.ingestText(
    "Database migrations are handled with Prisma. The main schema lives in prisma/schema.prisma and there are 42 tables.",
    "DB setup",
    { contentType: "markdown", metadata: { project: "core" } }
  );
  check("ingestText returns doc id", typeof doc1.docId === "string" && doc1.docId.length > 0);
  check("ingestText created chunks", doc1.chunks >= 1, `chunks=${doc1.chunks}`);
  check("ingestText counts tokens", doc1.tokens > 0);

  const s1 = rag.searchDocs("jwt authentication RSA", 5);
  check("search finds auth doc first", s1.length > 0 && s1[0].docTitle === "Auth architecture", JSON.stringify(s1[0]));
  check("search returns scores", s1.every((h) => h.score > 0));
  check("search results include docTitle", s1.every((h) => h.docTitle));

  const s2 = rag.searchDocs("prisma migration tables", 5);
  check("search finds db doc ", s2.length > 0 && s2[0].docTitle === "DB setup");

  const retrieved = rag.retrieve("how is jwt signing configured", 3);
  check("retrieve returns context", retrieved.chunks.length > 0);
  check("retrieve reports tokens", retrieved.totalTokens >= retrieved.chunks[0]?.tokenCount);
  check("retrieve ranks auth content", retrieved.chunks[0]?.content.includes("JWT"), retrieved.chunks[0]?.content);

  const docs = rag.listDocuments();
  check("listDocuments returns 2 docs", docs.length === 2);
  const stats = rag.documentStats();
  check("documentStats correct", stats.documents === 2 && stats.chunks === doc1.chunks + doc2.chunks, JSON.stringify(stats));

  const fPath = path.join(ROOT, "src/test/sample.md");
  fs.writeFileSync(fPath, "# Sample\n\nThe rate limiter allows 100 requests per second per API key.");
  const doc3 = rag.ingestFile(fPath);
  check("ingestFile works", doc3.chunks >= 1);
  check("ingestFile detects markdown", doc3.title === "sample.md");
  fs.rmSync(fPath);

  const d = rag.deleteDocument(doc3.docId);
  check("deleteDocument works", d.deleted === true);
  const docsAfter = rag.listDocuments();
  check("document removed after delete", docsAfter.length === 2);

  /* ================== 5. LONG-TERM MEMORY ================== */
  console.log("\n=== 5. Context Management / Memory ===");
  const m1 = mem.remember({ content: "User prefers Python over JavaScript for backend services.", type: "preference", importance: 0.9, tags: ["user", "language"] });
  const m2 = mem.remember({ content: "The production API runs on Kubernetes cluster GKE-us-east1.", type: "fact", importance: 0.8, tags: ["infra"] });
  const m3 = mem.remember({ content: "We decided to use Postgres over MySQL for the new billing service.", type: "decision", importance: 0.95 });
  check("remember creates memory", typeof m1.id === "string" && m1.content.includes("Python"));
  check("memory has importance", m1.importance === 0.9);
  check("memory has tags parsed", Array.isArray(m1.tags) && m1.tags.includes("user"));

  const r1 = mem.recall("what language does the user prefer", 5);
  check("recall finds preference", r1.length > 0 && r1[0].content.includes("Python"), JSON.stringify(r1[0] ?? null));
  check("recall increments count", r1.every((h) => h.recallCount >= 1));

  const mAll = mem.listMemories();
  check("listMemories returns 3", mAll.length === 3);
  const mByTag = mem.listMemories({ tag: "infra" });
  check("listMemories filters by tag", mByTag.length === 1 && mByTag[0].content.includes("Kubernetes"));
  const mPref = mem.listMemories({ type: "preference" });
  check("listMemories filters by type", mPref.length === 1 && mPref[0].type === "preference");
  const mHigh = mem.listMemories({ minImportance: 0.85 });
  check("listMemories filters by importance", mHigh.length === 2, JSON.stringify(mHigh.map((m) => m.importance)));

  const got = mem.getMemory(m2.id);
  check("getMemory works", got !== null && got.content.includes("Kubernetes"));

  const upd = mem.updateMemory(m2.id, { importance: 0.99, tags: ["infra", "gcp"] });
  check("updateMemory changes importance", upd?.importance === 0.99);
  check("updateMemory changes tags", upd?.tags?.includes("gcp"));

  const ctx = mem.contextPrompt("python user preference");
  check("contextPrompt returns block", ctx.context.length > 0 && ctx.sources.length > 0);
  check("contextPrompt includes sources", ctx.sources[0].content.includes("Python"));

  const st = mem.memoryStats();
  check("memoryStats counts 3 memories", st.memories === 3, JSON.stringify(st));
  check("memoryStats breaks down by type", st.byType.preference === 1 && st.byType.decision === 1 && st.byType.fact === 1);

  // near-duplicate cleanup
  mem.remember({ content: "User prefers Python over JavaScript for backend services.", type: "preference", importance: 0.5 });
  const beforeConsolidate = mem.memoryStats().memories;
  check("near-dup created total 4", beforeConsolidate === 4);
  const report = mem.consolidate();
  check("consolidate removes duplicate", report.removedDuplicates >= 1, JSON.stringify(report));
  const afterConsolidate = mem.memoryStats().memories;
  check("consolidate leaves 3", afterConsolidate === 3, JSON.stringify(afterConsolidate));

  const del = mem.forget(m3.id);
  check("forget deletes memory", del.deleted === true);
  check("forget removed from list", mem.listMemories().length === 2);

  /* ================== 6. MCP SERVER ROUND-TRIP ================== */
  console.log("\n=== 6. MCP Server Round-Trip (via SDK Client) ===");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", path.join("src", "mcp", "rag-server.ts")],
    cwd: ROOT,
    env: { ...process.env, RAG_DB_DIR: TEST_DB },
    stderr: "pipe",
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });

  try {
    await client.connect(transport);
    check("MCP client connected", true);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    const expected = [
      "system_stats", "rag_ingest_text", "rag_ingest_file", "rag_ingest_dir",
      "rag_search", "rag_retrieve", "rag_list_documents", "rag_document_stats",
      "rag_delete_document", "memory_remember", "memory_recall", "memory_list",
      "memory_get", "memory_update", "memory_forget", "memory_consolidate",
      "memory_stats", "memory_context",
    ];
    check("all tools registered", expected.every((t) => toolNames.includes(t)), `missing: ${expected.filter((t) => !toolNames.includes(t))}`);
    check("exactly 18 tools", toolNames.length === expected.length, `got ${toolNames.length}`);

    const sys = await client.callTool({ name: "system_stats", arguments: {} });
    const sysText = toolText(sys);
    const sysJson = JSON.parse(sysText.startsWith("---") ? sysText.replace(/^---.*$/m, "").trim() : sysText);
    check("system_stats has dbDir", sysJson.dbDir === TEST_DB, sysText.slice(0, 100));

    // Note: shared DB — docs from earlier in-process ingestion are visible.
    const listDocs = await client.callTool({ name: "rag_list_documents", arguments: {} });
    const listText = toolText(listDocs);
    check("rag_list_documents returns existing docs", JSON.parse(listText).length >= 2);

    const ingest = await client.callTool({
      name: "rag_ingest_text",
      arguments: { title: "MCP test doc", content: "The ci pipeline runs on GitHub Actions with three stages: lint, test, deploy.", contentType: "text" },
    });
    const ingestJson = JSON.parse(toolText(ingest));
    check("rag_ingest_text works over MCP", ingestJson.chunks >= 1);

    const search = await client.callTool({ name: "rag_search", arguments: { query: "github actions pipeline", top_k: 3 } });
    const searchHits = JSON.parse(toolText(search));
    check("rag_search works over MCP", searchHits.length >= 1 && searchHits[0].content.includes("GitHub Actions"), JSON.stringify(searchHits[0]));

    const retrieveTool = await client.callTool({ name: "rag_retrieve", arguments: { query: "ci pipeline" } });
    check("rag_retrieve returns context block", toolText(retrieveTool).includes("Context block"));

    const rem = await client.callTool({
      name: "memory_remember",
      arguments: { content: "The user deploys to staging every Friday afternoon.", type: "task", importance: 0.7, tags: ["deploy", "schedule"] },
    });
    const remJson = JSON.parse(toolText(rem));
    check("memory_remember works over MCP", remJson.content.includes("Friday"), JSON.stringify(remJson));

    const rec = await client.callTool({ name: "memory_recall", arguments: { query: "deployment schedule", top_k: 3 } });
    const recHits = JSON.parse(toolText(rec));
    check("memory_recall works over MCP", recHits.length >= 1 && recHits[0].content.includes("Friday"));

    const memCtx = await client.callTool({ name: "memory_context", arguments: { topic: "deployment" } });
    check("memory_context works over MCP", toolText(memCtx).includes("Memory context"));

    const mStats = await client.callTool({ name: "memory_stats", arguments: {} });
    check("memory_stats works over MCP", JSON.parse(toolText(mStats)).memories > 0);

    await client.close();
    check("MCP client closed cleanly", true);
  } catch (e) {
    check("MCP round-trip succeeded", false, (e as Error).message);
    try { await client.close(); } catch { /* ignore */ }
  }

  /* ================== RESULTS ================== */
  console.log("\n=== RESULTS ===");
  console.log(`  Total:  ${passed + failed}`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) {
    console.log("\nFailed:");
    failures.forEach((f) => console.log(`  ❌ ${f}`));
    process.exit(1);
  } else {
    console.log("All checks passed!");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});