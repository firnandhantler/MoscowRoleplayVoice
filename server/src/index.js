import { ServerMessageType } from '../shared/protocol.js';
import { loadConfig } from './config/index.js';
import { createDatabase } from './database/pool.js';
import { createHttpServer } from './http/server.js';
import { createWebSocketGateway } from './websocket/server.js';
import { createLogger } from './utils/logger.js';
import { GracefulShutdown } from './utils/shutdown.js';

import { AuthRepository } from './auth/repository.js';
import { AuthRouter } from './auth/routes.js';
import { AuthService } from './auth/service.js';
import { SessionStore } from './auth/session-store.js';
import { OAuthStateStore } from './auth/state-store.js';
import { ErlcRussiaVerificationClient } from './erlcrussia/client.js';
import { DiscordOAuthClient } from './discord/client.js';
import { DiscordRoleService } from './discord/roles.js';
import { GameState, GameStateEvent } from './game/state.js';
import { GamePoller } from './game/poller.js';
import { MediaSoupManager } from './mediasoup/manager.js';
import { PrcClient } from './prc/client.js';
import { ProximityEngine } from './proximity/engine.js';
import { RadioEngine } from './radio/engine.js';
import { loadRadioChannels } from './radio/channels.js';
import { RobloxUsersClient } from './roblox/client.js';
import { SignalingService } from './signaling/service.js';
import { VoiceManager } from './voice/manager.js';

let logger;
let database;
let httpServer;
let wsGateway;
let poller;
let proximityEngine;
let voiceManager;
let signaling;
let mediasoup;
let sessionCleanupTimer;

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

/**
 * Собирает модуль авторизации. Маршрут /auth/session работает и при отключённом
 * Discord OAuth2, чтобы клиент мог показать понятную причину недоступности входа.
 *
 * @param {Readonly<object>} config
 * @param {import('./database/pool.js').Database} db
 * @param {import('pino').Logger} log
 * @returns {{authService: AuthService, authRouter: AuthRouter, sessionStore: import('./auth/session-store.js').SessionStore}}
 */
function createAuthModule(config, db, log) {
  const authEnabled = config.auth.enabled;

  if (!authEnabled) {
    log.warn(
      'Discord OAuth2 не настроен (DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI). ' +
        'Вход отключён: /auth/session сообщает authEnabled=false.',
    );
  }

  const discordClient = authEnabled
    ? new DiscordOAuthClient({
        clientId: config.discord.clientId,
        clientSecret: config.discord.clientSecret,
        redirectUri: config.discord.redirectUri,
        timeoutMs: config.discord.timeoutMs,
      })
    : null;

  const verificationClient =
    authEnabled && config.erlcRussia.enabled
      ? new ErlcRussiaVerificationClient({
          apiKey: config.erlcRussia.apiKey,
          apiBaseUrl: config.erlcRussia.apiBaseUrl,
          timeoutMs: config.erlcRussia.timeoutMs,
        })
      : null;

  if (authEnabled && verificationClient === null) {
    log.warn(
      'Верификация ER:LC Россия не настроена (ERLCRUSSIA_API_KEY). Привязка Roblox будет недоступна.',
    );
  }

  const robloxClient = new RobloxUsersClient({
    usersApiBaseUrl: config.roblox.usersApiBaseUrl,
    timeoutMs: config.roblox.timeoutMs,
  });

  const sessionStore = new SessionStore({
    database: db,
    idleTtlSeconds: config.auth.sessionIdleTtlSeconds,
    absoluteTtlSeconds: config.auth.sessionAbsoluteTtlSeconds,
    touchIntervalSeconds: config.auth.sessionTouchIntervalSeconds,
    logger: log,
  });

  const stateStore = new OAuthStateStore({
    ttlMs: config.auth.stateTtlSeconds * 1000,
  });

  const repository = new AuthRepository({ database: db, logger: log });

  const authService = new AuthService({
    config,
    logger: log,
    discordClient,
    verificationClient,
    robloxClient,
    sessionStore,
    stateStore,
    repository,
  });

  const authRouter = new AuthRouter({ authService, config, logger: log });

  return { authService, authRouter, sessionStore };
}

