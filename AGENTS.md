# mcp-rag-memory

RAG + Context Management MCP server: long-term memory, vector storage, knowledge retrieval. Server runs via stdio, zero external APIs.

## Commands

- `npm run build` — type-check + build to `dist/` (`prebuild` cleans first)
- `npm run lint` — oxlint over `src/` and `scripts/` (warnings denied)
- `npm test` — full suite (unit + MCP round-trip via SDK client + entry-shim e2e)
- `npm run cli -- <cmd>` — playground CLI mirroring the MCP tools
- `npm run cli -- reindex` — re-embed every stored vector for the current `EMBEDDING_PROVIDER`/`EMBEDDING_MODEL`, migrating the store in place instead of wiping and re-ingesting
- `npm run clean-db -- --force` — wipe ALL documents + memories (destructive)
- `npm run setup-opencode` — re-assert the global opencode config (mcp rag-memory, plugin, lsp, instructions); opencode updates have been observed to reset it. After an opencode update (or if the MCP server/plugin goes missing from a session), run this and restart opencode.

Always run `npm run lint` and `npm test` after a change; the suite's final line prints the exact pass/fail total.

## Architecture

- `src/mcp/rag-server.ts` — MCP server over stdio (20 tools); read this first.
- `src/rag/` — ingestion and hybrid search (vector cosine ⊕ FTS5 BM25, RRF fusion); `chunks_fts` uses the trigram tokenizer (CJK + substring).
- `src/memory/` — curated long-term memories (facts/preferences/decisions/tasks/...).
- `src/session/` — sync opencode's own DB into the store (`source: opencode-db` / `session-log`), schema-guarded, probed per candidate DB so a corrupt one cannot hide a healthy one.
- `src/db/database.ts` — SQLite storage (`documents`, `chunks`, `memories`, `chunks_fts`).
- `src/env.ts` + `src/index.ts` — zero-dependency `.env` loader and boot shim (host env wins; `RAG_ENV_FILE`/`<cwd>/.env`).
- Store dir from `RAG_DB_DIR` (default `.rag-data`, gitignored).

## Retrieval honesty

Do not describe the default embedding backend as "semantic".

- `EMBEDDING_PROVIDER=local` (default) is a **lexical** hashing embedder over character
  1/2/3-grams. It scores lexical and sub-word overlap, not meaning, so paraphrase-only
  queries ("cara fix login" vs "masalah autentikasi") score near zero on the vector leg.
  Retrieval still works via the FTS5 trigram leg; paraphrase recall is the blind spot.
- `EMBEDDING_PROVIDER=transformers` is the only genuinely **semantic** option (optional
  dep). After switching, run `reindex` to migrate the store.
- `system_stats` reports this as `embedding.vectorLeg` + `embedding.note`. Keep that field
  accurate; an agent that believes the default is semantic will trust recall that is
  not there.
- `rag_search(explain=true)` exposes per-leg scores (cosine, normalised BM25, RRF
  contribution) so a bad ranking can be attributed to a leg instead of guessed at.

## Invariants worth protecting

- **One vector space per store.** `ensureDim` rejects a dimension *or model* change, and
  also refuses to run while `embed_state='reindexing'`. Do not bypass `ensureDim`; the
  only sanctioned bypass is `embedTextUnguarded`, used solely by `src/rag/reindex.ts`.
- **The vector cache is complete on purpose.** It is uncapped because truncating it would
  silently change which documents are findable. Warn via `RAG_VECTOR_CACHE_WARN_MB`
  instead of truncating.
- **Tool inputs are length-bounded** at the zod schema. Any new tool parameter needs an
  explicit cap, or one call can stall the synchronous embedder.
- **Keep `searchChunks`' reported `score` on a 0..1 scale** in every mode; `min_score` is
  documented to the caller against that scale.

## Conventions

- TypeScript strict mode; English prose; commit comments only where the reasoning is not
  obvious from the diff.
- Verify changes with `npm run lint` + `npm test` before finishing.
- Commit messages: short imperative ASCII summary (`feat: ...`, `fix: ...`, `chore: ...`).

## Long-term memory protocol (template block for adopter projects)

Copy this block into the `AGENTS.md` (or equivalent rules file) of **any** project
that uses mcp-rag-memory. It is agent-agnostic, so every primary agent and
subagent behaves identically, which keeps the shared store stable:

- At session start, recall identity and preferences with `memory_context(topic="identity")` — never ask who the user is.
- Persist important facts, decisions, preferences, and instructions with `memory_remember` (with sensible `type`/`importance`/`tags`).
- On the user interrupting mid-task, their newest input wins: stop immediately, re-sync the todo list (mark/queue per the new plan, never drop silently), and re-plan when the new intent conflicts.

Full behavioral details live in `.opencode/instructions.md`, which is also wired
into the global opencode config so this protocol applies across sessions.