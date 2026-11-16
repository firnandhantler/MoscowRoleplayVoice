import { ExternalApiError, parseRetryAfterMs, requestJson } from '../utils/http-client.js';
import { isPlainObject } from '../utils/errors.js';

const SERVICE = 'ER:LC Россия';
const SNOWFLAKE_PATTERN = /^[0-9]{17,20}$/;
const ROBLOX_ID_PATTERN = /^[1-9][0-9]{0,19}$/;

/** Коды «связки нет»: 5012 — Discord ID не найден, 5050 — Roblox не привязан. */
const NOT_LINKED_CODES = new Set([5012, 5050]);

/** Ошибки ключа и прав: это проблема конфигурации, а не пользователя. */
const AUTH_CODES = new Set([5007, 5008, 5009, 5010, 5011, 5033]);

/** Ограничение частоты запросов. */
const RATE_LIMIT_CODES = new Set([5016, 5039]);

/** Временные ошибки сервиса. */
const UNAVAILABLE_CODES = new Set([5017, 5018, 5049]);

/**
 * Клиент верификации ER:LC Россия API V3 (раздел «Верификация»).
 *
 * Документация: https://apidocs.erlcrussia.com/ru/reference/v3/users/get-users
 *
 * Отличия от Bloxlink:
 * - проверка не привязана к Discord-серверу, DISCORD_GUILD_ID не нужен;
 * - ключ передаётся в заголовке `erlcrussia-api-key`;
 * - ответ 404 и коды 5012/5050 означают «связки нет», а не ошибку сервиса.
 */
export class ErlcRussiaVerificationClient {
  /**
   * @param {{apiKey: string, apiBaseUrl: string, timeoutMs: number, fetchImpl?: typeof fetch}} options
   */
  constructor({ apiKey, apiBaseUrl, timeoutMs, fetchImpl = globalThis.fetch }) {
    this.apiKey = apiKey;
    this.apiBaseUrl = apiBaseUrl;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  /**
   * Возвращает Roblox ID, связанный с Discord-аккаунтом, или null, если связки нет.
   * Discord ID должен быть получен сервером из Discord API, а не от клиента.
   *
   * @param {string} discordId
   * @returns {Promise<string|null>}
   */
  async getRobloxIdByDiscordId(discordId) {
    if (typeof discordId !== 'string' || !SNOWFLAKE_PATTERN.test(discordId)) {
      throw new TypeError('Некорректный Discord ID.');
    }

    const url = `${this.apiBaseUrl}/users?discordId=${encodeURIComponent(discordId)}`;

    const { status, headers, data } = await requestJson({
      service: SERVICE,
      url,
      headers: { 'erlcrussia-api-key': this.apiKey },
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      maxResponseBytes: 16 * 1024,
    });

    if (status === 200) {
      return parseRobloxId(data, status);
    }

    if (status === 404) {
      return null;
    }

    const code = readErrorCode(data);

    // Пользователь есть в Discord, но связка с Roblox отсутствует — это не сбой.
    if (code !== null && NOT_LINKED_CODES.has(code)) {
      return null;
    }

    throw mapError(status, headers, code);
  }
}

/**
 * Извлекает числовой код ошибки из тела ответа `{code, message}`.
 *
 * @param {unknown} data
 * @returns {number|null}
 */
function readErrorCode(data) {
  if (!isPlainObject(data)) {
    return null;
  }

  const raw = data.code;

  if (typeof raw === 'number' && Number.isInteger(raw)) {
    return raw;
  }

  if (typeof raw === 'string' && /^[0-9]{1,5}$/.test(raw)) {
    return Number(raw);
  }

  return null;
}

/**
 * Извлекает Roblox ID из ответа. Документация показывает строку; число
 * принимается только если это безопасное целое.
 *
 * @param {unknown} data
 * @param {number} status
 * @returns {string|null} null, если сервис не вернул связку.
 */
function parseRobloxId(data, status) {
  if (!isPlainObject(data)) {
    throw invalidResponse(status);
  }

  const raw = data.robloxId;

  // Поле может отсутствовать: сервис нашёл Discord-аккаунт без привязки Roblox.
  if (raw === null || raw === undefined) {
    return null;
  }

  const robloxId = typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : raw;

  if (typeof robloxId !== 'string' || !ROBLOX_ID_PATTERN.test(robloxId)) {
    throw new ExternalApiError('ER:LC Россия вернул некорректный Roblox ID.', {
      code: 'erlcrussia_invalid_response',
      service: SERVICE,
      status,
    });
  }

  return robloxId;
}

/**
 * @param {number} status
 * @returns {ExternalApiError}
 */
function invalidResponse(status) {
  return new ExternalApiError('ER:LC Россия вернул ответ неожиданного формата.', {
    code: 'erlcrussia_invalid_response',
    service: SERVICE,
    status,
  });
}

/**
 * Преобразует HTTP-статус и код ошибки в безопасное исключение.
 * Текст ошибки не содержит ключ, URL и тело ответа.
 *
 * @param {number} status
 * @param {Headers} headers
 * @param {number|null} code
 * @returns {ExternalApiError}
 */
function mapError(status, headers, code) {
  if (status === 429 || (code !== null && RATE_LIMIT_CODES.has(code))) {
    return new ExternalApiError(
      'ER:LC Россия временно ограничил число запросов. Повторите попытку позже.',
      {
        code: 'erlcrussia_rate_limited',
        service: SERVICE,
        status,
        retryAfterMs: parseRetryAfterMs(headers.get('retry-after')),
      },
    );
  }

  if (status === 401 || status === 403 || (code !== null && AUTH_CODES.has(code))) {
    return new ExternalApiError(
      'ER:LC Россия отклонил ключ API. Проверьте ERLCRUSSIA_API_KEY и права ключа.',
      {
        code: 'erlcrussia_unauthorized',
        service: SERVICE,
        status,
      },
    );
  }

  if (status >= 500 || (code !== null && UNAVAILABLE_CODES.has(code))) {
    return new ExternalApiError('ER:LC Россия временно недоступен.', {
      code: 'erlcrussia_unavailable',
      service: SERVICE,
      status,
    });
  }

  return new ExternalApiError('ER:LC Россия отклонил запрос проверки.', {
    code: 'erlcrussia_request_failed',
    service: SERVICE,
    status,
  });
}
