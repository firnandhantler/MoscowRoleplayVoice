import { ExternalApiError, parseRetryAfterMs, requestJson } from '../utils/http-client.js';
import { isPlainObject } from '../utils/errors.js';

const SERVICE = 'PRC';

/** Формат поля Player в PRC API V2: "Name:Id". Имя Roblox не может содержать двоеточие. */
const PLAYER_PATTERN = /^([A-Za-z0-9_]{3,20}):([1-9][0-9]{0,19})$/;
const MAX_TEXT_LENGTH = 128;

/** Коды ошибок PRC API V2 (по официальной документации). */
const AUTH_ERROR_CODES = new Set([2000, 2001, 2002, 2003, 2004, 2005]);
const SERVER_OFFLINE_CODE = 3002;
const RATE_LIMITED_CODE = 4001;
const OUTDATED_MODULE_CODE = 9999;

const TRANSPORT_ERROR_CODES = new Map([
  ['external_timeout', ['prc_timeout', 'PRC API не ответил вовремя.']],
  ['external_network_error', ['prc_network_error', 'PRC API недоступен.']],
  ['external_invalid_json', ['prc_invalid_json', 'PRC API вернул некорректный JSON.']],
  ['external_response_too_large', ['prc_invalid_response', 'Ответ PRC API превышает допустимый размер.']],
]);

function readHeaderNumber(headers, name) {
  const raw = headers?.get?.(name);

  if (typeof raw !== 'string' || raw.trim() === '') {
    return null;
  }

  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : null;
}

/**
 * Читает заголовки лимитов PRC API. Лимиты динамические, поэтому их нужно
 * учитывать в каждом ответе, а не задавать константой.
 *
 * @param {Headers} headers
 * @returns {{bucket: string|null, limit: number|null, remaining: number|null, resetAt: number|null}}
 */
export function parseRateLimitHeaders(headers) {
  const reset = readHeaderNumber(headers, 'x-ratelimit-reset');
  const bucket = headers?.get?.('x-ratelimit-bucket');

  let resetAt = null;

  if (reset !== null && reset > 0) {
    // Документация указывает epoch-время в секундах; значения в миллисекундах тоже принимаются.
    resetAt = reset > 1e12 ? Math.round(reset) : Math.round(reset * 1000);
  }

  return {
    bucket: typeof bucket === 'string' && bucket.length <= MAX_TEXT_LENGTH ? bucket : null,
    limit: readHeaderNumber(headers, 'x-ratelimit-limit'),
    remaining: readHeaderNumber(headers, 'x-ratelimit-remaining'),
    resetAt,
  };
}

function readOptionalText(value) {
  return typeof value === 'string' && value.length <= MAX_TEXT_LENGTH ? value : null;
}

function prcError(message, code, status, rateLimit, extra = {}) {
  const err = new ExternalApiError(message, { code, service: SERVICE, status, ...extra });
  err.rateLimit = rateLimit;
  return err;
}

/**
 * Преобразует запись игрока PRC во внутренний формат.
 *
 * @param {unknown} entry
 * @returns {object|null} null, если запись некорректна.
 */
function parsePlayer(entry) {
  if (!isPlainObject(entry) || typeof entry.Player !== 'string') {
    return null;
  }

  const match = PLAYER_PATTERN.exec(entry.Player);

  if (!match) {
    return null;
  }

  let position = null;
  let postalCode = null;
  let streetName = null;

  // Координаты есть только по осям X и Z (без высоты); начало — центр карты ER:LC.
  if (isPlainObject(entry.Location)) {
    const { LocationX: x, LocationZ: z } = entry.Location;

    if (Number.isFinite(x) && Number.isFinite(z)) {
      position = Object.freeze({ x, z });
    }

    postalCode = readOptionalText(entry.Location.PostalCode);
    streetName = readOptionalText(entry.Location.StreetName);
  }

  const wantedStars =
    Number.isSafeInteger(entry.WantedStars) && entry.WantedStars >= 0 ? entry.WantedStars : 0;

  return Object.freeze({
    robloxId: match[2],
    name: match[1],
    team: readOptionalText(entry.Team),
    callsign: readOptionalText(entry.Callsign),
    permission: readOptionalText(entry.Permission),
    wantedStars,
    position,
    postalCode,
    streetName,
  });
}

/**
 * Проверяет успешный ответ GET /v2/server?Players=true.
 *
 * @param {unknown} data
 * @param {number} status
 * @param {object} rateLimit
 */
