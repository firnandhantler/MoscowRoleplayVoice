import { parseRetryAfterMs, requestJson } from '../utils/http-client.js';

const SERVICE = 'Discord';
const API_BASE = 'https://discord.com/api/v10';
const MAX_CACHE_ENTRIES = 5000;
const SNOWFLAKE_PATTERN = /^[0-9]{17,20}$/;

/**
 * Роли участника Discord-сервера.
 *
 * OAuth2 scope `identify` не отдаёт роли, поэтому используется Discord Bot API:
 * `GET /guilds/{guild.id}/members/{user.id}` с заголовком `Authorization: Bot <token>`.
 * Бот должен состоять на сервере и иметь право просматривать участников.
 *
 * Ответы кэшируются на DISCORD_ROLES_CACHE_TTL_MS, чтобы не расходовать
 * лимиты Discord при каждом включении радио.
 */
export class DiscordRoleService {
  /**
   * @param {{
   *   botToken: string|null,
   *   guildId: string|null,
   *   cacheTtlMs: number,
   *   timeoutMs: number,
   *   fetchImpl?: typeof fetch,
   *   now?: () => number,
   *   logger?: import('pino').Logger|null,
   * }} options
   */
  constructor({
    botToken = null,
    guildId = null,
    cacheTtlMs = 60_000,
    timeoutMs = 5000,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    logger = null,
  }) {
    this.botToken = typeof botToken === 'string' && botToken !== '' ? botToken : null;
    this.guildId = typeof guildId === 'string' && SNOWFLAKE_PATTERN.test(guildId) ? guildId : null;
    this.cacheTtlMs = cacheTtlMs;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.logger = logger?.child ? logger.child({ module: 'discord-roles' }) : logger;
    /** @type {Map<string, {roles: string[], expiresAt: number}>} */
    this.cache = new Map();
    this.lastErrorCode = null;
  }

  /** @returns {boolean} true, если бот настроен и роли можно проверять. */
  isEnabled() {
    return this.botToken !== null && this.guildId !== null;
  }

  /**
   * Возвращает роли участника.
   * Пустой массив — участник не на сервере. null — роли получить не удалось.
   *
   * @param {string} discordId
   * @returns {Promise<string[]|null>}
   */
  async getRoles(discordId) {
    if (!this.isEnabled()) {
      return null;
    }

    if (typeof discordId !== 'string' || !SNOWFLAKE_PATTERN.test(discordId)) {
      return null;
    }

    const now = this.now();
    const cached = this.cache.get(discordId);

    if (cached && cached.expiresAt > now) {
      return cached.roles;
    }

    const response = await requestJson({
      service: SERVICE,
      url: `${API_BASE}/guilds/${this.guildId}/members/${discordId}`,
      headers: { Authorization: `Bot ${this.botToken}` },
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      maxResponseBytes: 64 * 1024,
    });

    if (response.status === 404) {
      // Пользователь не состоит на сервере либо скрыт от бота.
      this.#store(discordId, [], now);
      return [];
    }

    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
      this.logger?.warn({ retryAfterMs }, 'Discord ограничил запросы ролей');
      return null;
    }

    if (response.status === 401 || response.status === 403) {
      this.lastErrorCode = 'discord_bot_unauthorized';
      this.logger?.error(
        { status: response.status },
        'Discord отклонил токен бота или у бота нет прав на просмотр участников',
      );
      return null;
    }

    if (response.status !== 200) {
      this.lastErrorCode = 'discord_roles_failed';
      return null;
    }

    const data = response.data;

    if (typeof data !== 'object' || data === null || !Array.isArray(data.roles)) {
      return null;
    }

    const roles = data.roles.filter(
      (role) => typeof role === 'string' && SNOWFLAKE_PATTERN.test(role),
    );

    this.#store(discordId, roles, now);
    return roles;
  }

  /**
   * @param {string} discordId
   * @param {string} roleId
   * @returns {Promise<boolean|null>}
   */
  async hasRole(discordId, roleId) {
    const roles = await this.getRoles(discordId);

    if (roles === null) {
      return null;
    }

    return roles.includes(roleId);
  }

  /**
   * Проверяет, есть ли у пользователя одна из ролей.
   * Пустой список ролей означает «канал доступен всем авторизованным пользователям».
   *
   * @param {string} discordId
   * @param {string[]} roleIds
   * @returns {Promise<boolean|null>} null — проверить невозможно.
   */
  async hasAnyRole(discordId, roleIds) {
    if (!Array.isArray(roleIds) || roleIds.length === 0) {
      return true;
    }

    const roles = await this.getRoles(discordId);

    if (roles === null) {
      return null;
    }

    return roles.some((role) => roleIds.includes(role));
  }

  /**
   * @param {string} discordId
   * @param {string[]} roles
   * @param {number} now
   */
  #store(discordId, roles, now) {
    if (this.cache.size >= MAX_CACHE_ENTRIES && !this.cache.has(discordId)) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }

    this.cache.set(discordId, { roles, expiresAt: now + this.cacheTtlMs });
  }

  /** Сбрасывает кэш (например, при выходе пользователя с сервера). */
  clear() {
    this.cache.clear();
  }

  /** @returns {{enabled: boolean, cachedUsers: number, lastErrorCode: string|null}} */
  getStatus() {
    return {
      enabled: this.isEnabled(),
      cachedUsers: this.cache.size,
      lastErrorCode: this.lastErrorCode,
    };
  }
}
