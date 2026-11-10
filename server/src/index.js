import { loadConfig } from './config/index.js';
import { createDatabase } from './database/pool.js';
import { createHttpServer } from './http/server.js';
import { createWebSocketGateway } from './websocket/server.js';
import { createLogger } from './utils/logger.js';
import { GracefulShutdown } from './utils/shutdown.js';

let logger;
let database;
let httpServer;
let wsGateway;

/**
 * Запускает HTTP-сервер и ждёт события listening.
 *
 * @param {import('node:http').Server} server
 * @param {number} port
 * @param {string} host
 * @returns {Promise<void>}
 */
function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };

    const onListening = () => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * Закрывает HTTP-сервер и ожидает завершения.
 *
 * @param {import('node:http').Server} server
 * @returns {Promise<void>}
 */
function closeHttpServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }

    server.close((err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });

    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }
  });
}

async function main() {
  const config = loadConfig();
  logger = createLogger(config);

  logger.info(
    {
      nodeVersion: process.version,
    },
    'Запуск MoscowRoleplay Voice',
  );

  database = createDatabase(config, logger);
  await database.connect();

  httpServer = createHttpServer({ config, logger, database });
  wsGateway = createWebSocketGateway({ httpServer, config, logger });

  await listen(httpServer, config.server.port, config.server.host);

  logger.info(
    {
      host: config.server.host,
      port: config.server.port,
      websocketPath: config.websocket.path,
      database: {
        host: config.database.host,
        name: config.database.database,
      },
      mediasoup: config.mediasoup,
    },
    'HTTP- и WebSocket-серверы запущены',
  );

  const shutdown = new GracefulShutdown({
    logger,
    timeoutMs: config.shutdownTimeoutMs,
  });

  // Порядок важен: сначала перестаём принимать сообщения,
  // затем закрываем HTTP-соединения и только после этого — базу.
  shutdown.register('websocket', () => wsGateway.close());
  shutdown.register('http', () => closeHttpServer(httpServer));
  shutdown.register('database', () => database.close());

  const handleSignal = (signal) => {
    void shutdown.run(signal, 0);
  };

  process.once('SIGINT', () => handleSignal('SIGINT'));
  process.once('SIGTERM', () => handleSignal('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.fatal(
      { err: reason instanceof Error ? reason : { message: String(reason) } },
      'Необработанный отказ Promise',
    );
    void shutdown.run('unhandledRejection', 1);
  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Необработанное исключение');
    void shutdown.run('uncaughtException', 1);
  });
}

main().catch(async (err) => {
  if (logger) {
    logger.fatal({ err }, 'Не удалось запустить сервер');
  } else {
    console.error(
      JSON.stringify({
        level: 'fatal',
        message: 'Не удалось запустить сервер MoscowRoleplay Voice.',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  if (wsGateway) {
    try {
      await wsGateway.close();
    } catch (closeErr) {
      logger?.error({ err: closeErr }, 'Ошибка остановки WebSocket-сервера');
    }
  }

  if (httpServer) {
    try {
      await closeHttpServer(httpServer);
    } catch (closeErr) {
      logger?.error({ err: closeErr }, 'Ошибка остановки HTTP-сервера');
    }
  }

  if (database) {
    try {
      await database.close();
    } catch (closeErr) {
      logger?.error({ err: closeErr }, 'Ошибка закрытия PostgreSQL');
    }
  }

  process.exitCode = 1;
});
