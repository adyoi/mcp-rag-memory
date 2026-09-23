#!/usr/bin/env bash
# Re-assert the opencode global config this repo depends on:
# mcp.rag-memory, plugin, lsp, instructions, model, permission.
# opencode updates have been observed to reset/wipe the global config.
#
#   bash scripts/setup-opencode.sh
#   bash scripts/setup-opencode.sh --check
#
# Merges into the existing config without clobbering other keys; rewrites both
# opencode.json and opencode.jsonc. Uses jq, else python3, else rewrites the
# standalone template (covers the "config wiped by update" case everywhere).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GLOBAL_DIR="$HOME/.config/opencode"
CONFIG_JSON="$GLOBAL_DIR/opencode.json"
CONFIG_JSONC="$GLOBAL_DIR/opencode.jsonc"

INSTRUCTIONS_PATH="$ROOT/.opencode/instructions.md"
PLUGIN_PATH="$ROOT/.opencode/plugin/session-logger.ts"
SERVER_PATH="$ROOT/src/mcp/rag-server.ts"

PATCH=$(cat <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-6",
  "lsp": true,
  "instructions": ["$INSTRUCTIONS_PATH"],
  "plugin": ["file://$PLUGIN_PATH"],
  "permission": { "edit": "allow", "bash": { "git *": "allow", "*": "ask" } },
  "mcp": {
    "rag-memory": {
      "type": "local",
      "command": ["node", "--import", "tsx", "$SERVER_PATH"],
      "cwd": "$ROOT",
      "environment": { "RAG_DB_DIR": "$ROOT/.rag-data" }
    }
  }
}
EOF
)

for f in "$INSTRUCTIONS_PATH" "$PLUGIN_PATH" "$SERVER_PATH"; do
  if [ ! -e "$f" ]; then
    echo "setup-opencode: missing repo file (run from this repo): $f" >&2
    exit 1
  fi
done

merge_with_jq() {
  jq -n --argjson base "$1" --argjson patch "$2" '
    def m($a;$b):
      reduce (($a + $b) | keys_unsorted[]) as $k ({}; 
        if ($a|has($k)) and ($b|has($k)) and (($a[$k]|type)=="object") and (($b[$k]|type)=="object") then
          .[$k] = m($a[$k];$b[$k])
        elif ($a|has($k)) and ($b|has($k)) and (($a[$k]|type)=="array") and (($b[$k]|type)=="array") then
          (.[$k] = (($a[$k]) + ($b[$k]) | reduce .[] as $x ([]; if index($x) then . else . + [$x] end)))
        elif ($a|has($k)) then
          .[$k] = $a[$k]
        else
          .[$k] = $b[$k]
        end
      );
    m((if $base == null then {} else $base end);$patch)
  '
}

merge_with_py() {
  python3 -c "
import json, sys
base = json.loads(sys.argv[1]) if sys.argv[1] not in ('null', '') else {}
patch = json.loads(sys.argv[2])
out = dict(base)
for k, v in patch.items():
    if isinstance(v, dict) and isinstance(out.get(k), dict):
        out[k] = {**out[k], **v}
    elif isinstance(v, list) and isinstance(out.get(k), list):
        seen = set()
        merged = []
        for x in list(out[k]) + v:
            if x not in seen:
                seen.add(x)
                merged.append(x)
        out[k] = merged
    elif out.get(k) is None:
        out[k] = v
print(json.dumps(out, indent=2))
" "$1" "$2"
}

merge() {
  local base="$1" patch="$2"
  if command -v jq >/dev/null 2>&1; then
    merge_with_jq "$base" "$patch"
  elif command -v python3 >/dev/null 2>&1; then
    merge_with_py "$base" "$patch"
  else
    printf '%s\n' "$patch"
  fi
}

json_valid() {
  if [ "$1" = "null" ]; then
    return 0
  fi
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$1" | jq -e . >/dev/null 2>&1
  elif command -v python3 >/dev/null 2>&1; then
    printf '%s' "$1" | python3 -c "import json,sys; json.load(sys.stdin)" >/dev/null 2>&1
  else
    return 0
  fi
}

read_config() {
  if [ ! -f "$1" ]; then
    echo null
    return
  fi
  cat -- "$1"
}

same_config() {
  local a="$1" b="$2"
  if command -v jq >/dev/null 2>&1; then
    [ "$(jq -n --argjson x "$a" --argjson y "$b" '$x == $y')" = "true" ]
  else
    [ "$a" = "$b" ]
  fi
}

config_equal() {
  local a b
  a="$(read_config "$1")"
  b="$2"
  [ "$a" = "null" ] && [ "$b" = "null" ] && return 0
  [ "$a" = "null" ] && return 1
  same_config "$a" "$b"
}

backup_broken() {
  local file="$1"
  local backup="$file.bak-$(date +%s%3N)"
  mv -- "$file" "$backup"
  echo "unreadable opencode config  -  moved to $backup" >&2
}

mkdir -p "$GLOBAL_DIR"

JSON_BASE="$(read_config "$CONFIG_JSON")"
JSONC_BASE="$(read_config "$CONFIG_JSONC")"
if [ -f "$CONFIG_JSON" ] && [ "$JSON_BASE" != "null" ] && ! json_valid "$JSON_BASE"; then
  backup_broken "$CONFIG_JSON"
  JSON_BASE=null
fi
if [ -f "$CONFIG_JSONC" ] && [ "$JSONC_BASE" != "null" ] && ! json_valid "$JSONC_BASE"; then
  backup_broken "$CONFIG_JSONC"
  JSONC_BASE=null
fi

# Union both existing files (either may hold user keys) then fill gaps with the
# managed defaults. Managed keys never clobber existing values.
MERGED="$(merge "$JSON_BASE" "$PATCH")"
MERGED="$(merge "$JSONC_BASE" "$MERGED")"

if [ "${1:-}" = "--check" ]; then
  if config_equal "$CONFIG_JSON" "$MERGED" && config_equal "$CONFIG_JSONC" "$MERGED"; then
    echo "global opencode config is up to date"
    exit 0
  fi
  echo "global opencode config is out of date (run without --check to apply)"
  exit 1
fi

written=0
for f in "$CONFIG_JSON" "$CONFIG_JSONC"; do
  if config_equal "$f" "$MERGED"; then
    continue
  fi
  printf '%s\n' "$MERGED" > "$f"
  written=$((written + 1))
done
if [ "$written" -eq 0 ]; then
  echo "global opencode config is up to date"
  exit 0
fi
echo "wrote opencode config: $CONFIG_JSON, $CONFIG_JSONC"
echo "restart opencode to load: plugin, mcp rag-memory, lsp, instructions"