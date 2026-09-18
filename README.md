# RAG + Context Management MCP Server

<img src="assets/logo.jpg" alt="mcp-rag-memory" />

Persistent long-term memory & knowledge retrieval for AI assistants.
Exposes RAG (vector storage + semantic search) and context management
(memories) as MCP tools, so opencode can store and recall
context **across sessions**.

> 👤 Identity: **The Coder** — "I'm The Coder, Selamat datang dan Semoga perjalanan mu menyenangkan"
>
> 📖 Project documentation site: https://adyoi.github.io/mcp-rag-memory/ (see [`docs/`](./docs/))

## What it does

- **RAG** — ingest documents (text / files / whole directories), chunk + embed locally, store in SQLite, and semantically retrieve relevant context.
- **Hybrid search** — FTS5 BM25 keyword hits fused with vector similarity (reciprocal-rank fusion). Tunable `SEARCH_MODE=hybrid|vector|keyword`.
- **Context Management** — `remember` facts/decisions/preferences, `recall` them later (score-decayed by staleness), rate by importance, consolidate duplicates, filter by type/tag.
- **Zero external APIs by default** — local hashing-embedder (1024-dim), built-in `node:sqlite`. Works fully offline. Optional `EMBEDDING_PROVIDER=transformers` for a higher-quality ONNX model.
- **Safe ingestion** — content-hash deduplication, file size guard (`RAG_MAX_FILE_MB`) and an opt-in path allowlist (`RAG_ALLOWED_DIRS`).
- **MCP server** — runs on stdio, 19 tools.

## Quick start

```bash
npm install
npm test                 # 103 checks: unit + MCP round-trip via SDK client
npm run lint             # oxlint
npm run build            # compile to dist/
npm run cli -- stats     # CLI playground
```

### Run from npm (npx)

Install or run directly from the npm package — no `tsx`, no source checkout:

```bash
npx mcp-rag-memory
```

Point your MCP client at `npx mcp-rag-memory` (the published `bin`), or
at the local dev entry: `node --import tsx src/mcp/rag-server.ts`.

## Works with any MCP client

This is a **standard MCP server** (stdio transport, official
`@modelcontextprotocol/sdk`). It speaks the MCP spec, so **any** agent
that supports MCP can use it — not just opencode. Memory & knowledge
become **shared across all your tools**: remember once, recall everywhere.

### opencode

```json
{
  "mcp": {
    "rag-memory": {
      "type": "local",
      "command": ["node", "--import", "tsx", "D:/Project/mcp-server/src/mcp/rag-server.ts"],
      "cwd": "D:/Project/mcp-server",
      "enabled": true,
      "environment": { "RAG_DB_DIR": "D:/Project/mcp-server/.rag-data" }
    }
  }
}
```

### Claude Desktop

`claude_desktop_config.json` (in `%APPDATA%\Claude`):

```json
{
  "mcpServers": {
    "rag-memory": {
      "command": "node",
      "args": ["--import", "tsx", "D:/Project/mcp-server/src/mcp/rag-server.ts"],
      "env": { "RAG_DB_DIR": "D:/Project/mcp-server/.rag-data" }
    }
  }
}
```

### Cursor / Windsurf

Settings → MCP → add server, same `command`/`args` pattern as Claude
Desktop. No `cwd` needed — use absolute paths for the entry file and DB.

### VS Code (Copilot)

`mcp.json` in `.vscode/`:

```json
{
  "servers": {
    "rag-memory": {
      "type": "stdio",
      "command": "node",
      "args": ["--import", "tsx", "D:/Project/mcp-server/src/mcp/rag-server.ts"],
      "env": { "RAG_DB_DIR": "D:/Project/mcp-server/.rag-data" }
    }
  }
}
```

> Tip: once published (or installed), just point every client at
> `npx mcp-rag-memory` — no `tsx`, no absolute paths, no local checkout.
> Locally you can still use `node --import tsx <abs-path>/src/mcp/rag-server.ts`.

## opencode configuration

