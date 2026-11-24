import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { appendFile, mkdir, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { get as httpGet } from 'node:http';
import { dirname, join } from 'node:path';
import { createServer } from '../server.mjs';
import { event, lines, message, meta, seed, stamp } from './fixtures.mjs';

async function start(t, options = {}, setup) {
  const paths = await seed(t);
  await setup?.(paths);
  const server = createServer({ ...paths, ...options });
  server.listen(0, '0.0.0.0');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close(error => {
    if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
    else resolve();
  })));
  const { port, address } = server.address();
  assert.equal(address, '127.0.0.1');
  return { ...paths, base: `http://127.0.0.1:${port}`, port, server };
}

test('HTTP sessions endpoint provides sorted summaries, search and sub-thread filters', async t => {
  const { base } = await start(t);
  const baseList = await fetch(base + '/api/sessions').then(response => response.json());
  assert.deepEqual(baseList.map(item => item.threadId), ['main']);
  assert.equal(baseList[0].model, 'gpt-codex');
  assert.equal(baseList[0].turnsCount, 1);
  assert.equal(baseList[0].linkedAgyCallsCount, 1);
  const all = await fetch(base + '/api/sessions?include_subthreads=1').then(response => response.json());
  assert.deepEqual(all.map(item => item.threadId), ['review', 'main']);
  const filtered = await fetch(base + '/api/sessions?include_subthreads=1&q=dashboard').then(response => response.json());
  assert.deepEqual(filtered.map(item => item.threadId), ['main']);
});

test('HTTP details and orchestrator endpoints return linked calls and opt-in system events', async t => {
  const { base } = await start(t);
  const detail = await fetch(base + '/api/sessions/main').then(response => response.json());
  assert.deepEqual(detail.timeline.map(item => item.type), ['dispatch', 'message']);
  assert.equal(detail.orchestratorCalls[0].args.effort, 'high');
  assert.deepEqual(detail.commands, []);
  const raw = await fetch(base + '/api/sessions/main?raw=1').then(response => response.json());
  assert.ok(raw.timeline.some(item => item.text === 'Hidden instructions'));
  const calls = await fetch(base + '/api/orchestrator').then(response => response.json());
  assert.deepEqual(calls, detail.orchestratorCalls);
  assert.equal((await fetch(base + '/api/sessions/missing')).status, 404);
});

test('static assets have expected content types and request paths cannot traverse public', async t => {
  const { base, port } = await start(t);
  for (const [path, type] of [['/', 'text/html'], ['/index.html', 'text/html'], ['/styles.css', 'text/css'], ['/app.js', 'text/javascript']]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type').startsWith(type));
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    await response.text();
  }
  for (const path of ['/../SPEC.md', '/%2e%2e/SPEC.md', '/..%2fSPEC.md', '/..%5cSPEC.md', '/%252e%252e/SPEC.md', '/%00', '/%zz', '//server.mjs', '/server.mjs']) {
    // Send the original request path so a client URL normalizer cannot remove dot segments.
    const result = await new Promise((resolve, reject) => {
      httpGet({ hostname: '127.0.0.1', port, path }, async response => {
        let body = '';
        for await (const chunk of response) body += chunk;
        resolve([response.statusCode, body]);
      }).on('error', reject);
    });
    assert.ok([400, 404].includes(result[0]), path);
    assert.doesNotMatch(result[1], /Specification|createHttpServer/);
  }
  assert.equal((await fetch(base + '/api/sessions', { method: 'POST' })).status, 405);
});

test('SSE emits live append and session update, then closes with the server', { timeout: 6000 }, async t => {
  const { base, codexFile, server } = await start(t, { pollInterval: 120 });
  await fetch(base + '/api/sessions').then(response => response.json());
  const response = await fetch(base + '/api/stream', { signal: AbortSignal.timeout(4500) });
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  assert.match((await reader.read()).value, /connected/);
  const { size: sizeBefore } = await stat(codexFile);
  const addition = lines(message('developer', 'New internal instructions', 9), message('assistant', 'Dashboard delivered', 10));
  await appendFile(codexFile, addition);
  let frames = '';
  while (!frames.includes('event: sessions_updated\ndata:')) {
    const part = await reader.read();
    assert.equal(part.done, false);
    frames += part.value;
  }
  const data = JSON.parse(frames.match(/event: session_append\ndata: ([^\n]+)/)[1]);
  assert.equal(data.id, 'main');
  assert.equal(data.offset, sizeBefore + Buffer.byteLength(addition));
  assert.deepEqual(data.newEvents.map(item => item.text), ['Dashboard delivered']);
  assert.doesNotMatch(frames, /internal instructions/);
  const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  assert.equal((await reader.read()).done, true);
  await closed;
});

