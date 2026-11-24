import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { constants, watch } from 'node:fs';
import { lstat, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendRollout, appendTranscript, correlateCalls, createRollout, createTranscript, getThreadId, tokenCount, visibleEvents,
} from './parser.mjs';
import { buildWorkflow } from './workflow.mjs';

const unavailable = error => ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code);
const byTime = (a, b) => (Date.parse(a) || 0) - (Date.parse(b) || 0);
const defaultBrain = join(homedir(), '.gemini', 'antigravity', 'brain');
const rolloutName = /^rollout-.*\.jsonl$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

async function entries(dir, directories) {
  directories.add(dir);
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (!unavailable(error)) throw error;
    return [];
  }
}

async function discoverRollouts(dir, directories, found) {
  for (const entry of await entries(dir, directories)) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) await discoverRollouts(file, directories, found);
    else if (entry.isFile() && rolloutName.test(entry.name)) found.set(file, 'rollout');
  }
}

async function discoverTranscripts(dir, directories, found) {
  for (const entry of await entries(dir, directories)) {
    if (!entry.isDirectory()) continue;
    const conversation = join(dir, entry.name);
    const generated = join(conversation, '.system_generated');
    const logs = join(generated, 'logs');
    directories.add(conversation);
    directories.add(generated);
    if ((await entries(logs, directories)).some(file => file.isFile() && file.name === 'transcript.jsonl')) {
      found.set(join(logs, 'transcript.jsonl'), 'transcript');
    }
  }
}

async function readRange(handle, start, end) {
  const buffer = Buffer.allocUnsafe(end - start);
  let size = 0;
  while (size < buffer.length) {
    const { bytesRead } = await handle.read(buffer, size, buffer.length - size, start + size);
    if (!bytesRead) break;
    size += bytesRead;
  }
  return buffer.subarray(0, size);
}

async function hasOriginalBytes(handle, entry) {
  const head = await readRange(handle, 0, entry.head.length);
  const tail = await readRange(handle, entry.readOffset - entry.tail.length, entry.readOffset);
  return head.equals(entry.head) && tail.equals(entry.tail);
}

function isInside(root, file) {
  const path = relative(root, file);
  return path && !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep);
}

async function existingRealpath(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    return null;
  }
}

async function removeRollout(file, cached, root, protectedRoots) {
  const target = await existingRealpath(file);
  if (!target) return { status: 'missing' };
  if (!cached || !rolloutName.test(basename(target)) || !isInside(root, target)
    || protectedRoots.some(path => isInside(path, target))) return { status: 'unsafe' };
  // Unlink the verified path only if it still names the regular file scanned by the store.
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.dev !== cached.dev || stat.ino !== cached.ino
      || await existingRealpath(file) !== target) return { status: 'unsafe' };
    await unlink(target);
    return { status: 'removed', directory: dirname(target) };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { status: 'missing' };
    throw error;
  }
}

async function removeEmptyDates(directory, root, protectedRoots) {
  if (!/^\d{4}(?:\/\d{2}){0,2}$/.test(relative(root, directory).split(sep).join('/'))) return;
  for (let path = directory; path !== root; path = dirname(path)) {
    if (protectedRoots.some(protectedRoot => path === protectedRoot || isInside(protectedRoot, path))) return;
    try {
      const current = await existingRealpath(path);
      if (!current) continue;
      if (current !== path) return;
      await rmdir(path);
    } catch {
      // A directory may still contain another session or be unavailable.
      return;
    }
  }
}

function usageWindow(window) {
  if (!window) return null;
  return {
    usedPercent: window.used_percent ?? null, windowMinutes: window.window_minutes ?? null,
    resetsAt: window.resets_at ?? null,
  };
}

function geminiQuota(files, now) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const models = new Map();
  let totalInputTokens = 0, totalCacheReadTokens = 0, totalOutputTokens = 0, todayTotalTokens = 0, turnsCount = 0;
  for (const { state } of files.values()) {
    for (const usage of state.usage ?? []) {
      const { model, inputTokens, cacheReadTokens, outputTokens, timestamp } = usage;
      const totalTokens = inputTokens + cacheReadTokens + outputTokens;
      const time = Date.parse(timestamp);
      if (time >= start && time < end) todayTotalTokens += totalTokens;
      totalInputTokens += inputTokens;
      totalCacheReadTokens += cacheReadTokens;
      totalOutputTokens += outputTokens;
      turnsCount++;
      const row = models.get(model) ?? { model, turns: 0, totalTokens: 0, outputTokens: 0 };
      row.turns++;
      row.totalTokens += totalTokens;
      row.outputTokens += outputTokens;
      models.set(model, row);
    }
  }
  const inputs = totalInputTokens + totalCacheReadTokens;
  return {
    totalInputTokens, totalCacheReadTokens, totalOutputTokens, totalTokens: inputs + totalOutputTokens,
    todayTotalTokens, cacheHitRate: inputs ? totalCacheReadTokens / inputs : 0, turnsCount,
    estimatedCostUsd: (2 * totalInputTokens + 0.15 * totalCacheReadTokens + 10 * totalOutputTokens) / 1_000_000,
    models: [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model)),
  };
}

