# mcp-rag-memory

RAG + Context Management MCP server: long-term memory, vector storage, knowledge retrieval. Server runs via stdio, zero external APIs.

## Commands

- `npm run build` — type-check + build to `dist/` (`prebuild` cleans first)
- `npm run lint` — oxlint over `src/` and `scripts/` (warnings denied)
- `npm test` — full suite (unit + MCP round-trip via SDK client + entry-shim e2e)
- `npm run cli -- <cmd>` — playground CLI mirroring the MCP tools
- `npm run clean-db -- --force` — wipe ALL documents + memories (destructive)
- `npm run setup-opencode` — re-assert the global opencode config (mcp rag-memory, plugin, lsp, instructions); opencode updates have been observed to reset it. After an opencode update (or if the MCP server/plugin goes missing from a session), run this and restart opencode.

Always run `npm run lint` and `npm test` after a change; the suite's final line prints the exact pass/fail total.

## Architecture

- `src/mcp/rag-server.ts` — MCP server over stdio (19 tools); read this first.
- `src/rag/` — ingestion and hybrid search (vector cosine ⊕ FTS5 BM25, RRF fusion); `chunks_fts` uses the trigram tokenizer (CJK + substring).
- `src/memory/` — curated long-term memories (facts/preferences/decisions/tasks/...).
- `src/session/` — sync opencode's own DB into the store (`source: opencode-db` / `session-log`), schema-guarded.
- `src/db/database.ts` — SQLite storage (`documents`, `chunks`, `memories`, `chunks_fts`).
- `src/env.ts` + `src/index.ts` — zero-dependency `.env` loader and boot shim (host env wins; `RAG_ENV_FILE`/`<cwd>/.env`).
- Store dir from `RAG_DB_DIR` (default `.rag-data`, gitignored).

## Conventions

- TypeScript strict mode; no code comments unless asked; English prose.
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