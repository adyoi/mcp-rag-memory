/**
 * Zero-dependency `.env` loader.
 *
 * Loads KEY=VALUE pairs from `RAG_ENV_FILE` (if set) or `<cwd>/.env` into
 * process.env. Existing environment variables are never overridden, so host
 * config (MCP clients, CI, shell) always wins. Runs synchronously at import —
 * must be imported before any module that reads `process.env.*` at load time.
 * Supports `#` comments, `export KEY=` prefixes, and single/double-quoted values.
 *
 * Only this package's own knobs are loadable: an untrusted repo's `.env` must
 * not be able to inject arbitrary process.env entries into the host session.
 */
import * as fs from "fs";
import * as path from "path";

/** Prefixes/names this server actually reads. */
const LOADABLE = /^(RAG_[A-Z0-9_]+|OPENCODE_[A-Z0-9_]+|EMBEDDING_[A-Z0-9_]+|SEARCH_MODE)$/;
const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Strip one layer of matching quotes plus any trailing `# comment`. */
function unquote(value: string): string {
  const q = value[0];
  if (q === '"' || q === "'") {
    const close = value.indexOf(q, 1);
    if (close > 0) {
      const rest = value.slice(close + 1).trim();
      if (rest === "" || rest.startsWith("#")) return value.slice(1, close);
    }
  }
  const hash = value.indexOf(" #");
  return hash >= 0 ? value.slice(0, hash).trimEnd() : value;
}

export function loadDotenv(file: string): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (process.env.RAG_ENV_FILE) {
      process.stderr.write(`env: cannot read RAG_ENV_FILE ${file} (${(e as Error).message})\n`);
    }
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    let t = line.trim();
    if (!t || t.startsWith("#")) continue;
    if (t.startsWith("export ") || t.startsWith("export\t")) t = t.slice(7).trimStart();
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    if (!VALID_KEY.test(key)) continue;
    if (!LOADABLE.test(key)) {
      process.stderr.write(`env: ignoring ${key} (not an mcp-rag-memory variable)\n`);
      continue;
    }
    const value = unquote(t.slice(eq + 1).trim());
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const envFile = process.env.RAG_ENV_FILE ?? path.join(process.cwd(), ".env");
if (process.env.RAG_ENV_FILE || fs.existsSync(envFile)) {
  loadDotenv(envFile);
}