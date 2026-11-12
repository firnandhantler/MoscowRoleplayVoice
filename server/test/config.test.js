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

test('разрешает пароль-заглушку в development и test', () => {
  const config = buildConfig({
    ...BASE_ENV,
    NODE_ENV: 'development',
    POSTGRES_PASSWORD: 'change_me_app_password',
  });

  assert.equal(config.database.password, 'change_me_app_password');
});

test('отклоняет пароль-заглушку в production и не выводит его значение', () => {
  const weakPassword = 'change_me_app_password';

  assert.throws(
    () =>
      buildConfig({
        ...BASE_ENV,
        NODE_ENV: 'production',
        POSTGRES_PASSWORD: weakPassword,
      }),
    (err) => {
      assert.equal(err instanceof ConfigError, true);
      assert.match(err.message, /POSTGRES_PASSWORD/);
      assert.match(err.message, /пароль-заглушку/);
      assert.equal(err.message.includes(weakPassword), false);
      return true;
    },
  );
});

test('отклоняет в production пароль, совпадающий с POSTGRES_USER', () => {
  assert.throws(
    () =>
      buildConfig({
        ...BASE_ENV,
        NODE_ENV: 'production',
        POSTGRES_USER: 'mrv_app_user',
        POSTGRES_PASSWORD: 'mrv_app_user',
      }),
    /совпадать с POSTGRES_USER или POSTGRES_DB/,
  );
});

test('отклоняет в production пароль, совпадающий с POSTGRES_DB', () => {
  assert.throws(
    () =>
      buildConfig({
        ...BASE_ENV,
        NODE_ENV: 'production',
        POSTGRES_DB: 'moscowroleplay_voice',
        POSTGRES_PASSWORD: 'moscowroleplay_voice',
      }),
    /совпадать с POSTGRES_USER или POSTGRES_DB/,
  );
});

test('принимает в production уникальный пароль достаточной длины', () => {
  const config = buildConfig({
    ...BASE_ENV,
    NODE_ENV: 'production',
    POSTGRES_PASSWORD: 'StrongUniquePass_2026!',
  });

  assert.equal(config.nodeEnv, 'production');
  assert.equal(config.database.password, 'StrongUniquePass_2026!');
});