async function main() {
  const config = loadConfig();
  logger = createLogger(config);

  logger.info({ nodeVersion: process.version }, 'Запуск MoscowRoleplay Voice');

  database = createDatabase(config, logger);
  await database.connect();

  // --- Авторизация и интеграции ---
  const { authService, authRouter, sessionStore } = createAuthModule(config, database, logger);

  // --- Игровое состояние и опрос PRC ---
  const gameState = new GameState({
    staleAfterMs: config.game.staleAfterMs,
    logger,
  });

  if (config.game.pollEnabled) {
    const prcClient = new PrcClient({
      apiBaseUrl: config.prc.apiBaseUrl,
      serverKey: config.prc.serverKey,
      timeoutMs: config.prc.timeoutMs,
    });

    poller = new GamePoller({
      prcClient,
      gameState,
      logger,
      intervalMs: config.game.pollIntervalMs,
      maxBackoffMs: config.game.pollMaxBackoffMs,
    });
  } else {
    logger.warn(
      'Опрос PRC API отключён (нет PRC_SERVER_KEY или GAME_POLL_ENABLED=false). Proximity работать не будет.',
    );
  }

  // --- Голосовой сервер ---
  mediasoup = new MediaSoupManager({ config, logger });

  if (config.voice.enabled) {
    try {
      await mediasoup.start();
    } catch (err) {
      logger.error(
        { err },
        'Не удалось запустить mediasoup. Голосовые функции отключены, остальной сервер продолжит работу.',
      );
    }
  } else {
    logger.warn('VOICE_ENABLED=false: голосовые функции отключены');
  }

  voiceManager = new VoiceManager({ mediasoup, logger });

  const roleService = new DiscordRoleService({
    botToken: config.discord.botToken,
    guildIds: config.discord.roleGuildIds,
    cacheTtlMs: config.discord.rolesCacheTtlMs,
    timeoutMs: config.discord.timeoutMs,
    logger,
  });

  if (!roleService.isEnabled()) {
    logger.warn(
      'DISCORD_BOT_TOKEN или список Discord-серверов не задан: закрытые радиоканалы недоступны, открытые каналы продолжат работать.',
    );
  }

  let radioChannels = [];

  if (config.radio.enabled) {
    try {
      radioChannels = loadRadioChannels({
        ...(config.radio.channelsFile ? { path: config.radio.channelsFile } : {}),
        allowedGuildIds: config.discord.roleGuildIds,
        logger,
      });
    } catch (err) {
      logger.error({ err }, 'Не удалось загрузить файл радиоканалов, радио отключено');
      radioChannels = [];
    }
  }

  const radioEngine = new RadioEngine({
    channels: radioChannels,
    roleService,
    voiceManager,
    logger,
    maxTransmissionMs: config.radio.maxTransmissionMs,
  });

  proximityEngine = new ProximityEngine({
    gameState,
    voiceManager,
    logger,
    maxDistance: config.proximity.maxDistance,
    hysteresis: config.proximity.hysteresis,
    maxNeighbors: config.proximity.maxNeighbors,
    intervalMs: config.proximity.intervalMs,
  });

  // --- Сигнализация ---
  // Без настроенного Discord OAuth2 голосовой сервис не запускается:
  // клиент не сможет подтвердить личность, а открытые каналы без входа
  // противоречат требованиям безопасности.
  if (authService.isEnabled()) {
    signaling = new SignalingService({
      config,
      logger,
      authService,
      mediasoup,
      voiceManager,
      proximityEngine,
      radioEngine,
      gameState,
    });

    proximityEngine.onConsumerCreated = (event) => signaling.handleProximityConsumerCreated(event);
    proximityEngine.onConsumerClosed = (event) => signaling.handleConsumerClosed(event);
    proximityEngine.onNearbyChanged = (event) => signaling.handleNearbyChanged(event);

    radioEngine.onStateChanged = () => signaling.broadcastRadioState();
    radioEngine.onTransmissionChanged = (event) => signaling.handleTransmissionChanged(event);
    radioEngine.onConsumerCreated = (event) =>
      signaling.sendToUser(event.userId, ServerMessageType.VOICE_CONSUMER_CREATED, event.message);
    radioEngine.onConsumerClosed = (event) => signaling.handleConsumerClosed(event);

    // Игровое состояние: клиент должен узнать о входе в игру и выходе из неё,
    // чтобы создать или закрыть proximity Producer.
    const onGameUpdate = (record) => signaling.handleGameUpdate(record.robloxId);

    gameState.on(GameStateEvent.PLAYER_JOINED, onGameUpdate);
    gameState.on(GameStateEvent.PLAYER_UPDATED, onGameUpdate);
    gameState.on(GameStateEvent.PLAYER_LEFT, onGameUpdate);
  }

  httpServer = createHttpServer({
    config,
    logger,
    database,
    authRouter,
    gameState,
    poller,
    voice: {
      mediasoup,
      signaling: signaling ?? null,
    },
  });

  wsGateway = createWebSocketGateway({
    httpServer,
    config,
    logger,
    appHandler: signaling,
  });

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
      authEnabled: config.auth.enabled,
      erlcRussiaEnabled: config.erlcRussia.enabled,
      gamePolling: config.game.pollEnabled,
      voice: {
        enabled: config.voice.enabled,
        ready: mediasoup.isReady(),
        radioChannels: radioChannels.length,
        radioEnabled: radioEngine.isEnabled(),
      },
      proximity: config.proximity,
    },
    'HTTP- и WebSocket-серверы запущены',
  );

  // --- Фоновые задачи ---
  poller?.start();
  proximityEngine.start();

  if (sessionStore && config.auth.enabled) {
    sessionCleanupTimer = setInterval(() => {
      sessionStore.deleteExpired().catch((err) => {
        logger.warn({ err }, 'Не удалось удалить истёкшие сессии');
      });
    }, config.auth.sessionCleanupIntervalMs);

    sessionCleanupTimer.unref();
  }

  const shutdown = new GracefulShutdown({
    logger,
    timeoutMs: config.shutdownTimeoutMs,
  });

  // Порядок важен: сначала перестаём принимать сообщения,
  // затем закрываем голос, HTTP-соединения и только после этого — базу.
  shutdown.register('proximity', () => proximityEngine?.stop());
  shutdown.register('signaling', () => signaling?.closeAll());
  shutdown.register('voice', () => voiceManager?.closeAll());
  shutdown.register('mediasoup', () => mediasoup?.close());
  shutdown.register('poller', () => poller?.stop());
  shutdown.register('websocket', () => wsGateway.close());
  shutdown.register('http', () => closeHttpServer(httpServer));
  shutdown.register('database', () => database.close());

  if (sessionCleanupTimer) {
    shutdown.register('session-cleanup', () => {
      clearInterval(sessionCleanupTimer);
    });
  }

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

  if (proximityEngine) {
    try {
      proximityEngine.stop();
    } catch {
      // ignore
    }
  }

  if (signaling) {
    try {
      signaling.closeAll();
    } catch {
      // ignore
    }
  }

  if (voiceManager) {
    try {
      voiceManager.closeAll();
    } catch {
      // ignore
    }
  }

  if (mediasoup) {
    try {
      await mediasoup.close();
    } catch (closeErr) {
      logger?.error({ err: closeErr }, 'Ошибка остановки mediasoup');
    }
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
