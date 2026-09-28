# Changelog

All notable changes to **mcp-rag-memory** are documented here. Uses [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [Unreleased]

## [2.5.0] - 2026-09-28

### Added
- **`setup-opencode` config re-assert scripts** — `scripts/setup-opencode.ps1` (Windows PowerShell) and `scripts/setup-opencode.sh` (bash; picks `jq` → `python3` → fallback), dispatched by `scripts/setup-opencode.mjs` via `npm run setup-opencode`. Rewrites the global opencode config (`opencode.json` + `opencode.jsonc`) after an opencode update wipes it: merges with existing files without clobbering user keys, unions `instructions`/`plugin` arrays, backs up broken files to `.bak-<ts>`, stays idempotent, and `--check` reports drift (exit 0 = up to date). Both scripts also force the canonical `mcp.rag-memory` entry so a half-written or renamed server entry can't survive an update. Docs in README + AGENTS.md.
- **`LICENSE`** (MIT, matching `package.json`) and **`npm run typecheck`** (`tsconfig.check.json` covering `src/`, `scripts/`, `.opencode/plugin/` — the build config only sees `src/`).
- **CI matrix** now runs Windows as well as Linux, and gates on the standalone type-check before the build.
- **Test suite 116 → 158 assertions** (FTS backfill, FTS metacharacters, trigram substring search, `min_score` filtering, cross-connection cache invalidation, `dedupScope`, consolidate false-positive guard, chunker overlap/clamp guards, late `OPENCODE_DB`, env allowlist, corrupted `tags` rows, and a real `clean-all --force` run over 100+ documents).

### Changed
- **`rag_list_documents` is paginated** — returns `{ documents, total, limit, offset }` with `limit` clamped to 1–1000 instead of dumping every document into the tool response. CLI `docs` gained `--limit`/`--offset`.
- **`memory_consolidate` no longer re-embeds** — the promotion pass is a single `UPDATE` instead of a per-memory re-embed (a full model inference each), and it now sees the whole store rather than the newest 100 entries. Reports a `skippedDedup` flag when the store is too large for the O(n²) pass.
- **Deduplication is strictly safer**: only *exact* duplicates dedupe by content hash, and `consolidate` additionally requires ≥ 80% word overlap before deleting a near-duplicate — templated agent memories ("the user's X is Y") sit at ~0.95 cosine but say different things, and deleting those is unrecoverable.
- **Node engine** is now `>=22.12.0` (the first release with `node:sqlite` read-only + `busy_timeout` behaviour this server relies on).
- **`.env` loading is restricted** to this server's own variables (`RAG_*`, `OPENCODE_*`, `EMBEDDING_*`, `SEARCH_MODE`); other keys are ignored with a stderr warning so a repository `.env` cannot inject arbitrary environment variables into the host session.

### Fixed
- **Concurrent ingestion no longer corrupts the store** — embedding happens *before* the write transaction opens. The MCP SDK does not serialise tool calls, and awaiting a model inference inside an open `BEGIN` let another request's writes be folded into — or rolled back with — the first one's transaction.
- **`chunks_fts` is backfilled on creation** — a store that had the FTS table dropped (or created by a failed migration) silently lost keyword search for every pre-existing chunk forever, because the next boot saw "trigram" and skipped the rebuild.
- **FTS5 queries are escaped** — a query containing `"`, `*`, `(`, `OR` or `NEAR` used to throw `fts5: syntax error`; tokens are now quoted before `MATCH`.
- **Vector cache notices other writers** — the in-process cache is keyed on `PRAGMA data_version`, so a document written by the CLI, the session-logger plugin or a second MCP server is visible without restarting this one.
- **`min_score` actually filters** — the threshold is applied to the final fused score, and scores are clamped to `0..1`.
- **Session sync no longer collapses messages across sessions** — dedup is scoped to `(source, session, ts)`, so the same short reply ("ok", "continue") in two sessions is two documents instead of one. Re-running a sync stays idempotent.
- **Session DB discovery is read per call**, includes the Windows `%LOCALAPPDATA%` location, uses `LIMIT` + SQL-side text filtering instead of loading every part blob, opens read-only handles with a busy timeout, and reports a missing session instead of silently returning nothing.
- **Chunker**: `overlapChars: 0` no longer duplicates the previous chunk (`slice(-0)` returns the whole string); a pending window is flushed before hard-splitting an oversized sentence, which used to emit earlier text twice; fenced code blocks are kept intact; `maxChars`/`overlapChars` are validated.
- **Vector blobs** are copied by byte range instead of sharing the underlying `ArrayBuffer` (a pooled Node buffer could corrupt stored vectors), and a partial/foreign blob is rejected instead of read past its end.
- **`memory_recall`/`memory_list`** no longer issue one query per row, and recall counts are only bumped for the memories actually returned.
- **`memory_update`** no longer re-embeds on a metadata-only change, and an all-undefined patch is a no-op instead of a silent re-embed.
- **`memory_consolidate` prune env vars** are range-validated instead of accepting `NaN`.
- **CLI** parses `--key=value`, treats bare flags as booleans (so `--content true` no longer stores the literal word "true"), validates required arguments, and returns a non-zero exit code on failure.
- **`clean-all` wipes the whole store** — the old list-then-delete loop stopped after 100 documents/memories; it is now one transaction per table and verifies the result.
- **The session-logger plugin** spawns with `shell: false` (no shell re-parsing of the workspace path, no command injection), resolves `npx.cmd` on Windows, and swallows async spawn errors instead of emitting an unhandled `error` event.
- **`SEARCH_MODE`** is read per call, so changing it at runtime (as the tests do) takes effect.
- **Search filters are validated and clamped** — the MCP schema rejects an out-of-range `limit` instead of passing it to SQL.
- **Search filters now pre-rank** — `doc_id`/`source` are resolved against the DB before scoring, so a filtered document can never be squeezed out of the top-K by unfiltered chunks. Vector and FTS legs both restrict to the allowed chunk set.
- **`ingestText` is atomic** — a failed embed/chunk write rolls the whole document back (BEGIN/COMMIT/ROLLBACK) instead of leaving a partial doc.
- **`ingestText` rejects empty content** with a clear error.
- **`RAG_MAX_FILE_MB` sanitised** — non-numeric/negative values fall back to 10 MB instead of silently disabling the size guard.
- **CLI `memory-update` no longer rewrites memory type** to `fact` when `--type` is omitted; non-numeric `--importance`/`--min-importance`/`--limit` fall back to defaults instead of `NaN`.
- **`getSessionTranscript` searches both opencode DBs** — sessions living in `opencode-local.db` (desktop mode) now sync properly, not just the global DB.
- **`PRAGMA busy_timeout = 5000`** in the store so concurrent writers (MCP server + CLI auto-save) wait instead of failing immediately with `SQLITE_BUSY`.
- **`memory_list` clamps `limit` to ≥ 1** so a bad/zero limit never produces a no-op or invalid `LIMIT`.

## [2.4.1] - 2026-09-19

### Fixed
- Auto-save invocation: `npx -y mcp-rag-memory-cli` (a package name mistake) renamed to the correct `npx -y -p mcp-rag-memory mcp-rag-memory-cli` form in the plugin and README. The CLI bin ships inside the `mcp-rag-memory` package; `npx` needs `-p` to resolve a bin whose name differs from the package name.

## [2.4.0] - 2026-09-19

### Added
- **Cross-workspace auto-save** — the CLI is published as a global bin (`mcp-rag-memory-cli`) and the plugin shells out via `npx -y mcp-rag-memory-cli sync-latest --dir <workspace>`, so auto-save works in any project; the CLI loads `.env`/`RAG_ENV_FILE` like the server.
- **Search filters** — `rag_search` / `rag_retrieve` / CLI `search`/`retrieve` accept `doc_id` and `source` to narrow ranked results.
- **GitHub Actions publish workflow** (`.github/workflows/publish.yml`) — push a `v*` tag to publish to npm with provenance (OIDC `id-token: write`); runs build + lint + test first.
- **`loadDotenv` exported** and covered by tests, plus an end-to-end entry-shim test proving `RAG_ENV_FILE` steers the store dir.
- **Schema guard for opencode DB sync** — warm, actionable error if the opencode DB layout changes (table/column missing); optional `time_archived` / `parent_id` columns detected dynamically.
- Test suite 103 → 114 assertions (env loader, entry-shim e2e, search filters).

### Changed
- **FTS5 tokenizer `unicode61` → `trigram`** (migrated automatically) for CJK and Indonesian-style substring matching. Short terms (≤ 2 chars) skip the keyword leg — the vector leg covers them.
- README: honest auto-save scope note (plugin ships with this repo; copy it anywhere + `.env` to reuse), new "Performance & limits" section (O(N) bruteforce, ANN = v3 scope), filters and `--source`/`--doc-id` docs.

## [2.3.0] - 2026-09-19

### Added
- **Run in any MCP client** — documented `npx`, Claude Desktop, Cursor and Continue configs; server stays a plain stdio MCP server.
- **`.env` support** — `src/env.ts` zero-dependency loader reads `RAG_ENV_FILE` or `<cwd>/.env` before config imports (host env always wins). New `.env.example`; `.env`/`.env.*` gitignored.
- New entrypoint `src/index.ts` (loads env → boots server); `bin` and `start`/`dev` scripts point to it.

### Changed
- `consolidate()` dedup loop O(n³) → O(n²) (lookup maps instead of nested linear scans).
- Removed dead code: `vectorStats`, `packEmbedding`, `ChunkRow`, `STORAGE_DIR` re-export in `vector-search.ts`.
- Server version now read from `package.json` (no more duplicated literal).
- Custom slash commands carry a `<rag>` prefix in their frontmatter description.

## [2.2.0] - 2026-09-18

### Added
- **Key-point condensing** — session inputs are condensed to their essence before ingest: short inputs pass through untouched, long ones are reduced to the most information-dense sentences via deterministic extractive scoring (no LLM, stays idempotent). Toggle with `RAG_SESSION_CONDENSE` (default `1`), thresholds `RAG_SESSION_CONDENSE_MIN_CHARS` (default `120`) and `RAG_SESSION_CONDENSE_RATIO` (default `0.35`). Ingested docs carry `metadata.condensed` when reduced.
- **Code linting** — `oxlint` dev-dependency + `npm run lint` (covers `src/` and `scripts/`, errors deny warnings). LSP in opencode picks `oxlint` up automatically once the dependency is present.
- **Safe maintenance script** — `npm run clean-db` with `--force` guardrail to safely reset scratch stores.

### Changed
- Test suite 99 → 103 assertions (condensing + determinism + key-fact retention).
- Documentation updated to reflect 19 tools, 103 checks, session sync commands, and `clean-db`.
- Cleaned `.gitignore` rules and removed dead `src/index.ts`.
- `.opencode/instructions.md`: added protocol "Interruption beats the old plan".

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