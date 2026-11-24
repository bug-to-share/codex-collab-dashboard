# Antigravity × Codex Collaboration Studio

A zero-dependency, real-time local web dashboard (`127.0.0.1:4318`) for monitoring collaboration between **Google Antigravity (Gemini)** and **OpenAI Codex**.

## Features

- **Dual-Model Quota & Usage Panel**:
  - **OpenAI Codex**: Displays live `rate_limits` from Codex sessions (`PLUS` plan badge, 5-hour primary window and 7-day secondary window progress bars with reset timestamps).
  - **Google Gemini (Antigravity)**: Aggregates daily and total token usage across Gemini models (`gemini-4-argon`, `gemini-4-hydrogen`, etc.), cache hit rate, turn count, estimated API cost, and a customizable daily token budget.
- **Unified Interactive Workflow Stream**:
  - Single-screen desktop layout (`100dvh`) with an independent scrollable workflow stream (`#workflow-stream`) and custom inline SVG mascots.
  - Compact 3-line summary cards showing role, turn number, execution duration, status, model, reasoning effort (`low` / `medium` / `high` / `xhigh`), and thinking item count.
  - **Centered Floating Detail Modal**: Click any card to open a modal window displaying written thinking/progress notes (`思考内容`) and the full output/prompt (`完整输出` / `指令全文`) rendered in XSS-safe Markdown.
- **Session Search & Physical Deletion**:
  - Filter sessions by keyword, toggle auto-review sub-threads, and physically delete sessions (`DELETE /api/sessions/:id`) with `realpath` containment checks and automatic empty date-directory pruning.
- **Zero External Dependencies**:
  - Built purely with Node.js (`>= 22`) built-in modules (`node:http`, `node:fs`, `node:test`) and vanilla ES modules.

## Quick Start

```bash
node server.mjs
# Open http://127.0.0.1:4318
```

### Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `4318` | Local loopback port (`127.0.0.1`) |
| `CODEX_SESSIONS_DIR` | `~/.codex/sessions` | Path to Codex session rollout JSONL directory |
| `AGY_BRAIN_DIR` | `~/.gemini/antigravity/brain` | Path to Antigravity conversation brain directory |

## Running Tests

```bash
npm test
```
