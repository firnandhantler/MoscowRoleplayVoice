import { generateToken, sha256Hex } from '../utils/crypto.js';
import { mapUserRow } from './mappers.js';

/** Случайный токен сессии: 32 байта в base64url дают ровно 43 символа. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const INSERT_SESSION_SQL = `
  INSERT INTO user_sessions (user_id, token_hash, expires_at, absolute_expires_at)
  VALUES ($1, $2, now() + make_interval(secs => $3), now() + make_interval(secs => $4))
  RETURNING id, expires_at, absolute_expires_at
`;

const SELECT_SESSION_SQL = `
  SELECT
    s.id AS session_id,
    s.expires_at AS session_expires_at,
    s.absolute_expires_at AS session_absolute_expires_at,
    s.last_used_at AS session_last_used_at,
    u.id AS user_id,
    u.discord_id,
    u.discord_username,
    u.discord_global_name,
    u.roblox_id,
    u.roblox_username,
    u.roblox_linked_at,
    u.created_at AS user_created_at,
    u.last_login_at
  FROM user_sessions s
  JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = $1
    AND s.revoked = false
    AND s.expires_at > now()
    AND s.absolute_expires_at > now()
  LIMIT 1
`;

const TOUCH_SESSION_SQL = `
  UPDATE user_sessions
  SET last_used_at = now(),
      expires_at = LEAST(
        now() + make_interval(secs => $2),
        absolute_expires_at
      )
  WHERE id = $1
    AND revoked = false
    AND last_used_at < now() - make_interval(secs => $3)
`;

const REVOKE_SESSION_SQL = `
  UPDATE user_sessions
  SET revoked = true, revoked_at = now()
  WHERE token_hash = $1 AND revoked = false
`;

const REVOKE_ALL_SQL = `
  UPDATE user_sessions
  SET revoked = true, revoked_at = now()
  WHERE user_id = $1 AND revoked = false
`;

const DELETE_EXPIRED_SQL = `
  DELETE FROM user_sessions
  WHERE id IN (
    SELECT id
    FROM user_sessions
    WHERE expires_at < now() - make_interval(secs => $1)
       OR absolute_expires_at < now() - make_interval(secs => $1)
    LIMIT $2
  )
`;

/**
 * Серверные сессии пользователя.
 *
 * В cookie клиента лежит случайный токен, в базе — только его SHA-256-хеш.
 * Сессия действительна, пока не отозвана и пока не истёк скользящий или абсолютный срок.
 */
export class SessionStore {
  /**
   * @param {{
   *   database: {query: (text: string, params?: unknown[]) => Promise<{rows: object[], rowCount: number}>},
   *   idleTtlSeconds: number,
   *   absoluteTtlSeconds: number,
   *   touchIntervalSeconds?: number,
   *   logger?: import('pino').Logger|null,
   *   now?: () => number,
   * }} options
   */
  constructor({
    database,
    idleTtlSeconds,
    absoluteTtlSeconds,
    touchIntervalSeconds = 60,
    logger = null,
    now = Date.now,
  }) {
    this.database = database;
    this.idleTtlSeconds = idleTtlSeconds;
    this.absoluteTtlSeconds = absoluteTtlSeconds;
    this.touchIntervalSeconds = touchIntervalSeconds;
    this.logger = logger?.child ? logger.child({ module: 'session-store' }) : logger;
    this.now = now;
  }

  /**
   * Создаёт сессию в базе и возвращает токен для cookie.
   *
   * @param {{userId: string|number, userAgent?: string|null}} params
   * @returns {Promise<{token: string, expiresAt: Date, absoluteExpiresAt: Date}>}
   */
  async create({ userId }) {
    const token = generateToken(32);
    const tokenHash = sha256Hex(token);

    const result = await this.database.query(INSERT_SESSION_SQL, [
      userId,
      tokenHash,
      this.idleTtlSeconds,
      this.absoluteTtlSeconds,
    ]);

    const row = result.rows[0];

    return {
      token,
      expiresAt: row.expires_at,
      absoluteExpiresAt: row.absolute_expires_at,
    };
  }

  /**
   * Проверяет сессию по токену из cookie и продлевает скользящий срок.
   * Некорректный по формату токен не доходит до базы.
   *
   * @param {unknown} token
   * @returns {Promise<{sessionId: string, user: object, expiresAt: Date, absoluteExpiresAt: Date}|null>}
   */
  async find(token) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
      return null;
    }

    const result = await this.database.query(SELECT_SESSION_SQL, [sha256Hex(token)]);

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];

    // Продление не чаще touchIntervalSeconds, чтобы не писать в базу на каждый запрос.
    const lastUsedAt =
      row.session_last_used_at instanceof Date
        ? row.session_last_used_at.getTime()
        : Date.parse(row.session_last_used_at);

    if (!Number.isFinite(lastUsedAt) || this.now() - lastUsedAt >= this.touchIntervalSeconds * 1000) {
      try {
        await this.database.query(TOUCH_SESSION_SQL, [
          row.session_id,
          this.idleTtlSeconds,
          this.touchIntervalSeconds,
        ]);
      } catch (err) {
        // Неудачное продление не должно ломать уже проверенную сессию.
        this.logger?.warn({ err }, 'Не удалось продлить срок сессии');
      }
    }

    return {
      sessionId: String(row.session_id),
      user: mapUserRow(row),
      expiresAt: row.session_expires_at,
      absoluteExpiresAt: row.session_absolute_expires_at,
    };
  }

  /**
   * Отзывает одну сессию. Повторный вызов безопасен.
   *
   * @param {unknown} token
   * @returns {Promise<boolean>} true, если сессия была активна и отозвана этим вызовом.
   */
  async revoke(token) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
      return false;
    }

    const result = await this.database.query(REVOKE_SESSION_SQL, [sha256Hex(token)]);

    return result.rowCount > 0;
  }

  /**
   * Отзывает все активные сессии пользователя (например, при повторной привязке аккаунта).
   *
   * @param {string|number} userId
   * @returns {Promise<number>}
   */
  async revokeAllForUser(userId) {
    const result = await this.database.query(REVOKE_ALL_SQL, [userId]);

    return result.rowCount;
  }

  /**
   * Удаляет давно истёкшие сессии пачками, чтобы не держать историю вечно.
   *
   * @param {{retentionSeconds?: number, limit?: number}} options
   * @returns {Promise<number>}
   */
  async deleteExpired({ retentionSeconds = 7 * 24 * 60 * 60, limit = 1000 } = {}) {
    const result = await this.database.query(DELETE_EXPIRED_SQL, [retentionSeconds, limit]);

    return result.rowCount;
  }
}
