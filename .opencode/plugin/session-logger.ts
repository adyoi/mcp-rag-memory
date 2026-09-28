/**
 * session-logger — opencode plugin.
 *
 * Debounced auto-sync: whenever the session changes (a new message landed), it
 * triggers `npx mcp-rag-memory-cli sync-latest --dir <workspace>` so every user
 * input is ingested from opencode's own DB into the RAG store (mcp-rag-memory).
 * It runs through npx against the published package (not the local repo's
 * scripts), so it works in ANY workspace — the CLI bin ships inside the
 * `mcp-rag-memory` package as `mcp-rag-memory-cli`.
 *
 * The raw transcript stays in opencode's DB as-is; curated long-term memories are
 * not affected. Re-runs are idempotent: every user message is deduped by
 * (source, session, ts), so a repeat sync is a no-op. Never blocks the chat —
 * all errors are swallowed. Disable with env RAG_AUTOSYNC=0.
 */
const MIN_INTERVAL_MS = 60_000;
import { spawn } from "node:child_process";

export const SessionLoggerPlugin = async ({ directory }: { directory?: string }) => {
  let lastRun = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const workspace = directory ?? process.cwd();

  const runSync = async () => {
    timer = null;
    const now = Date.now();
    if (now - lastRun < MIN_INTERVAL_MS) return;
    lastRun = now;
    try {
      spawnCli(workspace);
    } catch {
      /* never break the chat over logging */
    }
  };

  const schedule = () => {
    if (process.env.RAG_AUTOSYNC === "0") return;
    if (timer) return;
    timer = setTimeout(runSync, Math.max(5_000, MIN_INTERVAL_MS - (Date.now() - lastRun)));
  };

  return {
    event: async ({ event }: { event: { type?: string } }) => {
      const t = event?.type;
      if (t === "message.updated" || t === "session.idle" || t === "session.updated") schedule();
    },
  };
};

/**
 * shell:false is deliberate — with shell:true a workspace path containing
 * spaces or quotes is re-parsed by the shell, and the path is command
 * injection. On Windows the npx shim is npx.cmd, so resolve that explicitly.
 */
function spawnCli(workspace: string): void {
  const isWindows = process.platform === "win32";
  const child = spawn(
    isWindows ? "npx.cmd" : "npx",
    ["--yes", "-p", "mcp-rag-memory", "mcp-rag-memory-cli", "sync-latest", "--dir", workspace],
    { shell: false, stdio: "ignore", windowsHide: true, detached: !isWindows }
  );
  // An async spawn error (npx missing, ENOENT) is emitted on the child, not
  // thrown; without a listener it is an unhandled 'error' event that can take
  // the host process down.
  child.on("error", () => {});
  child.unref();
}