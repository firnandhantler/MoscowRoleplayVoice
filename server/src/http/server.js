import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { createHealthService } from '../monitoring/health.js';
import { sendJson } from './respond.js';

const HEALTH_PATHS = new Set(['/health', '/health/live', '/health/ready']);

/**
 * Создаёт HTTP-сервер приложения.
 *
 * @param {{
 *   config: Readonly<object>,
 *   logger: import('pino').Logger,
 *   database: import('../database/pool.js').Database,
 *   authRouter?: {handle: (ctx: object) => Promise<boolean>}|null,
 *   gameState?: import('../game/state.js').GameState|null,
 *   poller?: import('../game/poller.js').GamePoller|null,
 *   voice?: {mediasoup: object, signaling: object|null}|null,
 * }} options
 * @returns {import('node:http').Server}
 */
export function createHttpServer({
  config,
  logger,
  database,
  authRouter = null,
  gameState = null,
  poller = null,
  voice = null,
}) {
  const log = logger.child({ module: 'http' });
  const healthService = createHealthService({
    config,
    database,
    gameState,
    poller,
    voice,
  });

  const server = http.createServer((req, res) => {
    const requestId = randomUUID();
    const startedAt = process.hrtime.bigint();
    const method = req.method ?? 'UNKNOWN';
    let pathname = '/';

    res.setHeader('X-Request-Id', requestId);

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const level =
        HEALTH_PATHS.has(pathname)
          ? 'debug'
          : res.statusCode >= 500
            ? 'error'
            : res.statusCode >= 400
              ? 'warn'
              : 'info';

      log[level](
        {
          requestId,
          method,
          path: pathname,
          statusCode: res.statusCode,
          durationMs: Math.round(durationMs * 100) / 100,
          remoteAddress: req.socket.remoteAddress ?? null,
        },
        'HTTP-запрос обработан',
      );
    });

    void (async () => {
      try {
        let url;

        try {
          url = new URL(req.url ?? '/', 'http://localhost');
        } catch {
          sendJson(res, 400, {
            error: {
              code: 'invalid_request_url',
              message: 'Некорректный URL запроса.',
            },
          });
          return;
        }

        pathname = url.pathname;

        if (HEALTH_PATHS.has(pathname)) {
          if (method !== 'GET') {
            sendJson(
              res,
              405,
              {
                error: {
                  code: 'method_not_allowed',
                  message: 'Для этого маршрута разрешён только метод GET.',
                },
              },
              { Allow: 'GET' },
            );
            return;
          }

          // Liveness не обращается к PostgreSQL, readiness проверяет базу.
          // /health сохранён как readiness-проверка для совместимости с Docker healthcheck.
          const health =
            pathname === '/health/live'
              ? healthService.checkLiveness()
              : await healthService.checkReadiness();

          sendJson(res, health.status === 'ok' ? 200 : 503, health);
          return;
        }

        if (pathname === '/') {
          if (method !== 'GET') {
            sendJson(
              res,
              405,
              {
                error: {
                  code: 'method_not_allowed',
                  message: 'Для этого маршрута разрешён только метод GET.',
                },
              },
              { Allow: 'GET' },
            );
            return;
          }

          sendJson(res, 200, {
            service: config.serviceName,
            version: config.appVersion,
            status: 'running',
            health: '/health',
            healthLiveness: '/health/live',
            healthReadiness: '/health/ready',
            websocket: config.websocket.path,
            auth: config.auth?.enabled === true ? '/auth/discord/start' : null,
            game: gameState === null ? null : '/health/ready',
          });
          return;
        }

        // Маршруты авторизации подключаются, только если модуль auth собран.
        if (authRouter !== null && (await authRouter.handle({ req, res, url, method }))) {
          return;
        }

        sendJson(res, 404, {
          error: {
            code: 'not_found',
            message: 'Маршрут не найден.',
          },
        });
      } catch (err) {
        log.error(
          { err, requestId },
          'Ошибка обработки HTTP-запроса',
        );

        if (!res.headersSent) {
          sendJson(res, 500, {
            error: {
              code: 'internal_error',
              message: 'Внутренняя ошибка сервера.',
            },
          });
        } else {
          res.destroy();
        }
      }
    })();
  });

  server.requestTimeout = 15_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;

  server.on('clientError', (err, socket) => {
    log.debug({ err }, 'Ошибка HTTP-клиента');

    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    }
  });

  return server;
}
