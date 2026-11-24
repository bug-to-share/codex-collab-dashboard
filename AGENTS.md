# Codex Collaboration Dashboard — Project Guidelines

- Runtime: Node.js >= 22 (ESM `.mjs` modules), **zero external npm dependencies** (use only built-in `node:*` modules).
- Security:
  - Bind HTTP server strictly to `127.0.0.1` (default port `4318`, configurable via `PORT` env var).
  - Never modify files inside `~/.gemini/antigravity/brain` (strictly read-only).
  - For `~/.codex/sessions` (`CODEX_SESSIONS_DIR`), reading is read-only EXCEPT for `DELETE /api/sessions/:id`, which may ONLY delete a known session rollout file verified via `realpath` to reside strictly inside `CODEX_SESSIONS_DIR` (and optionally invoke `codex delete --force <threadId>` when a valid UUID).
  - Escape all rendered text in HTML/DOM (`textContent`) to prevent XSS.
- Code style: Clean, modular functions with shallow nesting (`lib/parser.mjs`, `lib/store.mjs`, `server.mjs`, `public/index.html`, `public/app.js`, `public/styles.css`).
- Testing: Put unit/integration tests under `test/*.test.mjs` using `node:test` and `node:assert/strict` with synthetic fixture files.
- Verification: Ensure `npm test` passes completely before finishing.
