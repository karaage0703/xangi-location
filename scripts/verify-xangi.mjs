// Optional compatibility check against a separately built xangi checkout.
// Only a disposable store and synthetic location data are used.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';

if (!process.argv[2]) throw new Error('Usage: npm run test:xangi -- /path/to/built/xangi-checkout');
const root = resolve(process.argv[2]);
const dir = mkdtempSync(join(tmpdir(), 'xangi-location-integration-'));
const configPath = join(dir, 'config.json');
const password = randomBytes(32).toString('hex');
let runtime;
try {
  Object.assign(process.env, {
    XANGI_EXTENSIONS_FILE: join(dir, 'extensions.json'),
    XANGI_LOCATION_CONFIG: configPath,
    DATA_DIR: join(dir, 'xangi-data'), WORKSPACE_PATH: dir,
    XANGI_EVENTS_ENABLED: 'false', XANGI_INSTANCE_ID: 'location-compat-test',
  });
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  writeFileSync(configPath, JSON.stringify({
    dataDir: './location-data', username: 'owner', deviceId: 'iphone',
    password, ingestPort: port, maxAgeSeconds: 1800,
  }), { mode: 0o600 });

  runtime = await import(pathToFileURL(join(root, 'dist/extensions.js')).href);
  const { executeExtensionRequest } = await import(pathToFileURL(join(root, 'dist/extension-request.js')).href);
  const manifest = fileURLToPath(new URL('../xangi-extension.json', import.meta.url));
  const linked = await runtime.linkExtension(manifest, { configPath: process.env.XANGI_EXTENSIONS_FILE });
  const status = await runtime.runExtensionAction(linked, 'start', { workspace: dir });
  assert.equal(status.running, true); assert.equal(status.healthy, true); assert.equal(status.ready, true);
  console.log('PASS: xangi manifest parser, managed launch, readiness, and authenticated health');

  const flags = { id: 'xangi-location', capability: 'location.read', path: '/location' };
  assert.equal(JSON.parse(await executeExtensionRequest(flags)).status, 'missing');
  const response = await fetch(`http://127.0.0.1:${port}/pub`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`owner:${password}`).toString('base64')}`,
    },
    body: JSON.stringify({
      _type: 'location', lat: 35.5, lon: 139.5, tst: Math.floor(Date.now() / 1000),
      acc: 12, topic: 'owntracks/owner/iphone',
    }),
  });
  assert.equal(response.status, 200);
  const location = JSON.parse(await executeExtensionRequest(flags));
  assert.equal(location.status, 'fresh'); assert.equal(location.location.latitude, 35.5);
  console.log('PASS: OwnTracks publish -> xangi executeExtensionRequest -> fresh location');

  await runtime.runExtensionAction(linked, 'stop');
  await assert.rejects(executeExtensionRequest(flags));
  await runtime.runExtensionAction(linked, 'start', { workspace: dir });
  assert.equal(JSON.parse(await executeExtensionRequest(flags)).location.latitude, 35.5);
  console.log('PASS: xangi stop, unavailable capability, restart, and persisted location');
} finally {
  if (runtime) await runtime.stopManagedExtensions();
  rmSync(dir, { recursive: true, force: true });
}
