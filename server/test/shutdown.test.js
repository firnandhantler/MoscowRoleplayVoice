import assert from 'node:assert/strict';
import test from 'node:test';
import { GracefulShutdown } from '../src/utils/shutdown.js';

function createTestLogger() {
  const records = [];

  const logger = {
    info: (fields, message) => records.push({ level: 'info', fields, message }),
    warn: (fields, message) => records.push({ level: 'warn', fields, message }),
    error: (fields, message) => records.push({ level: 'error', fields, message }),
    child: () => logger,
    flush: () => {},
  };

  return { logger, records };
}

test('выполняет обработчики в порядке регистрации', async () => {
  const { logger } = createTestLogger();
  const calls = [];
  const originalExit = process.exit;
  let exitCode;

  process.exit = (code) => {
    exitCode = code;
  };

  try {
    const shutdown = new GracefulShutdown({ logger, timeoutMs: 1000 });
    shutdown.register('first', () => calls.push('first'));
    shutdown.register('second', () => calls.push('second'));

    await shutdown.run('test', 0);

    assert.deepEqual(calls, ['first', 'second']);
    assert.equal(exitCode, 0);
  } finally {
    process.exit = originalExit;
  }
});

test('продолжает остановку после ошибки обработчика и выставляет код 1', async () => {
  const { logger } = createTestLogger();
  const calls = [];
  const originalExit = process.exit;
  let exitCode;

  process.exit = (code) => {
    exitCode = code;
  };

  try {
    const shutdown = new GracefulShutdown({ logger, timeoutMs: 1000 });
    shutdown.register('broken', () => {
      throw new Error('Тестовая ошибка обработчика');
    });
    shutdown.register('after-broken', () => calls.push('after-broken'));

    await shutdown.run('test', 0);

    assert.deepEqual(calls, ['after-broken']);
    assert.equal(exitCode, 1);
  } finally {
    process.exit = originalExit;
  }
});

test('игнорирует повторный запуск завершения', async () => {
  const { logger } = createTestLogger();
  let calls = 0;
  const originalExit = process.exit;

  process.exit = () => {};

  try {
    const shutdown = new GracefulShutdown({ logger, timeoutMs: 1000 });
    shutdown.register('counter', () => {
      calls += 1;
    });

    await shutdown.run('first', 0);
    await shutdown.run('second', 0);

    assert.equal(calls, 1);
  } finally {
    process.exit = originalExit;
  }
});
