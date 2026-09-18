# Changelog

All notable changes to **mcp-rag-memory** are documented here. Uses [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [2.2.0] - 2026-09-18

### Added
- **Key-point condensing** — session inputs are condensed to their essence before ingest: short inputs pass through untouched, long ones are reduced to the most information-dense sentences via deterministic extractive scoring (no LLM, stays idempotent). Toggle with `RAG_SESSION_CONDENSE` (default `1`), thresholds `RAG_SESSION_CONDENSE_MIN_CHARS` (default `120`) and `RAG_SESSION_CONDENSE_RATIO` (default `0.35`). Ingested docs carry `metadata.condensed` when reduced.
- **Code linting** — `oxlint` dev-dependency + `npm run lint` (errors deny warnings). LSP in opencode picks `oxlint` up automatically once the dependency is present.

### Changed
- Test suite 99 → 103 assertions (condensing + determinism + key-fact retention).

## [2.1.0] - 2026-09-17

### Added
- **Auto-save session inputs** — every user message typed in opencode can be ingested into the RAG store as searchable documents.
  - `.opencode/plugin/session-logger.ts` (opencode plugin) auto-triggers `sync-latest` on message events (debounced 60 s, disable with `RAG_AUTOSYNC=0`).
  - `src/session/transcript.ts` reads transcripts from opencode's global + local DB (`OPENCODE_DB` / `OPENCODE_DB_LOCAL` override); messages ingested one-doc-per-message with metadata `source: "opencode-db"`, idempotent via content-hash dedup.
  - CLI: `sync-session <id>`, `sync-latest [--dir]`, `sync-logs [dir]`, `sessions`, `ingest-jsonl`.
  - MCP tool `rag_sync_session` exposes the same operation as an MCP call.
- `listDocuments` now includes the `metadata` column; ingest content-type map covers `.jsonl` / `.log`.

### Changed
- MCP tool count 18 → 19; test suite 92 → 99 assertions.

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