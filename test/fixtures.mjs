import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const stamp = (second = 0) => new Date(Date.UTC(2026, 0, 1, 12, 0, second)).toISOString();
export const rollout = (type, payload, second) => ({ timestamp: stamp(second), type, payload });
export const event = (type, payload = {}, second) => rollout('event_msg', { type, ...payload }, second);
export const response = (type, payload = {}, second) => rollout('response_item', { type, ...payload }, second);
export const message = (role, text, second) => response('message', { role, content: [{ type: 'input_text', text }] }, second);
export const meta = (id, extra = {}, second) => rollout('session_meta', { id, cwd: '/projects/dashboard', originator: 'codex', ...extra }, second);
export const lines = (...records) => records.map(record => JSON.stringify(record) + '\n').join('');

export async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'collab-dashboard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexDir = join(root, 'sessions');
  const agyDir = join(root, 'brain');
  const codexFile = join(codexDir, '2026', '01', '01', 'rollout-main.jsonl');
  const agyFile = join(agyDir, 'conversation', '.system_generated', 'logs', 'transcript.jsonl');
  await Promise.all([mkdir(dirname(codexFile), { recursive: true }), mkdir(dirname(agyFile), { recursive: true })]);
  return { codexDir, agyDir, codexFile, agyFile };
}

export function dispatch(args, second = 0) {
  return {
    step_index: second, created_at: stamp(second), type: 'MODEL',
    tool_calls: [{
      id: `call-${second}`, name: 'call_mcp_tool',
      args: { ServerName: '"codex"', ToolName: '"codex_run"', Arguments: JSON.stringify(args) },
    }],
  };
}

export async function seed(t) {
  const paths = await fixture(t);
  await Promise.all([
    writeFile(paths.codexFile, lines(
      meta('main', {}, 1),
      rollout('turn_context', { turn_id: 'turn-1', model: 'gpt-codex' }, 2),
      message('developer', 'Hidden instructions', 3),
      message('user', 'Implement the dashboard', 4),
    )),
    writeFile(join(dirname(paths.codexFile), 'rollout-review.jsonl'),
      lines(meta('review', { cwd: '/projects/review', parent_thread_id: 'main' }, 5))),
    writeFile(paths.agyFile, lines(dispatch({ prompt: 'Implement the dashboard', thread_id: 'main', effort: 'high' }))),
  ]);
  return paths;
}
