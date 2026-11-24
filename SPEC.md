# Specification v3: Clean & Elegant Unified Workflow Studio (Antigravity × Codex)

## 1. Visual Direction & Terminology (User Feedback #1)
- **Aesthetic**: Clean, modern, elegant light theme (inspired by Linear / Notion / Vercel Light):
  - Crisp neutral surfaces (`#F8FAFC` page background, `#FFFFFF` cards, `#F1F5F9` subtle badges, `1px solid #E2E8F0` borders, subtle refined shadows `0 1px 3px rgba(15, 23, 42, 0.06)`).
  - Refined accent colors: Indigo/Violet (`#4F46E5` / `#EEF2FF`) for **Gemini**, Emerald/Teal (`#059669` / `#ECFDF5`) for **Codex**, Slate (`#0F172A` / `#64748B`) for typography.
- **Keep the 2 Custom SVG Mascots**: Keep `<symbol id="gemini-mascot">` and `<symbol id="codex-mascot">` in `public/index.html` as tasteful, fun avatar icons!
- **Professional & Concise Copywriting (NO childish terms)**:
  - **NEVER** use childish words like `"闯关"`, `"关卡"`, `"糖果"`, `"小工匠"`, `"队长"`, `"任务小本本"`, `"悄悄话"`, `"努力施工中"`, `"默默施工"`.
  - Use clean, professional Chinese/English labels:
    - Brand title: `Antigravity × Codex` · `协作工作台`
    - Roles: `Gemini` and `Codex`
    - Sidebar: `任务列表` (Sessions), `搜索会话...`, `显示自动审查子线程`
    - Main Stage: `协作工作流` (Workflow Stream)
    - Statuses: `进行中` (`inProgress`), `已完成` (`completed`), `已中断` (`aborted`)
    - Metrics: `轮次` (Turns), `Tokens`, `耗时` (Duration)

## 2. Unified Interactive Workflow Stream (User Feedback #2)
- **Merge the Workflow Diagram and Text Dialogue into ONE Unified Vertical Connected Flow (`#workflow-stream`)**:
  - Remove the separate bottom `#dialogue-drawer`. Instead, render a single chronological connected workflow stream where consecutive nodes are visually linked by a clean vertical connector line.
  - Each workflow node (`article.flow-node` / expandable card) represents either a **Gemini Request/Dispatch** or a **Codex Execution Turn**:
    - **Default (Collapsed) View of a Node**:
      - **Header Bar**:
        - Role SVG avatar (`#gemini-mascot` or `#codex-mascot`) + Role Name (`Gemini` or `Codex`) + Turn label (e.g. `Turn #1 · 任务下发` or `Turn #1 · 执行响应`).
        - Metadata badges:
          - **Model name** (`model`, e.g. `gpt-6.2-sol` or `gemini-4-argon-high`)
          - **Reasoning effort** (`effort`, e.g. `推理: xhigh` / `high` / `medium` / `low` when available, from dispatch args or rollout `configuration_update` `payload.reasoning.effort`)
          - **Work time & duration** (`timestamp` HH:mm:ss + turn `durationMs` formatted like `耗时 1m 42s` or `12s` computed from turn start to turn end/latest event)
          - **Work status** (`已完成` / `进行中` / `已中断`)
          - For Codex nodes: concise trace summary pill (e.g. `思考 3 步 · 动作 6 项`).
      - **Summary Body (Always visible)**:
        - Shows the clean **Final Output** (for Codex nodes) or **Task Prompt** (for Gemini nodes), clamped to 3 lines by default when collapsed.
      - **Expand Toggle Button**:
        - Clicking the card or its `展开思考过程与完整输出` / `收起详情` button toggles `data-expanded="true"` (`aria-expanded="true"`).
    - **Expanded View of a Node (`data-expanded="true"`)**:
      - **Section A — 思考过程与动作轨迹 (Thinking & Action Trace)** (for Codex nodes):
        - Displays intermediate progress messages (earlier assistant updates in that turn), reasoning summaries (`reasoning` text or compact `推理步骤 × N`), and compact single-line action pills/rows (e.g. `执行命令: npm test`, `修改文件: public/app.js` — **never** dump multi-line raw terminal output or code blocks).
      - **Section B — 完整输出 / 指令全文 (Full Output / Prompt)**:
        - Full un-clamped text of the final output or prompt.

