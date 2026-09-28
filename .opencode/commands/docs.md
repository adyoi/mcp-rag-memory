---
description: <rag> List knowledge documents
---
Call `rag_list_documents` and show the documents with their available metadata (document id, title, metadata), plus the returned `total`.

The tool is paginated: pass `limit` (1–1000, default 100) and `offset` to walk the whole store — if `total` is larger than the page you received, call it again with the next `offset` instead of asking for a huge `limit`.
