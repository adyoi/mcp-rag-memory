import { listDocuments, deleteDocument } from "../src/rag/pipeline.js";
import { listMemories, forget } from "../src/memory/memory.js";
import { closeDB } from "../src/db/database.js";

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