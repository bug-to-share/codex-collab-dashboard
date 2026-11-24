import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { appendFile, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createStore } from '../lib/store.mjs';
import { dispatch, event, fixture, lines, message, meta, response, rollout, seed, stamp } from './fixtures.mjs';

test('store discovers both sources, sorts and filters sessions, and links their timelines', async t => {
  const paths = await seed(t);
  const store = createStore(paths);
  await store.scan();
  assert.deepEqual(store.list().map(row => row.threadId), ['main']);
  assert.deepEqual(store.list({ includeSubthreads: true }).map(row => row.threadId), ['review', 'main']);
  assert.equal(store.list({ q: 'DASHBOARD' })[0].linkedAgyCallsCount, 1);
  assert.equal(store.list({ q: 'nope' }).length, 0);
  assert.equal(store.detail('main').timeline[0].type, 'dispatch');
  assert.equal(store.detail('main').timeline[1].text, 'Implement the dashboard');
  assert.equal(store.detail('review').parentThreadId, 'main');
});

test('store advances byte offsets only for complete UTF-8 records and emits one append', async t => {
  const paths = await fixture(t);
  const initial = lines(meta('main'));
  await writeFile(paths.codexFile, initial);
  const store = createStore(paths);
  await store.scan();
  const originalState = store.files.get(paths.codexFile).state;
  const next = Buffer.from(lines(message('user', 'Build 🧪', 1)));
  const split = next.indexOf(Buffer.from('🧪')) + 1;
  await appendFile(paths.codexFile, next.subarray(0, split));
  await store.scan();
  assert.equal(store.files.get(paths.codexFile).offset, Buffer.byteLength(initial));
  assert.equal(store.detail('main').timeline.length, 0);
  const received = once(store, 'session_append');
  await appendFile(paths.codexFile, next.subarray(split));
  await store.scan();
  const [append] = await received;
  assert.equal(store.files.get(paths.codexFile).state, originalState);
  assert.equal(append.offset, Buffer.byteLength(initial) + next.length);
  assert.deepEqual(append.newEvents.map(event => event.text), ['Build 🧪']);
  await store.scan();
  assert.equal(store.detail('main').timeline.length, 1);
});

test('store handles replacements, same-path truncation and deletion', async t => {
  const paths = await seed(t);
  const store = createStore(paths);
  await store.scan();
  await writeFile(paths.codexFile + '.new', lines(meta('replacement')).trimEnd());
  await rename(paths.codexFile + '.new', paths.codexFile);
  await store.scan();
  assert.equal(store.detail('main'), null);
  assert.equal(store.detail('replacement').turnsCount, 0);
  await writeFile(paths.codexFile, lines(meta('short')));
  await store.scan();
  assert.deepEqual(store.list().map(row => row.threadId), ['short']);
  await rm(paths.codexFile);
  await store.scan();
  assert.deepEqual(store.list(), []);
});

test('fallback polling picks up late transcripts and updates correlation after tool results', async t => {
  const paths = await fixture(t);
  await writeFile(paths.codexFile, lines(meta('main')));
  const store = createStore({ ...paths, pollInterval: 25 });
  store.watchDirectories = () => {};
  t.after(() => store.stop());
  await store.start();
  store.timer.ref();
  const updated = () => once(store, 'sessions_updated', { signal: AbortSignal.timeout(2000) });
  let change = updated();
  await writeFile(paths.agyFile, lines(dispatch({ prompt: 'Unmatched initially' }, 1)));
  await change;
  assert.equal(store.calls[0].sessionId, null);
  change = updated();
  await appendFile(paths.agyFile, lines({ type: 'TOOL_RESULT', tool_call_id: 'call-1', content: { thread_id: 'main' } }));
  await change;
  assert.equal(store.detail('main').orchestratorCalls[0].sessionId, 'main');
});

function savedResult(path) {
  return { type: 'GENERIC', source: 'MODEL', content: 'The output was large and was saved to: ' + pathToFileURL(path) };
}

