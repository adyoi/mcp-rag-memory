/**
 * Zero-dependency `.env` loader.
 *
 * Loads KEY=VALUE pairs from `RAG_ENV_FILE` (if set) or `<cwd>/.env` into
 * process.env. Existing environment variables are never overridden, so host
 * config (MCP clients, CI, shell) always wins. Runs synchronously at import —
 * must be imported before any module that reads `process.env.*` at load time.
 * Supports `#` comments, `export KEY=` prefixes, and single/double-quoted values.
 */
import * as fs from "fs";
import * as path from "path";

function loadDotenv(file: string): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    let t = line.trim();
    if (!t || t.startsWith("#")) continue;
    if (t.startsWith("export ")) t = t.slice(7).trimStart();
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let value = t.slice(eq + 1).trim();
    // Strip trailing inline comments for unquoted values (e.g. `KEY=val # note`).
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trimEnd();
    }
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

const envFile = process.env.RAG_ENV_FILE ?? path.join(process.cwd(), ".env");
if (process.env.RAG_ENV_FILE || fs.existsSync(envFile)) {
  loadDotenv(envFile);
}