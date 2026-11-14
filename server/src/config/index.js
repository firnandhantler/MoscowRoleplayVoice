import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_MESSAGE_BYTES, WS_PATH } from '../../shared/protocol.js';

/** Корень серверной части (папка server, в которой находятся src, config, database и shared). */
export const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

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
 * Загружает файл .env из папки server.
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

const SNOWFLAKE_PATTERN = /^[0-9]{17,20}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Читает необязательный секрет. Пустое значение означает, что интеграция не настроена.
 * Значение секрета никогда не попадает в сообщения об ошибках.
 *
 * @param {Record<string, string|undefined>} env
 * @param {string} name
 * @returns {string}
 */
function readOptionalSecret(env, name) {
  const value = env[name];

  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

/**
 * Читает и проверяет URL.
 *
 * @param {Record<string, string|undefined>} env
 * @param {string} name
 * @param {string} defaultValue
 * @param {string[]} errors
 * @param {{requireHttps?: boolean, stripTrailingSlash?: boolean}} options
 * @returns {string}
 */
function readUrl(env, name, defaultValue, errors, { requireHttps = false, stripTrailingSlash = false } = {}) {
  const value = readString(env, name, defaultValue, errors);

  if (value === '') {
    return '';
  }

  let url;

  try {
    url = new URL(value);
  } catch {
    errors.push(`Переменная ${name} должна содержать корректный URL.`);
    return defaultValue;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    errors.push(`Переменная ${name} должна использовать протокол http или https.`);
    return defaultValue;
  }

  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    errors.push(`Переменная ${name} не должна содержать учётные данные и фрагмент (#).`);
    return defaultValue;
  }

  // HTTP допускается только для loopback-адресов (локальная разработка и тесты).
  if (requireHttps && url.protocol !== 'https:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    errors.push(`Переменная ${name} должна использовать https.`);
    return defaultValue;
  }

  return stripTrailingSlash ? value.replace(/\/+$/, '') : value;
}

function validateSnowflake(value, name, errors) {
  if (value !== '' && !SNOWFLAKE_PATTERN.test(value)) {
    errors.push(`Переменная ${name} должна содержать Discord ID (17–20 цифр).`);
  }
}

/**
 * Читает список Discord ID через запятую.
 *
 * @param {Record<string, string|undefined>} env
 * @param {string} name
 * @param {string[]} errors
 * @param {{max?: number}} options
 * @returns {string[]}
 */
