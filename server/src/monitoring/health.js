/**
 * Формирует ответы health-check.
 * Ответы не содержат секретов и внутренних деталей ошибок базы данных.
 *
 * Liveness проверяет только сам процесс HTTP-сервера и не обращается к PostgreSQL.
 * Readiness дополнительно проверяет доступность базы данных.
 */

/**
 * @param {Readonly<object>} config
 * @returns {object}
 */
function createBaseStatus(config) {
  return {
    status: 'ok',
    service: config.serviceName,
    version: config.appVersion,
    environment: config.nodeEnv,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}

/**
 * @param {{config: Readonly<object>, database: import('../database/pool.js').Database}} options
 */
export function createHealthService({ config, database }) {
  return {
    /**
     * Liveness: процесс способен обработать HTTP-запрос.
     * Намеренно не зависит от PostgreSQL.
     *
     * @returns {object}
     */
    checkLiveness() {
      return {
        ...createBaseStatus(config),
        checks: {
          process: {
            status: 'ok',
          },
        },
      };
    },

    /**
     * Readiness: сервер готов обслуживать запросы, включая работу с PostgreSQL.
     *
     * @returns {Promise<object>}
     */
    async checkReadiness() {
      const databaseCheck = await database.checkHealth();
      const ready = databaseCheck.status === 'ok';

      return {
        ...createBaseStatus(config),
        status: ready ? 'ok' : 'degraded',
        checks: {
          database: databaseCheck,
        },
      };
    },
  };
}
