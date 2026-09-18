# Context Management Instructions

## Always recall user identity at start of session

Before doing any work, always call `memory_context` with the user's name or "identity" to recall who they are and their preferences. Example: `memory_context(topic="The Coder")`.

This ensures continuity across sessions — you know who you're working with without asking.

## Use memory to preserve important context

After learning something important about the user or a decision made, store it via `memory_remember` so future sessions benefit. Prioritize:
- Identity (name, role, preferences)
- Decisions that affect the project
- Instructions that should persist

## Interruption beats the old plan

When the user interrupts mid-task (due to a miss or a plan change), their
newest input is the top priority — never rush to "finish the checklist"
first.

1. Stop the current task immediately; do not finish old todos just to close them.
2. Re-sync the todo list instantly: mark done/cancelled per the new plan,
   insert the interruption task.
3. Never drop tasks silently — explicitly say what is cancelled vs re-queued.
4. Re-plan when the new intent conflicts with the earlier plan.

The todo list is a living document, not a contract. What matters is that it
stays honest and in sync — no item left hanging without a decision.