test('DELETE unlinks the selected session and descendants and emits sessions_updated', { timeout: 5000 }, async t => {
  const { base, codexFile, agyFile } = await start(t, { codexBin: null }, async ({ codexFile }) => {
    await writeFile(join(dirname(codexFile), 'rollout-nested.jsonl'), lines(meta('nested', { parent_thread_id: 'review' })));
    await writeFile(join(dirname(codexFile), 'rollout-other.jsonl'), lines(meta('other')));
  });
  await fetch(base + '/api/sessions').then(response => response.json());
  const rejected = await fetch(base + '/api/sessions/main', { method: 'DELETE', headers: { Origin: 'https://example.invalid' } });
  assert.equal(rejected.status, 403);
  assert.ok((await stat(codexFile)).isFile());
  const badMethod = await fetch(base + '/api/sessions/main', { method: 'POST' });
  assert.equal(badMethod.headers.get('allow'), 'GET, DELETE');

  const sse = await fetch(base + '/api/stream', { signal: AbortSignal.timeout(3500) });
  const reader = sse.body.pipeThrough(new TextDecoderStream()).getReader();
  assert.match((await reader.read()).value, /connected/);
  const result = await fetch(base + '/api/sessions/main', { method: 'DELETE' });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { deleted: 'main' });
  let frames = '';
  while (!frames.includes('event: sessions_updated\ndata: {"count":1}')) {
    const part = await reader.read();
    assert.equal(part.done, false);
    frames += part.value;
  }
  await reader.cancel();

  for (const file of ['rollout-main.jsonl', 'rollout-review.jsonl', 'rollout-nested.jsonl']) {
    await assert.rejects(stat(join(dirname(codexFile), file)), { code: 'ENOENT' });
  }
  assert.ok((await stat(agyFile)).isFile());
  const sessions = await fetch(base + '/api/sessions?include_subthreads=1').then(response => response.json());
  assert.deepEqual(sessions.map(session => session.threadId), ['other']);
  assert.equal((await fetch(base + '/api/sessions/main', { method: 'DELETE' })).status, 404);
});

test('DELETE rejects a rollout redirected outside the sessions directory', async t => {
  const { base, codexDir, codexFile } = await start(t, { codexBin: null, pollInterval: 60_000 });
  assert.equal((await fetch(base + '/api/sessions/main')).status, 200);
  const day = dirname(codexFile);
  const moved = join(dirname(codexDir), 'sessions-other');
  const original = await readFile(codexFile, 'utf8');
  await rename(day, moved);
  await symlink(moved, day);
  const response = await fetch(base + '/api/sessions/main', { method: 'DELETE' });
  // A watcher can already have dropped the old entry.
  assert.ok([403, 404].includes(response.status));
  assert.equal(await readFile(join(moved, 'rollout-main.jsonl'), 'utf8'), original);
});

test('quota combines latest Codex windows with Gemini totals, daily usage, cache rate, and model breakdown', async t => {
  const { base } = await start(t, {}, async paths => {
    const latest = event('token_count', {
      info: { total_token_usage: { total_tokens: 125 } },
      rate_limits: {
        plan_type: 'plus', primary: { used_percent: 37.5, window_minutes: 300, resets_at: 1767283200 },
        secondary: { used_percent: 62, window_minutes: 10080, resets_at: 1767801600 },
      },
    }, 10);
    await appendFile(paths.codexFile, lines(latest));
    await appendFile(join(dirname(paths.codexFile), 'rollout-review.jsonl'), lines(
      event('token_count', { info: { total_token_usage: { total_tokens: 25 } }, rate_limits: { plan_type: 'older' } }, 9),
      message('assistant', 'Updated after the most recent quota sample', 12),
    ));
    const now = new Date();
    const previousDay = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    await appendFile(paths.agyFile, lines(
      { type: 'PLANNER_RESPONSE', model: 'argon', input_tokens: 500_000, cache_read_tokens: 500_000,
        output_tokens: 100_000, created_at: now.toISOString() },
      { type: 'PLANNER_RESPONSE', model: 'argon', input_tokens: 500_000, output_tokens: 100_000, created_at: previousDay.toISOString() },
      { type: 'GENERIC', input_tokens: 999_999 },
    ));
    const other = join(paths.agyDir, 'another', '.system_generated', 'logs', 'transcript.jsonl');
    await mkdir(dirname(other), { recursive: true });
    await writeFile(other, lines(
      { type: 'PLANNER_RESPONSE', model: 'hydrogen', input_tokens: 100_000, cache_read_tokens: 200_000,
        output_tokens: 50_000, created_at: now.toISOString() },
    ));
  });
  const result = await fetch(base + '/api/quota');
  assert.equal(result.status, 200);
  const { codex, gemini } = await result.json();
  assert.deepEqual(codex, {
    planType: 'plus', primary: { usedPercent: 37.5, windowMinutes: 300, resetsAt: 1767283200 },
    secondary: { usedPercent: 62, windowMinutes: 10080, resetsAt: 1767801600 },
    updatedAt: stamp(10), totalTokens: 150, sessionsCount: 1,
  });
  assert.deepEqual(gemini, {
    totalInputTokens: 1_100_000, totalCacheReadTokens: 700_000, totalOutputTokens: 250_000,
    totalTokens: 2_050_000, todayTotalTokens: 1_450_000, cacheHitRate: 700_000 / 1_800_000,
    turnsCount: 3, estimatedCostUsd: 4.805,
    models: [
      { model: 'argon', turns: 2, totalTokens: 1_700_000, outputTokens: 200_000 },
      { model: 'hydrogen', turns: 1, totalTokens: 350_000, outputTokens: 50_000 },
    ],
  });
});
