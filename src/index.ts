#!/usr/bin/env node
/**
 * MCP server entry point.
 *
 * Loads `.env` (from RAG_ENV_FILE or <cwd>/.env) before any module that reads
 * `process.env.*` at import time, then boots the stdio MCP server. This keeps
 * `npx mcp-rag-memory` configurable from a plain `.env` file in addition to
 * environment variables set by the host MCP client.
 */
import "./env.js";
await import("./mcp/rag-server.js");