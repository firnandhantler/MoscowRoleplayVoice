import assert from 'node:assert/strict';
import test from 'node:test';
import { createHealthService } from '../src/monitoring/health.js';

const config = Object.freeze({
  serviceName: 'moscowroleplay-voice-server',
  appVersion: '0.1.0',
  nodeEnv: 'test',
});

test('health-check возвращает ok при доступной базе', async () => {
  const service = createHealthService({
    config,
    database: {
      checkHealth: async () => ({ status: 'ok', latencyMs: 3 }),
    },
  });

  const result = await service.check();

  assert.equal(result.status, 'ok');
  assert.equal(result.checks.database.status, 'ok');
  assert.equal(result.service, config.serviceName);
});

test('health-check возвращает degraded при недоступной базе', async () => {
  const service = createHealthService({
    config,
    database: {
      checkHealth: async () => ({
        status: 'error',
        code: 'database_unavailable',
        message: 'База данных недоступна.',
        latencyMs: 3000,
      }),
    },
  });

  const result = await service.check();

  assert.equal(result.status, 'degraded');
  assert.equal(result.checks.database.code, 'database_unavailable');
});
