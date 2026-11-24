const $ = id => document.getElementById(id);
const numbers = new Intl.NumberFormat('zh-CN');
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const percents = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
const relative = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
const clock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const statuses = { inProgress: '进行中', completed: '已完成', aborted: '已中断' };
const voices = { gemini: 'Gemini', codex: 'Codex' };
const budgets = [20_000_000, 50_000_000, 100_000_000];
const budgetKey = 'gemini-token-budget';
const deleting = new Set();
const detailBackdrop = $('detail-backdrop');
const detailBody = $('detail-body');
const detailClose = $('detail-close');
const modalBackground = document.querySelectorAll('[data-modal-background]');

let sessions = [];
let selectedId = null;
let activeDetail;
let renderedDetail = '';
let renderedWorkflow = '';
let overviewRequest;
let detailRequest;
let quotaRequest;
let quota;
let refreshTimer;
let liveRefresh = false;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function appendInline(parent, text, depth = 0) {
  // Delimiters are interpreted here. All content is assigned as text.
  const tokens = /(?<![\\`])(`+)(?!`)([^\n]+?)(?<!`)\1(?!`)|(?<![\\*])(?:\*\*(?![\s*])([^\n]+?)\*\*(?!\*)|\*(?![\s*])([^*\n]+)\*(?!\*))/g;
  let offset = 0;
  if (depth < 3) {
    for (const match of text.matchAll(tokens)) {
      const [source, , code, bold, italic] = match;
      if (match.index > offset) parent.append(element('span', '', text.slice(offset, match.index)));
      if (code != null) parent.append(element('code', 'md-inline', code));
      else {
        const emphasis = element(bold != null ? 'strong' : 'em');
        appendInline(emphasis, bold ?? italic, depth + 1);
        parent.append(emphasis);
      }
      offset = match.index + source.length;
    }
  }
  if (offset < text.length) parent.append(element('span', '', text.slice(offset)));
}

function markdownLine(line) {
  const fence = /^ {0,3}(`{3,})[^`]*$/.exec(line);
  if (fence) return { tag: 'pre', fence: fence[1].length };
  const heading = /^ {0,3}#{1,4}(?:[ \t]+|$)(.*)$/.exec(line);
  if (heading) return { tag: 'h4', text: heading[1].replace(/[ \t]+#+[ \t]*$/, '') };
  const unordered = /^ {0,3}[-*][ \t]+(.*)$/.exec(line);
  if (unordered) return { tag: 'ul', text: unordered[1] };
  const ordered = /^ {0,3}(\d{1,9})\.[ \t]+(.*)$/.exec(line);
  if (ordered) return { tag: 'ol', start: Number(ordered[1]), text: ordered[2] };
  const quote = /^ {0,3}>[ \t]?(.*)$/.exec(line);
  if (quote) return { tag: 'blockquote', text: quote[1] };
  return { tag: line.trim() ? 'p' : null, text: line };
}

function* markdownBlocks(text) {
  const lines = text.split(/\r\n?|\n/);
  let index = 0;
  while (index < lines.length) {
    const block = markdownLine(lines[index++]);
    if (!block.tag) continue;
    const content = [];
    if (block.tag === 'pre') {
      while (index < lines.length) {
        const line = lines[index++];
        const closing = /^ {0,3}(`{3,})[ \t]*$/.exec(line);
        if (closing && closing[1].length >= block.fence) break;
        content.push(line);
      }
    } else {
      content.push(block.text);
      while (block.tag !== 'h4' && index < lines.length) {
        const next = markdownLine(lines[index]);
        if (next.tag !== block.tag) break;
        content.push(next.text);
        index++;
      }
    }
    yield { ...block, lines: content };
  }
}

function renderMarkdown(text, className) {
  const body = element('div', className);
  const classes = { h4: 'md-heading', p: 'md-p', ul: 'md-list', ol: 'md-list', pre: 'md-code', blockquote: 'md-quote' };
  for (const { tag, lines, start } of markdownBlocks(text)) {
    const block = element(tag, classes[tag]);
    if (tag === 'pre') {
      block.append(element('code', '', lines.join('\n')));
    } else if (tag === 'ul' || tag === 'ol') {
      if (tag === 'ol' && start !== 1) block.start = start;
      for (const line of lines) {
        const item = element('li');
        appendInline(item, line);
        block.append(item);
      }
    } else {
      appendInline(block, lines.join('\n'));
    }
    body.append(block);
  }
  return body;
}

