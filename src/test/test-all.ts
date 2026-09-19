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
  const { getDB, packVector, unpackVector, DB_PATH } = await import("../db/database.js");
  const { embed, cosineSimilarity, dotProduct, EMBED_DIM } = await import("../rag/embedder.js");
  const { chunkText } = await import("../rag/chunker.js");
  const rag = await import("../rag/pipeline.js");
  const mem = await import("../memory/memory.js");

  /* ================== 1. DB LAYER ================== */
  console.log("\n=== 1. Database Layer ===");
  const db = getDB();
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
  check("tables created", ["documents", "chunks", "memories", "chunks_fts", "meta"].every((t) => tables.includes(t)), tables.join(","));
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
  check("dotProduct == cosine for normalized vectors", Math.abs(dotProduct(e1, e2) - cosineSimilarity(e1, e2)) < 1e-9);
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
  const doc1 = await rag.ingestText(
    "The authentication service uses JWT tokens, RSA signing with a 4096-bit key, and sessions expire after 30 minutes.",
    "Auth architecture"
  );
  const doc2 = await rag.ingestText(
    "Database migrations are handled with Prisma. The main schema lives in prisma/schema.prisma and there are 42 tables.",
    "DB setup",
    { contentType: "markdown", metadata: { project: "core" } }
  );
  check("ingestText returns doc id", typeof doc1.docId === "string" && doc1.docId.length > 0);
  check("ingestText created chunks", doc1.chunks >= 1, `chunks=${doc1.chunks}`);
  check("ingestText counts tokens", doc1.tokens > 0);
  check("ingestText not deduplicated on first insert", doc1.deduplicated === false);

  const s1 = await rag.searchDocs("jwt authentication RSA", 5);
  check("search finds auth doc first", s1.length > 0 && s1[0].docTitle === "Auth architecture", JSON.stringify(s1[0]));
  check("search returns scores", s1.every((h) => h.score > 0));
  check("search results include docTitle", s1.every((h) => h.docTitle));
  check("search hits include tokenCount", s1.length > 0 && s1.every((h) => typeof h.tokenCount === "number" && h.tokenCount > 0));

  const s2 = await rag.searchDocs("prisma migration tables", 5);
  check("search finds db doc ", s2.length > 0 && s2[0].docTitle === "DB setup");

  const sFiltered = await rag.searchDocs("jwt authentication RSA", 5, 0.08, { source: "scratch" });
  check("search filter: source narrows results", sFiltered.length === 0, JSON.stringify(sFiltered));

  const authDocId = (await rag.listDocuments()).find((d) => d.title === "Auth architecture")?.id as string;
  const sDocFiltered = await rag.searchDocs("jwt authentication RSA", 5, 0.08, { docId: authDocId });
  check("search filter: doc_id keeps only that document", sDocFiltered.length > 0 && sDocFiltered.every((h) => h.docId === authDocId && h.docTitle === "Auth architecture"), JSON.stringify(sDocFiltered[0] ?? null));

  const retrieved = await rag.retrieve("how is jwt signing configured", 3);
  check("retrieve returns context", retrieved.chunks.length > 0);
  check("retrieve reports tokens", retrieved.totalTokens >= retrieved.chunks[0]?.tokenCount);
  check("retrieve ranks auth content", retrieved.chunks[0]?.content.includes("JWT"), retrieved.chunks[0]?.content);

  const docs = await rag.listDocuments();
  check("listDocuments returns 2 docs", docs.length === 2);
  const stats = await rag.documentStats();
  check("documentStats correct", stats.documents === 2 && stats.chunks === doc1.chunks + doc2.chunks, JSON.stringify(stats));

  // Content-hash dedup.
  const dupText = "Deduplication marker content alpha beta gamma.";
  const d1 = await rag.ingestText(dupText, "Dup first");
  const d2 = await rag.ingestText(dupText, "Dup second");
  check("dedup returns existing doc id", d2.deduplicated === true && d2.docId === d1.docId);
  check("dedup reuses chunk count", d2.chunks === d1.chunks);
  const statsAfterDup = await rag.documentStats();
  check("dedup does not grow store", statsAfterDup.documents === stats.documents + 1 && statsAfterDup.chunks === stats.chunks + d1.chunks, JSON.stringify(statsAfterDup));
  await rag.deleteDocument(d1.docId);
  const statsAfterDupDelete = await rag.documentStats();
  check("dedup doc deletable", statsAfterDupDelete.documents === stats.documents);

  // Hybrid / keyword search modes.
  const kwDoc = await rag.ingestText(
    "The zzzqx hypertesting marker appears exclusively inside this single document body.",
    "Hybrid marker"
  );
  const prevMode = process.env.SEARCH_MODE;
  process.env.SEARCH_MODE = "keyword";
  const kw = await rag.searchDocs("zzzqx", 5);
  check("keyword (FTS5) search finds exact term", kw.length > 0 && kw[0].docTitle === "Hybrid marker", JSON.stringify(kw[0] ?? null));
  process.env.SEARCH_MODE = "vector";
  const vh = await rag.searchDocs("zzzqx hypertesting", 5);
  check("vector search still works", vh.length >= 1, JSON.stringify(vh.length));
  process.env.SEARCH_MODE = "hybrid";
  const hy = await rag.searchDocs("zzzqx hypertesting", 5);
  check("hybrid search returns marker doc", hy.length >= 1 && hy.some((h) => h.docTitle === "Hybrid marker"));
  if (prevMode === undefined) delete process.env.SEARCH_MODE;
  else process.env.SEARCH_MODE = prevMode;
  await rag.deleteDocument(kwDoc.docId);

  // ingestFile + size guard.
  const fPath = path.join(ROOT, "src/test/sample.md");
  fs.writeFileSync(fPath, "# Sample\n\nThe rate limiter allows 100 requests per second per API key.");
  const doc3 = await rag.ingestFile(fPath);
  check("ingestFile works", doc3.chunks >= 1);
  check("ingestFile detects markdown", doc3.title === "sample.md");
  fs.rmSync(fPath);

  const bigPath = path.join(TEST_DB, "big.ts");
  fs.writeFileSync(bigPath, "x".repeat(4096));
  process.env.RAG_MAX_FILE_MB = "0.0005";
  let sizeGuardHit = false;
  try {
    await rag.ingestFile(bigPath);
  } catch (e) {
    sizeGuardHit = (e as Error).message.includes("too large");
  }
  check("size guard rejects large files", sizeGuardHit);
  delete process.env.RAG_MAX_FILE_MB;

  // RAG_ALLOWED_DIRS allowlist.
  const okPath = path.join(TEST_DB, "ok.ts");
  fs.writeFileSync(okPath, "allowlisted content one two three.");
  const blkPath = path.join(ROOT, "src/test/blk.ts");
  fs.writeFileSync(blkPath, "blocked content four five six.");
  process.env.RAG_ALLOWED_DIRS = TEST_DB;
  let allowGuardHit = false;
  try {
    await rag.ingestFile(blkPath);
  } catch (e) {
    allowGuardHit = (e as Error).message.includes("not allowed");
  }
  check("allowlist blocks outside paths", allowGuardHit);
  const okDoc = await rag.ingestFile(okPath);
  check("allowlist allows inside paths", okDoc.docId !== undefined);
  await rag.deleteDocument(okDoc.docId);
  delete process.env.RAG_ALLOWED_DIRS;
  fs.unlinkSync(blkPath);
  fs.unlinkSync(bigPath);

  const d = await rag.deleteDocument(doc3.docId);
  check("deleteDocument works", d.deleted === true);
  const docsAfter = await rag.listDocuments();
  check("document removed after delete", docsAfter.length === 2);

  // ingestDirectory skips junk dirs and tolerates per-file failures.
  const srcDir = path.join(TEST_DB, "ingest-src");
  fs.mkdirSync(path.join(srcDir, ".git"), { recursive: true });
  fs.mkdirSync(path.join(srcDir, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(srcDir, ".git", "config.ts"), "git internal stuff.");
  fs.writeFileSync(path.join(srcDir, "node_modules", "dep.ts"), "dependency code.");
  for (let i = 0; i < 12; i++) {
    fs.writeFileSync(path.join(srcDir, `file${i}.ts`), `module file ${i} with distinct payload.`);
  }
  fs.writeFileSync(path.join(srcDir, "notes.txt"), "not an extension we ingest.");
  const dirResult = await rag.ingestDirectory(srcDir, { recursive: true });
  const dirTitles = dirResult.ingested.map((r) => r.title);
  check("ingest-dir ingests source + txt files", dirResult.ingested.length === 13, `got ${dirResult.ingested.length}`);
  check("ingest-dir skips .git and node_modules", !dirTitles.includes("config.ts") && !dirTitles.includes("dep.ts"), JSON.stringify(dirTitles));
  check("ingest-dir includes txt default ext", dirTitles.includes("notes.txt"));
  check("ingest-dir reports no failures", dirResult.skipped.length === 0, JSON.stringify(dirResult.skipped));
  fs.rmSync(srcDir, { recursive: true, force: true });

  /* ================== 5. LONG-TERM MEMORY ================== */
  console.log("\n=== 5. Context Management / Memory ===");
  const m1 = await mem.remember({ content: "User prefers Python over JavaScript for backend services.", type: "preference", importance: 0.9, tags: ["user", "language"] });
  const m2 = await mem.remember({ content: "The production API runs on Kubernetes cluster GKE-us-east1.", type: "fact", importance: 0.8, tags: ["infra"] });
  const m3 = await mem.remember({ content: "We decided to use Postgres over MySQL for the new billing service.", type: "decision", importance: 0.95 });
  check("remember creates memory", typeof m1.id === "string" && m1.content.includes("Python"));
  check("memory has importance", m1.importance === 0.9);
  check("memory has tags parsed", Array.isArray(m1.tags) && m1.tags.includes("user"));

  const r1 = await mem.recall("what language does the user prefer", 5);
  check("recall finds preference", r1.length > 0 && r1[0].content.includes("Python"), JSON.stringify(r1[0] ?? null));
  check("recall increments count", r1.every((h) => h.recallCount >= 1));
  check("recall exposes decay factor", r1.every((h) => typeof h.decay === "number" && h.decay > 0 && h.decay <= 1));

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

  const upd = await mem.updateMemory(m2.id, { importance: 0.99, tags: ["infra", "gcp"] });
  check("updateMemory changes importance", upd?.importance === 0.99);
  check("updateMemory changes tags", upd?.tags?.includes("gcp"));

  const ctx = await mem.contextPrompt("python user preference");
  check("contextPrompt returns block", ctx.context.length > 0 && ctx.sources.length > 0);
  check("contextPrompt includes sources", ctx.sources[0].content.includes("Python"));

  const st = mem.memoryStats();
  check("memoryStats counts 3 memories", st.memories === 3, JSON.stringify(st));
  check("memoryStats breaks down by type", st.byType.preference === 1 && st.byType.decision === 1 && st.byType.fact === 1);

  // near-duplicate cleanup
  await mem.remember({ content: "User prefers Python over JavaScript for backend services.", type: "preference", importance: 0.5 });
  const beforeConsolidate = mem.memoryStats().memories;
  check("near-dup created total 4", beforeConsolidate === 4);
  const report = await mem.consolidate();
  check("consolidate removes duplicate", report.removedDuplicates >= 1, JSON.stringify(report));
  const afterConsolidate = mem.memoryStats().memories;
  check("consolidate leaves 3", afterConsolidate === 3, JSON.stringify(afterConsolidate));
  const survivor = mem.listMemories().find((m) => m.content.includes("Python"));
  check("consolidate keeps higher-importance memory", survivor?.importance === 0.9, JSON.stringify(survivor));

  const del = mem.forget(m3.id);
  check("forget deletes memory", del.deleted === true);
  check("forget removed from list", mem.listMemories().length === 2);

  // Tag filtering must be exact, not a JSON substring match.
  await mem.remember({ content: "Alpha services use Bazel for builds.", type: "fact", tags: ["alpha"] });
  check("tag filter exact-match (no substring)", mem.listMemories({ tag: "alp" }).length === 0, JSON.stringify(mem.listMemories({ tag: "alp" })));
  check("tag filter exact matches", mem.listMemories({ tag: "alpha" }).length === 1);

  // Optional prune — only runs when RAG_PRUNE=1 (deletes are irreversible).
  await mem.remember({ content: "Obsolete scratch note xy.", type: "fact", importance: 0.1 });
  check("prune candidate exists", mem.listMemories().length === 4);
  process.env.RAG_PRUNE = "1";
  process.env.RAG_PRUNE_IMPORTANCE = "0.5";
  process.env.RAG_PRUNE_AGE_DAYS = "0";
  const pruneReport = await mem.consolidate();
  check("prune removes stale low-importance memory", pruneReport.pruned === 1, JSON.stringify(pruneReport));
  check("prune leaves other memories", mem.listMemories().length === 3);
  const afterPrune = mem.listMemories();
  check("prune keeps alpha memory", afterPrune.some((m) => m.content.includes("Bazel")));
  delete process.env.RAG_PRUNE;
  delete process.env.RAG_PRUNE_IMPORTANCE;
  delete process.env.RAG_PRUNE_AGE_DAYS;

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
      "memory_stats", "memory_context", "rag_sync_session",
    ];
    check("all tools registered", expected.every((t) => toolNames.includes(t)), `missing: ${expected.filter((t) => !toolNames.includes(t))}`);
    check("exactly 19 tools", toolNames.length === expected.length, `got ${toolNames.length}`);

    const sys = await client.callTool({ name: "system_stats", arguments: {} });
    const sysText = toolText(sys);
    const sysJson = JSON.parse(sysText.startsWith("---") ? sysText.replace(/^---.*$/m, "").trim() : sysText);
    check("system_stats has dbDir", sysJson.dbDir === TEST_DB, sysText.slice(0, 100));
    check("system_stats exposes embedding backend", typeof sysJson.embedding?.provider === "string", JSON.stringify(sysJson.embedding));

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

  /* ================== 7. SESSION SYNC ================== */
  console.log("\n=== 7. Session Sync (jsonl logs + transcript) ===");
  const sess = await import("../session/transcript.js");

  const logDir = path.join(TEST_DB, "session-logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, "ses-demo.jsonl");
  fs.writeFileSync(
    logFile,
    [
      JSON.stringify({ ts: 1000, session: "ses-demo", content: "Session log line one about the flying birds of Java island." }),
      JSON.stringify({ ts: 2000, session: "ses-demo", content: "Session log line two, a follow-up question about databases." }),
      JSON.stringify({ ts: 3000, session: "ses-demo", content: "   " }),
      "not-json-at-all",
      "",
    ].join("\n"),
    "utf8"
  );

  const parsed = sess.readJsonl(logFile);
  check("readJsonl parses valid lines only", parsed.length === 2, `got ${parsed.length}`);

  /* --- key-point condensing --- */
  const short = "Singkat saja";
  const shortOut = sess.condenseInput(short);
  check("short input passes through untouched", shortOut === short, shortOut);

  const longUncondensed =
    "Hari ini saya memutuskan arsitektur utama untuk layanan autentikasi dengan JWT token, RSA signing, dan expiry. " +
    "Kami juga memilih Prisma sebagai ORM dengan schema tunggal, dan Chart.js untuk dashboard. " +
    "Deployment dilakukan ke staging setiap Jumat sore menggunakan GitHub Actions dengan tiga stage lint, test, dan deploy. " +
    "Semua rahasia disimpan di vault dan tidak boleh masuk repository. " +
    "Tim kecil ini menyepakati bahwa review kode wajib sebelum merge. " +
    "Anggaran bulanan infrastruktur dijaga di bawah sepuluh juta rupiah.";
  const longOut = sess.condenseInput(longUncondensed);
  check("long input condensed", longOut.length < longUncondensed.length, `${longUncondensed.length} -> ${longOut.length}`);
  check("condense is deterministic", longOut === sess.condenseInput(longUncondensed));
  check("condense keeps key facts", longOut.includes("autentikasi") || longOut.includes("Prisma") || longOut.includes("staging"));

  const lr1 = await sess.ingestJsonlFile(logFile);
  check("ingest-jsonl creates one doc per message", lr1.newDocs === 2, JSON.stringify(lr1));
  check("blank/malformed lines skipped", lr1.messages === 2 && lr1.skipped === 0, JSON.stringify(lr1));

  const lr2 = await sess.ingestJsonlFile(logFile);
  check("re-run deduplicates by content-hash", lr2.deduplicated === 2 && lr2.newDocs === 0, JSON.stringify(lr2));

  const ls = await rag.searchDocs("flying birds java", 5);
  check("session log entries searchable", ls.some((h) => h.content.includes("flying")), JSON.stringify(ls[0]));

  const ld = await sess.ingestLogDir(logDir);
  check("ingest-logs-dir counts files and stays idempotent", ld.files === 1 && ld.newDocs === 0 && ld.deduplicated === 2, JSON.stringify(ld));

  const withMeta = (await rag.listDocuments()).find((d) => (d as { title: string }).title.includes("ses-demo")) as { source?: string; metadata?: unknown };
  check("listDocuments exposes source metadata", withMeta?.source === "session-log" && typeof withMeta?.metadata === "string", JSON.stringify(withMeta));

  /* ================== 8. Env loader + entry shim ================== */
  const { loadDotenv } = await import("../env.js");
  const envFile = path.join(TEST_DB, "env-fixture");
  fs.writeFileSync(
    envFile,
    [
      "# comment line",
      "RAG_ENVTEST_ALPHA=hello",
      'RAG_ENVTEST_QUOTED="two words"',
      "export RAG_ENVTEST_EXPORT=ok",
      "RAG_ENVTEST_INLINE=val # keep the note out",
      "RAG_ENVTEST_EMPTY=",
    ].join("\n"),
    "utf8"
  );
  process.env.RAG_ENVTEST_PRESET = "existing";
  loadDotenv(envFile);
  check("env: existing var never overridden", process.env.RAG_ENVTEST_PRESET === "existing");
  check("env: plain KEY=VALUE", process.env.RAG_ENVTEST_ALPHA === "hello", process.env.RAG_ENVTEST_ALPHA);
  check("env: quoted value stripped", process.env.RAG_ENVTEST_QUOTED === "two words", process.env.RAG_ENVTEST_QUOTED);
  check("env: export prefix stripped", process.env.RAG_ENVTEST_EXPORT === "ok", process.env.RAG_ENVTEST_EXPORT);
  check("env: inline comment stripped", process.env.RAG_ENVTEST_INLINE === "val", process.env.RAG_ENVTEST_INLINE);
  check("env: empty value stored as ''", process.env.RAG_ENVTEST_EMPTY === "", JSON.stringify(process.env.RAG_ENVTEST_EMPTY));
  for (const k of ["RAG_ENVTEST_ALPHA", "RAG_ENVTEST_QUOTED", "RAG_ENVTEST_EXPORT", "RAG_ENVTEST_INLINE", "RAG_ENVTEST_EMPTY", "RAG_ENVTEST_PRESET"]) delete process.env[k];

  // End-to-end: the published entry shim must load RAG_ENV_FILE before booting the
  // server, so the store lands where the .env points. Spawned as a real process
  // (node + tsx loader) to exercise the exact startup path. Keeps stdin open so
  // the sequential handshake (init → initialized → tools/call) completes.
  const { spawn } = await import("node:child_process");
  const envDir = path.join(TEST_DB, "entry-store");
  fs.rmSync(envDir, { recursive: true, force: true });
  const entryEnv = path.join(TEST_DB, "entry-env");
  fs.writeFileSync(entryEnv, `RAG_DB_DIR=${JSON.stringify(envDir)}`, "utf8");

  const runEntry = (lines: string[]) =>
    new Promise<string>((resolve, reject) => {
      const childEnv: Record<string, string | undefined> = { ...process.env, RAG_ENV_FILE: entryEnv };
      delete childEnv.RAG_DB_DIR;
      const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
        cwd: ROOT,
        env: childEnv,
        stdio: ["pipe", "pipe", "ignore"],
      });
      let out = "";
      let sent = 0;
      const killer = setTimeout(() => {
        child.kill();
        reject(new Error(`entry shim timeout; received: ${out.trim()}`));
      }, 30_000);
      child.stdout!.on("data", (chunk) => {
        out += chunk;
        // Progress the handshake once the previous response has landed.
        if (sent === 1 && out.includes('"id":1')) {
          sent = 2;
          child.stdin!.write(lines[1] + "\n");
          child.stdin!.write(lines[2] + "\n");
        }
        if (sent === 2 && out.includes('"id":2')) {
          clearTimeout(killer);
          child.kill();
          resolve(out);
        }
      });
      child.stdin!.write(lines[0] + "\n");
      sent = 1;
    });

  const entryOut = await runEntry([
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"suite","version":"0"}}}',
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"system_stats","arguments":{}}}',
  ]).catch((e) => {
    check("entry: server answered initialize + tools/call", false, String(e));
    return "";
  });
  const outLines = entryOut.split("\n").filter(Boolean);
  const last = outLines[outLines.length - 1] ?? "";
  check("entry: server answered initialize + tools/call", outLines.length >= 2 && /"id":2/.test(entryOut), outLines.join(" | "));
  const parsedStat = (() => {
    try {
      const o = JSON.parse(last) as { result?: { content?: Array<{ text?: string }> } };
      return JSON.parse(o.result?.content?.[0]?.text ?? "{}") as { dbDir?: string };
    } catch {
      return {};
    }
  })();
  check("entry: RAG_ENV_FILE honored (dbDir from .env)", parsedStat.dbDir === path.resolve(envDir), String(parsedStat.dbDir));
  check("entry: exists on disk", fs.existsSync(path.join(ROOT, "src", "index.ts")));

  /* ================== 9. RESULTS ================== */
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