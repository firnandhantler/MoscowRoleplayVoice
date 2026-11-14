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
 * Бот должен состоять на каждом проверяемом сервере и иметь право просматривать участников.
 *
 * Сервис поддерживает несколько Discord-серверов: роли запрашиваются отдельно
 * для каждого guildId и кэшируются по паре guildId + discordId.
 */
export class DiscordRoleService {
  /**
   * @param {{
   *   botToken: string|null,
   *   guildId?: string|null,
   *   guildIds?: string[]|null,
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
    guildIds = null,
    cacheTtlMs = 60_000,
    timeoutMs = 5000,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    logger = null,
  }) {
    this.botToken = typeof botToken === 'string' && botToken !== '' ? botToken : null;

    const candidates = Array.isArray(guildIds) ? guildIds : guildId === null ? [] : [guildId];
    const validGuildIds = candidates.filter(
      (id) => typeof id === 'string' && SNOWFLAKE_PATTERN.test(id),
    );

    this.guildIds = [...new Set(validGuildIds)];
    // Основной сервер оставлен для обратной совместимости и старых вызовов.
    this.guildId = this.guildIds[0] ?? null;
    this.cacheTtlMs = cacheTtlMs;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.logger = logger?.child ? logger.child({ module: 'discord-roles' }) : logger;
    /** @type {Map<string, {roles: string[], expiresAt: number}>} */
    this.cache = new Map();
    this.lastErrorCode = null;
  }

  /** @returns {boolean} true, если бот настроен и есть хотя бы один сервер. */
  isEnabled() {
    return this.botToken !== null && this.guildIds.length > 0;
  }

  /**
   * Возвращает роли участника на конкретном Discord-сервере.
   * Пустой массив — участник не на сервере. null — роли получить не удалось.
   *
   * @param {string} discordId
   * @param {string} [guildId]
   * @returns {Promise<string[]|null>}
   */
  async getRoles(discordId, guildId = this.guildId) {
    if (!this.isEnabled()) {
      return null;
    }

    if (typeof discordId !== 'string' || !SNOWFLAKE_PATTERN.test(discordId)) {
      return null;
    }

    if (typeof guildId !== 'string' || !this.guildIds.includes(guildId)) {
      this.lastErrorCode = 'discord_guild_not_configured';
      this.logger?.warn(
        { guildId },
        'Discord-сервер не входит в список серверов для проверки ролей',
      );
      return null;
    }

    const cacheKey = `${guildId}:${discordId}`;
    const now = this.now();
    const cached = this.cache.get(cacheKey);

    if (cached && cached.expiresAt > now) {
      return cached.roles;
    }

    const response = await requestJson({
      service: SERVICE,
      url: `${API_BASE}/guilds/${guildId}/members/${discordId}`,
      headers: { Authorization: `Bot ${this.botToken}` },
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      maxResponseBytes: 64 * 1024,
    });

    if (response.status === 404) {
      // Пользователь не состоит на сервере либо скрыт от бота.
      this.#store(cacheKey, [], now);
      return [];
    }

    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
      this.logger?.warn({ guildId, retryAfterMs }, 'Discord ограничил запросы ролей');
      return null;
    }

    if (response.status === 401 || response.status === 403) {
      this.lastErrorCode = 'discord_bot_unauthorized';
      this.logger?.error(
        { guildId, status: response.status },
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

    this.#store(cacheKey, roles, now);
    return roles;
  }

  /**
   * Проверяет роль на одном сервере или на всех настроенных серверах.
   *
   * @param {string} discordId
   * @param {string} roleId
   * @param {string|null} [guildId] null — проверить все серверы.
   * @returns {Promise<boolean|null>}
   */
  async hasRole(discordId, roleId, guildId = null) {
    return this.hasAnyRole(discordId, [roleId], guildId);
  }

  /**
   * Проверяет, есть ли у пользователя одна из ролей.
   * Пустой список ролей означает «доступ разрешён».
   *
   * @param {string} discordId
   * @param {string[]} roleIds
   * @param {string|null} [guildId] null — проверить все настроенные серверы.
   * @returns {Promise<boolean|null>} null — проверить невозможно.
   */
  async hasAnyRole(discordId, roleIds, guildId = null) {
    if (!Array.isArray(roleIds) || roleIds.length === 0) {
      return true;
    }

    if (!this.isEnabled()) {
      return null;
    }

    const guilds = guildId === null ? this.guildIds : [guildId];
    let hadError = false;

    for (const id of guilds) {
      const roles = await this.getRoles(discordId, id);

      if (roles === null) {
        hadError = true;
        continue;
      }

      if (roles.some((role) => roleIds.includes(role))) {
        return true;
      }
    }

    return hadError ? null : false;
  }

  /**
   * Проверяет доступ по группам радиоканала.
   *
   * Каждая группа — { guildId, roleIds }. Доступ разрешён, если пользователь
   * имеет хотя бы одну роль хотя бы в одной группе. Пустой массив групп
   * означает открытый канал.
   *
   * @param {string} discordId
   * @param {{guildId: string|null, roleIds: string[]}[]} access
   * @returns {Promise<boolean|null>} null — хотя бы один сервер не удалось проверить.
   */
  async hasAnyRoleInGuilds(discordId, access) {
    if (!Array.isArray(access) || access.length === 0) {
      return true;
    }

    let hadError = false;

    for (const group of access) {
      const allowed = await this.hasAnyRole(
        discordId,
        group.roleIds,
        group.guildId ?? null,
      );

      if (allowed === true) {
        return true;
      }

      if (allowed === null) {
        hadError = true;
      }
    }

    return hadError ? null : false;
  }

  /**
   * @param {string} cacheKey
   * @param {string[]} roles
   * @param {number} now
   */
  #store(cacheKey, roles, now) {
    if (this.cache.size >= MAX_CACHE_ENTRIES && !this.cache.has(cacheKey)) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }

    this.cache.set(cacheKey, { roles, expiresAt: now + this.cacheTtlMs });
  }

  /** Сбрасывает кэш ролей всех серверов. */
  clear() {
    this.cache.clear();
  }

  /** @returns {{enabled: boolean, guilds: number, cachedEntries: number, lastErrorCode: string|null}} */
  getStatus() {
    return {
      enabled: this.isEnabled(),
      guilds: this.guildIds.length,
      cachedEntries: this.cache.size,
      lastErrorCode: this.lastErrorCode,
    };
  }
}
