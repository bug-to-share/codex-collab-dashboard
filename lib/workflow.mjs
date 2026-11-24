// Project the rollout and linked dispatches into one request/response stream.
const timestamp = event => Date.parse(event.timestamp);
const compact = text => text.trim().replace(/\s+/g, ' ');
const isMessage = (event, role) => !event.system && event.type === 'message'
  && event.role === role && event.text?.trim();

function matchDispatches(events) {
  const prompts = new Map();
  for (const event of events) {
    if (!isMessage(event, 'user')) continue;
    const text = compact(event.text);
    if (!prompts.has(text)) prompts.set(text, []);
    prompts.get(text).push(event);
  }
  const replacements = new Map();
  const matched = new Set();
  for (const event of events) {
    if (event.type !== 'dispatch' || !event.call.prompt?.trim()) continue;
    const turnId = event.call.args?.turn_id;
    const candidates = prompts.get(compact(event.call.prompt)) ?? [];
    let nearest;
    let distance = Infinity;
    for (const candidate of candidates) {
      if (replacements.has(candidate) || (turnId && candidate.turnId && turnId !== candidate.turnId)) continue;
      const difference = Math.abs(timestamp(event) - timestamp(candidate));
      if (nearest && !(difference < distance)) continue;
      nearest = candidate;
      distance = Number.isFinite(difference) ? difference : Infinity;
    }
    if (nearest) {
      replacements.set(nearest, event);
      matched.add(event);
    }
  }
  return { replacements, matched };
}

function collectTurns(events) {
  const { replacements, matched } = matchDispatches(events);
  const settings = {};
  const turns = [];
  const byId = new Map();
  const newTurn = () => {
    const turn = { settings: { ...settings }, requests: [], trace: [] };
    turns.push(turn);
    return turn;
  };
  let turn = newTurn();

  events.forEach((event, index) => {
    if (matched.has(event)) return;
    const dispatch = replacements.get(event) ?? (event.type === 'dispatch' && event.call.prompt?.trim() ? event : null);
    const request = dispatch || isMessage(event, 'user');
    const reply = isMessage(event, 'assistant');
    if (event.system && !event.settings && event.label !== 'Token usage') return;
    if (!request && !reply && !event.settings && !['tool', 'tool_output', 'reasoning', 'turn'].includes(event.type)
      && event.label !== 'Token usage') return;

    const id = dispatch?.call.args?.turn_id ?? event.turnId;
    const startsNextTurn = id ? turn.end && id === turn.id : turn.end || turn.requests.length || turn.reply;
    if (request && startsNextTurn) {
      turn = newTurn();
    } else if (id !== undefined && id !== null) {
      if (!byId.has(id)) {
        if (turn.id || turn.end) turn = newTurn();
        byId.set(id, turn);
        turn.id = id;
      }
      turn = byId.get(id);
    }

    for (const [key, value] of Object.entries(event.settings ?? {})) {
      if (value == null || value === '') continue;
      settings[key] = value;
      if (!turn.end) turn.settings[key] = value;
    }
    turn.lastIndex = index;
    if (Number.isFinite(timestamp(event))) {
      turn.latest = event.timestamp;
      if (event.type !== 'dispatch') turn.first ??= event.timestamp;
    }
    if (request) turn.requests.push({ event, dispatch, index });
    if (reply) {
      if (turn.reply) {
        turn.trace.splice(turn.reply.traceIndex, 0, { type: 'progress', text: turn.reply.text });
      }
      turn.reply = { text: event.text, timestamp: event.timestamp, index, traceIndex: turn.trace.length };
    }
    if (!event.system && event.type === 'reasoning') {
      const text = event.text?.trim();
      if (text && text !== '[Reasoning step]' && text !== '推理步骤') turn.trace.push({ type: 'reasoning', text });
    }
    if (!event.system && (event.type === 'reasoning' || event.type === 'tool')) turn.hasExecution = true;
    if (event.label === 'Turn started') turn.start = event.timestamp;
    if (event.label === 'Turn completed' || event.label === 'Turn aborted') {
      turn.end = event.timestamp;
      turn.status = event.label === 'Turn completed' ? 'completed' : 'aborted';
      turn.reportedDuration = event.durationMs;
    }
  });
  return turns.filter(turn => turn.requests.length || turn.reply || turn.hasExecution || turn.start);
}

export function buildWorkflow(session, calls) {
  const events = [
    ...session.events,
    ...calls.map(call => ({ key: call.id, type: 'dispatch', timestamp: call.timestamp, call })),
  ].sort((a, b) => (timestamp(a) || 0) - (timestamp(b) || 0));
  const turns = collectTurns(events);
  return turns.flatMap((turn, index) => {
    const request = turn.requests[0];
    const startedAt = turn.start ?? turn.first ?? request?.dispatch?.timestamp;
    const elapsed = Date.parse(turn.end ?? turn.latest) - Date.parse(startedAt);
    const durationMs = Number.isFinite(turn.reportedDuration) ? Math.max(0, turn.reportedDuration)
      : Number.isFinite(elapsed) ? Math.max(0, elapsed) : null;
    const common = {
      turn: index + 1, turnStartedAt: startedAt, turnCompletedAt: turn.end, durationMs,
      status: turn.status ?? (index === turns.length - 1 ? session.status : 'completed'),
    };
    const requests = turn.requests.map(({ event, dispatch, index }) => ({
      ...common, id: 'request:' + (event.key ?? index), role: 'gemini', index,
      text: dispatch?.call.prompt ?? event.text, timestamp: dispatch?.timestamp ?? event.timestamp,
      model: dispatch?.call.args?.model, effort: dispatch?.call.args?.effort,
    }));
    if (turn.reply || turn.start || turn.hasExecution) {
      requests.push({
        ...common, id: 'response:' + (turn.id ?? request?.event.key ?? index), role: 'codex',
        index: turn.reply?.index ?? turn.lastIndex, timestamp: turn.reply?.timestamp ?? turn.latest,
        text: turn.reply?.text ?? '', model: turn.settings.model ?? request?.dispatch?.call.args?.model ?? session.model,
        effort: turn.settings.effort ?? request?.dispatch?.call.args?.effort,
        trace: turn.trace,
      });
    }
    return requests;
  }).sort((a, b) => a.index - b.index).map(({ index, ...node }) => node);
}
