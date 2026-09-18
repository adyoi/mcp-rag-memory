/**
 * Wipe ALL documents and memories from the current store (RAG_DB_DIR).
 * Destructive — requires `--force` to run.
 */
import { closeDB, STORAGE_DIR } from "../src/db/database.js";
import { listDocuments, deleteDocument } from "../src/rag/pipeline.js";
import { listMemories, forget } from "../src/memory/memory.js";

if (!process.argv.includes("--force")) {
  console.error("Refusing to run without --force. This deletes ALL documents and memories in:");
  console.error("  " + STORAGE_DIR);
  process.exit(1);
}

const docs = listDocuments();
for (const d of docs) {
  deleteDocument(String(d.id));
}
console.log("documents deleted:", docs.length);

const mems = listMemories({});
for (const m of mems) {
  forget(m.id);
}
console.log("memories deleted:", mems.length);

closeDB();