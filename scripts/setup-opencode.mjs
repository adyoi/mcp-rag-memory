// Dispatch `setup-opencode` to the platform-native script so npm works on
// both Windows PowerShell and POSIX shells with a single entrypoint.
import * as childProcess from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

const [bin, fileArgs] =
  process.platform === "win32"
    ? ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "scripts", "setup-opencode.ps1"), ...args]]
    : ["bash", [path.join(ROOT, "scripts", "setup-opencode.sh"), ...args]];

const res = childProcess.spawnSync(bin, fileArgs, { stdio: "inherit" });
process.exit(res.status ?? 1);