async function savedThreadId(reference, agyDir, root, directories) {
  let path;
  try {
    path = fileURLToPath(reference.uri);
  } catch {
    return;
  }
  if (basename(path) !== 'output.txt' || !(isInside(agyDir, path) || isInside(root, path))) return;

  let handle;
  try {
    const target = await realpath(path);
    if (basename(target) !== 'output.txt' || !isInside(root, target)) return;
    directories.add(dirname(target));
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile()) return;
    const signature = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
    if (signature === reference.signature) return;
    let previous = '';
    for await (const line of handle.readLines({ autoClose: false })) {
      const id = getThreadId(line) ?? getThreadId(previous + line);
      if (id) return id;
      previous = line.slice(-1024) + '\n';
    }
    reference.signature = signature;
  } catch (error) {
    if (!unavailable(error) && !['ELOOP', 'EISDIR'].includes(error.code)) throw error;
  } finally {
    await handle?.close();
  }
}

async function updateFile(file, kind, previous) {
  let handle;
  try {
    handle = await open(file, 'r');
    const { dev, ino, size, mtimeMs, ctimeMs } = await handle.stat();
    const sameFile = previous?.dev === dev && previous.ino === ino;
    if (sameFile && previous.readOffset === size && previous.mtimeMs === mtimeMs && previous.ctimeMs === ctimeMs) return null;
    const append = sameFile && size > previous.readOffset && await hasOriginalBytes(handle, previous);
    const create = kind === 'rollout' ? createRollout : createTranscript;
    const consume = kind === 'rollout' ? appendRollout : appendTranscript;
    const state = append ? previous.state : create(file);
    const from = append ? previous.readOffset : 0;
    const initialEvents = state.events?.length ?? 0;
    let pending = append ? previous.pending : Buffer.alloc(0);
    let readOffset = from;
    let offset = append ? previous.offset : 0;
    while (readOffset < size) {
      const chunk = await readRange(handle, readOffset, Math.min(readOffset + 256 * 1024, size));
      if (!chunk.length) break;
      readOffset += chunk.length;
      const bytes = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      const end = bytes.lastIndexOf(10) + 1;
      if (end) consume(state, bytes.toString('utf8', 0, end));
      pending = Buffer.from(bytes.subarray(end));
      offset = readOffset - pending.length;
    }
    if (pending.at(-1) === 125) {
      const finalLine = pending.toString('utf8');
      let complete;
      try {
        complete = JSON.parse(finalLine);
      } catch {
        // The producer may still be writing this record.
      }
      if (complete && typeof complete === 'object') {
        consume(state, finalLine);
        pending = Buffer.alloc(0);
        offset = readOffset;
      }
    }
    const head = await readRange(handle, 0, Math.min(256, readOffset));
    const tail = await readRange(handle, Math.max(0, readOffset - 256), readOffset);
    return {
      entry: { dev, ino, mtimeMs, ctimeMs, readOffset, offset, head, tail, state, pending },
      changed: offset !== (previous?.offset ?? 0) || Boolean(previous && !append),
      append: append && state.events?.length > initialEvents
        ? { id: state.threadId, offset, newEvents: visibleEvents(state.events.slice(initialEvents)) }
        : null,
    };
  } catch (error) {
    if (!unavailable(error)) throw error;
    return null;
  } finally {
    await handle?.close();
  }
}

function summarize(session, linkedAgyCallsCount) {
  const { threadId, file, cwd, model, effort, originator, status, tokens, updatedAt, createdAt } = session;
  return {
    threadId, file, cwd, model, effort, originator, isSubthread: Boolean(session.parentThreadId), status,
    preview: session.preview.replace(/\s+/g, ' ').slice(0, 300), turnsCount: session.turns.size, tokens, updatedAt, createdAt,
    linkedAgyCallsCount,
  };
}

export class SessionStore extends EventEmitter {
  constructor({
    codexDir = process.env.CODEX_SESSIONS_DIR || join(homedir(), '.codex', 'sessions'),
    agyDir = process.env.AGY_BRAIN_DIR || defaultBrain,
    codexBin = join(homedir(), '.local', 'bin', 'codex'),
    pollInterval = 2000,
  } = {}) {
    super();
    this.codexDir = resolve(codexDir);
    this.agyDir = resolve(agyDir);
    this.codexBin = codexBin;
    this.pollInterval = pollInterval;
    this.files = new Map();
    this.watchers = new Map();
    this.sessions = new Map();
    this.calls = [];
    this.linked = new Map();
  }

