/**
 * Wipe ALL documents and memories from the current store (RAG_DB_DIR).
 * Destructive — requires `--force` to run.
 *
 * Deletes in one transaction per table instead of list-then-delete per row: the
 * old loop only removed the first 100 documents/memories, so "clean" left data
 * behind and, for a store with FTS rows, paid a per-document cost for nothing.
 */
import { closeDB, getDB, STORAGE_DIR } from "../src/db/database.js";
import { invalidateVectorCache } from "../src/rag/vector-search.js";

if (!process.argv.includes("--force")) {
  console.error("Refusing to run without --force. This deletes ALL documents and memories in:");
  console.error("  " + STORAGE_DIR);
  process.exit(1);
}

const db = getDB();
db.exec("BEGIN IMMEDIATE;");
try {
  db.prepare("DELETE FROM chunks").run();
  db.prepare("DELETE FROM chunks_fts").run();
  db.prepare("DELETE FROM documents").run();
  db.prepare("DELETE FROM memories").run();
  db.exec("COMMIT;");
} catch (e) {
  try {
    db.exec("ROLLBACK;");
  } catch {
    /* transaction already closed */
  }
  throw e;
}
invalidateVectorCache();

const docs = db.prepare("SELECT COUNT(*) AS c FROM documents").get() as { c: number };
const mems = db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number };
console.log("documents deleted:", docs.c === 0 ? "all" : `ERROR ${docs.c} remain`);
console.log("memories deleted:", mems.c === 0 ? "all" : `ERROR ${mems.c} remain`);

closeDB();