### Global config (`~/.config/opencode/opencode.json`)

The MCP server is registered here so it works in **every project**, not just this folder:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "rag-memory": {
      "type": "local",
      "command": ["node", "--import", "tsx", "src/mcp/rag-server.ts"],
      "cwd": "D:/Project/mcp-server",
      "enabled": true,
      "environment": {
        "RAG_DB_DIR": "D:/Project/mcp-server/.rag-data"
      }
    }
  }
}
```

> `cwd` and `RAG_DB_DIR` are absolute paths so the server resolves `tsx`
> from this project's `node_modules` and stores data in the same DB
> regardless of which project opencode is opened from.

### Project config (`opencode.json` in this repo)

Keeps project-specific settings (model, LSP, permissions, instructions) — **no `mcp` block here**:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-6",
  "lsp": true,
  "instructions": [".opencode/instructions.md"],
  "permission": {
    "edit": "allow",
    "bash": { "git *": "allow", "*": "ask" }
  }
}
```

`.opencode/instructions.md` tells every new session to call
`memory_context(topic="The Coder")` first, so the assistant always knows
who you are without asking. The same instructions file is also wired into
the global config to apply to every project.

### Notifications & sound (`~/.config/opencode/tui.json`)

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "attention": {
    "enabled": true,
    "sound": true,
    "notifications": true,
    "volume": 0.4
  }
}
```

Restart opencode after any config change.

## MCP tools (19)

| Group | Tool | Purpose |
|-------|------|---------|
| System | `system_stats` | DB dir, embedding backend, doc/memory counts |
| RAG ingest | `rag_ingest_text` | Store text as a knowledge document (dedup-aware) |
| | `rag_ingest_file` | Store a file (`content_type` auto-detected) |
| | `rag_ingest_dir` | Recursively ingest source files |
| RAG query | `rag_search` | Hybrid (BM25 + vector) search, ranked chunks + scores |
| | `rag_retrieve` | Ready-to-inject context block with token count |
| RAG docs | `rag_list_documents`, `rag_document_stats` | Inventory |
| | `rag_delete_document` | Remove a document + chunks + FTS rows |
| Session sync | `rag_sync_session` | Ingest an opencode session's user inputs (or the latest in a workspace) |
| Memory | `memory_remember` | Save long-term memory (type/importance/tags) |
| | `memory_recall` | Semantic memory search (decay + recall count) |
| | `memory_context` | Compact context block from memories for prompts |
| | `memory_list`, `memory_get`, `memory_update`, `memory_forget` | CRUD |
| | `memory_consolidate` | Dedupe near-identical + promote hot memories |
| | `memory_stats` | Counts, tokens, avg importance, by type |

## Custom slash commands

The 18 MCP tools are called by the AI automatically — but you can also
trigger them directly with custom commands. Sources (same name, project
wins):

- Per-project: `.opencode/commands/`
- Global: `~/.config/opencode/commands/`

| Command | Backing tool | Use |
|---------|--------------|-----|
| `/remember <content> [--type][--importance]` | `memory_remember` | Save a memory |
| `/recall <topic>` | `memory_recall` | Search memories semantically |
| `/context <topic>` | `memory_context` | Context block for prompts |
| `/consolidate` | `memory_consolidate` | Dedupe + promote hot memories |
| `/search <query>` | `rag_search` | Semantic search documents |
| `/retrieve <query>` | `rag_retrieve` | Raw context block + tokens |
| `/ingest <text>` | `rag_ingest_text` | Store knowledge text |
| `/docs` | `rag_list_documents` | List all documents |
| `/stats` | `system_stats` + doc/memory stats | Full statistics |

## CLI

```bash
npm run cli -- remember "deploys every Friday" --type task --importance 0.7
npm run cli -- recall "deployment schedule"
npm run cli -- ingest-dir ./src/rag
npm run cli -- search "vector similarity"
npm run cli -- mem-context "database"
npm run cli -- sessions              # list recent opencode sessions
npm run cli -- sync-session ses_123  # ingest one session's inputs
npm run cli -- sync-latest           # ingest the most recent session
npm run clean-db -- --force          # wipe ALL documents + memories (destructive)
```

Semua akses juga tersedia sebagai custom commands (`/remember`, `/recall`,
`/search`, ...) dan sebagai MCP tools.

## Auto-save session inputs

Every user input you type in opencode becomes searchable in the RAG store —
new, untouched, friendly to your existing long-term memories. Three layers:

1. **Plugin (real-time, debounced).** `.opencode/plugin/session-logger.ts`
   watches message events and, at most once a minute, runs
   `sync-latest` so the session you are typing in lands in the store.
   Disable with `RAG_AUTOSYNC=0`.
2. **CLI on demand.**
   ```bash
   npm run sync-latest -- --dir "D:/Project/my-app"   # latest session in a workspace
   npm run sync-session -- ses_abc123                  # a specific session
   npm run sync-logs                                    # .session-logs/*.jsonl (custom logs)
   ```
3. **MCP tool.** `rag_sync_session` exposes the same logic over MCP:
   `{ "session_id": "..." }` or `{ "directory": "..." }` for the latest.

How it works: sessions are read from opencode's own DB
(`~/.local/share/opencode/opencode.db` + `opencode-local.db`, override with
`OPENCODE_DB` / `OPENCODE_DB_LOCAL`), each user message becomes one small
document (title `<session>-<ts>`, metadata `source: "opencode-db"`). Long
inputs are **condensed to key points** before storage (extractive, no LLM) so
the store stays lean; short inputs are saved whole. Raw transcripts stay in
opencode's DB; long-term **memories** are never mixed in. Re-runs are
idempotent thanks to SHA-256 content-hash dedup (`metadata.condensed` marks
reduced docs), so plugging this into any scheduler is safe.

The plugin needs an opencode restart to take effect.

## Architecture

```
src/
├── db/database.ts          node:sqlite (documents, chunks, memories, chunks_fts, meta)
├── rag/
│   ├── embedder.ts         local hashing embedder (1024-d, FNV-1a, n-grams)
│   ├── embeddings.ts       provider layer: local | transformers (optional dep)
│   ├── chunker.ts          paragraph/code-aware chunking with overlap
│   ├── vector-search.ts    vector cache + FTS5 BM25 + RRF hybrid scoring
│   └── pipeline.ts         async ingest/search/retrieve, dedup, guards, doc mgmt
├── session/transcript.ts   read opencode sessions (global+local DB), ingest inputs
├── memory/memory.ts        remember / recall / consolidate + decay + prune
├── mcp/rag-server.ts       MCP server (19 tools, stdio, npm bin)
├── cli.ts                  CLI playground (incl. sync-session / sync-latest / sync-logs)
└── test/test-all.ts        full test suite (unit + MCP round-trip)
```

Data lives in `.rag-data/rag.sqlite` (git-ignored).

## Configuration (env vars)

| Variable | Default | Purpose |
|----------|---------|---------|
| `RAG_DB_DIR` | `.rag-data` | Where the SQLite store lives |
| `SEARCH_MODE` | `hybrid` | `hybrid` \| `vector` \| `keyword` |
| `EMBEDDING_PROVIDER` | `local` | `local` (zero-dep) \| `transformers` (needs optional `@huggingface/transformers`) |
| `EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | Transformers model name |
| `RAG_MAX_FILE_MB` | `10` | Reject files larger than this |
| `RAG_ALLOWED_DIRS` | *(unset = anywhere)* | Semicolon/pipe/comma-separated allowed ingest roots |
| `RAG_MEMORY_HALF_LIFE_DAYS` | `14` | Recall score decay half-life |
| `RAG_PRUNE` | `0` | Set `1` to allow `consolidate` to delete non-essential memories |
| `RAG_PRUNE_IMPORTANCE` | `0.2` | Delete memories below this importance |
| `RAG_PRUNE_AGE_DAYS` | `90` | ...and older than this (never-recalled only) |
| `RAG_AUTOSYNC` | `1` | Set `0` to disable the session-logger plugin's auto-sync |
| `OPENCODE_DB` / `OPENCODE_DB_LOCAL` | `~/.local/share/opencode/*.db` | Where session transcripts are read from |
| `RAG_SESSION_CONDENSE` | `1` | Set `0` to store session inputs verbatim |
| `RAG_SESSION_CONDENSE_MIN_CHARS` | `120` | Inputs at/below this length are saved whole |
| `RAG_SESSION_CONDENSE_RATIO` | `0.35` | Fraction of long-input length to keep as key points |