test('store links a saved output written after its transcript, without an inline ID or matching prompt', async t => {
  const paths = await fixture(t);
  const output = join(dirname(paths.agyFile), '..', 'steps', '236 spaced', 'output.txt');
  await writeFile(paths.codexFile, lines(meta('main')));
  await writeFile(paths.agyFile, lines(dispatch({ prompt: 'Different from session preview' }, 1), savedResult(output)));
  const store = createStore(paths);
  await store.scan();
  assert.equal(store.calls[0].sessionId, null);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, 'Created At: just now\nOutput still being written\n');
  await store.scan();
  assert.equal(store.calls[0].sessionId, null);

  const changed = once(store, 'sessions_updated');
  await appendFile(output, '{\n  "thread_id":\n    "main"\n}\n');
  await store.scan();
  await changed;
  assert.equal(store.calls[0].threadId, 'main');
  assert.equal(store.detail('main').timeline[0].type, 'dispatch');
  assert.equal(store.detail('main').linkedAgyCallsCount, 1);
});

test('store ignores saved output paths outside the brain, including symlink escapes', async t => {
  const paths = await fixture(t);
  const outside = paths.agyDir + '-other';
  const externalFile = join(outside, 'output.txt');
  const linkDir = join(paths.agyDir, 'linked');
  const linkFile = join(paths.agyDir, 'output.txt');
  await mkdir(outside);
  await writeFile(externalFile, '{"thread_id":"main"}');
  await symlink(outside, linkDir);
  await symlink(externalFile, linkFile);
  await writeFile(paths.codexFile, lines(meta('main')));
  await writeFile(paths.agyFile, lines(
    dispatch({}, 1), savedResult(externalFile),
    dispatch({}, 2), savedResult(join(linkDir, 'output.txt')),
    dispatch({}, 3), savedResult(linkFile),
  ));
  const store = createStore(paths);
  await store.scan();
  assert.deepEqual(store.calls.map(call => call.sessionId), [null, null, null]);
});

class TestNode {
  #text = '';

  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
  }

  set innerHTML(_) { assert.fail('Dynamic content must not be assigned as HTML'); }
  set outerHTML(_) { assert.fail('Dynamic content must not be assigned as HTML'); }
  insertAdjacentHTML() { assert.fail('Dynamic content must not be inserted as HTML'); }
  set textContent(text) { this.#text = text; this.children = []; }
  get textContent() { return this.#text + this.children.map(node => node.textContent).join(''); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  append(...children) {
    this.children.push(...children.flatMap(node => node.tag === '#fragment' ? node.children : [node]));
  }
  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  focus() { this.focused = true; }
  click(target = this) { return this.listeners.get('click')?.({ target, stopPropagation() {} }); }
}

function descendants(node) {
  return node.children.flatMap(child => [child, ...descendants(child)]);
}

