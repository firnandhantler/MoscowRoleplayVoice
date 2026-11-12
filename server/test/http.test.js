import assert from 'node:assert/strict';
import test from 'node:test';
import { createHttpServer } from '../src/http/server.js';

const config = Object.freeze({
  serviceName: 'moscowroleplay-voice-server',
  appVersion: '0.1.0',
  nodeEnv: 'test',
  websocket: Object.freeze({
    path: '/ws',
  }),
});

const logger = {
  child() {
    return logger;
  },
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
};

/**
 * Запускает HTTP-сервер на свободном порту loopback.
 *
 * @param {import('node:http').Server} server
 * @returns {Promise<string>}
 */
function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };

    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

/**
 * @param {import('node:http').Server} server
 * @returns {Promise<void>}
 */
function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Создаёт сервер и автоматически закрывает его после теста.
 *
 * @param {import('node:test').TestContext} t
 * @param {{checkHealth: () => Promise<object>}} database
 * @returns {Promise<string>}
 */
async function startServer(t, database) {
  const server = createHttpServer({ config, logger, database });
  const baseUrl = await listen(server);

  t.after(async () => {
    await close(server);
  });

  return baseUrl;
}

test('GET /health/live возвращает 200 без обращения к PostgreSQL', async (t) => {
  let databaseCalled = false;
  const baseUrl = await startServer(t, {
    checkHealth: async () => {
      databaseCalled = true;
      throw new Error('Liveness не должен обращаться к базе.');
    },
  });

  const response = await fetch(`${baseUrl}/health/live`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.checks.process.status, 'ok');
  assert.equal(body.checks.database, undefined);
  assert.equal(databaseCalled, false);
});

test('GET /health/ready возвращает 200 при доступной базе', async (t) => {
  const baseUrl = await startServer(t, {
    checkHealth: async () => ({ status: 'ok', latencyMs: 2 }),
  });

  const response = await fetch(`${baseUrl}/health/ready`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.checks.database.status, 'ok');
});

test('GET /health/ready возвращает 503 при недоступной базе', async (t) => {
  const baseUrl = await startServer(t, {
    checkHealth: async () => ({
      status: 'error',
      code: 'database_unavailable',
      message: 'База данных недоступна.',
      latencyMs: 3000,
    }),
  });

  const response = await fetch(`${baseUrl}/health/ready`);
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.status, 'degraded');
  assert.equal(body.checks.database.code, 'database_unavailable');
});

test('GET /health остаётся readiness-проверкой для Docker healthcheck', async (t) => {
  const baseUrl = await startServer(t, {
    checkHealth: async () => ({
      status: 'error',
      code: 'database_unavailable',
      message: 'База данных недоступна.',
      latencyMs: 3000,
    }),
  });

  const response = await fetch(`${baseUrl}/health`);

  assert.equal(response.status, 503);
});

test('GET / указывает liveness- и readiness-маршруты', async (t) => {
  const baseUrl = await startServer(t, {
    checkHealth: async () => ({ status: 'ok', latencyMs: 1 }),
  });

  const response = await fetch(`${baseUrl}/`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.health, '/health');
  assert.equal(body.healthLiveness, '/health/live');
  assert.equal(body.healthReadiness, '/health/ready');
  assert.equal(body.websocket, '/ws');
});

test('ошибка проверки базы не раскрывает внутренние детали', async (t) => {
  const baseUrl = await startServer(t, {
    checkHealth: async () => {
      throw new Error('password=secret host=internal');
    },
  });

  const response = await fetch(`${baseUrl}/health/ready`);
  const body = await response.text();

  assert.equal(response.status, 500);
  assert.equal(body.includes('password=secret'), false);
  assert.match(body, /Внутренняя ошибка сервера/);
});

test('health-маршруты не принимают методы кроме GET', async (t) => {
  const baseUrl = await startServer(t, {
    checkHealth: async () => ({ status: 'ok', latencyMs: 1 }),
  });

  const response = await fetch(`${baseUrl}/health/ready`, {
    method: 'POST',
  });

  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET');
});
