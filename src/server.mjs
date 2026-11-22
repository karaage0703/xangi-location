#!/usr/bin/env node
import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { InputError, LocationStore, loadConfig } from './location.mjs';

function matches(actual, expected) {
  const digest = (value) => createHash('sha256').update(value).digest();
  return typeof actual === 'string' && timingSafeEqual(digest(actual), digest(expected));
}

function respond(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

async function payload(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > 8192) throw Object.assign(new InputError('Payload too large'), { status: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.length) return undefined; // OwnTracks may publish an empty payload.
  try { return JSON.parse(raw); } catch { throw new InputError('Invalid JSON'); }
}

export function createLocationServers(config, token, { now } = {}) {
  if (typeof token !== 'string' || token.length < 24) throw new InputError('Missing extension token');
  const store = new LocationStore(config, now);
  const api = createServer((req, res) => {
    if (!matches(req.headers.authorization, `Bearer ${token}`)) {
      respond(res, 401, { error: 'Unauthorized' }); return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      respond(res, 200, { ready: true }); return;
    }
    if (req.method === 'GET' && req.url === '/location') {
      respond(res, 200, store.snapshot()); return;
    }
    respond(res, 404, { error: 'Not found' });
  });
  const basic = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
  const ingest = createServer(async (req, res) => {
    if (!matches(req.headers.authorization, basic)) {
      respond(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Basic realm="OwnTracks"' }); return;
    }
    if (req.method !== 'POST' || req.url !== '/pub') {
      respond(res, 404, { error: 'Not found' }); return;
    }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
      respond(res, 415, { error: 'Expected application/json' }); return;
    }
    try {
      const body = await payload(req);
      if (body !== undefined) store.receive(body, req.headers);
      respond(res, 200, []);
    } catch (error) {
      req.resume();
      // Never include coordinates, credentials, request bodies or filesystem paths in errors.
      if (error instanceof InputError) respond(res, error.status ?? 422, { error: error.message });
      else respond(res, 500, { error: 'Unable to save location' });
    }
  });
  for (const server of [api, ingest]) {
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.timeout = 15_000;
    server.maxHeadersCount = 32;
  }
  return { api, ingest };
}

function listen(server, port) {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolveListen(server.address().port);
    });
  });
}

export async function startLocation(config, token) {
  const servers = createLocationServers(config, token);
  try {
    const ingestPort = await listen(servers.ingest, config.ingestPort);
    const apiPort = await listen(servers.api, 0);
    return { ...servers, ingestPort, baseUrl: `http://127.0.0.1:${apiPort}` };
  } catch (error) {
    for (const server of Object.values(servers)) { server.closeAllConnections(); server.close(); }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let running;
  try {
    const workspaceIndex = process.argv.indexOf('--workspace');
    const workspace = workspaceIndex >= 0 ? process.argv[workspaceIndex + 1] : process.cwd();
    if (process.argv[2] !== 'serve' || !workspace || !process.env.XANGI_LOCATION_CONFIG) {
      throw new InputError('Use serve with XANGI_LOCATION_CONFIG');
    }
    const config = loadConfig(resolve(process.env.XANGI_LOCATION_CONFIG));
    running = await startLocation(config, process.env.XANGI_EXTENSION_AUTH_TOKEN);
    console.log(JSON.stringify({
      schemaVersion: 2, event: 'ready', id: 'xangi-location',
      baseUrl: running.baseUrl, workspace: resolve(workspace),
    }));
    const stop = () => {
      for (const server of [running.api, running.ingest]) {
        server.closeAllConnections(); server.close();
      }
      process.stdin.destroy();
    };
    process.stdin.resume();
    process.stdin.once('end', stop);
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  } catch {
    console.error('Location extension failed to start; check private configuration and port availability.');
    process.exitCode = 1;
  }
}