function renderMarkdownPreview(text) {
  const summary = element('p', 'flow-text');
  let remainingLines = 3;
  for (const { tag, lines } of markdownBlocks(text)) {
    const preview = lines.slice(0, remainingLines).join('\n');
    if (!preview.trim()) continue;
    if (remainingLines < 3) summary.append(element('span', '', '\n'));
    if (tag === 'pre') summary.append(element('code', 'md-inline', preview));
    else appendInline(summary, preview);
    remainingLines -= Math.min(remainingLines, lines.length);
    if (!remainingLines) break;
  }
  return summary;
}

function avatar(role) {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  const use = document.createElementNS(namespace, 'use');
  svg.setAttribute('class', 'avatar');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', '#' + role + '-mascot');
  svg.append(use);
  return svg;
}

function project(session) {
  return session.cwd?.split(/[\\/]/).filter(Boolean).at(-1) || session.threadId;
}

function time(timestamp, relativeTime = false) {
  const date = new Date(timestamp);
  if (!timestamp || Number.isNaN(date.getTime())) return element('span');
  let label = clock.format(date);
  if (relativeTime) {
    const seconds = (date.getTime() - Date.now()) / 1000;
    const [unit, duration] = [['day', 86400], ['hour', 3600], ['minute', 60]]
      .find(([, scale]) => Math.abs(seconds) >= scale) ?? ['second', 1];
    label = relative.format(Math.round(seconds / duration), unit);
  }
  const node = element('time', '', label);
  node.dateTime = date.toISOString();
  node.title = date.toLocaleString('zh-CN');
  if (relativeTime) node.dataset.relative = '';
  return node;
}

