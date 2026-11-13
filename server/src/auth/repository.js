import { AppError } from '../utils/errors.js';
import { mapUserRow } from './mappers.js';

const UPSERT_USER_SQL = `
  INSERT INTO users (discord_id, discord_username, discord_global_name, last_login_at)
  VALUES ($1, $2, $3, now())
  ON CONFLICT (discord_id) DO UPDATE
    SET discord_username = EXCLUDED.discord_username,
        discord_global_name = EXCLUDED.discord_global_name,
        last_login_at = now()
  RETURNING
    id AS user_id,
    discord_id,
    discord_username,
    discord_global_name,
    roblox_id,
    roblox_username,
    roblox_linked_at,
    created_at AS user_created_at,
    last_login_at
`;

const SELECT_ROBLOX_OWNER_SQL = `
  SELECT id FROM users WHERE roblox_id = $1 AND id <> $2 LIMIT 1
`;

const LINK_ROBLOX_SQL = `
  UPDATE users
  SET roblox_id = $2, roblox_username = $3, roblox_linked_at = now()
  WHERE id = $1
  RETURNING
    id AS user_id,
    discord_id,
    discord_username,
    discord_global_name,
    roblox_id,
    roblox_username,
    roblox_linked_at,
    created_at AS user_created_at,
    last_login_at
`;

const UNLINK_ROBLOX_SQL = `
  UPDATE users
  SET roblox_id = NULL, roblox_username = NULL, roblox_linked_at = NULL
  WHERE id = $1
  RETURNING
    id AS user_id,
    discord_id,
    discord_username,
    discord_global_name,
    roblox_id,
    roblox_username,
    roblox_linked_at,
    created_at AS user_created_at,
    last_login_at
`;

const GET_USER_SQL = `
  SELECT
    id AS user_id,
    discord_id,
    discord_username,
    discord_global_name,
    roblox_id,
    roblox_username,
    roblox_linked_at,
    created_at AS user_created_at,
    last_login_at
  FROM users
  WHERE id = $1
`;

/** Код PostgreSQL «нарушение уникальности». */
const UNIQUE_VIOLATION = '23505';

/**
 * Доступ к таблицам users и user_sessions в рамках модуля auth.
 *
 * Вход выполняется в транзакции: обновление профиля Discord и изменение привязки Roblox
 * должны применяться вместе, иначе пользователь останется в промежуточном состоянии.
 */
export class AuthRepository {
  /**
   * @param {{database: {query: Function, withTransaction: Function}, logger?: import('pino').Logger|null}} options
   */
  constructor({ database, logger = null }) {
    this.database = database;
    this.logger = logger?.child ? logger.child({ module: 'auth-repository' }) : logger;
  }

  /**
   * Создаёт или обновляет пользователя по данным Discord и применяет привязку Roblox.
   *
   * @param {{
   *   discordId: string,
   *   username: string,
   *   globalName: string|null,
   *   roblox: {id: string, username: string}|{unlink: true}|null,
   * }} params
   * @returns {Promise<{user: object, linkStatus: 'linked'|'not_linked'|'roblox_already_linked'|'unchanged'}>}
   */
  async applyDiscordLogin({ discordId, username, globalName, roblox = null }) {
    try {
      return await this.database.withTransaction((client) => this.#applyLogin(client, {
        discordId,
        username,
        globalName,
        roblox,
      }));
    } catch (err) {
      // Гонка двух одновременных входов: Roblox ID успел занять другой пользователь.
      // Повторяем вход без привязки — это безопасно, вход сам по себе не должен падать.
      if (err?.code === UNIQUE_VIOLATION && roblox !== null) {
        this.logger?.warn(
          { constraint: err.constraint ?? null },
          'Roblox ID уже занят другим пользователем, вход выполнен без изменения привязки',
        );

        const result = await this.database.withTransaction((client) =>
          this.#applyLogin(client, { discordId, username, globalName, roblox: null }),
        );

        return { ...result, linkStatus: 'roblox_already_linked' };
      }

      throw err;
    }
  }

  /**
   * @param {{query: Function}} client
   * @param {{discordId: string, username: string, globalName: string|null, roblox: object|null}} params
   * @returns {Promise<{user: object, linkStatus: string}>}
   */
  async #applyLogin(client, { discordId, username, globalName, roblox }) {
    const upsert = await client.query(UPSERT_USER_SQL, [discordId, username, globalName]);
    const user = upsert.rows[0];

    if (roblox === null) {
      return { user: mapUserRow(user), linkStatus: 'unchanged' };
    }

    if (roblox.unlink === true) {
      if (user.roblox_id === null) {
        return { user: mapUserRow(user), linkStatus: 'not_linked' };
      }

      const unlinked = await client.query(UNLINK_ROBLOX_SQL, [user.id]);
      return { user: mapUserRow(unlinked.rows[0]), linkStatus: 'not_linked' };
    }

    const owner = await client.query(SELECT_ROBLOX_OWNER_SQL, [roblox.id, user.id]);

    if (owner.rows.length > 0) {
      return { user: mapUserRow(user), linkStatus: 'roblox_already_linked' };
    }

    const linked = await client.query(LINK_ROBLOX_SQL, [user.id, roblox.id, roblox.username]);

    return { user: mapUserRow(linked.rows[0]), linkStatus: 'linked' };
  }

  /**
   * Повторная привязка Roblox для уже авторизованного пользователя.
   *
   * @param {{userId: string|number, roblox: {id: string, username: string}|{unlink: true}}} params
   * @returns {Promise<{user: object|null, linkStatus: string}>}
   */
  async updateRobloxLink({ userId, roblox }) {
    if (roblox.unlink === true) {
      const result = await this.database.query(UNLINK_ROBLOX_SQL, [userId]);
      return { user: result.rows[0] ? mapUserRow(result.rows[0]) : null, linkStatus: 'not_linked' };
    }

    try {
      const owner = await this.database.query(SELECT_ROBLOX_OWNER_SQL, [roblox.id, userId]);

      if (owner.rows.length > 0) {
        const current = await this.database.query(GET_USER_SQL, [userId]);
        return {
          user: current.rows[0] ? mapUserRow(current.rows[0]) : null,
          linkStatus: 'roblox_already_linked',
        };
      }

      const linked = await this.database.query(LINK_ROBLOX_SQL, [userId, roblox.id, roblox.username]);

      return {
        user: linked.rows[0] ? mapUserRow(linked.rows[0]) : null,
        linkStatus: 'linked',
      };
    } catch (err) {
      if (err?.code === UNIQUE_VIOLATION) {
        const current = await this.database.query(GET_USER_SQL, [userId]);
        return {
          user: current.rows[0] ? mapUserRow(current.rows[0]) : null,
          linkStatus: 'roblox_already_linked',
        };
      }

      throw err;
    }
  }

  /**
   * @param {string|number} userId
   * @returns {Promise<object|null>}
   */
  async getUser(userId) {
    const result = await this.database.query(GET_USER_SQL, [userId]);

    return result.rows[0] ? mapUserRow(result.rows[0]) : null;
  }
}

/**
 * Ошибка «Roblox-аккаунт уже привязан к другому пользователю».
 * Используется маршрутами, чтобы вернуть понятный ответ без раскрытия чужих данных.
 *
 * @returns {AppError}
 */
export function robloxAlreadyLinkedError() {
  return new AppError(
    'Этот Roblox-аккаунт уже привязан к другому пользователю Discord.',
    { code: 'roblox_already_linked', statusCode: 409, expose: true },
  );
}
