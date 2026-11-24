import { basename } from 'node:path';

export function parseLines(text, consume) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record && typeof record === 'object') consume(record);
  }
}

export const asText = value => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    return JSON.stringify(value, null, 2);
  }
  return value == null ? '' : String(value);
};

function decode(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value.trim();
  }
}

function addEvent(session, type, timestamp, fields = {}) {
  session.events.push({ key: session.events.length, type, timestamp, turnId: session.turnId, ...fields });
}

function setTurn(session, id) {
  if (!id) return;
  session.turnId = id;
  session.turns.add(id);
}

function readMessage(session, timestamp, role, content, source) {
  const original = asText(content);
  const cleaned = role === 'user'
    ? original.replace(/<environment_context\b[^>]*>[\s\S]*?<\/environment_context>/gi, '').trim()
    : original;
  const injected = role === 'user' && /^(?:# AGENTS\.md instructions for\b|<(?:instructions|permissions\s+instructions|user_instructions)\s*>)/i.test(cleaned);
  const dialogueRole = role === 'user' || role === 'assistant';
  const directive = dialogueRole && /^::[a-z-]+(?:\{.*\}|\b)/i.test(cleaned.trimStart());
  const value = injected || directive ? '' : cleaned;
  if ((value || directive) && dialogueRole) {
    const key = JSON.stringify([session.turnId, role, cleaned]);
    const counts = session.messages.get(key) ?? {};
    const previousCount = Math.max(0, ...Object.values(counts));
    counts[source] = (counts[source] ?? 0) + 1;
    session.messages.set(key, counts);
    if (counts[source] <= previousCount) return;
  }
  if (role === 'user' && value) session.preview ||= value;
  if (!original) return;
  addEvent(session, 'message', timestamp, {
    role, text: value,
    system: role === 'developer' || role === 'system' || !value,
    ...(original !== value ? { rawText: original } : {}),
  });
}

function unwrapExecCommand(input) {
  const opening = /\btools\.exec_command\s*\(\s*\{/.exec(input);
  if (!opening) return;
  const body = input.slice(opening.index + opening[0].length);
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|[\w$]+|[^\s]/g;
  let depth = 0;
  let property = true;
  for (let match; (match = tokens.exec(body));) {
    const [token] = match;
    if (token.startsWith('//') || token.startsWith('/*')) continue;
    if (!depth && token === '}') break;
    if (!depth && property && /^(?:cmd|"cmd"|'cmd')$/.test(token)) {
      const literal = /^\s*:\s*("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')\s*(?=[,}])/.exec(body.slice(tokens.lastIndex));
      if (!literal) return;
      return decodeCommandLiteral(literal[1]);
    }
    if ('{[('.includes(token)) depth++;
    if ('}])'.includes(token)) depth--;
    property = !depth && token === ',';
  }
}

function decodeCommandLiteral(literal) {
  const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
  return literal.slice(1, -1).replace(
    /\\(?:u\{([\da-fA-F]{1,6})\}|u([\da-fA-F]{4})|x([\da-fA-F]{2})|(\r\n|[\s\S]))/g,
    (match, codePoint, unicode, hex, character) => {
      const code = codePoint ?? unicode ?? hex;
      if (code) {
        const number = Number.parseInt(code, 16);
        return number <= 0x10ffff ? String.fromCodePoint(number) : match;
      }
      if (/^[\r\n\u2028\u2029]/.test(character)) return '';
      return escapes[character] ?? character;
    },
  );
}

function recordCommand(session, value) {
  const command = Array.isArray(value) ? value.join(' ') : asText(value);
  const shell = /^\/bin\/(?:z|ba)?sh$/;
  const summary = Array.isArray(value) && value.length === 3 && shell.test(value[0]) && value[1] === '-lc'
    ? asText(value[2])
    : command.replace(/^\/bin\/(?:z|ba)?sh[ \t]+-lc[ \t]/, '');
  if (summary) session.commands.add(summary);
  return command;
}

function readItem(session, timestamp, item = {}) {
  switch (String(item.type).replaceAll('_', '').toLowerCase()) {
    case 'usermessage':
    case 'agentmessage':
      readMessage(session, timestamp, /user/i.test(item.type) ? 'user' : 'assistant',
        item.content ?? item.text ?? item.message, 'item');
      break;
    case 'reasoning':
      addEvent(session, 'reasoning', timestamp, { text: asText(item.summary) || '[Reasoning step]' });
      break;
    case 'commandexecution': {
      const command = recordCommand(session, item.command);
      addEvent(session, 'tool', timestamp, {
        name: 'Command execution', command, cwd: item.cwd,
        output: asText(item.aggregated_output ?? item.output),
        exitCode: item.exit_code, status: item.status,
      });
      break;
    }
    case 'filechange': {
      const paths = Array.isArray(item.changes)
        ? item.changes.map(change => typeof change === 'string' ? change : change?.path).filter(Boolean)
        : Object.keys(item.changes ?? {});
      for (const path of paths) session.files.add(path);
      addEvent(session, 'tool', timestamp, { name: 'File change', paths, status: item.status });
      break;
    }
    case 'mcptoolcall':
      addEvent(session, 'tool', timestamp, {
        name: [item.server, item.tool ?? item.name].filter(Boolean).join(' / ') || 'MCP tool',
        input: asText(item.arguments), output: asText(item.result ?? item.error), status: item.status,
      });
      break;
    default:
      addEvent(session, 'record', timestamp, { label: item.type ?? 'Item', text: asText(item), system: true });
  }
}

function readEvent(session, timestamp, payload) {
  setTurn(session, payload.turn_id ?? payload.turn_attribution?.turn_id);
  switch (payload.type) {
    case 'thread_settings_applied': {
      const settings = payload.thread_settings ?? {};
      session.model = settings.model ?? session.model;
      session.approvalPolicy = settings.approval_policy ?? session.approvalPolicy;
      session.sandboxPolicy = settings.sandbox_policy ?? session.sandboxPolicy;
      addEvent(session, 'record', timestamp, {
        label: 'Thread settings', text: asText(settings), system: true, settings: { model: settings.model },
      });
      break;
    }
    case 'task_started':
      session.status = 'inProgress';
      addEvent(session, 'turn', timestamp, { label: 'Turn started', text: asText(payload.turn_attribution?.turn_trigger) });
      break;
    case 'task_complete':
      session.status = 'completed';
      if (payload.last_agent_message && !session.messages.has(JSON.stringify([session.turnId, 'assistant', payload.last_agent_message]))) {
        readMessage(session, timestamp, 'assistant', payload.last_agent_message, 'complete');
      }
      addEvent(session, 'turn', timestamp, { label: 'Turn completed' });
      break;
    case 'turn_aborted':
      session.status = 'aborted';
      addEvent(session, 'turn', timestamp, { label: 'Turn aborted', text: asText(payload.reason), durationMs: payload.duration_ms });
      break;
    case 'token_count':
      session.tokens = payload.info?.total_token_usage ?? session.tokens;
      session.lastTokenUsage = payload.info?.last_token_usage ?? session.lastTokenUsage;
      if (payload.rate_limits && (!session.rateLimits
        || (Date.parse(timestamp) || 0) >= (Date.parse(session.rateLimitsUpdatedAt) || 0))) {
        session.rateLimits = payload.rate_limits;
        session.rateLimitsUpdatedAt = timestamp;
      }
      addEvent(session, 'record', timestamp, { label: 'Token usage', text: asText(payload.info), system: true });
      break;
    case 'item_completed':
      readItem(session, timestamp, payload.item ?? {});
      break;
    case 'user_message':
    case 'agent_message':
      readMessage(session, timestamp, payload.type === 'user_message' ? 'user' : 'assistant', payload.message, 'event');
      break;
    default:
      addEvent(session, 'record', timestamp, { label: payload.type ?? 'Event', text: asText(payload), system: true });
  }
}

function readResponse(session, timestamp, payload) {
  switch (payload.type) {
    case 'configuration_update': {
      session.effort = payload.reasoning?.effort ?? session.effort;
      addEvent(session, 'record', timestamp, {
        label: 'Configuration update', text: asText(payload), system: true, settings: { effort: payload.reasoning?.effort },
      });
      break;
    }
    case 'message':
      readMessage(session, timestamp, payload.role, payload.content, 'response');
      break;
    case 'reasoning':
      addEvent(session, 'reasoning', timestamp, { text: asText(payload.summary) || '[Reasoning step]' });
      break;
    case 'function_call':
    case 'custom_tool_call': {
      const input = decode(payload.arguments ?? payload.input);
      const command = typeof input === 'string' && payload.name === 'exec'
        ? unwrapExecCommand(input)
        : input?.cmd ?? input?.command;
      const commandText = recordCommand(session, command);
      addEvent(session, 'tool', timestamp, {
        name: payload.name, callId: payload.call_id, input: asText(input), command: commandText,
      });
      break;
    }
    case 'function_call_output':
    case 'custom_tool_call_output':
      addEvent(session, 'tool_output', timestamp, { callId: payload.call_id, output: asText(payload.output) });
      break;
    default:
      addEvent(session, 'record', timestamp, { label: payload.type ?? 'Response', text: asText(payload), system: true });
  }
}

export function createRollout(file = '') {
  return {
    file, threadId: basename(file).replace(/^rollout-/, '').replace(/\.jsonl$/, ''),
    hasMetadata: false, cwd: '', model: '', effort: null, originator: '', parentThreadId: null,
    status: 'inProgress', preview: '', createdAt: null, updatedAt: null,
    tokens: {}, lastTokenUsage: {}, rateLimits: null, rateLimitsUpdatedAt: null, events: [], turns: new Set(),
    commands: new Set(), files: new Set(), messages: new Map(), turnId: null,
  };
}

export function appendRollout(session, text) {
  parseLines(text, ({ timestamp, type, payload }) => {
    if (!payload || typeof payload !== 'object') return;
    if (Number.isFinite(Date.parse(timestamp))) {
      session.createdAt ??= timestamp;
      if (Date.parse(timestamp) >= (Date.parse(session.updatedAt) || 0) || !session.updatedAt) session.updatedAt = timestamp;
    }
    switch (type) {
      case 'session_meta':
        session.hasMetadata = true;
        session.threadId = payload.id ?? session.threadId;
        session.cwd = payload.cwd ?? session.cwd;
        session.originator = payload.originator ?? session.originator;
        session.parentThreadId = payload.parent_thread_id
          ?? payload.source?.subagent?.thread_spawn?.parent_thread_id ?? session.parentThreadId;
        addEvent(session, 'record', timestamp, { label: 'Session metadata', text: asText(payload), system: true });
        break;
      case 'turn_context':
        setTurn(session, payload.turn_id);
        session.cwd = payload.cwd ?? session.cwd;
        session.model = payload.model ?? session.model;
        session.approvalPolicy = payload.approval_policy ?? session.approvalPolicy;
        addEvent(session, 'record', timestamp, {
          label: 'Turn context', text: asText(payload), system: true, settings: { model: payload.model },
        });
        break;
      case 'event_msg':
        readEvent(session, timestamp, payload);
        break;
      case 'response_item':
        readResponse(session, timestamp, payload);
        break;
      default:
        addEvent(session, 'record', timestamp, { label: type ?? 'Record', text: asText(payload), system: true });
    }
  });
  return session;
}

export const parseRollout = (text, file) => appendRollout(createRollout(file), text);

export function visibleEvents(events, raw = false) {
  if (raw) return events.map(event => event.rawText === undefined ? event : { ...event, text: event.rawText });
  return events.filter(event => !event.system).map(({ rawText, ...event }) => event);
}

export function createTranscript(file = '') {
  return { file, calls: [], pending: [], savedResults: new Map(), usage: [] };
}

export const tokenCount = value => Number.isFinite(value) && value >= 0 ? value : 0;

export function getThreadId(result) {
  const parsed = decode(result);
  if (Array.isArray(parsed)) return parsed.map(getThreadId).find(Boolean);
  if (parsed && typeof parsed === 'object') {
    const id = parsed.thread_id ?? parsed.threadId;
    if (typeof id === 'string') return id;
    return Object.values(parsed).map(getThreadId).find(Boolean);
  }
  if (typeof parsed !== 'string') return undefined;
  return parsed.replace(/\\(["'])/g, '$1')
    .match(/\bthread[_ ]?id["'`]?\s*[:=]\s*["'`]?([\w-]+)/i)?.[1];
}

function isResultStep(step, toolCalls, reference, text) {
  const type = String(step.type).toUpperCase();
  if ([step.source, step.role, step.author, step.content?.role]
    .some(role => /^(?:user|system|planner|developer)(?:[_ -]|$)/i.test(String(role ?? '')))) return false;
  if (type === 'TOOL_RESULT') return true;
  return type === 'GENERIC' && !toolCalls.length && Boolean(text.trim()) && (
    reference != null || /^(?:model|tool)$/i.test(String(step.source ?? ''))
    || /^(?:Created At:|The output was large and was saved to:)/i.test(text.trimStart())
    || Boolean(getThreadId(step.content))
  );
}

export function appendTranscript(transcript, text) {
  parseLines(text, step => {
    if (step.type === 'PLANNER_RESPONSE') {
      transcript.usage.push({
        model: typeof step.model === 'string' && step.model.trim() ? step.model : 'gemini',
        inputTokens: tokenCount(step.input_tokens),
        cacheReadTokens: tokenCount(step.cache_read_tokens),
        outputTokens: tokenCount(step.output_tokens),
        timestamp: step.created_at,
      });
    }
    const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    for (const tool of toolCalls) {
      const args = decode(tool?.args) ?? {};
      const name = tool?.name === 'call_mcp_tool'
        ? (decode(args.ServerName) === 'codex' ? decode(args.ToolName) : null)
        : tool?.name;
      const callId = tool?.id ?? tool?.call_id ?? tool?.tool_call_id;
      if (typeof name !== 'string' || !name.startsWith('codex_')) {
        transcript.pending.push({ callId });
        continue;
      }
      const parameters = decode(args.Arguments ?? args);
      const call = {
        id: `${transcript.file}#${transcript.calls.length}`, callId, tool: name,
        file: transcript.file, stepIndex: step.step_index, timestamp: step.created_at,
        args: parameters, prompt: asText(parameters?.prompt),
        threadId: parameters?.thread_id ?? parameters?.threadId,
      };
      transcript.calls.push(call);
      transcript.pending.push(call);
    }
    if (!transcript.pending.length) return;
    const reference = step.tool_call_id ?? step.call_id ?? step.toolCallId;
    const result = asText(step.content);
    if (!isResultStep(step, toolCalls, reference, result)) return;
    const threadId = getThreadId(step.content);
    const call = reference != null ? transcript.pending.find(candidate => candidate.callId === reference)
      : (threadId && transcript.pending.find(candidate => candidate.threadId === threadId))
        || transcript.pending[0];
    if (!call) return;
    transcript.pending = transcript.pending.filter(candidate => candidate !== call);
    if (!call.tool) return;
    if (threadId) call.threadId ??= threadId;
    call.result = result;
    const uri = result.match(/\bfile:\/\/[^\r\n]*?\/output\.txt(?=$|[\s"'`)\].])/i)?.[0];
    if (!call.threadId && uri) transcript.savedResults.set(call, { uri });
  });
  return transcript;
}

export const parseTranscript = (text, file) => appendTranscript(createTranscript(file), text);

export function correlateCalls(calls, sessions) {
  const byId = new Map(sessions.map(session => [session.threadId, session]));
  const normalize = value => value.trim().replace(/\s+/g, ' ').toLowerCase();
  return calls.map(call => {
    if (call.threadId) return { ...call, sessionId: byId.has(call.threadId) ? call.threadId : null };
    const prompt = normalize(call.prompt);
    let closest;
    let bestDistance = Infinity;
    for (const session of sessions) {
      if (!prompt || !session.preview || (call.args?.cwd && session.cwd && call.args.cwd !== session.cwd)) continue;
      const preview = normalize(session.preview);
      if (!preview.includes(prompt) && !prompt.includes(preview)) continue;
      const distance = Math.abs(Date.parse(call.timestamp) - Date.parse(session.createdAt));
      if (distance > 5 * 60_000 || !Number.isFinite(distance)) continue;
      if (distance === bestDistance) closest = null;
      if (distance < bestDistance) {
        closest = session.threadId;
        bestDistance = distance;
      }
    }
    return { ...call, sessionId: closest ?? null };
  });
}