## Testing

`npm test` spins up the real MCP server over stdio using the SDK client
and exercises every tool end-to-end against a scratch DB (`.test-data`).
`npm run lint` checks the codebase with oxlint (run in CI too).

## GitHub Pages site

The [`docs/`](./docs/) directory is a self-contained static site of this
project (single `index.html`, no build step). To publish it on GitHub
Pages:

1. Push this repo to GitHub.
2. Repo **Settings → Pages → Build and deployment → Source: Deploy from a
   branch**.
3. Choose branch `main` and folder `/docs`.
4. Your site is live at `https://adyoi.github.io/mcp-rag-memory/`.

## Troubleshooting

### `ConfigInvalidError: missing key "command"` for typescript / javascript / json

The `lsp` block in `opencode.json` has the wrong shape.
Each language key must have a `command` array:

```json
"lsp": {
  "typescript": {
    "command": ["typescript-language-server", "--stdio"]
  }
}
```

Fields like `language_id` or `extensions` alone are not allowed — the
schema enforces `additionalProperties: false` and requires `command`.

**Fix:** either write the `command` array, or (if you just want built-in
LSP) replace the whole block with `"lsp": true`.

---

### MCP tools not showing up in opencode

1. **Wrong config filename** — opencode reads only `opencode.json`,
   `opencode.jsonc`, or `.opencode/opencode.json`. A file named
   `opencode.jsonx` is **silently ignored**; no error, no tools.
