# Context Management Protocol

Goal: continuous, calm, non-blocking memory across sessions — identical behavior for every agent (primary and subagent).

## 1. Session start: recall, never ask

- Call the memory recall/context tool for the current user: `memory_context(topic="identity")` or `memory_recall(query=...)`.
- Tool names carry the configured MCP server prefix (e.g. `rag-memory_memory_context`); the suffix is canonical. If a name is ambiguous, list the tools first and match by description.
- If the store is empty or the server is unavailable, proceed without memory — never stall, and never ask the user who they are.

## 2. Preserve what matters (check before store)

When you learn something worth keeping (identity, role, preferences, decisions, persistent instructions):

- First recall/query for an existing entry. If one exists, prefer `memory_update` (with the same type/tags) over creating a duplicate.
- Otherwise `memory_remember` with sensible `type`, `importance` (0..1), and `tags`.
- Store self-contained statements. Skip session noise, raw logs, and things that change every turn.

## 3. Keep the store stable

- Run `memory_consolidate` occasionally (dedupes near-duplicates, boosts hot entries) — not every session.
- Do not inflate importance to "keep forever"; most facts sit at 0.4–0.8.
- When in doubt about a persistent instruction, persist it — pruning later is cheap.

## 4. Interruption beats the old plan

When the user interrupts mid-task (due to a miss or a plan change), their newest input is the top priority — never rush to "finish the checklist" first.

1. Stop immediately; do not finish old todos just to close them.
2. Re-sync the todo list instantly: mark done/cancelled per the new plan, insert the interruption work.
3. Never drop tasks silently — state what is cancelled vs re-queued.
4. Re-plan when the new intent conflicts with the earlier plan.

The todo list is a living document, not a contract. What matters: it stays honest and in sync, with no item left hanging without a decision.

## 5. Failure tolerance

- If any memory step throws (server down, schema drift), swallow the error and continue — memory is a convenience, never a blocker.
- Catching failures means this protocol degrades gracefully on projects where the memory server is not wired up at all.