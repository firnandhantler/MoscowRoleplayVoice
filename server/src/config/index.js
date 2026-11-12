import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_MESSAGE_BYTES, WS_PATH } from '../../../shared/protocol.js';

/** Корень проекта (папка, в которой находятся server, client, database и shared). */
export const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const DEFAULT_ENV_FILE = join(PROJECT_ROOT, '.env');
const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);

const SERVICE_NAME = 'moscowroleplay-voice-server';
const NODE_ENVIRONMENTS = new Set(['development', 'test', 'production']);
const LOG_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

/**
 * Ошибка конфигурации. Сообщение содержит только имена переменных,
 * но никогда не содержит их значения.
 */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.code = 'CONFIG_INVALID';
  }
}

/**
 * Загружает файл .env из корня проекта.
 * Уже заданные переменные окружения имеют приоритет над значениями из файла.
 *
 * @param {{path?: string}} options
 * @returns {{loaded: boolean, path: string}}
 */
export function loadEnvironmentFile({ path = DEFAULT_ENV_FILE } = {}) {
  if (!existsSync(path)) {
    return { loaded: false, path };
  }

  try {
    process.loadEnvFile(path);
    return { loaded: true, path };
  } catch {
    throw new ConfigError(
      'Не удалось загрузить файл .env. Проверьте его синтаксис и кодировку UTF-8.',
    );
  }
}

function readString(env, name, defaultValue, errors) {
  const raw = env[name];

  if (raw === undefined || raw === '') {
    return defaultValue;
  }

  if (typeof raw !== 'string') {
    errors.push(`Переменная ${name} должна быть строкой.`);
    return defaultValue;
  }

  const value = raw.trim();

  if (value === '') {
    return defaultValue;
  }

  return value;
}

function readRequiredSecret(env, name, errors) {
  const value = env[name];

  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`Обязательная переменная ${name} не задана.`);
    return '';
  }

  return value;
}

function readInteger(env, name, defaultValue, { min, max }, errors) {
  const raw = env[name];

  if (raw === undefined || raw === '') {
    return defaultValue;
  }

  const normalized = String(raw).trim();

  if (!/^-?\d+$/.test(normalized)) {
    errors.push(`Переменная ${name} должна быть целым числом.`);
    return defaultValue;
  }

  const value = Number(normalized);

  if (!Number.isSafeInteger(value) || value < min || value > max) {
    errors.push(`Переменная ${name} должна находиться в диапазоне от ${min} до ${max}.`);
    return defaultValue;
  }

  return value;
}

function readBoolean(env, name, defaultValue, errors) {
  const raw = env[name];

  if (raw === undefined || raw === '') {
    return defaultValue;
  }

  const normalized = String(raw).trim().toLowerCase();

  if (['true', '1', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['false', '0', 'no', 'off'].includes(normalized)) {
    return false;
  }

  errors.push(`Переменная ${name} должна быть true или false.`);
  return defaultValue;
}

function readEnum(env, name, defaultValue, allowedValues, errors) {
  const value = readString(env, name, defaultValue, errors);

  if (!allowedValues.has(value)) {
    errors.push(
      `Переменная ${name} должна принимать одно из значений: ${[...allowedValues].join(', ')}.`,
    );
    return defaultValue;
  }

  return value;
}

function validateDatabaseName(value, name, errors) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value)) {
    errors.push(
      `Переменная ${name} должна начинаться с латинской буквы или подчёркивания и содержать только латинские буквы, цифры и подчёркивания.`,
    );
  }
}

/**
 * Проверяет, похож ли пароль на заглушку из документации или примера.
 * Само значение пароля никогда не попадает в сообщение об ошибке.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isPlaceholderPassword(value) {
  const normalized = value.trim().toLowerCase();

  return [
    'change_me',
    'change-me',
    'changeme',
    'replace_me',
    'replace-me',
    'your_password',
    'your-password',
    'example_password',
    'example-password',
    'placeholder',
  ].some((prefix) => normalized.startsWith(prefix));
}

/**
 * Дополнительные проверки пароля PostgreSQL для production.
 * В development и test заглушки допустимы, чтобы не усложнять локальный запуск.
 *
 * @param {string} password
 * @param {{nodeEnv: string, user: string, database: string}} context
 * @param {string[]} errors
 */
