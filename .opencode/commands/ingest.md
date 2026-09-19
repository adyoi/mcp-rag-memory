---
description: <rag> Simpan dokumen knowledge (teks atau file)
---
Simpan sebagai dokumen knowledge: $ARGUMENTS

- Jika argumen adalah path file → gunakan `rag_ingest_file`.
- Jika argumen adalah teks → gunakan `rag_ingest_text` (tentukan title + contentType markdown/text sesuai isi, metadata jika ada).

Konfirmasikan id dokumen yang dibuat.