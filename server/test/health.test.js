import assert from 'node:assert/strict';
import test from 'node:test';
import { createHealthService } from '../src/monitoring/health.js';

const config = Object.freeze({
  serviceName: 'moscowroleplay-voice-server',
  appVersion: '0.1.0',
  nodeEnv: 'test',
});

test('liveness возвращает ok и не обращается к базе данных', () => {
  let databaseCalled = false;
  const service = createHealthService({
    config,
    database: {
      checkHealth: async () => {
        databaseCalled = true;
        throw new Error('База данных не должна вызываться при liveness-проверке.');
      },
    },
  });

  const result = service.checkLiveness();

  assert.equal(result.status, 'ok');
  assert.equal(result.checks.process.status, 'ok');
  assert.equal(result.checks.database, undefined);
  assert.equal(result.service, config.serviceName);
  assert.equal(databaseCalled, false);
});

test('readiness возвращает ok при доступной базе', async () => {
  const service = createHealthService({
    config,
    database: {
      checkHealth: async () => ({ status: 'ok', latencyMs: 3 }),
    },
  });

  const result = await service.checkReadiness();

  assert.equal(result.status, 'ok');
  assert.equal(result.checks.database.status, 'ok');
  assert.equal(result.service, config.serviceName);
});

test('readiness возвращает degraded при недоступной базе', async () => {
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

  const result = await service.checkReadiness();

  assert.equal(result.status, 'degraded');
  assert.equal(result.checks.database.code, 'database_unavailable');
});