2. **File not in the right place** — global MCP config lives at
   `~/.config/opencode/opencode.json`, not in the project folder.
3. **Missing `cwd` for global use** — when `command` uses a relative
   path (`src/mcp/rag-server.ts`), opencode resolves it against the
   *workspace* directory, not the project. Add `"cwd"` to point at the
   project that contains `node_modules/tsx`:

```json
"rag-memory": {
  "type": "local",
  "command": ["node", "--import", "tsx", "src/mcp/rag-server.ts"],
  "cwd": "D:/Project/mcp-server"
}
```

4. **Missing env var** — `RAG_DB_DIR` must be set (absolute path for
   global config) or the DB defaults to `.rag-data` relative to cwd.

---

### Sound / notification not playing when response finishes

The `attention` feature is **off by default**. Create
`~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "attention": {
    "enabled": true,
    "sound": true,
    "notifications": true,
    "volume": 0.4
  }
}
```

**Known issue** ([#40445](https://github.com/anomalyco/opencode/issues/40445)):
sound silently fails when opencode runs under the **Node runtime** instead
of Bun — the audio library depends on Bun FFI. Symptoms: no sound despite
correct config. Not a configuration error.

---

### Server slow to start on first load (~3 s)

`tsx` compiles TypeScript on first invocation. This is normal and only
happens on cold start; subsequent tool calls within the same session are
instant.

---

### Opencode feels sluggish / UI lag after adding plugins

Plugins that run synchronous I/O or write to stderr on every tool call
can slow down the TUI. This project no longer ships any plugins — keep
`opencode.json` plugin-free for clean operation.

---

### `ajv-cli` fails with `strict mode: unknown keyword: allowComments`

The opencode schema uses custom JSON-Schema extensions (`allowComments`,
`allowTrailingCommas`). `ajv-cli` rejects these by default. Validate
config manually instead:

```bash
node -e "JSON.parse(require('fs').readFileSync('opencode.json','utf8')); console.log('OK')"
```