test('workflow previews and live detail windows render Markdown while keeping HTML literal', async t => {
  const paths = await fixture(t);
  const image = '<img src=x onerror=alert(1)>';
  const script = '<script>alert(1)</script>';
  const prompt = image + ' 请更新**流程图**';
  const progress = '正在检查 `节点`。';
  const reasoning = '> 已检查 **流程数据**。';
  const codeSample = '  const marker = "**literal**";\n' + script;
  const reply = [
    '# **流程图已完成**', '复核 `npm test` 和 *检查项*。', '',
    '- **通过**', '* `public/app.js`', '', '1. 安全', '2. 样式', '',
    '> 审核 *完成*', '', '```js', codeSample, '```', '', script,
  ].join('\n');
  await writeFile(paths.codexFile, lines(
    meta('main', {}, 1),
    rollout('turn_context', { turn_id: 't1', model: 'gpt-fixture' }, 2),
    event('task_started', { turn_id: 't1' }, 3),
    response('configuration_update', { reasoning: { effort: 'high' } }, 3),
    message('user', prompt, 4),
    response('function_call', { call_id: 'work', name: 'exec', arguments: JSON.stringify({ cmd: 'npm test\nHIDDEN COMMAND BODY' }) }, 5),
    response('function_call_output', { call_id: 'work', output: 'HIDDEN TERMINAL OUTPUT' }, 6),
    message('assistant', progress, 7),
    message('assistant', '::browser-complete{title="INTERNAL HARNESS"}', 8),
    event('item_completed', { item: { type: 'CommandExecution', command: '/bin/zsh -lc npm test\nHIDDEN COMMAND BODY' } }, 8),
    event('item_completed', { item: { type: 'FileChange', changes: [{ path: 'public/app.js' }] } }, 9),
    response('function_call', { call_id: 'inspect', name: 'inspect_context', arguments: '{}' }, 9),
    response('reasoning', { summary: [{ text: reasoning }] }, 9),
    response('reasoning', { encrypted_content: 'HIDDEN REASONING' }, 10),
    response('reasoning', { summary: [{ text: '   ' }] }, 10),
    message('assistant', reply, 11),
    event('task_complete', { turn_id: 't1' }, 65),
    rollout('turn_context', { turn_id: 't2' }, 66),
    event('task_started', { turn_id: 't2' }, 66),
    message('user', prompt, 67),
    response('reasoning', { summary: [{ text: '推理步骤' }] }, 67),
    message('assistant', '第二轮回复。', 68),
  ));
  await writeFile(paths.agyFile, lines(
    dispatch({ prompt, thread_id: 'main', model: 'gemini-fixture', effort: 'xhigh' }, 0),
    { type: 'PLANNER_RESPONSE', model: 'gemini-fixture', input_tokens: 1_000_000, cache_read_tokens: 1_000_000, created_at: new Date().toISOString() },
  ));
  await writeFile(join(dirname(paths.codexFile), 'rollout-second.jsonl'), lines(
    meta('second', {}, 1), message('user', '另一项任务', 2),
  ));
  const store = createStore(paths);
  await store.scan();
  const { workflow } = store.detail('main');
  assert.deepEqual(workflow.map(node => [node.role, node.turn, node.text]), [
    ['gemini', 1, prompt], ['codex', 1, reply], ['gemini', 2, prompt], ['codex', 2, '第二轮回复。'],
  ]);
  assert.deepEqual(workflow[1].trace, [
    { type: 'progress', text: progress },
    { type: 'reasoning', text: reasoning },
  ]);
  assert.deepEqual(workflow[3].trace, []);
  assert.equal(workflow[1].durationMs, 62000);
  assert.equal(workflow[1].turnStartedAt, '2026-01-01T12:00:03.000Z');
  assert.equal(workflow[1].turnCompletedAt, '2026-01-01T12:01:05.000Z');
  assert.equal(workflow[1].effort, 'high');
  assert.equal(workflow[1].status, 'completed');
  assert.equal(workflow[3].status, 'inProgress');
  assert.equal(workflow[3].durationMs, 2000);

  const [app, html, styles] = await Promise.all(['app.js', 'index.html', 'styles.css'].map(file =>
    readFile(new URL('../public/' + file, import.meta.url), 'utf8')));
  assert.match(html, /id="workflow-stream"/);
  assert.match(html, /id="quota-panel"/);
  assert.doesNotMatch(html + app, /闯关|关卡|糖果|小工匠|队长|任务小本本|悄悄话|努力施工中|默默施工|dialogue-drawer/);
  assert.match(html, /<symbol id="gemini-mascot"/);
  assert.match(html, /<symbol id="codex-mascot"/);
  assert.match(html, /id="detail-backdrop" hidden/);
  assert.match(html, /id="detail-window" role="dialog" aria-modal="true"/);
  assert.match(styles, /\.flow-node \.flow-text\s*\{[^}]*height:\s*3lh;[^}]*-webkit-line-clamp:\s*3/);
  assert.match(styles, /#detail-body\s*\{[^}]*overflow-y:\s*auto/);

  const nodes = new Map();
  function getNode(id) {
    if (!nodes.has(id)) nodes.set(id, new TestNode('div'));
    return nodes.get(id);
  }
  const storage = new Map([['gemini-token-budget', '20000000']]);
  const requests = [];
  const streamListeners = new Map();
  const documentListeners = new Map();
  const backdrop = getNode('detail-backdrop');
  const modal = getNode('detail-window');
  const modalBody = getNode('detail-body');
  const close = getNode('detail-close');
  const background = [new TestNode('header'), new TestNode('main')];
  backdrop.hidden = true;
  let pendingRefresh;
  runInNewContext(app, {
    document: {
      createElement: tag => new TestNode(tag),
      createElementNS: (_, tag) => new TestNode(tag),
      createDocumentFragment: () => new TestNode('#fragment'),
      getElementById: getNode,
      querySelectorAll: selector => selector === '[data-modal-background]' ? background : [],
      addEventListener: (type, listener) => documentListeners.set(type, listener),
    },
    fetch: async (path, options) => {
      requests.push([path, options?.method]);
      return {
        ok: true,
        json: async () => {
          if (path === '/api/quota') return store.quota();
          if (path.startsWith('/api/sessions?')) return store.list();
          const id = decodeURIComponent(path.split('/').at(-1));
          if (options?.method === 'DELETE') return (await store.deleteSession(id)).body;
          return store.detail(id);
        },
      };
    },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    EventSource: class {
      addEventListener(type, listener) { streamListeners.set(type, listener); }
    },
    AbortController, URLSearchParams, setInterval() {},
    setTimeout(callback) { pendingRefresh = callback; },
    clearTimeout() { pendingRefresh = undefined; },
  });
  await setImmediate();

  const flow = getNode('workflow-stream');
  const cards = flow.children;
  assert.deepEqual(cards.map(node => [node.tag, node.dataset.role, node.dataset.expanded]), [
    ['article', 'gemini', 'false'], ['article', 'codex', 'false'], ['article', 'gemini', 'false'], ['article', 'codex', 'false'],
  ]);
  const responseNodes = descendants(cards[1]);
  const toggle = responseNodes.find(node => node.className === 'flow-toggle');
  const output = responseNodes.find(node => node.className === 'flow-text');
  assert.equal(backdrop.hidden, true);
  assert.equal(toggle.textContent, '查看思考与完整输出');
  assert.equal(toggle.getAttribute('aria-controls'), 'detail-window');
  assert.equal(toggle.getAttribute('aria-haspopup'), 'dialog');
  assert.ok(responseNodes.some(node => node.textContent === 'Turn #1 · 执行响应'));
  assert.ok(responseNodes.some(node => node.textContent === '思考 2 条'));
  assert.ok(responseNodes.some(node => node.textContent === '耗时 1m 2s'));
  assert.ok(responseNodes.some(node => node.textContent === '推理: high'));
  assert.ok(descendants(cards[0]).some(node => node.textContent === '推理: xhigh'));
  assert.equal(output.textContent, '流程图已完成\n复核 npm test 和 检查项。\n通过');
  assert.ok(descendants(output).some(node => node.tag === 'strong' && node.textContent === '流程图已完成'));
  assert.ok(descendants(output).some(node => node.tag === 'code' && node.className === 'md-inline' && node.textContent === 'npm test'));
  assert.ok(descendants(flow).every(node => !['flow-trace', 'output-title'].includes(node.className)));

  cards[1].click();
  assert.equal(backdrop.hidden, false);
  assert.equal(cards[1].dataset.expanded, 'true');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(toggle.textContent, '关闭详情窗口');
  assert.equal(close.focused, true);
  assert.ok(background.every(area => area.inert));
  assert.equal(modal.dataset.role, 'codex');
  assert.ok(descendants(getNode('detail-heading')).some(node => node.id === 'detail-title' && node.textContent === 'Codex'));
  assert.ok(descendants(getNode('detail-heading')).some(node => node.getAttribute('href') === '#codex-mascot'));
  assert.ok(descendants(getNode('detail-badges')).some(node => node.textContent === '思考 2 条'));
  assert.deepEqual(descendants(cards[1]), responseNodes);
  const trace = modalBody.children.find(node => node.className === 'flow-trace');
  assert.equal(trace.children[0].textContent, '思考内容');
  const thoughts = descendants(trace).filter(node => node.className === 'trace-text md-body');
  assert.deepEqual(thoughts.map(node => node.textContent), [
    '正在检查 节点。', '已检查 流程数据。',
  ]);
  assert.ok(descendants(thoughts[0]).some(node => node.tag === 'code' && node.textContent === '节点'));
  assert.equal(thoughts[1].children[0].tag, 'blockquote');

  assert.ok(modalBody.children.some(node => node.textContent === '完整输出'));
  const detailText = modalBody.children.find(node => node.id === 'detail-text');
  assert.deepEqual(detailText.children.map(node => node.tag), ['h4', 'p', 'ul', 'ol', 'blockquote', 'pre', 'p']);
  const [heading, paragraph, unordered, ordered, quote, fenced, literal] = detailText.children;
  assert.ok(descendants(heading).some(node => node.tag === 'strong' && node.textContent === '流程图已完成'));
  assert.equal(paragraph.className, 'md-p');
  assert.ok(descendants(paragraph).some(node => node.tag === 'em' && node.textContent === '检查项'));
  assert.equal(unordered.className, 'md-list');
  assert.deepEqual(unordered.children.map(node => [node.tag, node.textContent]), [['li', '通过'], ['li', 'public/app.js']]);
  assert.deepEqual(ordered.children.map(node => [node.tag, node.textContent]), [['li', '安全'], ['li', '样式']]);
  assert.equal(quote.className, 'md-quote');
  assert.ok(descendants(quote).some(node => node.tag === 'em' && node.textContent === '完成'));
  assert.equal(fenced.className, 'md-code');
  assert.deepEqual(fenced.children.map(node => [node.tag, node.textContent]), [['code', codeSample]]);
  assert.equal(literal.textContent, script);
  assert.ok([...descendants(flow), ...descendants(modalBody)].every(node => !['img', 'script'].includes(node.tag)
    && !/HIDDEN|INTERNAL|执行命令|修改文件|调用工具|\[Reasoning step\]|推理步骤/.test(node.textContent ?? '')));

  cards[1].click();
  assert.equal(backdrop.hidden, true);
  assert.equal(cards[1].dataset.expanded, 'false');
  assert.equal(toggle.textContent, '查看思考与完整输出');
  assert.equal(toggle.focused, true);
  assert.ok(background.every(area => !area.inert));
  toggle.click();
  close.click();
  assert.equal(backdrop.hidden, true);
  const geminiToggle = descendants(cards[0]).find(node => node.className === 'flow-toggle');
  assert.equal(geminiToggle.textContent, '查看指令全文');
  geminiToggle.click();
  assert.equal(modal.dataset.role, 'gemini');
  assert.deepEqual(modalBody.children.map(node => node.textContent), ['指令全文', image + ' 请更新流程图']);
  assert.ok(descendants(modalBody).some(node => node.tag === 'span' && node.textContent.startsWith(image)));
  assert.ok(descendants(modalBody).every(node => node.tag !== 'img' && !node.attributes.has('onerror')));
  backdrop.click(modal);
  assert.equal(backdrop.hidden, false);
  backdrop.click();
  assert.equal(backdrop.hidden, true);
  toggle.click();
  documentListeners.get('keydown')({ key: 'Escape', preventDefault() {} });
  assert.equal(backdrop.hidden, true);

  assert.equal(getNode('token-budget').value, '20000000');
  assert.ok(descendants(getNode('gemini-usage')).some(node => node.textContent === '已用 10%'));
  getNode('token-budget').value = '100000000';
  getNode('token-budget').listeners.get('change')();
  assert.equal(storage.get('gemini-token-budget'), '100000000');
  assert.ok(descendants(getNode('gemini-usage')).some(node => node.textContent === '已用 2%'));

  const secondTurnId = cards[3].dataset.id;
  const outputOnly = descendants(cards[3]);
  const outputToggle = outputOnly.find(node => node.className === 'flow-toggle');
  assert.equal(outputToggle.textContent, '查看完整输出');
  assert.ok(outputOnly.every(node => node.className !== 'flow-trace' && node.className !== 'pill trace-pill'));
  outputToggle.click();
  assert.equal(cards[3].dataset.expanded, 'true');
  assert.deepEqual(modalBody.children.map(node => node.textContent), ['完整输出', '第二轮回复。']);
  modalBody.scrollTop = 42;
  await appendFile(paths.codexFile, lines(message('assistant', '实时追加的回复。', 69)));
  await store.scan();
  streamListeners.get('session_append')();
  pendingRefresh();
  await setImmediate();
  assert.equal(flow.children.at(-1).dataset.id, secondTurnId);
  assert.equal(flow.children.at(-1).dataset.expanded, 'true');
  assert.equal(backdrop.hidden, false);
  assert.equal(modalBody.scrollTop, 42);
  assert.ok(descendants(flow.children.at(-1)).some(node => node.textContent === '实时追加的回复。'));
  assert.ok(modalBody.children.some(node => node.id === 'detail-text' && node.textContent === '实时追加的回复。'));
  assert.ok(descendants(modalBody).some(node => node.className === 'trace-text md-body' && node.textContent === '第二轮回复。'));

  const saved = await readFile(paths.codexFile, 'utf8');
  const firstTurn = saved.trimEnd().split('\n').filter(line => JSON.parse(line).timestamp <= stamp(65));
  await writeFile(paths.codexFile, firstTurn.join('\n') + '\n');
  await store.scan();
  streamListeners.get('sessions_updated')();
  pendingRefresh();
  await setImmediate();
  assert.equal(backdrop.hidden, true);
  assert.equal(flow.focused, true);
  assert.ok(flow.children.every(node => node.dataset.expanded === 'false'));

  await getNode('sessions').children[0].children.find(node => node.className === 'session-delete').click();
  assert.ok(requests.some(([path, method]) => path === '/api/sessions/main' && method === 'DELETE'));
  assert.ok(descendants(flow).some(node => node.textContent === '另一项任务'));
  await assert.rejects(stat(paths.codexFile), { code: 'ENOENT' });
});

