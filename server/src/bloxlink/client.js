import { ExternalApiError, parseRetryAfterMs, requestJson } from '../utils/http-client.js';
import { isPlainObject } from '../utils/errors.js';

const SERVICE = 'Bloxlink';
const SNOWFLAKE_PATTERN = /^[0-9]{17,20}$/;
const ROBLOX_ID_PATTERN = /^[1-9][0-9]{0,19}$/;

/**
 * Клиент Bloxlink Server API (guild-endpoint).
 *
 * Ограничения (по официальной документации):
 * - endpoint возвращает только robloxID, без имени пользователя;
 * - бот Bloxlink должен быть добавлен на Discord-сервер DISCORD_GUILD_ID,
 *   а пользователь должен состоять на этом сервере;
 * - формат тела ошибок и лимиты запросов в документации не описаны.
 */
export class BloxlinkClient {
  /**
   * @param {{apiKey: string, apiBaseUrl: string, guildId: string, timeoutMs: number, fetchImpl?: typeof fetch}} options
   */
  constructor({ apiKey, apiBaseUrl, guildId, timeoutMs, fetchImpl = globalThis.fetch }) {
    this.apiKey = apiKey;
    this.apiBaseUrl = apiBaseUrl;
    this.guildId = guildId;
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

    const url = `${this.apiBaseUrl}/guilds/${this.guildId}/discord-to-roblox/${discordId}`;

    const response = await requestJson({
      service: SERVICE,
      url,
      headers: { Authorization: this.apiKey },
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      maxResponseBytes: 16 * 1024,
    });

    const { status, headers, data } = response;

    if (status === 404) {
      return null;
    }

    if (status === 429) {
      throw new ExternalApiError('Bloxlink временно ограничил число запросов. Повторите попытку позже.', {
        code: 'bloxlink_rate_limited',
        service: SERVICE,
        status,
        retryAfterMs: parseRetryAfterMs(headers.get('retry-after')),
      });
    }

    if (status === 401 || status === 403) {
      throw new ExternalApiError('Bloxlink отклонил ключ API. Проверьте BLOXLINK_API_KEY и сервер Discord.', {
        code: 'bloxlink_unauthorized',
        service: SERVICE,
        status,
      });
    }

    if (status >= 500) {
      throw new ExternalApiError('Bloxlink временно недоступен.', {
        code: 'bloxlink_unavailable',
        service: SERVICE,
        status,
      });
    }

    if (status !== 200) {
      throw new ExternalApiError('Bloxlink отклонил запрос.', {
        code: 'bloxlink_request_failed',
        service: SERVICE,
        status,
      });
    }

    if (!isPlainObject(data)) {
      throw new ExternalApiError('Bloxlink вернул ответ неожиданного формата.', {
        code: 'bloxlink_invalid_response',
        service: SERVICE,
        status,
      });
    }

    // Документация показывает robloxID строкой; число принимается только если оно безопасное целое.
    const raw = data.robloxID;
    const robloxId = typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : raw;

    if (typeof robloxId !== 'string' || !ROBLOX_ID_PATTERN.test(robloxId)) {
      throw new ExternalApiError('Bloxlink вернул некорректный Roblox ID.', {
        code: 'bloxlink_invalid_response',
        service: SERVICE,
        status,
      });
    }

    return robloxId;
  }
}
