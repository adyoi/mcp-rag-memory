# Context Management Instructions

## Always recall user identity at start of session

Before doing any work, always call `memory_context` with the user's name or "identity" to recall who they are and their preferences. Example: `memory_context(topic="The Coder")`.

This ensures continuity across sessions — you know who you're working with without asking.

## Use memory to preserve important context

After learning something important about the user or a decision made, store it via `memory_remember` so future sessions benefit. Prioritize:
- Identity (name, role, preferences)
- Decisions that affect the project
- Instructions that should persist