test('store checks the real target of a known rollout before unlink or CLI deletion', async t => {
  const paths = await seed(t);
  const store = createStore({ ...paths, codexBin: null });
  await store.scan();
  const original = dirname(paths.codexFile);
  const moved = join(dirname(paths.codexDir), 'moved');
  await rename(original, moved);
  await symlink(moved, original);
  const result = await store.deleteSession('main');
  assert.equal(result.status, 403);
  assert.ok((await stat(join(moved, 'rollout-main.jsonl'))).isFile());
  assert.ok(store.detail('main'));
});

test('store invokes the configured Codex binary for a UUID and tolerates CLI failure', async t => {
  const paths = await fixture(t);
  const id = '74fe83da-6673-4c19-a759-7a4739285b91';
  const marker = join(dirname(paths.codexDir), 'cli-args.txt');
  const codexBin = join(dirname(paths.codexDir), 'codex-fixture');
  await writeFile(codexBin, '#!/bin/sh\nprintf "%s\\n" "$@" > "${0%/*}/cli-args.txt"\nexit 1\n', { mode: 0o755 });
  await writeFile(paths.codexFile, lines(meta(id)));
  const store = createStore({ ...paths, codexBin });
  await store.scan();
  assert.deepEqual(await store.deleteSession(id), { status: 200, body: { deleted: id } });
  assert.deepEqual((await readFile(marker, 'utf8')).trimEnd().split('\n'), ['delete', '--force', id]);
  await assert.rejects(stat(paths.codexFile), { code: 'ENOENT' });
});

