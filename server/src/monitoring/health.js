/**
 * Формирует ответы health-check.
 * Ответы не содержат секретов и внутренних деталей ошибок базы данных.
 *
 * Liveness проверяет только сам процесс HTTP-сервера и не обращается к PostgreSQL.
 * Readiness дополнительно проверяет доступность базы данных.
 *
 * Состояние игрового сервера включается в readiness как информационный блок:
 * недоступность PRC API не делает сервер неготовым принимать HTTP-запросы,
 * но её видно в диагностике (`checks.game`).
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
 * Информационный блок о состоянии игрового сервера.
 *
 * @param {{gameState: import('../game/state.js').GameState, poller: import('../game/poller.js').GamePoller|null}} options
 * @returns {object}
 */
function createGameCheck({ gameState, poller }) {
  const status = gameState.getStatus();

  return {
    status: status.stale ? 'degraded' : 'ok',
    affectsReadiness: false,
    online: status.online,
    playerCount: status.playerCount,
    currentPlayers: status.currentPlayers,
    maxPlayers: status.maxPlayers,
    lastSuccessAt: status.lastSuccessAt,
    snapshotAgeMs: status.snapshotAgeMs,
    stale: status.stale,
    consecutiveErrors: status.consecutiveErrors,
    lastErrorCode: status.lastErrorCode,
    poller: poller === null ? null : poller.getStatus(),
  };
}

/**
 * Информационный блок о голосовой подсистеме.
 *
 * @param {{mediasoup: object, signaling: object|null}} voice
 * @returns {object}
 */
function createVoiceCheck(voice) {
  const mediasoup = voice.mediasoup.getStatus();
  const signaling = voice.signaling === null ? null : voice.signaling.getStatus();

  return {
    status: mediasoup.ready ? 'ok' : 'degraded',
    affectsReadiness: false,
    mediasoup,
    signaling,
  };
}

/**
 * @param {{
 *   config: Readonly<object>,
 *   database: import('../database/pool.js').Database,
 *   gameState?: import('../game/state.js').GameState|null,
 *   poller?: import('../game/poller.js').GamePoller|null,
 *   voice?: {mediasoup: object, signaling: object|null}|null,
 * }} options
 */
export function createHealthService({
  config,
  database,
  gameState = null,
  poller = null,
  voice = null,
}) {
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
      // Готовность определяется только базой: без неё нельзя войти в систему
      // и проверить сессию. Игровые данные — вспомогательная информация.
      const ready = databaseCheck.status === 'ok';

      const checks = { database: databaseCheck };

      if (gameState !== null) {
        checks.game = createGameCheck({ gameState, poller });
      }

      if (voice !== null) {
        checks.voice = createVoiceCheck(voice);
      }

      return {
        ...createBaseStatus(config),
        status: ready ? 'ok' : 'degraded',
        checks,
      };
    },
  };
}
