import pg from 'pg';
import { withTimeout } from '../utils/errors.js';

const { Pool } = pg;

/**
 * Обёртка над пулом подключений PostgreSQL.
 * Не логирует пароль и не передаёт его наружу.
 */
export class Database {
  /**
   * @param {{config: Readonly<object>, logger: import('pino').Logger}} options
   */
  constructor({ config, logger }) {
    this.logger = logger.child({ module: 'database' });
    this.healthTimeoutMs = config.database.healthTimeoutMs;
    this.closed = false;

    this.pool = new Pool({
      host: config.database.host,
      port: config.database.port,
      database: config.database.database,
      user: config.database.user,
      password: config.database.password,
      max: config.database.poolMax,
      connectionTimeoutMillis: config.database.connectionTimeoutMs,
      idleTimeoutMillis: config.database.idleTimeoutMs,
      query_timeout: config.database.queryTimeoutMs,
      statement_timeout: config.database.queryTimeoutMs,
      application_name: 'moscowroleplay-voice-server',
      ssl: config.database.ssl
        ? { rejectUnauthorized: config.database.sslRejectUnauthorized }
        : false,
    });

    this.pool.on('error', (err) => {
      this.logger.error(
        { err },
        'Необработанная ошибка простаивающего клиента PostgreSQL',
      );
    });
  }

  /**
   * Проверяет реальное подключение к PostgreSQL.
   * @returns {Promise<void>}
   */
  async connect() {
    const startedAt = Date.now();
    const client = await this.pool.connect();

    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }

    this.logger.info(
      {
        host: this.pool.options.host,
        database: this.pool.options.database,
        latencyMs: Date.now() - startedAt,
      },
      'Подключение к PostgreSQL проверено',
    );
  }

  /**
   * Возвращает пул для инфраструктурных задач, например для миграций.
   * Бизнес-модулям следует использовать метод query.
   *
   * @returns {import('pg').Pool}
   */
  getPool() {
    return this.pool;
  }

  /**
   * Выполняет запрос через пул.
   *
   * @param {string} text
   * @param {unknown[]} params
   * @returns {Promise<import('pg').QueryResult>}
   */
  async query(text, params = []) {
    return this.pool.query(text, params);
  }

  /**
   * Выполняет набор запросов в одной транзакции.
   *
   * Колбэк получает клиента пула и обязан использовать именно его:
   * запросы через this.query выполняются вне транзакции.
   *
   * @template T
   * @param {(client: import('pg').PoolClient) => Promise<T>} callback
   * @returns {Promise<T>}
   */
  async withTransaction(callback) {
    const client = await this.pool.connect();
    let broken = false;

    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        // Соединение могло уже разорваться: его нельзя возвращать в пул.
        broken = true;
        this.logger.warn({ err: rollbackErr }, 'Не удалось откатить транзакцию');
      }

      throw err;
    } finally {
      client.release(broken);
    }
  }

  /**
   * Безопасная проверка состояния базы для health-check.
   * Возвращает только общую информацию, без текста ошибки PostgreSQL.
   *
   * @returns {Promise<{status: 'ok'|'error', latencyMs: number, code?: string, message?: string}>}
   */
  async checkHealth() {
    const startedAt = Date.now();

    try {
      await withTimeout(
        this.pool.query('SELECT 1'),
        this.healthTimeoutMs,
        'Проверка PostgreSQL превысила допустимое время ожидания.',
      );

      return {
        status: 'ok',
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      this.logger.warn({ err }, 'Проверка PostgreSQL не удалась');

      return {
        status: 'error',
        code: 'database_unavailable',
        message: 'База данных недоступна.',
        latencyMs: Date.now() - startedAt,
      };
    }
  }

  /**
   * Закрывает пул подключений.
   * @returns {Promise<void>}
   */
  async close() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    await this.pool.end();
    this.logger.info('Пул подключений PostgreSQL закрыт');
  }
}

/**
 * @param {Readonly<object>} config
 * @param {import('pino').Logger} logger
 * @returns {Database}
 */
export function createDatabase(config, logger) {
  return new Database({ config, logger });
}
