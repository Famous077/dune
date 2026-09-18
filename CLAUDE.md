# Dune

Specs live in `docs/`. Read them before implementing anything.

- `docs/03-API.md` is authoritative. If code disagrees with it, the code is wrong.
- `docs/01-BACKEND.md` "Order of work" is the build sequence. Do not skip ahead.
- Scope is fixed. Do not add features listed as "Extended" in `docs/00-PRD.md`.
- TypeScript and TSX only. Do not add other language support.
- Every API response must match the shapes in `docs/03-API.md`, with null instead of missing keys.

Region: ap-south-1.

Embeddings and generation sit behind provider interfaces. Embeddings default to a local model
(`@xenova/transformers`, `all-MiniLM-L6-v2`). Generation uses Gemini by default, with Groq as an
alternative (`GENERATOR` selects; model ids in `GEMINI_MODEL` / `GROQ_MODEL`; keys in the gitignored
`.env`, never committed). Bedrock (`global.anthropic.claude-sonnet-4-6`) is another implementation of
the same interfaces, but our model access is blocked, so do not write code that assumes Bedrock is
available.