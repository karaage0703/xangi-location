import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { LocationStore, loadConfig } from '../src/location.mjs';
import { createLocationServers, startLocation } from '../src/server.mjs';

const token = 'test-only-extension-token-00000000';
const password = 'test-only-ingest-password-00000000';
const current = 1_790_000_000;
const sample = (extra = {}) => ({
  _type: 'location', lat: 35.5, lon: 139.5, acc: 12, tst: current,
  topic: 'owntracks/owner/iphone', ...extra,
});

function fixture(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'xangi-location-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dataDir: join(dir, 'data'), ingestPort: 0, username: 'owner', password,
    deviceId: 'iphone', maxAgeSeconds: 1800, ...extra,
  };
}

async function service(t, extra = {}) {
  const config = fixture(t, extra);
  const servers = createLocationServers(config, token, { now: () => current });
  for (const server of Object.values(servers)) {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
  }
  t.after(async () => {
    await Promise.all(Object.values(servers).map((server) => new Promise((done) => {
      server.closeAllConnections(); server.close(done);
    })));
  });
  const apiURL = `http://127.0.0.1:${servers.api.address().port}`;
  const ingestURL = `http://127.0.0.1:${servers.ingest.address().port}`;
  const basic = `Basic ${Buffer.from(`owner:${password}`).toString('base64')}`;
  return {
    config, apiURL, ingestURL, basic,
    read: () => fetch(`${apiURL}/location`, { headers: { Authorization: `Bearer ${token}` } }),
    post: (body, headers = {}) => fetch(`${ingestURL}/pub`, {
      method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { Authorization: basic, 'Content-Type': 'application/json', ...headers },
    }),
  };
}

