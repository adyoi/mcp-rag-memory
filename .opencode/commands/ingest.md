---
description: <rag> Store a knowledge document (text or file)
---
Store as a knowledge document: $ARGUMENTS

- If the argument is a file path, use `rag_ingest_file`.
- If the argument is text, use `rag_ingest_text` (pick title + contentType markdown/text to match the content, metadata if any).

Confirm the created document id.