function readSnowflakeList(env, name, errors, { max = 20 } = {}) {
  const raw = env[name];

  if (raw === undefined || raw === '') {
    return [];
  }

  if (typeof raw !== 'string') {
    errors.push(`Переменная ${name} должна быть строкой со списком Discord ID через запятую.`);
    return [];
  }

  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');

  if (parts.length > max) {
    errors.push(`Переменная ${name} должна содержать не более ${max} Discord ID.`);
  }

  const result = [];
  let hasInvalid = false;

  for (const part of parts) {
    if (!SNOWFLAKE_PATTERN.test(part)) {
      hasInvalid = true;
      continue;
    }

    if (!result.includes(part)) {
      result.push(part);
    }
  }

  if (hasInvalid) {
    errors.push(
      `Переменная ${name} должна содержать Discord ID (17–20 цифр), разделённые запятой.`,
    );
  }

  return result.slice(0, max);
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

  // Голосовой сервер: включается отдельно, чтобы этап 2 можно было запускать без mediasoup.
  const voiceEnabled = readBoolean(env, 'VOICE_ENABLED', true, errors);

  const proximityMaxDistance = readInteger(
    env,
    'PROXIMITY_MAX_DISTANCE',
    30,
    { min: 1, max: 1000 },
    errors,
  );
  const proximityHysteresis = readInteger(
    env,
    'PROXIMITY_HYSTERESIS',
    5,
    { min: 0, max: 500 },
    errors,
  );
  const proximityIntervalMs = readInteger(
    env,
    'PROXIMITY_UPDATE_INTERVAL_MS',
    500,
    { min: 100, max: 10000 },
    errors,
  );
  const proximityMaxNeighbors = readInteger(
    env,
    'PROXIMITY_MAX_NEIGHBORS',
    16,
    { min: 1, max: 64 },
    errors,
  );

  if (proximityMaxDistance <= proximityHysteresis) {
    errors.push(
      'Переменная PROXIMITY_HYSTERESIS должна быть меньше PROXIMITY_MAX_DISTANCE.',
    );
  }

  // Discord-бот нужен только для проверки ролей радиоканалов.
  const discordBotToken = readOptionalSecret(env, 'DISCORD_BOT_TOKEN');
  const discordRolesCacheTtlMs = readInteger(
    env,
    'DISCORD_ROLES_CACHE_TTL_MS',
    60000,
    { min: 1000, max: 600000 },
    errors,
  );

  const radioEnabledRequested = readBoolean(env, 'RADIO_ENABLED', true, errors);
  const radioChannelsFile = readString(env, 'RADIO_CHANNELS_FILE', '', errors);
  const radioMaxTransmissionMs = readInteger(
    env,
    'RADIO_MAX_TRANSMISSION_MS',
    120000,
    { min: 5000, max: 600000 },
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

  // Discord OAuth2. Авторизация включается, только если заданы все три переменные.
  const discordClientId = readString(env, 'DISCORD_CLIENT_ID', '', errors);
  const discordClientSecret = readOptionalSecret(env, 'DISCORD_CLIENT_SECRET');
  const discordRedirectUri = readUrl(env, 'DISCORD_REDIRECT_URI', '', errors, {
    requireHttps: nodeEnv === 'production',
  });
  const discordGuildId = readString(env, 'DISCORD_GUILD_ID', '', errors);
  const discordTimeoutMs = readInteger(
    env,
    'DISCORD_TIMEOUT_MS',
    5000,
    { min: 1000, max: 30000 },
    errors,
  );

  validateSnowflake(discordClientId, 'DISCORD_CLIENT_ID', errors);
  validateSnowflake(discordGuildId, 'DISCORD_GUILD_ID', errors);

  // Основной сервер всегда участвует в проверке ролей. Дополнительные
  // Discord-серверы перечисляются через запятую в DISCORD_ROLE_GUILD_IDS.
  const discordRoleGuildIds = discordGuildId === '' ? [] : [discordGuildId];

  for (const guildId of readSnowflakeList(env, 'DISCORD_ROLE_GUILD_IDS', errors)) {
    if (!discordRoleGuildIds.includes(guildId)) {
      discordRoleGuildIds.push(guildId);
    }
  }

  const discordValues = [discordClientId, discordClientSecret, discordRedirectUri];
  const authEnabled = discordValues.every((value) => value !== '');

  if (!authEnabled && discordValues.some((value) => value !== '')) {
    errors.push(
      'Переменные DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET и DISCORD_REDIRECT_URI задаются вместе: укажите все три или ни одной.',
    );
  }

  // Серверные сессии.
  const sessionIdleTtlSeconds = readInteger(
    env,
    'SESSION_IDLE_TTL_SECONDS',
    7 * 24 * 60 * 60,
    { min: 300, max: 30 * 24 * 60 * 60 },
    errors,
  );
  const sessionAbsoluteTtlSeconds = readInteger(
    env,
    'SESSION_ABSOLUTE_TTL_SECONDS',
    30 * 24 * 60 * 60,
    { min: 3600, max: 90 * 24 * 60 * 60 },
    errors,
  );

  if (sessionIdleTtlSeconds > sessionAbsoluteTtlSeconds) {
    errors.push(
      'Переменная SESSION_IDLE_TTL_SECONDS не может быть больше SESSION_ABSOLUTE_TTL_SECONDS.',
    );
  }

  const sessionCookieSecure = readBoolean(
    env,
    'SESSION_COOKIE_SECURE',
    nodeEnv === 'production',
    errors,
  );

  if (nodeEnv === 'production' && !sessionCookieSecure) {
    errors.push('Переменная SESSION_COOKIE_SECURE должна быть true в production.');
  }

  const authRateLimitMaxRequests = readInteger(
    env,
    'AUTH_RATE_LIMIT_MAX_REQUESTS',
    20,
    { min: 1, max: 1000 },
    errors,
  );
  const authRateLimitWindowMs = readInteger(
    env,
    'AUTH_RATE_LIMIT_WINDOW_MS',
    60000,
    { min: 1000, max: 3600000 },
    errors,
  );
  const trustProxy = readBoolean(env, 'TRUST_PROXY', false, errors);

  // OAuth2 state живёт минуты, а не дни: это одноразовая попытка входа.
  const authStateTtlSeconds = readInteger(
    env,
    'AUTH_STATE_TTL_SECONDS',
    600,
    { min: 60, max: 3600 },
    errors,
  );
  // Необязательный адрес возврата после успешного входа (например, страница клиента).
  const authPostLoginRedirectUrl = readUrl(
    env,
    'AUTH_POST_LOGIN_REDIRECT_URL',
    '',
    errors,
    { requireHttps: nodeEnv === 'production' },
  );
  const sessionTouchIntervalSeconds = readInteger(
    env,
    'SESSION_TOUCH_INTERVAL_SECONDS',
    60,
    { min: 0, max: 3600 },
    errors,
  );
  const sessionCleanupIntervalMs = readInteger(
    env,
    'SESSION_CLEANUP_INTERVAL_MS',
    3600000,
    { min: 60000, max: 24 * 60 * 60 * 1000 },
    errors,
  );

  // Bloxlink. Используется guild-endpoint, поэтому нужен DISCORD_GUILD_ID.
  const bloxlinkApiKey = readOptionalSecret(env, 'BLOXLINK_API_KEY');
  const bloxlinkApiBaseUrl = readUrl(
    env,
    'BLOXLINK_API_BASE_URL',
    'https://api.blox.link/v4/public',
    errors,
    { requireHttps: true, stripTrailingSlash: true },
  );
  const bloxlinkTimeoutMs = readInteger(
    env,
    'BLOXLINK_TIMEOUT_MS',
    5000,
    { min: 1000, max: 30000 },
    errors,
  );
  const bloxlinkEnabled = bloxlinkApiKey !== '';

  if (bloxlinkEnabled && discordGuildId === '') {
    errors.push('Для работы BLOXLINK_API_KEY необходимо задать DISCORD_GUILD_ID.');
  }

  // Публичный Roblox Users API (ключ не требуется).
  const robloxUsersApiBaseUrl = readUrl(
    env,
    'ROBLOX_USERS_API_BASE_URL',
    'https://users.roblox.com',
    errors,
    { requireHttps: true, stripTrailingSlash: true },
  );
  const robloxTimeoutMs = readInteger(
    env,
    'ROBLOX_TIMEOUT_MS',
    5000,
    { min: 1000, max: 30000 },
    errors,
  );

  // PRC ER:LC API V2 и опрос игрового сервера.
  const prcServerKey = readOptionalSecret(env, 'PRC_SERVER_KEY');
  const prcApiBaseUrl = readUrl(
    env,
    'PRC_API_BASE_URL',
    'https://api.erlc.gg/v2',
    errors,
    { requireHttps: true, stripTrailingSlash: true },
  );
  const prcTimeoutMs = readInteger(
    env,
    'PRC_TIMEOUT_MS',
    2500,
    { min: 500, max: 30000 },
    errors,
  );
  const gamePollEnabledRequested = readBoolean(env, 'GAME_POLL_ENABLED', true, errors);
  const gamePollIntervalMs = readInteger(
    env,
    'GAME_POLL_INTERVAL_MS',
    500,
    { min: 500, max: 60000 },
    errors,
  );
  const gamePollMaxBackoffMs = readInteger(
    env,
    'GAME_POLL_MAX_BACKOFF_MS',
    30000,
    { min: 1000, max: 300000 },
    errors,
  );
  const gameStateStaleAfterMs = readInteger(
    env,
    'GAME_STATE_STALE_AFTER_MS',
    5000,
    { min: 1000, max: 120000 },
    errors,
  );

  if (gamePollMaxBackoffMs < gamePollIntervalMs) {
    errors.push('Переменная GAME_POLL_MAX_BACKOFF_MS не может быть меньше GAME_POLL_INTERVAL_MS.');
  }

  if (gameStateStaleAfterMs <= gamePollIntervalMs) {
    errors.push('Переменная GAME_STATE_STALE_AFTER_MS должна быть больше GAME_POLL_INTERVAL_MS.');
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
    auth: Object.freeze({
      enabled: authEnabled,
      sessionIdleTtlSeconds,
      sessionAbsoluteTtlSeconds,
      sessionTouchIntervalSeconds,
      sessionCleanupIntervalMs,
      cookieSecure: sessionCookieSecure,
      rateLimitMaxRequests: authRateLimitMaxRequests,
      rateLimitWindowMs: authRateLimitWindowMs,
      stateTtlSeconds: authStateTtlSeconds,
      postLoginRedirectUrl: authPostLoginRedirectUrl === '' ? null : authPostLoginRedirectUrl,
      trustProxy,
    }),
    discord: Object.freeze({
      clientId: discordClientId,
      clientSecret: discordClientSecret,
      redirectUri: discordRedirectUri,
      guildId: discordGuildId === '' ? null : discordGuildId,
      roleGuildIds: Object.freeze(discordRoleGuildIds),
      timeoutMs: discordTimeoutMs,
      botToken: discordBotToken,
      rolesCacheTtlMs: discordRolesCacheTtlMs,
    }),
    bloxlink: Object.freeze({
      enabled: bloxlinkEnabled,
      apiKey: bloxlinkApiKey,
      apiBaseUrl: bloxlinkApiBaseUrl,
      timeoutMs: bloxlinkTimeoutMs,
    }),
    roblox: Object.freeze({
      usersApiBaseUrl: robloxUsersApiBaseUrl,
      timeoutMs: robloxTimeoutMs,
    }),
    prc: Object.freeze({
      apiBaseUrl: prcApiBaseUrl,
      serverKey: prcServerKey,
      timeoutMs: prcTimeoutMs,
    }),
    game: Object.freeze({
      pollEnabled: gamePollEnabledRequested && prcServerKey !== '',
      pollIntervalMs: gamePollIntervalMs,
      pollMaxBackoffMs: gamePollMaxBackoffMs,
      staleAfterMs: gameStateStaleAfterMs,
    }),
    voice: Object.freeze({
      enabled: voiceEnabled,
    }),
    proximity: Object.freeze({
      maxDistance: proximityMaxDistance,
      hysteresis: proximityHysteresis,
      intervalMs: proximityIntervalMs,
      maxNeighbors: proximityMaxNeighbors,
    }),
    radio: Object.freeze({
      enabled: radioEnabledRequested,
      channelsFile: radioChannelsFile === '' ? null : radioChannelsFile,
      maxTransmissionMs: radioMaxTransmissionMs,
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
