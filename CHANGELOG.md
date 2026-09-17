# Changelog

All notable changes to **mcp-rag-memory** are documented here. Uses [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [2.0.0] - 2026-09-17

### Added
- **Hybrid search** — FTS5 BM25 keyword retrieval fused with vector similarity (reciprocal-rank fusion, `k=60`). Toggle with `SEARCH_MODE=hybrid|vector|keyword` (default `hybrid`).
- **Content-hash deduplication** — identical documents are detected (SHA-256) and never re-embedded. `IngestResult` now reports `deduplicated`.
- **File size guard** — `RAG_MAX_FILE_MB` (default 10) rejects oversized file ingests.
- **Path allowlist** — `RAG_ALLOWED_DIRS` restricts which paths can be ingested (absolute-path/symlink-safe check).
- **Memory decay** — recall scores are faded by half-life `RAG_MEMORY_HALF_LIFE_DAYS` (default 14) since last recall, so stale memories rank lower.
- **Optional prune** — `RAG_PRUNE=1` removes never-recalled, low-importance memories older than `RAG_PRUNE_AGE_DAYS` (default 90) with `RAG_PRUNE_IMPORTANCE` threshold (default 0.2). Off by default (deletes are irreversible).
- **In-memory vector cache** — chunk/memory vectors are cached and invalidated on every write.
- **Optional transformer backend** — `EMBEDDING_PROVIDER=transformers` uses `@huggingface/transformers` (optional dep; default remains the zero-dependency local hashing embedder). Dimension/model are locked in `meta` and mismatches throw.
- **Non-blocking ingest** — pipeline/memory APIs are now async; directory ingests yield to the event loop every 10 files.
- **npm distribution** — package renamed to `mcp-rag-memory`, ships a `bin` (`mcp-rag-memory`) so clients can run `npx mcp-rag-memory` without `tsx` or absolute paths.
- **CI** — GitHub Actions (Node 22/24) runs build + full test suite.

### Changed
- `documents` gains a `content_hash` column (partial unique index).
- New `chunks_fts` virtual table and `meta` key/value table (schema migrates automatically).
- `memories` gains an index for prune queries.
- `system_stats` now reports the active embedding backend.
- `recall` returns a `decay` factor alongside each hit.
- Tests expanded from 71 to 92 assertions.

### Removed
- Dead `src/types/opencode-plugin.d.ts` stub.

## [1.0.0] - 2026-09-15

### Added
- Local zero-dependency hashing embedder (1024-dim, FNV-1a + n-grams, offline).
- Chunker with overlap, token estimation, CJK support.
- RAG pipeline: ingest text/file/dir, hybrid-capable search, retrieve context, document management.
- Long-term memory: remember/recall/update/forget/list, tag + type + importance filters, consolidate (dedup + promotion), `contextPrompt`.
- MCP server (18 tools) over stdio for opencode / Claude Desktop / Cursor / VS Code.
- CLI (`npm run cli`) mirroring all operations.
- `node:sqlite` storage (WAL), no native deps, Node >= 22.5.
- Documentation site (GitHub Pages) and README.