function validateProductionPassword(password, { nodeEnv, user, database }, errors) {
  if (nodeEnv !== 'production' || password === '') {
    return;
  }

  if (isPlaceholderPassword(password)) {
    errors.push(
      'Переменная POSTGRES_PASSWORD не должна содержать пароль-заглушку в production. Задайте уникальный пароль.',
    );
  }

  const normalizedPassword = password.toLowerCase();

  if (
    normalizedPassword === user.toLowerCase() ||
    normalizedPassword === database.toLowerCase()
  ) {
    errors.push(
      'Переменная POSTGRES_PASSWORD не должна совпадать с POSTGRES_USER или POSTGRES_DB в production.',
    );
  }
}

/**
 * Собирает и валидирует конфигурацию из переданного объекта окружения.
 * Не читает .env и не обращается к process.env, кроме переданного объекта.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {Readonly<object>}
 */
export function buildConfig(env = process.env) {
  const errors = [];
  const nodeEnv = readEnum(env, 'NODE_ENV', 'development', NODE_ENVIRONMENTS, errors);

  const logLevel = readEnum(env, 'LOG_LEVEL', 'info', LOG_LEVELS, errors);
  const requestedPrettyLogs = readBoolean(
    env,
    'LOG_PRETTY',
    nodeEnv !== 'production',
    errors,
  );
  const logPretty = nodeEnv === 'production' ? false : requestedPrettyLogs;

  const serverHost = readString(env, 'SERVER_HOST', '0.0.0.0', errors);
  const serverPort = readInteger(env, 'SERVER_PORT', 3000, { min: 1, max: 65535 }, errors);

  const wsPath = readString(env, 'WS_PATH', WS_PATH, errors);
  if (!wsPath.startsWith('/') || /\s/.test(wsPath) || /[?#]/.test(wsPath) || wsPath.length > 128) {
    errors.push(
      'Переменная WS_PATH должна начинаться с /, не содержать пробелов, символов ? и # и иметь длину до 128 символов.',
    );
  }

  const wsMaxPayloadBytes = readInteger(
    env,
    'WS_MAX_PAYLOAD_BYTES',
    MAX_MESSAGE_BYTES,
    { min: 1024, max: 1024 * 1024 },
    errors,
  );
  const wsHeartbeatIntervalMs = readInteger(
    env,
    'WS_HEARTBEAT_INTERVAL_MS',
    30000,
    { min: 5000, max: 300000 },
    errors,
  );
  const wsMaxConnections = readInteger(
    env,
    'WS_MAX_CONNECTIONS',
    200,
    { min: 1, max: 10000 },
    errors,
  );
  const wsRateLimitMaxMessages = readInteger(
    env,
    'WS_RATE_LIMIT_MAX_MESSAGES',
    30,
    { min: 1, max: 1000 },
    errors,
  );
  const wsRateLimitWindowMs = readInteger(
    env,
    'WS_RATE_LIMIT_WINDOW_MS',
    10000,
    { min: 1000, max: 60000 },
    errors,
  );
  const wsMaxViolations = readInteger(
    env,
    'WS_MAX_VIOLATIONS',
    5,
    { min: 1, max: 100 },
    errors,
  );

  const shutdownTimeoutMs = readInteger(
    env,
    'SHUTDOWN_TIMEOUT_MS',
    10000,
    { min: 1000, max: 60000 },
    errors,
  );

  const postgresHost = readString(env, 'POSTGRES_HOST', '127.0.0.1', errors);
  const postgresPort = readInteger(
    env,
    'POSTGRES_PORT',
    5432,
    { min: 1, max: 65535 },
    errors,
  );
  const postgresDatabase = readString(
    env,
    'POSTGRES_DB',
    'moscowroleplay_voice',
    errors,
  );
  const postgresUser = readString(env, 'POSTGRES_USER', 'mrv_app', errors);
  const postgresPassword = readRequiredSecret(env, 'POSTGRES_PASSWORD', errors);

  validateDatabaseName(postgresDatabase, 'POSTGRES_DB', errors);
  validateDatabaseName(postgresUser, 'POSTGRES_USER', errors);

  if (postgresPassword && postgresPassword.length < 12) {
    errors.push('Переменная POSTGRES_PASSWORD должна содержать не менее 12 символов.');
  }

  validateProductionPassword(
    postgresPassword,
    {
      nodeEnv,
      user: postgresUser,
      database: postgresDatabase,
    },
    errors,
  );

  const postgresSsl = readBoolean(env, 'POSTGRES_SSL', false, errors);
  const postgresSslRejectUnauthorized = readBoolean(
    env,
    'POSTGRES_SSL_REJECT_UNAUTHORIZED',
    true,
    errors,
  );
  const postgresPoolMax = readInteger(
    env,
    'POSTGRES_POOL_MAX',
    10,
    { min: 1, max: 50 },
    errors,
  );
  const postgresConnectionTimeoutMs = readInteger(
    env,
    'POSTGRES_CONNECTION_TIMEOUT_MS',
    5000,
    { min: 1000, max: 60000 },
    errors,
  );
  const postgresIdleTimeoutMs = readInteger(
    env,
    'POSTGRES_IDLE_TIMEOUT_MS',
    30000,
    { min: 1000, max: 300000 },
    errors,
  );
  const postgresQueryTimeoutMs = readInteger(
    env,
    'POSTGRES_QUERY_TIMEOUT_MS',
    5000,
    { min: 1000, max: 60000 },
    errors,
  );
  const healthDbTimeoutMs = readInteger(
    env,
    'HEALTH_DB_TIMEOUT_MS',
    3000,
    { min: 500, max: 30000 },
    errors,
  );

  const mediasoupListenIp = readString(env, 'MEDIASOUP_LISTEN_IP', '0.0.0.0', errors);
  if (isIP(mediasoupListenIp) === 0) {
    errors.push('Переменная MEDIASOUP_LISTEN_IP должна содержать корректный IP-адрес.');
  }

  const mediasoupAnnouncedIp = readString(env, 'MEDIASOUP_ANNOUNCED_IP', '', errors);
  if (mediasoupAnnouncedIp !== '' && isIP(mediasoupAnnouncedIp) === 0) {
    errors.push(
      'Переменная MEDIASOUP_ANNOUNCED_IP должна быть пустой или содержать корректный IP-адрес.',
    );
  }

  const mediasoupRtcMinPort = readInteger(
    env,
    'MEDIASOUP_RTC_MIN_PORT',
    40000,
    { min: 1024, max: 65535 },
    errors,
  );
  const mediasoupRtcMaxPort = readInteger(
    env,
    'MEDIASOUP_RTC_MAX_PORT',
    40049,
    { min: 1024, max: 65535 },
    errors,
  );
  const mediasoupWorkerCount = readInteger(
    env,
    'MEDIASOUP_WORKER_COUNT',
    1,
    { min: 1, max: 8 },
    errors,
  );

  if (mediasoupRtcMinPort > mediasoupRtcMaxPort) {
    errors.push(
      'Переменная MEDIASOUP_RTC_MIN_PORT не может быть больше MEDIASOUP_RTC_MAX_PORT.',
    );
  }

  if (errors.length > 0) {
    throw new ConfigError(
      `Некорректная конфигурация:\n- ${errors.join('\n- ')}`,
    );
  }

  return Object.freeze({
    nodeEnv,
    serviceName: SERVICE_NAME,
    appVersion: packageJson.version,
    logLevel,
    logPretty,
    shutdownTimeoutMs,
    server: Object.freeze({
      host: serverHost,
      port: serverPort,
    }),
    websocket: Object.freeze({
      path: wsPath,
      maxPayloadBytes: wsMaxPayloadBytes,
      heartbeatIntervalMs: wsHeartbeatIntervalMs,
      maxConnections: wsMaxConnections,
      rateLimitMaxMessages: wsRateLimitMaxMessages,
      rateLimitWindowMs: wsRateLimitWindowMs,
      maxViolations: wsMaxViolations,
    }),
    database: Object.freeze({
      host: postgresHost,
      port: postgresPort,
      database: postgresDatabase,
      user: postgresUser,
      password: postgresPassword,
      ssl: postgresSsl,
      sslRejectUnauthorized: postgresSslRejectUnauthorized,
      poolMax: postgresPoolMax,
      connectionTimeoutMs: postgresConnectionTimeoutMs,
      idleTimeoutMs: postgresIdleTimeoutMs,
      queryTimeoutMs: postgresQueryTimeoutMs,
      healthTimeoutMs: healthDbTimeoutMs,
    }),
    mediasoup: Object.freeze({
      listenIp: mediasoupListenIp,
      announcedIp: mediasoupAnnouncedIp === '' ? null : mediasoupAnnouncedIp,
      rtcMinPort: mediasoupRtcMinPort,
      rtcMaxPort: mediasoupRtcMaxPort,
      workerCount: mediasoupWorkerCount,
    }),
  });
}

/**
 * Загружает .env (если он есть) и возвращает проверенную конфигурацию.
 *
 * @param {{env?: Record<string, string|undefined>, loadEnvFile?: boolean}} options
 * @returns {Readonly<object>}
 */
export function loadConfig({ env = process.env, loadEnvFile = true } = {}) {
  if (loadEnvFile) {
    loadEnvironmentFile();
  }

  return buildConfig(env);
}