  start() {
    if (!this.started) {
      this.started = true;
      this.timer = setInterval(() => this.refresh(), this.pollInterval).unref();
    }
    return this.scan();
  }

  stop() {
    this.started = false;
    clearInterval(this.timer);
    clearTimeout(this.debounce);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  refresh() {
    if (this.started) this.scan().catch(error => this.emit('scan_error', error));
  }

  watchDirectories(directories) {
    if (!this.started) return;
    for (const [directory, watcher] of this.watchers) {
      if (directories.has(directory)) continue;
      watcher.close();
      this.watchers.delete(directory);
    }
    for (const directory of directories) {
      if (this.watchers.has(directory)) continue;
      try {
        const watcher = watch(directory, { persistent: false }, event => {
          if (event === 'rename') {
            watcher.close();
            if (this.watchers.get(directory) === watcher) this.watchers.delete(directory);
          }
          clearTimeout(this.debounce);
          this.debounce = setTimeout(() => this.refresh(), 80).unref();
        });
        this.watchers.set(directory, watcher);
        watcher.on('error', () => {
          watcher.close();
          if (this.watchers.get(directory) === watcher) this.watchers.delete(directory);
        });
      } catch (error) {
        if (!unavailable(error) && !['ENOSPC', 'EMFILE', 'ENFILE'].includes(error.code)) throw error;
      }
    }
  }

  scan() {
    if (this.deleting) return this.deleting.catch(() => {}).then(() => this.scan());
    this.scanning ??= this.scanFiles().finally(() => { this.scanning = null; });
    return this.scanning;
  }

  async scanFiles() {
    const directories = new Set([dirname(this.codexDir), dirname(this.agyDir)]);
    const found = new Map();
    await Promise.all([
      discoverRollouts(this.codexDir, directories, found),
      discoverTranscripts(this.agyDir, directories, found),
    ]);
    let changed = false;
    const appends = [];
    const files = [...found];
    for (let index = 0; index < files.length; index += 24) {
      const updates = await Promise.allSettled(files.slice(index, index + 24).map(async ([file, kind]) => (
        [file, await updateFile(file, kind, this.files.get(file))]
      )));
      for (const update of updates) {
        if (update.status === 'rejected') {
          this.emit('scan_error', update.reason);
          continue;
        }
        const [file, result] = update.value;
        if (!result) continue;
        this.files.set(file, result.entry);
        changed ||= result.changed;
        if (result.append) appends.push(result.append);
      }
    }
    for (const file of this.files.keys()) {
      if (!found.has(file)) {
        this.files.delete(file);
        changed = true;
      }
    }
    changed = await this.resolveSavedResults(directories) || changed;
    this.watchDirectories(directories);
    if (!changed) return;
    this.rebuild();
    for (const append of appends) {
      if (this.sessions.has(append.id)) this.emit('session_append', append);
    }
    this.emit('sessions_updated', { count: this.sessions.size });
  }

  async resolveSavedResults(directories) {
    const pending = [...this.files.values()]
      .flatMap(({ state }) => state.savedResults?.size ? [state.savedResults] : []);
    if (!pending.length) return false;
    let root;
    try {
      root = await realpath(this.agyDir);
    } catch (error) {
      if (!unavailable(error)) throw error;
      return false;
    }
    let changed = false;
    for (const results of pending) {
      for (const [call, reference] of results) {
        const id = await savedThreadId(reference, this.agyDir, root, directories);
        if (!id) continue;
        call.threadId = id;
        results.delete(call);
        changed = true;
      }
    }
    return changed;
  }

  rebuild() {
    const sessions = [...this.files.values()].map(entry => entry.state)
      .filter(state => state.events?.length)
      .sort((a, b) => byTime(b.updatedAt, a.updatedAt) || a.file.localeCompare(b.file));
    this.sessions = new Map(sessions.map(session => [session.threadId, session]).reverse());
    this.calls = correlateCalls([...this.files.values()].flatMap(entry => entry.state.calls ?? []),
      [...this.sessions.values()]).sort((a, b) => byTime(b.timestamp, a.timestamp));
    this.linked = new Map();
    for (const call of this.calls) {
      if (!call.sessionId) continue;
      if (!this.linked.has(call.sessionId)) this.linked.set(call.sessionId, []);
      this.linked.get(call.sessionId).push(call);
    }
  }

  list({ includeSubthreads = false, q = '' } = {}) {
    const query = q.trim().toLowerCase();
    return [...this.sessions.values()]
      .filter(session => includeSubthreads || !session.parentThreadId)
      .filter(session => !query || [session.threadId, session.cwd, session.model, session.originator, session.preview]
        .some(value => String(value).toLowerCase().includes(query)))
      .sort((a, b) => byTime(b.updatedAt, a.updatedAt) || a.threadId.localeCompare(b.threadId))
      .map(session => summarize(session, this.linked.get(session.threadId)?.length ?? 0));
  }

  quota(now = new Date()) {
    let latest;
    for (const { state } of this.files.values()) {
      if (state.rateLimits && (!latest || byTime(state.rateLimitsUpdatedAt, latest.rateLimitsUpdatedAt) > 0)) latest = state;
    }
    const rate = latest?.rateLimits;
    const sessions = [...this.sessions.values()];
    return {
      codex: {
        planType: rate?.plan_type ?? null, primary: usageWindow(rate?.primary), secondary: usageWindow(rate?.secondary),
        updatedAt: latest?.rateLimitsUpdatedAt ?? null,
        totalTokens: sessions.reduce((total, session) => total + tokenCount(session.tokens.total_tokens), 0),
        sessionsCount: sessions.filter(session => !session.parentThreadId).length,
      },
      gemini: geminiQuota(this.files, now),
    };
  }

  deleteSession(id) {
    const pending = this.deleting?.catch(() => {}) ?? Promise.resolve();
    const operation = pending.then(() => this.removeSession(id)).finally(() => {
      if (this.deleting === operation) this.deleting = null;
    });
    this.deleting = operation;
    return operation;
  }

  async removeSession(id) {
    await this.scanning;
    const missing = { status: 404, body: { error: 'Session not found' } };
    if (!this.sessions.has(id)) return missing;
    const [root, ...protectedRoots] = await Promise.all(
      [this.codexDir, this.agyDir, defaultBrain].map(existingRealpath),
    );
    if (!root) return missing;
    const rollouts = new Map();
    const children = new Map();
    for (const [file, entry] of this.files) {
      const { threadId, parentThreadId } = entry.state;
      if (threadId == null) continue;
      if (!rollouts.has(threadId)) rollouts.set(threadId, []);
      rollouts.get(threadId).push([file, entry]);
      if (parentThreadId == null) continue;
      if (!children.has(parentThreadId)) children.set(parentThreadId, new Set());
      children.get(parentThreadId).add(threadId);
    }
    const targets = new Set([id]);
    for (const threadId of targets) {
      for (const child of children.get(threadId) ?? []) targets.add(child);
    }
    const protectedPaths = protectedRoots.filter(Boolean);
    const directories = new Set();
    const unsafe = new Set();
    let removedParent = false;
    let changed = false;
    try {
      for (const threadId of targets) {
        if (threadId !== id && !removedParent) break;
        for (const [file, entry] of rollouts.get(threadId) ?? []) {
          const { status, directory } = await removeRollout(file, entry, root, protectedPaths);
          if (status === 'unsafe') {
            unsafe.add(file);
            continue;
          }
          this.files.delete(file);
          changed = true;
          if (status === 'removed') {
            directories.add(directory);
            if (threadId === id) removedParent = true;
          }
        }
      }
    } finally {
      for (const directory of directories) await removeEmptyDates(directory, root, protectedPaths);
      if (removedParent) {
        for (const file of unsafe) this.files.delete(file);
      }
      if (changed) {
        this.rebuild();
        this.emit('sessions_updated', { count: this.sessions.size });
      }
    }
    if (!removedParent) return unsafe.size ? { status: 403, body: { error: 'Unsafe session path' } } : missing;
    if (this.codexBin && uuid.test(id)) {
      await new Promise(resolve => execFile(this.codexBin, ['delete', '--force', id], { timeout: 2500 }, () => resolve()));
    }
    return { status: 200, body: { deleted: id } };
  }

  detail(id, { raw = false } = {}) {
    const session = this.sessions.get(id);
    if (!session) return null;
    const orchestratorCalls = this.linked.get(id) ?? [];
    const timeline = [
      ...visibleEvents(session.events, raw),
      ...orchestratorCalls.map(call => ({ key: call.id, type: 'dispatch', timestamp: call.timestamp, call })),
    ].sort((a, b) => byTime(a.timestamp, b.timestamp));
    return {
      ...summarize(session, orchestratorCalls.length),
      parentThreadId: session.parentThreadId, approvalPolicy: session.approvalPolicy,
      sandboxPolicy: session.sandboxPolicy, lastTokenUsage: session.lastTokenUsage,
      timeline, workflow: buildWorkflow(session, orchestratorCalls), orchestratorCalls,
      commands: [...session.commands], changedFiles: [...session.files],
    };
  }
}

export const createStore = options => new SessionStore(options);