test('deleting a valid parent skips a child redirected outside the sessions directory', async t => {
  const paths = await seed(t);
  const store = createStore({ ...paths, codexBin: null });
  await store.scan();
  const child = join(dirname(paths.codexFile), 'rollout-review.jsonl');
  const outside = join(dirname(paths.codexDir), 'rollout-external.jsonl');
  await rename(child, outside);
  await symlink(outside, child);
  assert.deepEqual(await store.deleteSession('main'), { status: 200, body: { deleted: 'main' } });
  await assert.rejects(stat(paths.codexFile), { code: 'ENOENT' });
  assert.ok((await stat(outside)).isFile());
  await store.scan();
  assert.equal(store.detail('review'), null);
});

test('desktop confines the dashboard to one viewport with independent list and workflow scrolling', async () => {
  const [html, styles] = await Promise.all(['index.html', 'styles.css'].map(file =>
    readFile(new URL('../public/' + file, import.meta.url), 'utf8')));
  const desktop = styles.match(/@media \(min-width: 681px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  const mobile = styles.match(/@media \(max-width: 680px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(desktop, /body\s*\{[^}]*flex-direction:\s*column;[^}]*height:\s*100dvh;[^}]*overflow:\s*hidden/);
  assert.match(desktop, /\.topbar,\s*#quota-panel,[^{]*\{[^}]*flex:\s*none/);
  assert.match(desktop, /\.studio,\s*\.workspace\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden/);
  assert.match(desktop, /\.session-list,\s*#workflow-stream\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto/);
  assert.match(desktop, /#workflow-stream\s*\{[^}]*padding-right:/);
  assert.match(html, /id="workflow-stream"[^>]*aria-labelledby="workflow-heading"[^>]*tabindex="0"/);
  assert.match(mobile, /body\s*\{[^}]*height:\s*auto;[^}]*overflow:\s*visible/);
  assert.doesNotMatch(mobile, /100dvh|overflow-y:\s*auto/);
});

test('session deletion removes every resumed rollout and prunes only emptied date directories', async t => {
  const paths = await seed(t);
  const reviewFile = join(dirname(paths.codexFile), 'rollout-review.jsonl');
  const resumedDay = join(paths.codexDir, '2027', '02', '09');
  const subthreadDay = join(paths.codexDir, '2028', '04', '01');
  await Promise.all([mkdir(resumedDay, { recursive: true }), mkdir(subthreadDay, { recursive: true })]);
  const resumed = join(resumedDay, 'rollout-main-resumed.jsonl');
  const subthread = join(subthreadDay, 'rollout-review-resumed.jsonl');
  const nested = join(subthreadDay, 'rollout-nested.jsonl');
  const keeper = join(resumedDay, 'rollout-other.jsonl');
  await Promise.all([
    writeFile(resumed, lines(meta('main', {}, 60))),
    // The resumed child omits the parent ID still present in its earlier rollout.
    writeFile(subthread, lines(meta('review', {}, 61))),
    writeFile(nested, lines(meta('nested', { parent_thread_id: 'review' }, 62))),
    writeFile(keeper, lines(meta('other', {}, 63))),
  ]);

  const store = createStore({ ...paths, codexBin: null });
  await store.scan();
  assert.equal(store.detail('main').file, resumed);
  assert.equal(store.detail('review').file, subthread);
  const updated = once(store, 'sessions_updated');
  assert.deepEqual(await store.deleteSession('main'), { status: 200, body: { deleted: 'main' } });
  assert.deepEqual(await updated, [{ count: 1 }]);
  for (const file of [paths.codexFile, reviewFile, resumed, subthread, nested]) {
    assert.equal(store.files.has(file), false);
    await assert.rejects(stat(file), { code: 'ENOENT' });
  }
  for (const year of ['2026', '2028']) {
    await assert.rejects(stat(join(paths.codexDir, year)), { code: 'ENOENT' });
  }
  assert.ok((await stat(resumedDay)).isDirectory());
  assert.ok((await stat(keeper)).isFile());
  await store.scan();
  assert.deepEqual(store.list({ includeSubthreads: true }).map(session => session.threadId), ['other']);
  assert.equal((await store.deleteSession('other')).status, 200);
  await assert.rejects(stat(join(paths.codexDir, '2027')), { code: 'ENOENT' });
  assert.ok((await stat(paths.codexDir)).isDirectory());
  assert.ok((await stat(paths.agyFile)).isFile());
});
