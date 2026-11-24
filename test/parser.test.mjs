import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendRollout, appendTranscript, correlateCalls, parseRollout, parseTranscript, visibleEvents,
} from '../lib/parser.mjs';
import { dispatch, event, lines, message, meta, response, rollout, stamp } from './fixtures.mjs';

test('rollout metadata, settings, turn status and cumulative and last token usage', () => {
  const state = parseRollout(lines(
    meta('review', { parent_thread_id: 'main' }),
    rollout('turn_context', { turn_id: 'turn-1', approval_policy: 'never' }, 1),
    event('thread_settings_applied', { thread_settings: { model: 'codex', sandbox_policy: { type: 'read-only' } } }, 2),
    event('task_started', { turn_attribution: { turn_id: 'turn-1', turn_trigger: 'review' } }, 3),
    event('token_count', { info: { total_token_usage: { total_tokens: 25 }, last_token_usage: { total_tokens: 8 } } }, 4),
    event('turn_aborted', { turn_id: 'turn-1', reason: 'cancelled', duration_ms: 20 }, 5),
  ), 'rollout-review.jsonl');
  assert.equal(state.parentThreadId, 'main');
  assert.equal(state.originator, 'codex');
  assert.equal(state.model, 'codex');
  assert.equal(state.approvalPolicy, 'never');
  assert.deepEqual(state.sandboxPolicy, { type: 'read-only' });
  assert.equal(state.status, 'aborted');
  assert.equal(state.turns.size, 1);
  assert.equal(state.tokens.total_tokens, 25);
  assert.equal(state.lastTokenUsage.total_tokens, 8);
  assert.equal(state.events.at(-1).durationMs, 20);
  assert.equal(state.updatedAt, stamp(5));
});

test('default timeline hides internal records and strips environment blocks; raw restores them', () => {
  const state = parseRollout(lines(
    meta('thread'),
    message('developer', '<instruction>private</instruction>'),
    message('user', 'Request\n<environment_context>\nprivate context\n</environment_context>'),
    message('user', '<environment_context>standalone</environment_context>'),
    response('reasoning', { summary: [], encrypted_content: 'opaque' }),
    response('reasoning', { summary: [{ type: 'summary_text', text: 'Investigated' }] }),
  ));
  const filtered = visibleEvents(state.events);
  assert.deepEqual(filtered.map(item => item.text), ['Request', '[Reasoning step]', 'Investigated']);
  assert.doesNotMatch(JSON.stringify(filtered), /private|environment_context/);
  const raw = JSON.stringify(visibleEvents(state.events, true));
  assert.match(raw, /private context/);
  assert.match(raw, /standalone/);
  assert.doesNotMatch(raw, /opaque/);
});

test('incremental rollout handles bad lines, normalizes items and tracks tool calls and outputs', () => {
  const initial = lines(meta('main'), event('task_started', { turn_id: 't1' }));
  const tail = 'not json\nnull\n' + lines(
    response('function_call', { name: 'exec', call_id: 'x', arguments: '{"cmd":"pwd"}' }),
    response('function_call_output', { call_id: 'x', output: '/projects/dashboard' }),
    response('custom_tool_call', { name: 'patch', call_id: 'y', input: 'patch input' }),
    response('custom_tool_call_output', { call_id: 'y', output: 'patched' }),
    event('item_completed', { item: { type: 'CommandExecution', command: ['node', '-v'], exit_code: 0, aggregated_output: 'v22' } }),
    event('item_completed', { item: { type: 'FileChange', changes: [{ path: 'server.mjs' }] } }),
    event('item_completed', { item: { type: 'McpToolCall', server: 'codex', tool: 'wait', result: 'done' } }),
    message('assistant', 'Implemented'),
    event('item_completed', { item: { type: 'AgentMessage', text: 'Implemented' } }),
    event('agent_message', { message: 'Implemented' }),
    event('task_complete', { last_agent_message: 'Implemented' }),
  );
  const state = appendRollout(parseRollout(initial), tail);
  assert.deepEqual(state, parseRollout(initial + tail));
  assert.deepEqual([...state.commands], ['pwd', 'node -v']);
  assert.deepEqual([...state.files], ['server.mjs']);
  assert.equal(state.events.find(item => item.callId === 'x' && item.type === 'tool_output').output, '/projects/dashboard');
  assert.equal(state.events.find(item => item.callId === 'y' && item.type === 'tool').input, 'patch input');
  assert.equal(state.events.find(item => item.command === 'node -v').exitCode, 0);
  assert.equal(state.status, 'completed');
  assert.equal(state.events.filter(item => item.role === 'assistant').length, 1);
});