function parseServerResponse(data, status, rateLimit) {
  const invalid = () =>
    prcError('PRC API вернул ответ неожиданного формата.', 'prc_invalid_response', status, rateLimit);

  if (!isPlainObject(data)) {
    throw invalid();
  }

  const { CurrentPlayers: currentPlayers, MaxPlayers: maxPlayers, Players: rawPlayers } = data;

  if (!Number.isSafeInteger(currentPlayers) || currentPlayers < 0) {
    throw invalid();
  }

  if (!Number.isSafeInteger(maxPlayers) || maxPlayers < 0) {
    throw invalid();
  }

  // При Players=true список обязателен. Его отсутствие нельзя считать пустым сервером.
  if (!Array.isArray(rawPlayers)) {
    throw invalid();
  }

  const players = [];
  const seen = new Set();

  for (const entry of rawPlayers) {
    const player = parsePlayer(entry);

    // Одна повреждённая запись делает некорректным весь снимок: иначе игрок
    // ошибочно «покинул бы» сервер.
    if (player === null || seen.has(player.robloxId)) {
      throw invalid();
    }

    seen.add(player.robloxId);
    players.push(player);
  }

  return { currentPlayers, maxPlayers, players };
}

/**
 * Адаптер PRC ER:LC API V2.
 * Ключ сервера передаётся только в заголовке server-key и никогда не попадает
 * в ошибки, логи и ответы клиентам.
 */
export class PrcClient {
  /**
   * @param {{apiBaseUrl: string, serverKey: string, timeoutMs: number, fetchImpl?: typeof fetch, now?: () => number}} options
   */
  constructor({ apiBaseUrl, serverKey, timeoutMs, fetchImpl = globalThis.fetch, now = Date.now }) {
    this.apiBaseUrl = apiBaseUrl;
    this.serverKey = serverKey;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  /**
   * Получает снимок игрового сервера со списком игроков.
   * Сервер без игроков (код 3002) возвращается как online: false.
   * Любая другая проблема — исключение ExternalApiError, а не пустой список.
   *
   * @returns {Promise<{online: boolean, currentPlayers: number, maxPlayers: number|null, players: object[], fetchedAt: number, rateLimit: object}>}
   */
  async fetchServerSnapshot() {
    if (typeof this.serverKey !== 'string' || this.serverKey === '') {
      throw prcError('Ключ PRC API не настроен (PRC_SERVER_KEY).', 'prc_missing_key', null, null);
    }

    let response;

    try {
      response = await requestJson({
        service: SERVICE,
        url: `${this.apiBaseUrl}/server?Players=true`,
        headers: { 'server-key': this.serverKey },
        timeoutMs: this.timeoutMs,
        fetchImpl: this.fetchImpl,
        maxResponseBytes: 512 * 1024,
      });
    } catch (err) {
      const mapped = TRANSPORT_ERROR_CODES.get(err?.code);

      if (mapped) {
        throw prcError(mapped[1], mapped[0], err.status ?? null, null, { cause: err });
      }

      throw err;
    }

    const { status, headers, data } = response;
    const rateLimit = parseRateLimitHeaders(headers);
    const fetchedAt = this.now();

    if (status === 200) {
      const parsed = parseServerResponse(data, status, rateLimit);
      return { online: true, ...parsed, fetchedAt, rateLimit };
    }

    const apiCode = isPlainObject(data) && Number.isSafeInteger(data.code) ? data.code : null;

    if (apiCode === SERVER_OFFLINE_CODE) {
      return { online: false, currentPlayers: 0, maxPlayers: null, players: [], fetchedAt, rateLimit };
    }

    if (status === 429 || apiCode === RATE_LIMITED_CODE) {
      let retryAfterMs = parseRetryAfterMs(headers.get('retry-after'));

      if (retryAfterMs === null && isPlainObject(data) && Number.isFinite(data.retry_after) && data.retry_after >= 0) {
        retryAfterMs = Math.ceil(data.retry_after * 1000);
      }

      throw prcError('PRC API ограничил число запросов.', 'prc_rate_limited', status, rateLimit, {
        retryAfterMs,
      });
    }

    if (status === 401 || status === 403 || (apiCode !== null && AUTH_ERROR_CODES.has(apiCode))) {
      throw prcError('PRC API отклонил ключ сервера.', 'prc_unauthorized', status, rateLimit);
    }

    if (apiCode === OUTDATED_MODULE_CODE) {
      throw prcError('Модуль PRC на игровом сервере устарел.', 'prc_outdated_module', status, rateLimit);
    }

    if (status >= 500) {
      throw prcError('PRC API временно недоступен.', 'prc_unavailable', status, rateLimit);
    }

    throw prcError('PRC API отклонил запрос.', 'prc_request_failed', status, rateLimit);
  }
}
