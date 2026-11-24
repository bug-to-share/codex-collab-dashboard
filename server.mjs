import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStore } from './lib/store.mjs';

const host = '127.0.0.1';
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function parseTarget(target) {
  const queryStart = target.indexOf('?');
  const rawPath = queryStart < 0 ? target : target.slice(0, queryStart);
  const path = decodeURIComponent(rawPath);
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\x00-\x1f]/.test(path)
    || path.split('/').some(segment => segment === '..' || segment === '.')) throw new Error('Invalid path');
  return [path, new URLSearchParams(queryStart < 0 ? '' : target.slice(queryStart + 1))];
}

export function createServer(options = {}) {
  const store = createStore(options);
  const clients = new Set();

  function broadcast(type, data) {
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      if (!client.write(frame) && client.writableLength > 1024 * 1024) client.destroy();
    }
  }

  for (const type of ['sessions_updated', 'session_append']) {
    store.on(type, data => broadcast(type, data));
  }
  store.on('scan_error', error => console.error('Dashboard log scan failed:', error.message));

  async function route(request, response) {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    let path, query;
    try {
      [path, query] = parseTarget(request.url);
    } catch {
      return json(response, 400, { error: 'Invalid request path' });
    }
    const sessionId = path.match(/^\/api\/sessions\/([^/]+)$/)?.[1];
    if (request.method === 'DELETE' && sessionId) {
      const authority = request.headers.host;
      const origin = request.headers.origin;
      if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(authority ?? '')
        || (origin && origin !== 'http://' + authority)) {
        return json(response, 403, { error: 'Local request required' });
      }
      await ready;
      const result = await store.deleteSession(sessionId);
      return json(response, result.status, result.body);
    }
    if (request.method !== 'GET') {
      response.setHeader('Allow', sessionId ? 'GET, DELETE' : 'GET');
      return json(response, 405, { error: 'Method not allowed' });
    }
    if (assets.has(path)) {
      const [file, type] = assets.get(path);
      const body = await readFile(new URL(`./public/${file}`, import.meta.url));
      response.writeHead(200, { 'Content-Type': type });
      return response.end(body);
    }
    if (path === '/api/stream') {
      if (!store.started || response.destroyed) return response.end();
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
      response.write(': connected\n\n');
      clients.add(response);
      response.on('close', () => clients.delete(response));
      return;
    }
    if (path === '/api/sessions' || sessionId || path === '/api/orchestrator' || path === '/api/quota') {
      await ready;
      await store.scanning;
      await store.deleting?.catch(() => {});
      if (path === '/api/sessions') {
        return json(response, 200, store.list({
          includeSubthreads: query.get('include_subthreads') === '1', q: query.get('q') ?? '',
        }));
      }
      if (path === '/api/orchestrator') return json(response, 200, store.calls);
      if (path === '/api/quota') return json(response, 200, store.quota());
      const detail = store.detail(sessionId, { raw: query.get('raw') === '1' });
      if (detail) return json(response, 200, detail);
    }
    return json(response, 404, { error: 'Not found' });
  }

  const server = createHttpServer((request, response) => {
    route(request, response).catch(error => {
      console.error('Dashboard request failed:', error.message);
      if (response.headersSent) response.destroy();
      else json(response, 500, { error: 'Internal server error' });
    });
  });
  let ready;
  let heartbeat;
  const listen = server.listen.bind(server);
  const close = server.close.bind(server);
  server.listen = (port = Number(process.env.PORT || 4318), ...args) => {
    const callback = args.find(arg => typeof arg === 'function');
    const suppliedPort = typeof port === 'object' ? port?.port : port;
    const number = typeof suppliedPort === 'string' && suppliedPort.trim() ? Number(suppliedPort) : suppliedPort;
    if (!Number.isInteger(number) || number < 0 || number > 65535) throw new RangeError('Invalid dashboard port');
    return listen({ port: number, host }, callback);
  };
  server.on('listening', () => {
    ready = store.start().catch(error => {
      console.error('Initial dashboard log scan failed:', error.message);
    });
    heartbeat = setInterval(() => {
      for (const client of clients) client.write(': heartbeat\n\n');
    }, 15_000).unref();
  });
  server.close = callback => {
    store.stop();
    clearInterval(heartbeat);
    for (const client of clients) client.end();
    clients.clear();
    return close(callback);
  };
  return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const server = createServer();
  server.listen(Number(process.env.PORT || 4318), () => {
    console.log(`Dashboard listening at http://${host}:${server.address().port}`);
  });
}