test('OwnTracks HTTP publication is persisted, minimized, and readable after restart', async (t) => {
  const s = await service(t);
  assert.deepEqual(await (await s.read()).json(), { status: 'missing', location: null });
  const response = await s.post(sample({ SSID: 'private-network', tag: 'private-note', batt: 42 }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
  const actual = await (await s.read()).json();
  assert.equal(actual.status, 'fresh'); assert.equal(actual.ageSeconds, 0);
  assert.equal(actual.location.latitude, 35.5); assert.equal(actual.location.accuracyMeters, 12);
  assert.equal(actual.location.observedAt, current); assert.equal(actual.location.receivedAt, current);
  const disk = readFileSync(join(s.config.dataDir, 'latest.json'), 'utf8');
  for (const secret of ['private-network', 'private-note', password, token, 'batt']) assert.ok(!disk.includes(secret));
  assert.equal(statSync(s.config.dataDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(s.config.dataDir, 'latest.json')).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(s.config.dataDir), ['latest.json']);
  const restored = new LocationStore(s.config, () => current + 1801).snapshot();
  assert.equal(restored.status, 'stale'); assert.equal(restored.ageSeconds, 1801);
  assert.deepEqual(restored.location, actual.location);
});

test('staleness uses GPS fix time rather than delayed HTTP receipt', (t) => {
  const store = new LocationStore(fixture(t), () => current + 3600);
  store.receive(sample());
  assert.equal(store.snapshot().status, 'stale');
  assert.equal(store.snapshot().ageSeconds, 3600);
});

test('out-of-order, duplicate, and iOS ping messages cannot replace or refresh the saved fix', (t) => {
  const store = new LocationStore(fixture(t), () => current + 3600);
  store.receive(sample());
  store.receive(sample({ tst: current - 100, lat: 1 }));
  store.receive(sample({ lat: 2 }));
  store.receive(sample({ tst: current + 3500, t: 'p', lat: 3 }));
  assert.equal(store.snapshot().location.latitude, 35.5);
  assert.equal(store.snapshot().location.observedAt, current);
  assert.equal(store.snapshot().status, 'stale');
});

test('API and ingestion credentials are separate and cannot read via public listener', async (t) => {
  const s = await service(t);
  for (const path of ['/health', '/location']) {
    for (const authorization of ['', s.basic, 'Bearer wrong']) {
      assert.equal((await fetch(`${s.apiURL}${path}`, { headers: { authorization } })).status, 401);
    }
  }
  assert.equal((await s.post(sample(), { Authorization: `Bearer ${token}` })).status, 401);
  assert.equal((await s.post(sample(), { Authorization: '' })).status, 401);
  assert.equal((await fetch(`${s.ingestURL}/location`, { headers: { Authorization: s.basic } })).status, 404);
  const health = await fetch(`${s.apiURL}/health`, { headers: { Authorization: `Bearer ${token}` } });
  assert.deepEqual(await health.json(), { ready: true });
  assert.equal(health.headers.get('cache-control'), 'no-store');
});

test('matching identity headers can replace topic; conflicts and missing identity are rejected', async (t) => {
  const s = await service(t);
  const withoutTopic = sample(); delete withoutTopic.topic;
  assert.equal((await s.post(withoutTopic)).status, 422);
  assert.equal((await s.post(withoutTopic, { 'X-Limit-U': 'owner', 'X-Limit-D': 'iphone' })).status, 200);
  assert.equal((await s.post(sample({ topic: 'owntracks/other/iphone' }))).status, 422);
  assert.equal((await s.post(sample(), { 'X-Limit-D': 'other' })).status, 422);
});

test('invalid values never create location state', async (t) => {
  const s = await service(t);
  const invalid = [
    { lat: 91 }, { lon: -181 }, { lat: '35.5' }, { lat: null },
    { tst: current + 61 }, { tst: -1 }, { tst: 1.2 }, { tst: '1790000000' },
    { acc: -1 }, { acc: '10' },
  ];
  for (const extra of invalid) assert.equal((await s.post(sample(extra))).status, 422);
  assert.equal((await s.read()).status, 200);
  assert.equal((await (await s.read()).json()).status, 'missing');
  assert.deepEqual(readdirSync(s.config.dataDir), []);
});

test('unknown accuracy is reported as null and zero coordinates are valid', (t) => {
  const store = new LocationStore(fixture(t), () => current);
  store.receive(sample({ lat: 0, lon: 0, acc: undefined }));
  assert.equal(store.snapshot().location.accuracyMeters, null);
  assert.equal(store.snapshot().location.latitude, 0);
});

test('empty and non-location publications are acknowledged; malformed or encrypted input is rejected', async (t) => {
  const s = await service(t);
  for (const body of ['', { _type: 'transition', event: 'enter' }, { _type: 'status' }]) {
    const response = await s.post(body);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), []);
  }
  for (const body of ['{', 'null', '[]', '{}', { _type: 'encrypted', data: 'secret' }]) {
    const response = await s.post(body);
    assert.equal(response.status, 422);
    assert.ok(!(await response.text()).includes('secret'));
  }
  assert.equal((await s.post(sample(), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await s.read()).headers.get('cache-control'), 'no-store');
});

test('body limit applies to regular and chunked requests and service remains usable', async (t) => {
  const s = await service(t);
  assert.equal((await s.post('x'.repeat(9000))).status, 413);
  const status = await new Promise((done, reject) => {
    const req = request(`${s.ingestURL}/pub`, {
      method: 'POST', headers: { Authorization: s.basic, 'Content-Type': 'application/json' },
    }, (res) => { res.resume(); done(res.statusCode); });
    req.on('error', reject);
    req.write('x'.repeat(5000)); req.end('x'.repeat(4000));
  });
  assert.equal(status, 413);
  assert.equal((await s.post(sample())).status, 200);
});

test('storage failure returns sanitized failure and does not acknowledge or retain unsaved location', async (t) => {
  const s = await service(t);
  rmSync(s.config.dataDir, { recursive: true });
  writeFileSync(s.config.dataDir, 'not a directory');
  const result = await s.post(sample());
  assert.equal(result.status, 500);
  assert.deepEqual(await result.json(), { error: 'Unable to save location' });
  assert.equal((await (await s.read()).json()).status, 'missing');
});

test('corrupt or mismatched saved state fails startup instead of serving it', (t) => {
  const config = fixture(t);
  const store = new LocationStore(config, () => current);
  store.receive(sample());
  assert.throws(() => new LocationStore({ ...config, deviceId: 'other' }, () => current));
  writeFileSync(join(config.dataDir, 'latest.json'), '{broken');
  assert.throws(() => new LocationStore(config, () => current));
});

test('configuration rejects placeholder credentials and resolves storage relative to config file', (t) => {
  const config = fixture(t);
  const path = join(config.dataDir, '..', 'config.json');
  writeFileSync(path, JSON.stringify({ ...config, dataDir: './private', ingestPort: 18991 }));
  assert.equal(loadConfig(path).dataDir, join(config.dataDir, '..', 'private'));
  for (const extra of [
    { password: 'REPLACE_WITH_RANDOM_PASSWORD' }, { username: 'owner:other' },
    { deviceId: '../escape' }, { password: 'x'.repeat(23) },
    { maxAgeSeconds: 0 }, { ingestPort: -1 }, { ingestPort: 65536 },
  ]) assert.throws(() => new LocationStore({ ...config, ...extra }));
});

test('occupied ingestion port prevents readiness and leaves the existing listener alone', async (t) => {
  const occupied = createServer(); occupied.listen(0, '127.0.0.1'); await once(occupied, 'listening');
  t.after(() => new Promise((done) => occupied.close(done)));
  await assert.rejects(startLocation(fixture(t, { ingestPort: occupied.address().port }), token), { code: 'EADDRINUSE' });
  assert.equal(occupied.listening, true);
});

test('real managed entrypoint: ready handshake, HTTP round trip, and stdin shutdown', { timeout: 10_000 }, async (t) => {
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  const config = fixture(t, { ingestPort: port });
  const configPath = join(config.dataDir, '..', 'config.json');
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const child = spawn(process.execPath, ['src/server.mjs', 'serve', '--workspace', cwd], {
    cwd, env: { ...process.env, XANGI_EXTENSION_AUTH_TOKEN: token, XANGI_LOCATION_CONFIG: configPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout });
  const [line] = await once(lines, 'line');
  const ready = JSON.parse(line);
  assert.equal(ready.event, 'ready'); assert.equal(ready.schemaVersion, 2);
  assert.equal(ready.id, 'xangi-location'); assert.equal(ready.workspace, cwd.replace(/\/$/, ''));
  assert.ok(ready.baseUrl.startsWith('http://127.0.0.1:'));
  const authorization = `Basic ${Buffer.from(`owner:${password}`).toString('base64')}`;
  const published = await fetch(`http://127.0.0.1:${port}/pub`, {
    method: 'POST', headers: { authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify(sample({ tst: Math.floor(Date.now() / 1000) })),
  });
  assert.equal(published.status, 200);
  const result = await fetch(`${ready.baseUrl}/location`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal((await result.json()).location.latitude, 35.5);
  child.stdin.end();
  const [code] = await exited;
  assert.equal(code, 0);
  lines.close();
  await assert.rejects(fetch(`${ready.baseUrl}/health`));
});
