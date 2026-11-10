import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigError, buildConfig } from '../src/config/index.js';

const BASE_ENV = Object.freeze({
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  LOG_PRETTY: 'false',
  POSTGRES_PASSWORD: 'test_password_12345',
});

test('собирает конфигурацию с безопасными значениями по умолчанию', () => {
  const config = buildConfig({ ...BASE_ENV });

  assert.equal(config.server.port, 3000);
  assert.equal(config.server.host, '0.0.0.0');
  assert.equal(config.websocket.path, '/ws');
  assert.equal(config.database.user, 'mrv_app');
  assert.equal(config.database.database, 'moscowroleplay_voice');
  assert.equal(config.mediasoup.rtcMinPort, 40000);
  assert.equal(config.mediasoup.rtcMaxPort, 40049);
  assert.equal(config.mediasoup.announcedIp, null);
});

test('требует POSTGRES_PASSWORD и не выводит его значение', () => {
  const env = { ...BASE_ENV };
  delete env.POSTGRES_PASSWORD;

  assert.throws(
    () => buildConfig(env),
    (err) => {
      assert.equal(err instanceof ConfigError, true);
      assert.match(err.message, /POSTGRES_PASSWORD/);
      return true;
    },
  );
});

test('отклоняет слишком короткий пароль', () => {
  assert.throws(
    () => buildConfig({ ...BASE_ENV, POSTGRES_PASSWORD: 'short' }),
    /не менее 12 символов/,
  );
});

test('отклоняет некорректный порт', () => {
  assert.throws(
    () => buildConfig({ ...BASE_ENV, SERVER_PORT: '70000' }),
    /SERVER_PORT/,
  );
});

test('отклоняет перевёрнутый диапазон UDP-портов mediasoup', () => {
  assert.throws(
    () =>
      buildConfig({
        ...BASE_ENV,
        MEDIASOUP_RTC_MIN_PORT: '40100',
        MEDIASOUP_RTC_MAX_PORT: '40000',
      }),
    /MEDIASOUP_RTC_MIN_PORT/,
  );
});

test('отклоняет некорректный публичный IP mediasoup', () => {
  assert.throws(
    () =>
      buildConfig({
        ...BASE_ENV,
        MEDIASOUP_ANNOUNCED_IP: 'not-an-ip',
      }),
    /MEDIASOUP_ANNOUNCED_IP/,
  );
});

test('отключает pino-pretty в production', () => {
  const config = buildConfig({
    ...BASE_ENV,
    NODE_ENV: 'production',
    LOG_PRETTY: 'true',
  });

  assert.equal(config.logPretty, false);
});