## 3. Session Physical Deletion (User Feedback #3)
- **Backend (`lib/store.mjs` & `server.mjs`)**:
  - Support `DELETE /api/sessions/:id` (in addition to `GET` routes; update `Allow: GET, DELETE`).
  - `await store.deleteSession(id)`:
    - Look up the session by `threadId === id`. If not found, return `404`.
    - Verify via `realpath` that `session.file` is strictly inside `realpath(this.codexDir)`.
    - Physically delete `session.file` via `unlink(session.file)`.
    - Also delete any sub-thread rollout files in `this.sessions` whose `parentThreadId === id` (if inside `this.codexDir`).
    - If `options.codexBin` (or `/Users/saymyname/.local/bin/codex`) exists and `id` is a valid UUID (`^[0-9a-f-]{36}$/i`), run `execFile(codexBin, ['delete', '--force', id])` best-effort (ignoring errors so tests without codex binary still pass cleanly).
    - Remove from `this.files` / `this.sessions`, rebuild store state, emit `sessions_updated`, and return `200 { deleted: id }`.
- **Frontend (`public/app.js`, `public/styles.css`)**:
  - Each session row in the left sidebar includes a subtle delete button (`button.session-delete`, title `删除此会话`, text `×`) on the right.
  - Clicking `×` stops propagation and deletes the session via `fetch('/api/sessions/' + encodeURIComponent(id), { method: 'DELETE' })`, then refreshes the session list and selects the next available session.

## 4. Dual-Model Quota & Usage Bar (User Feedback #4)
- **Parser (`lib/parser.mjs`)**:
  - In `parseRollout` / `appendRollout`:
    - When `type === "response_item"` and `payload.type === "configuration_update"`, capture `session.effort = payload.reasoning?.effort ?? session.effort`.
    - When `type === "event_msg"` and `payload.type === "token_count"`, in addition to `session.tokens`, capture `session.rateLimits = payload.rate_limits ?? session.rateLimits` (along with `session.rateLimitsUpdatedAt = timestamp`).
    - Also track per-turn timing (`turnStartedAt`, `turnCompletedAt`, `durationMs`) and group intermediate assistant messages, reasoning summaries, and compact single-line action summaries (`执行命令: ...`, `修改文件: ...`) so the frontend can render the Unified Workflow Stream effortlessly!
  - In `parseTranscript` / `appendTranscript`:
    - For `type === "PLANNER_RESPONSE"`, aggregate Gemini token usage across steps: `model` (`step.model || 'gemini'`), `input_tokens`, `cache_read_tokens`, `output_tokens`, `created_at`.
- **Store & API (`lib/store.mjs` & `server.mjs`)**:
  - Expose `store.quota()` and `GET /api/quota` (and include `quota` in `/api/sessions` or fetch `/api/quota` on load & SSE update):
    - `codex`:
      - Latest `rateLimits` across all rollout files (`planType`: `rate_limits.plan_type`, `primary`: `{ usedPercent: primary.used_percent, windowMinutes: primary.window_minutes, resetsAt }`, `secondary`: `{ usedPercent: secondary.used_percent, windowMinutes: secondary.window_minutes, resetsAt }`).
      - `totalTokens`: sum of `total_tokens` across discovered Codex sessions.
      - `sessionsCount`: number of root sessions.
    - `gemini`:
      - Aggregated across discovered Antigravity transcripts: `totalInputTokens`, `totalCacheReadTokens`, `totalOutputTokens`, `totalTokens` (`input + cache_read + output`), `cacheHitRate` (`cache_read / (input + cache_read)`), `turnsCount`, `estimatedCostUsd` (using ~$2/1M input, ~$0.15/1M cached input, ~$10/1M output), and per-model breakdown array `models: [{ model, turns, totalTokens, outputTokens }]`.
- **Frontend Top Quota Bar (`#quota-panel` in `public/index.html`)**:
  - Display two sleek side-by-side quota cards below or inside the top header:
    1. **OpenAI Codex 额度 (Plus)**:
       - 5小时窗口进度条 (`5h 限额: 已用 X%` + reset time) & 7天周限额进度条 (`7d 限额: 已用 Y%` + reset time).
    2. **Google Gemini 用量 (Antigravity)**:
       - 累计/今日 Token 进度条 against a user-adjustable token budget (default `50,000,000` tokens, editable or selectable, persisted in `localStorage`), plus `缓存命中率 X%`, `调用 N 轮`, `等效约 $X.XX`, and model pills (`gemini-4-argon-high`, `gemini-4-hydrogen-high`).