test('transcript pairs referenced and sequential results and ignores unrelated MCP calls', () => {
  const other = dispatch({}, 2);
  other.tool_calls[0].args.ServerName = 'other';
  const direct = { step_index: 3, created_at: stamp(3), tool_calls: [{ name: 'codex_wait', args: { thread_id: 'other' } }] };
  const transcript = parseTranscript(lines(dispatch({ prompt: 'Build' }, 1), other, direct), 'transcript.jsonl');
  appendTranscript(transcript, lines(
    { type: 'TOOL_RESULT', tool_call_id: 'call-2', content: { thread_id: 'wrong' } },
    { type: 'TOOL_RESULT', tool_call_id: 'call-1', content: [{ text: '{"threadId":"main"}' }] },
    { type: 'TOOL_RESULT', content: 'thread_id: other' },
  ));
  assert.deepEqual(transcript.calls.map(call => [call.tool, call.threadId]), [['codex_run', 'main'], ['codex_wait', 'other']]);
  assert.equal(transcript.calls[1].result, 'thread_id: other');
});

test('correlation prioritizes explicit IDs and uses nearest matching prompt and cwd as fallback', () => {
  const sessions = [
    parseRollout(lines(meta('late', {}, 20), message('user', 'Build the dashboard now', 21))),
    parseRollout(lines(meta('nearest', {}, 4), message('user', 'Build the dashboard now', 5))),
    parseRollout(lines(meta('unrelated', { cwd: '/other' }, 2), message('user', 'Build the dashboard', 3))),
  ];
  const transcript = parseTranscript(lines(
    dispatch({ prompt: 'build  the dashboard', cwd: '/projects/dashboard' }, 2),
    dispatch({ prompt: 'Build the dashboard', thread_id: 'late' }, 3),
    dispatch({ prompt: 'Build the dashboard', thread_id: 'missing' }, 4),
    dispatch({ prompt: 'Build the dashboard' }, 400),
  ));
  assert.deepEqual(correlateCalls(transcript.calls, sessions).map(call => call.sessionId), ['nearest', 'late', null, null]);
});

test('injected user instructions stay available in raw mode and never become the preview', () => {
  const instructions = [
    '# AGENTS.md instructions for /projects/dashboard\n<INSTRUCTIONS>Internal</INSTRUCTIONS>',
    '  <permissions instructions>\nInternal\n</permissions instructions>',
    '<user_instructions>Internal</user_instructions>',
    '<INSTRUCTIONS>Internal</INSTRUCTIONS>',
  ];
  const initial = parseRollout(lines(meta('main'), ...instructions.map(text => message('user', text))));
  assert.equal(initial.preview, '');
  assert.deepEqual(visibleEvents(initial.events), []);
  assert.deepEqual(visibleEvents(initial.events, true).filter(item => item.role === 'user').map(item => item.rawText), instructions);
  assert.ok(initial.events.every(item => item.system));
  appendRollout(initial, lines(message('user', 'Update the dashboard\n<environment_context>Internal</environment_context>')));
  assert.equal(initial.preview, 'Update the dashboard');
  assert.deepEqual(visibleEvents(initial.events).map(item => item.text), ['Update the dashboard']);
});

test('harness directives from either dialogue role are internal and stay available in raw mode', () => {
  const directive = '::browser-complete{title="Opened the page"}';
  const userDirective = '  ::HARNESS-STATUS ready';
  const session = parseRollout(lines(
    message('user', userDirective, 1),
    message('assistant', directive, 2),
    event('task_complete', { last_agent_message: directive }, 3),
    message('user', 'Explain the ::browser-complete directive.', 4),
    message('assistant', 'It reports that browser work finished.', 5),
  ));
  assert.equal(session.preview, 'Explain the ::browser-complete directive.');
  assert.deepEqual(visibleEvents(session.events).filter(item => item.type === 'message').map(item => item.text), [
    session.preview, 'It reports that browser work finished.',
  ]);
  assert.deepEqual(visibleEvents(session.events, true).filter(item => item.system).map(item => item.text), [
    userDirective, directive,
  ]);
});

test('Codex exec wrapper extracts static command strings and preserves shell quoting', () => {
  const command = 'printf "%s\\n" "$HOME"\nnode -v';
  const doubleQuoted = 'text(await tools.exec_command({workdir:"/projects", cmd:' + JSON.stringify(command) + '}))';
  const singleQuoted = "text(await tools.exec_command({nested:{cmd:'other'}, 'cmd':'printf \\'hi\\' \\x21'}))";
  const dynamic = 'text(await tools.exec_command({cmd:"prefix" + globalThis.command}))';
  const session = parseRollout(lines(
    response('custom_tool_call', { name: 'exec', input: doubleQuoted, call_id: 'first' }),
    response('custom_tool_call', { name: 'exec', input: singleQuoted, call_id: 'second' }),
    response('custom_tool_call', { name: 'exec', input: dynamic, call_id: 'third' }),
    response('custom_tool_call', { name: 'apply_patch', input: doubleQuoted, call_id: 'fourth' }),
  ));
  assert.deepEqual([...session.commands], [command, "printf 'hi' !"]);
  assert.deepEqual(session.events.map(item => item.command), [command, "printf 'hi' !", '', '']);
  assert.equal(session.events[0].input, doubleQuoted);
});

