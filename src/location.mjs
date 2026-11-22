import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export class InputError extends Error {}

export function validateConfig(config) {
  const identifier = /^[A-Za-z0-9_-]{1,64}$/;
  if (!config || typeof config.username !== 'string' || typeof config.deviceId !== 'string' ||
      !identifier.test(config.username) || !identifier.test(config.deviceId) ||
      typeof config.password !== 'string' || config.password.length < 24 ||
      /[\r\n\0]/.test(config.password) || config.password === 'REPLACE_WITH_RANDOM_PASSWORD' ||
      typeof config.dataDir !== 'string' || !config.dataDir ||
      !Number.isInteger(config.ingestPort) || config.ingestPort < 0 || config.ingestPort > 65535 ||
      !Number.isInteger(config.maxAgeSeconds) || config.maxAgeSeconds < 1) {
    throw new InputError('Invalid location configuration');
  }
  return config;
}

export function loadConfig(path) {
  const config = validateConfig(JSON.parse(readFileSync(path, 'utf8')));
  if (config.ingestPort === 0) throw new InputError('ingestPort must be stable and nonzero');
  return { ...config, dataDir: resolve(dirname(path), config.dataDir) };
}

function finiteRange(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function validLocation(value) {
  return value && finiteRange(value.latitude, -90, 90) && finiteRange(value.longitude, -180, 180) &&
    Number.isSafeInteger(value.observedAt) && value.observedAt > 0 &&
    (value.accuracyMeters === null || finiteRange(value.accuracyMeters, 0, 1_000_000));
}

export class LocationStore {
  constructor(config, now = () => Math.floor(Date.now() / 1000)) {
    this.config = validateConfig(config);
    this.now = now;
    this.file = join(config.dataDir, 'latest.json');
    // This directory belongs exclusively to this extension, never a workspace root.
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    chmodSync(config.dataDir, 0o700);
    this.latest = null;
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!validLocation(saved) || saved.deviceId !== config.deviceId || saved.username !== config.username ||
          !Number.isSafeInteger(saved.receivedAt) || saved.receivedAt < saved.observedAt - 60 ||
          saved.observedAt > this.now() + 60) throw new InputError('Invalid saved location');
      chmodSync(this.file, 0o600);
      this.latest = saved;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  receive(body, headers = {}) {
    if (!body || Array.isArray(body) || typeof body._type !== 'string') throw new InputError('Expected OwnTracks object');
    if (body._type === 'encrypted') throw new InputError('Payload encryption is unsupported; use HTTPS');
    if (body._type !== 'location') return;
    const config = this.config;
    const expectedTopic = `owntracks/${config.username}/${config.deviceId}`;
    const hasHeaders = headers['x-limit-u'] !== undefined && headers['x-limit-d'] !== undefined;
    if ((body.topic === undefined && !hasHeaders) ||
        (body.topic !== undefined && body.topic !== expectedTopic) ||
        (headers['x-limit-u'] !== undefined && headers['x-limit-u'] !== config.username) ||
        (headers['x-limit-d'] !== undefined && headers['x-limit-d'] !== config.deviceId)) {
      throw new InputError('Device identity does not match configuration');
    }
    const now = this.now();
    const location = {
      username: config.username,
      deviceId: config.deviceId,
      latitude: body.lat,
      longitude: body.lon,
      accuracyMeters: body.acc ?? null,
      observedAt: body.tst,
      receivedAt: now,
    };
    if (!validLocation(location) || location.observedAt > now + 60) throw new InputError('Invalid location values');
    // iOS pings can advance tst without obtaining a fresh GPS fix.
    if (body.t === 'p' || (this.latest && location.observedAt <= this.latest.observedAt)) return;
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(location), { mode: 0o600, flag: 'w' });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.file);
    this.latest = location;
  }

  snapshot() {
    if (!this.latest) return { status: 'missing', location: null };
    const ageSeconds = Math.max(0, this.now() - this.latest.observedAt);
    return {
      status: ageSeconds > this.config.maxAgeSeconds ? 'stale' : 'fresh',
      ageSeconds,
      maxAgeSeconds: this.config.maxAgeSeconds,
      location: this.latest,
    };
  }
}
