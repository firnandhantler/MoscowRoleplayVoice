/**
 * Формирует ответ health-check.
 * Не содержит секретов и внутренних деталей ошибок базы данных.
 *
 * @param {{config: Readonly<object>, database: import('../database/pool.js').Database}} options
 */
export function createHealthService({ config, database }) {
  return {
    /**
     * @returns {Promise<object>}
     */
    async check() {
      const databaseCheck = await database.checkHealth();
      const healthy = databaseCheck.status === 'ok';

      return {
        status: healthy ? 'ok' : 'degraded',
        service: config.serviceName,
        version: config.appVersion,
        environment: config.nodeEnv,
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        checks: {
          database: databaseCheck,
        },
      };
    },
  };
}