test('GENERIC model results link inline IDs and record saved outputs while skipping prompt steps', () => {
  const transcript = parseTranscript(lines(
    { type: 'GENERIC', source: 'MODEL', content: 'Created At: earlier\nthread_id: stray' },
    dispatch({ prompt: 'First' }, 1),
    { type: 'GENERIC', source: 'USER', content: 'Created At: earlier\nthread_id: user-prompt' },
    { type: 'GENERIC', source: 'SYSTEM', content: 'Created At: earlier\nthread_id: system-prompt' },
    { type: 'GENERIC', source: 'PLANNER', content: 'Created At: earlier\nthread_id: planner-prompt' },
    { type: 'GENERIC', source: 'MODEL', role: 'user', content: 'Created At: earlier\nthread_id: user-role' },
    { type: 'GENERIC', source: 'MODEL', content: 'Created At: just now\n{"thread_id":"first"}' },
    { ...dispatch({ prompt: 'Second' }, 2), type: 'GENERIC', source: 'MODEL', content: 'Calling Codex' },
  ));
  const uri = 'file:///tmp/brain/my%20conversation/steps/236/output.txt';
  appendTranscript(transcript, lines(
    { type: 'GENERIC', source: 'MODEL', tool_call_id: 'call-1', content: 'thread_id: duplicate' },
    { type: 'GENERIC', source: 'MODEL', content: 'The output was large and was saved to: ' + uri },
  ));
  assert.deepEqual(transcript.calls.map(call => call.threadId), ['first', undefined]);
  assert.deepEqual([...transcript.savedResults], [[transcript.calls[1], { uri }]]);
  assert.equal(transcript.pending.length, 0);
});

test('command summaries deduplicate shell wrappers while timeline commands keep the original text', () => {
  const command = "cat > example <<'EOF'\ncontent\nEOF";
  const wrappers = ['/bin/zsh -lc ' + command, ['/bin/bash', '-lc', command], '/bin/sh -lc ' + command];
  const state = parseRollout(lines(
    response('custom_tool_call', { name: 'exec', input: 'text(await tools.exec_command({cmd:' + JSON.stringify(command) + '}))' }),
    ...wrappers.map(command => event('item_completed', { item: { type: 'CommandExecution', command } })),
    event('item_completed', { item: { type: 'CommandExecution', command: ['/bin/bash', '-c', 'pwd'] } }),
  ));
  assert.deepEqual([...state.commands], [command, '/bin/bash -c pwd']);
  assert.deepEqual(state.events.map(item => item.command), [
    command, '/bin/zsh -lc ' + command, '/bin/bash -lc ' + command, '/bin/sh -lc ' + command, '/bin/bash -c pwd',
  ]);
});

test('rollout retains the latest Codex rate limits and configured reasoning effort across appends', () => {
  const rates = {
    plan_type: 'plus',
    primary: { used_percent: 25, window_minutes: 300, resets_at: 1767283200 },
    secondary: { used_percent: 74, window_minutes: 10080, resets_at: 1767801600 },
  };
  const state = parseRollout(lines(
    response('configuration_update', { reasoning: { effort: 'xhigh' } }, 1),
    event('token_count', { rate_limits: rates }, 2),
  ));
  appendRollout(state, lines(
    event('token_count', { info: { total_token_usage: { total_tokens: 99 } } }, 3),
    event('token_count', { rate_limits: { plan_type: 'stale' } }, 0),
    response('configuration_update', {}, 4),
  ));
  assert.equal(state.effort, 'xhigh');
  assert.deepEqual(state.rateLimits, rates);
  assert.equal(state.rateLimitsUpdatedAt, stamp(2));
  assert.equal(state.tokens.total_tokens, 99);
  assert.equal(state.events[0].settings.effort, 'xhigh');
  assert.ok(visibleEvents(state.events).every(item => !item.settings));
});

test('transcript collects usage only from planner responses and handles missing model and tokens', () => {
  const state = parseTranscript(lines(
    { type: 'PLANNER_RESPONSE', model: 'gemini-argon', input_tokens: 5, cache_read_tokens: 20,
      output_tokens: 3, created_at: stamp() },
    { type: 'GENERIC', input_tokens: 999 },
  ));
  appendTranscript(state, lines({ type: 'PLANNER_RESPONSE', input_tokens: -3, created_at: stamp(1) }));
  assert.deepEqual(state.usage, [
    { model: 'gemini-argon', inputTokens: 5, cacheReadTokens: 20, outputTokens: 3, timestamp: stamp() },
    { model: 'gemini', inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, timestamp: stamp(1) },
  ]);
});