function duration(ms) {
  if (!Number.isFinite(ms)) return '—';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function statusPill(status) {
  const badge = element('span', 'pill status-pill', statuses[status] ?? '进行中');
  badge.dataset.status = status;
  return badge;
}

function renderSessions() {
  const list = $('sessions');
  const focused = list.contains(document.activeElement) ? document.activeElement : null;
  $('session-count').textContent = numbers.format(sessions.length);
  const fragment = document.createDocumentFragment();
  let nextFocus;
  for (const session of sessions) {
    const row = element('div', 'session');
    const active = session.threadId === selectedId;
    row.dataset.active = String(active);
    const button = element('button', 'session-select');
    button.type = 'button';
    button.dataset.id = session.threadId;
    if (active) button.setAttribute('aria-current', 'true');
    const header = element('span', 'session-header');
    header.append(element('span', 'session-name', project(session)), statusPill(session.status));
    button.append(header);
    if (session.preview) button.append(element('span', 'session-preview', session.preview));
    const meta = element('span', 'session-meta');
    if (session.model) meta.append(element('span', 'pill model-pill', session.model));
    if (session.isSubthread) meta.append(element('span', 'pill', '子线程'));
    meta.append(time(session.updatedAt, true));
    button.append(meta);
    button.addEventListener('click', () => selectSession(session.threadId));

    const remove = element('button', 'session-delete', '×');
    remove.type = 'button';
    remove.title = '删除此会话';
    remove.setAttribute('aria-label', '删除此会话');
    remove.dataset.id = session.threadId;
    remove.disabled = deleting.has(session.threadId);
    remove.addEventListener('click', event => {
      event.stopPropagation();
      return deleteSession(session.threadId, remove);
    });
    row.append(button, remove);
    fragment.append(row);
    if (focused?.dataset.id === session.threadId) nextFocus = focused.className === 'session-delete' ? remove : button;
  }
  if (!sessions.length) fragment.append(element('p', 'empty', '没有符合条件的会话。'));
  list.replaceChildren(fragment);
  nextFocus?.focus({ preventScroll: true });
}

function renderTrace(trace) {
  const section = element('section', 'flow-trace');
  const list = element('ol', 'trace-list');
  for (const entry of trace) {
    const row = element('li', 'trace-item');
    row.append(
      element('span', 'trace-label', entry.type === 'progress' ? '进度更新' : '思考摘要'),
      renderMarkdown(entry.text, 'trace-text md-body'),
    );
    list.append(row);
  }
  section.append(element('h3', '', '思考内容'), list);
  return section;
}

function flowHeader(node, inDetail = false) {
  const header = element('div', 'flow-header');
  const identity = element('div', 'flow-identity');
  const title = element(inDetail ? 'h2' : 'h3', 'flow-role', voices[node.role]);
  const turn = element('span', 'flow-turn', `Turn #${node.turn} · ${node.role === 'codex' ? '执行响应' : '任务下发'}`);
  if (inDetail) {
    title.id = 'detail-title';
    turn.id = 'detail-turn';
  }
  identity.append(title, turn);
  const when = element('div', 'flow-time');
  when.append(time(node.timestamp), element('span', 'pill', '耗时 ' + duration(node.durationMs)));
  header.append(avatar(node.role), identity, when);
  return header;
}

function flowBadges(node) {
  const badges = element('div', 'meta-pills flow-badges');
  badges.append(statusPill(node.status));
  if (node.model) badges.append(element('span', 'pill', node.model));
  if (node.effort) badges.append(element('span', 'pill', '推理: ' + node.effort));
  if (node.trace?.length) badges.append(element('span', 'pill trace-pill', `思考 ${node.trace.length} 条`));
  return badges;
}

function setCardActive(entry, open) {
  entry.card.dataset.expanded = String(open);
  entry.toggle.setAttribute('aria-expanded', String(open));
  entry.toggle.textContent = open ? '关闭详情窗口' : entry.label;
}

function renderDetailWindow(node) {
  const signature = JSON.stringify(node);
  if (signature === renderedDetail) return;
  renderedDetail = signature;
  $('detail-window').dataset.role = node.role;
  $('detail-heading').replaceChildren(flowHeader(node, true));
  $('detail-badges').replaceChildren(flowBadges(node));
  const scrollTop = detailBody.scrollTop;
  const content = document.createDocumentFragment();
  if (node.role === 'codex' && node.trace?.length) content.append(renderTrace(node.trace));
  const text = renderMarkdown(node.text || '本轮暂无输出。', 'md-body');
  text.id = 'detail-text';
  content.append(
    element('h3', 'output-title', node.role === 'codex' ? '完整输出' : '指令全文'),
    text,
  );
  detailBody.replaceChildren(content);
  detailBody.scrollTop = scrollTop;
}

function closeDetailWindow(focus = activeDetail?.toggle) {
  if (!activeDetail) return;
  setCardActive(activeDetail, false);
  activeDetail = null;
  renderedDetail = '';
  detailBackdrop.hidden = true;
  detailBody.replaceChildren();
  for (const area of modalBackground) area.inert = false;
  focus?.focus({ preventScroll: true });
}

function toggleDetailWindow(entry) {
  if (activeDetail?.node.id === entry.node.id) {
    closeDetailWindow();
    return;
  }
  if (activeDetail) setCardActive(activeDetail, false);
  activeDetail = entry;
  setCardActive(entry, true);
  renderDetailWindow(entry.node);
  detailBackdrop.hidden = false;
  for (const area of modalBackground) area.inert = true;
  detailBody.scrollTop = 0;
  detailClose.focus({ preventScroll: true });
}

function makeFlowNode(node) {
  const isCodex = node.role === 'codex';
  const card = element('article', 'flow-node');
  card.dataset.role = node.role;
  card.dataset.id = node.id;
  const summary = renderMarkdownPreview(node.text || '本轮暂无输出。');
  const toggle = element('button', 'flow-toggle');
  toggle.type = 'button';
  toggle.dataset.id = node.id;
  toggle.setAttribute('aria-controls', 'detail-window');
  toggle.setAttribute('aria-haspopup', 'dialog');
  const label = isCodex ? (node.trace?.length ? '查看思考与完整输出' : '查看完整输出') : '查看指令全文';
  const entry = { node, card, toggle, label };
  toggle.addEventListener('click', event => {
    event.stopPropagation();
    toggleDetailWindow(entry);
  });
  card.addEventListener('click', () => {
    if (!globalThis.getSelection?.()?.toString()) toggleDetailWindow(entry);
  });
  card.append(flowHeader(node), flowBadges(node), summary, toggle);
  return entry;
}

function renderWorkflow(nodes, empty = '此会话暂无协作记录。') {
  const signature = JSON.stringify([nodes, empty]);
  if (signature === renderedWorkflow) return;
  renderedWorkflow = signature;
  const focusId = document.activeElement?.className === 'flow-toggle' ? document.activeElement.dataset.id : null;
  const fragment = document.createDocumentFragment();
  const flow = $('workflow-stream');
  let nextFocus;
  let refreshedDetail;
  for (const node of nodes) {
    const entry = makeFlowNode(node);
    const isActive = activeDetail?.node.id === node.id;
    setCardActive(entry, isActive);
    if (isActive) refreshedDetail = entry;
    if (focusId === node.id) nextFocus = entry.toggle;
    fragment.append(entry.card);
  }
  if (!nodes.length) fragment.append(element('p', 'empty', empty));
  flow.replaceChildren(fragment);
  if (refreshedDetail) {
    activeDetail = refreshedDetail;
    renderDetailWindow(refreshedDetail.node);
  } else if (activeDetail) {
    closeDetailWindow(flow);
  } else {
    nextFocus?.focus({ preventScroll: true });
  }
}

function usageBar(label, value, sublabel) {
  const box = element('div', 'usage-window');
  const header = element('div', 'window-label');
  header.append(element('span', 'window-title', label), element('strong', '', value == null ? '—' : '已用 ' + percents.format(value) + '%'));
  const bar = element('progress', 'usage-bar');
  bar.max = 100;
  bar.value = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
  bar.setAttribute('aria-label', label);
  box.append(header, bar, element('p', 'window-note', sublabel));
  return box;
}

function resetLabel(value) {
  const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
  if (value == null || !Number.isFinite(date.getTime())) return '重置时间 —';
  return '重置于 ' + date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function windowLabel(window, fallback) {
  const m = window?.windowMinutes;
  const label = m > 0 ? (m % 1440 === 0 ? m / 1440 + 'd' : m % 60 === 0 ? m / 60 + 'h' : m + 'm') : fallback;
  return label + ' 限额';
}

function renderQuota() {
  const codex = quota?.codex;
  $('codex-plan').hidden = !codex?.planType;
  $('codex-plan').textContent = String(codex?.planType ?? '').toUpperCase();
  $('codex-windows').replaceChildren(...[['primary', '5h'], ['secondary', '7d']].map(([key, fallback]) => {
    const window = codex?.[key];
    return usageBar(windowLabel(window, fallback), window?.usedPercent, resetLabel(window?.resetsAt));
  }));
  const gemini = quota?.gemini;
  const budget = Number($('token-budget').value) || budgets[1];
  const today = gemini?.todayTotalTokens;
  $('gemini-usage').replaceChildren(usageBar('今日 Tokens', today == null ? null : 100 * today / budget,
    today == null ? '用量暂不可用' : numbers.format(today) + ' / ' + compact.format(budget)));
  $('gemini-metrics').replaceChildren(...(gemini ? [
    '累计 ' + compact.format(gemini.totalTokens) + ' Tokens',
    '缓存命中 ' + percents.format(100 * gemini.cacheHitRate) + '%',
    '调用 ' + numbers.format(gemini.turnsCount) + ' 轮',
    '等效约 $' + gemini.estimatedCostUsd.toFixed(2),
  ].map(text => element('span', '', text)) : []));
  const models = document.createDocumentFragment();
  for (const model of gemini?.models ?? []) {
    const badge = element('span', 'pill model-pill', `${model.model} · ${compact.format(model.totalTokens)}`);
    badge.title = `${model.turns} 轮 · ${numbers.format(model.outputTokens)} 输出 Tokens`;
    models.append(badge);
  }
  $('gemini-models').replaceChildren(models);
}

async function get(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function loadQuota() {
  quotaRequest?.abort();
  const request = new AbortController();
  quotaRequest = request;
  try {
    const data = await get('/api/quota', { signal: request.signal });
    if (quotaRequest !== request) return;
    quota = data;
    renderQuota();
  } catch {
    // Keep the last available quota during a connection interruption.
  }
}

function report(message = '') {
  $('request-status').textContent = message;
  $('request-status').hidden = !message;
}

async function loadDetail(id) {
  detailRequest?.abort();
  if (!id) return;
  const request = new AbortController();
  detailRequest = request;
  try {
    const detail = await get(`/api/sessions/${encodeURIComponent(id)}`, { signal: request.signal });
    if (detailRequest !== request || selectedId !== id) return;
    $('project').textContent = project(detail);
    $('turn-count').textContent = '轮次 ' + numbers.format(detail.turnsCount);
    const tokens = detail.tokens?.total_tokens;
    $('token-count').textContent = 'Tokens ' + (tokens == null ? '—' : numbers.format(tokens));
    $('metadata').hidden = false;
    renderWorkflow(detail.workflow ?? []);
    report();
  } catch (error) {
    if (error.name !== 'AbortError' && detailRequest === request && selectedId === id) report('无法读取此会话。');
  }
}

function selectSession(id) {
  if (id !== selectedId) {
    selectedId = id;
    $('metadata').hidden = true;
    renderWorkflow([], id ? '正在加载会话…' : '请选择一个会话。');
    report();
  }
  renderSessions();
  return loadDetail(id);
}

async function deleteSession(id, button) {
  if (deleting.has(id)) return;
  deleting.add(id);
  button.disabled = true;
  const index = sessions.findIndex(session => session.threadId === id);
  const nextId = selectedId === id ? (sessions[index + 1] ?? sessions[index - 1])?.threadId : null;
  try {
    await get(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await update(true, nextId);
  } catch {
    report('无法删除此会话。');
  } finally {
    deleting.delete(id);
    renderSessions();
  }
}

async function update(live = false, nextId = null) {
  overviewRequest?.abort();
  const request = new AbortController();
  overviewRequest = request;
  if (live || !quota) void loadQuota();
  const query = new URLSearchParams({
    q: $('search').value,
    include_subthreads: $('subthreads').checked ? '1' : '0',
  });
  try {
    const results = await get(`/api/sessions?${query}`, { signal: request.signal });
    if (overviewRequest !== request) return;
    sessions = results;
    report();
    if (!sessions.some(session => session.threadId === selectedId)) {
      if (sessions.length || selectedId) {
        const next = sessions.find(session => session.threadId === nextId) ?? sessions[0];
        await selectSession(next?.threadId ?? null);
      }
      else {
        renderSessions();
        renderWorkflow([], '没有符合条件的会话。');
      }
    } else {
      renderSessions();
      if (live) await loadDetail(selectedId);
    }
  } catch (error) {
    if (error.name !== 'AbortError' && overviewRequest === request) report('无法读取会话列表。');
  }
}

function scheduleUpdate(live = false) {
  liveRefresh ||= live;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    const refresh = liveRefresh;
    liveRefresh = false;
    update(refresh);
  }, 90);
}

const budgetSelect = $('token-budget');
try {
  const saved = Number(localStorage.getItem(budgetKey));
  if (budgets.includes(saved)) budgetSelect.value = String(saved);
} catch {
  // Use the default budget when browser storage is unavailable.
}
budgetSelect.addEventListener('change', () => {
  try { localStorage.setItem(budgetKey, budgetSelect.value); } catch { /* Keep the selection for this page. */ }
  renderQuota();
});
$('search').addEventListener('input', () => scheduleUpdate());
$('subthreads').addEventListener('change', () => scheduleUpdate());
detailClose.addEventListener('click', () => closeDetailWindow());
detailBackdrop.addEventListener('click', event => {
  if (event.target === detailBackdrop) closeDetailWindow();
});
document.addEventListener('keydown', event => {
  if (!activeDetail) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeDetailWindow();
  } else if (event.key === 'Tab') {
    event.preventDefault();
    const focused = document.activeElement;
    const next = focused === detailClose || (focused !== detailBody && event.shiftKey) ? detailBody : detailClose;
    next.focus({ preventScroll: true });
  }
});

const stream = new EventSource('/api/stream');
function showConnection() {
  const live = stream.readyState === EventSource.OPEN;
  $('connection').dataset.state = live ? 'live' : 'pending';
  $('connection').textContent = live ? '实时连接' : '正在重新连接';
}
stream.addEventListener('open', () => {
  showConnection();
  scheduleUpdate(true);
});
stream.addEventListener('error', showConnection);
stream.addEventListener('sessions_updated', () => scheduleUpdate(true));
stream.addEventListener('session_append', () => scheduleUpdate(true));
setInterval(() => {
  for (const node of document.querySelectorAll('time[data-relative]')) {
    node.textContent = time(node.dateTime, true).textContent;
  }
}, 30_000);
renderQuota();
update();
