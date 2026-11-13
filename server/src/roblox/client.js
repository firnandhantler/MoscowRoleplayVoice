import { ExternalApiError, parseRetryAfterMs, requestJson } from '../utils/http-client.js';
import { isPlainObject } from '../utils/errors.js';

const SERVICE = 'Roblox';
const ROBLOX_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const ROBLOX_USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;

/**
 * Клиент публичного Roblox Users API (GET /v1/users/{userId}, ключ не требуется).
 * Используется только для получения имени пользователя по Roblox ID,
 * подтверждённому через Bloxlink.
 */
export class RobloxUsersClient {
  /**
   * @param {{usersApiBaseUrl: string, timeoutMs: number, fetchImpl?: typeof fetch}} options
   */
  constructor({ usersApiBaseUrl, timeoutMs, fetchImpl = globalThis.fetch }) {
    this.usersApiBaseUrl = usersApiBaseUrl;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  /**
   * Возвращает профиль Roblox-пользователя или null, если пользователь не найден.
   *
   * @param {string} robloxId
   * @returns {Promise<{id: string, name: string, displayName: string|null, isBanned: boolean}|null>}
   */
  async getUserById(robloxId) {
    if (typeof robloxId !== 'string' || !ROBLOX_ID_PATTERN.test(robloxId)) {
      throw new TypeError('Некорректный Roblox ID.');
    }

    const response = await requestJson({
      service: SERVICE,
      url: `${this.usersApiBaseUrl}/v1/users/${robloxId}`,
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      maxResponseBytes: 64 * 1024,
    });

    const { status, headers, data } = response;

    // 404 — пользователь с таким ID не существует; 400 — Roblox отклонил ID.
    if (status === 404 || status === 400) {
      return null;
    }

    if (status === 429) {
      throw new ExternalApiError('Roblox временно ограничил число запросов. Повторите попытку позже.', {
        code: 'roblox_rate_limited',
        service: SERVICE,
        status,
        retryAfterMs: parseRetryAfterMs(headers.get('retry-after')),
      });
    }

    if (status >= 500) {
      throw new ExternalApiError('Roblox временно недоступен.', {
        code: 'roblox_unavailable',
        service: SERVICE,
        status,
      });
    }

    if (status !== 200) {
      throw new ExternalApiError('Roblox отклонил запрос.', {
        code: 'roblox_request_failed',
        service: SERVICE,
        status,
      });
    }

    if (!isPlainObject(data)) {
      throw invalidResponse(status);
    }

    // Ответ должен относиться именно к запрошенному пользователю.
    if (!Number.isSafeInteger(data.id) || String(data.id) !== robloxId) {
      throw invalidResponse(status);
    }

    if (typeof data.name !== 'string' || !ROBLOX_USERNAME_PATTERN.test(data.name)) {
      throw invalidResponse(status);
    }

    const displayName =
      typeof data.displayName === 'string' && data.displayName.length > 0 && data.displayName.length <= 64
        ? data.displayName
        : null;

    return {
      id: robloxId,
      name: data.name,
      displayName,
      isBanned: data.isBanned === true,
    };
  }
}

function invalidResponse(status) {
  return new ExternalApiError('Roblox вернул ответ неожиданного формата.', {
    code: 'roblox_invalid_response',
    service: SERVICE,
    status,
  });
}
