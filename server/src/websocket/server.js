import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import {
  ClientMessageType,
  ProtocolErrorCode,
  ServerMessageType,
  createServerMessage,
  parseClientMessage,
} from '../../../shared/protocol.js';

const CLOSE_CODES = Object.freeze({
  GOING_AWAY: 1001,
  POLICY_VIOLATION: 1008,
  TRY_AGAIN_LATER: 1013,
});

/**
 * Ограниченный интерфейс соединения для прикладного слоя сигнализации.
 * Скрывает детали `ws` и не даёт бизнес-логике работать с сокетом напрямую.
 */
class SignalingConnection {
  /**
   * @param {WebSocket} socket
   * @param {{id: string, remoteAddress: string|null, send: Function, logger: object}} options
   */
  constructor(socket, { id, remoteAddress, send, logger }) {
    this.id = id;
    this.remoteAddress = remoteAddress;
    this.socket = socket;
    this.rawSend = send;
    this.logger = logger;
    this.user = null;
    this.peer = null;
    this.authFailures = 0;
    this.openedAt = Date.now();
    // true, пока выполняется радиодействие этого соединения: его состояние
    // придёт отдельным подтверждением с id запроса.
    this.radioOperation = false;
  }

  /**
   * @param {string} type
   * @param {object} data
   * @param {string|null} requestId
   */
  send(type, data = {}, requestId = null) {
    this.rawSend(createServerMessage(type, data, requestId));
  }

  /**
   * @param {string} code
   * @param {string} message
   * @param {string|null} requestId
   */
  error(code, message, requestId = null) {
    this.send(ServerMessageType.ERROR, { code, message }, requestId);
  }

  /**
   * @param {number} code
   * @param {string} reason
   */
  close(code, reason) {
    try {
      this.socket.close(code, reason);
    } catch {
      // Соединение уже могло быть закрыто.
    }
  }
}

/**
 * WebSocket-шлюз: принимает соединения, проверяет формат сообщений,
 * ограничивает частоту и передаёт запросы прикладному обработчику.
 */
class WebSocketGateway {
  /**
   * @param {{
   *   httpServer: import('node:http').Server,
   *   config: Readonly<object>,
   *   logger: import('pino').Logger,
   *   appHandler?: {handleMessage: Function, handleClose: Function}|null,
   * }} options
   */
  constructor({ httpServer, config, logger, appHandler = null }) {
    this.config = config;
    this.logger = logger.child({ module: 'websocket' });
    this.appHandler = appHandler;
    this.connections = new Map();
    this.closed = false;

    this.wss = new WebSocketServer({
      server: httpServer,
      path: config.websocket.path,
      maxPayload: config.websocket.maxPayloadBytes,
      perMessageDeflate: false,
      clientTracking: true,
    });

    this.wss.on('connection', (socket, request) => {
      this.#handleConnection(socket, request);
    });

    this.wss.on('error', (err) => {
      this.logger.error({ err }, 'Ошибка WebSocket-сервера');
    });

    this.heartbeatTimer = setInterval(() => {
      this.#checkHeartbeats();
    }, config.websocket.heartbeatIntervalMs);

    this.heartbeatTimer.unref();
  }

  /**
   * @param {WebSocket} socket
   * @param {import('node:http').IncomingMessage} request
   */
  #handleConnection(socket, request) {
    if (this.closed) {
      socket.close(CLOSE_CODES.GOING_AWAY, 'Сервер завершает работу');
      return;
    }

    if (this.wss.clients.size > this.config.websocket.maxConnections) {
      this.logger.warn(
        {
          maxConnections: this.config.websocket.maxConnections,
          remoteAddress: request.socket.remoteAddress ?? null,
        },
        'Превышен лимит WebSocket-соединений',
      );
      socket.close(CLOSE_CODES.TRY_AGAIN_LATER, 'Сервер перегружен');
      return;
    }

    const connectionId = randomUUID();
    const state = {
      id: connectionId,
      isAlive: true,
      violations: 0,
      windowStartedAt: Date.now(),
      messageCount: 0,
      remoteAddress: request.socket.remoteAddress ?? null,
    };

    const send = (message) => {
      this.#send(socket, state, message);
    };

    const connection = new SignalingConnection(socket, {
      id: connectionId,
      remoteAddress: state.remoteAddress,
      send,
      logger: this.logger,
    });

    state.connection = connection;
    this.connections.set(socket, state);

    this.logger.info(
      {
        connectionId,
        remoteAddress: state.remoteAddress,
        totalConnections: this.connections.size,
      },
      'WebSocket-клиент подключён',
    );

    socket.on('pong', () => {
      state.isAlive = true;
    });

    socket.on('message', (data, isBinary) => {
      this.#handleMessage(socket, state, connection, data, isBinary);
    });

    socket.on('error', (err) => {
      this.logger.warn({ err, connectionId }, 'Ошибка WebSocket-соединения');
    });

    socket.on('close', (code, reason) => {
      this.connections.delete(socket);

      this.logger.info(
        {
          connectionId,
          code,
          reason: reason.toString('utf8').slice(0, 128),
          totalConnections: this.connections.size,
        },
        'WebSocket-клиент отключён',
      );

      if (this.appHandler) {
        Promise.resolve()
          .then(() => this.appHandler.handleClose(connection))
          .catch((err) => {
            this.logger.error({ err, connectionId }, 'Ошибка очистки голосового соединения');
          });
      }
    });

    this.#send(
      socket,
      state,
      createServerMessage(ServerMessageType.HELLO, {
        connectionId,
        heartbeatIntervalMs: this.config.websocket.heartbeatIntervalMs,
        maxMessageBytes: this.config.websocket.maxPayloadBytes,
        serverTime: new Date().toISOString(),
        requiresAuth: this.appHandler !== null,
        authMessage: ClientMessageType.AUTHENTICATE,
      }),
    );
  }

  /**
   * @param {WebSocket} socket
   * @param {object} state
   * @param {SignalingConnection} connection
   * @param {import('node:buffer').Buffer|ArrayBuffer|Buffer[]} data
   * @param {boolean} isBinary
   */
  #handleMessage(socket, state, connection, data, isBinary) {
    if (isBinary) {
      this.#protocolError(
        socket,
        state,
        ProtocolErrorCode.BINARY_NOT_SUPPORTED,
        'Двоичные сообщения не поддерживаются. Отправьте текстовый JSON.',
        null,
      );
      return;
    }

    const now = Date.now();

    if (!this.#consumeRateLimit(state, now)) {
      this.#protocolError(
        socket,
        state,
        ProtocolErrorCode.RATE_LIMITED,
        'Превышен допустимый лимит сообщений. Попробуйте позже.',
        null,
      );
      return;
    }

    const text = Buffer.isBuffer(data)
      ? data.toString('utf8')
      : Buffer.from(data).toString('utf8');
    const parsed = parseClientMessage(text);

    if (!parsed.ok) {
      this.#protocolError(socket, state, parsed.error.code, parsed.error.message, null);
      return;
    }

    const message = parsed.message;

    if (message.type === ClientMessageType.PING) {
      const pongData = {
        serverTime: new Date().toISOString(),
      };

      if (message.data.nonce !== undefined) {
        pongData.nonce = message.data.nonce;
      }

      this.#send(
        socket,
        state,
        createServerMessage(ServerMessageType.PONG, pongData, message.id),
      );
      return;
    }

    if (this.appHandler === null) {
      this.#protocolError(
        socket,
        state,
        ProtocolErrorCode.UNSUPPORTED_TYPE,
        'Этот тип сообщения пока не поддерживается сервером.',
        message.id,
      );
      return;
    }

    Promise.resolve()
      .then(() => this.appHandler.handleMessage(connection, message))
      .catch((err) => {
        this.logger.error({ err, connectionId: state.id }, 'Ошибка обработки сообщения');
        connection.error(
          ProtocolErrorCode.INTERNAL_ERROR,
          'Внутренняя ошибка сервера.',
          message.id,
        );
      });
  }

  /**
   * @param {object} state
   * @param {number} now
   * @returns {boolean}
   */
  #consumeRateLimit(state, now) {
    const windowMs = this.config.websocket.rateLimitWindowMs;

    if (now - state.windowStartedAt >= windowMs) {
      state.windowStartedAt = now;
      state.messageCount = 0;
    }

    state.messageCount += 1;
    return state.messageCount <= this.config.websocket.rateLimitMaxMessages;
  }

  /**
   * @param {WebSocket} socket
   * @param {object} state
   * @param {string} code
   * @param {string} message
   * @param {string|null} requestId
   */
  #protocolError(socket, state, code, message, requestId) {
    state.violations += 1;

    this.logger.debug(
      {
        connectionId: state.id,
        code,
        violations: state.violations,
      },
      'Нарушение протокола WebSocket',
    );

    this.#send(
      socket,
      state,
      createServerMessage(ServerMessageType.ERROR, { code, message }, requestId),
    );

    if (state.violations >= this.config.websocket.maxViolations) {
      this.logger.warn(
        {
          connectionId: state.id,
          violations: state.violations,
        },
        'WebSocket-клиент закрыт из-за нарушений протокола',
      );
      socket.close(CLOSE_CODES.POLICY_VIOLATION, 'Слишком много нарушений протокола');
    }
  }

  /**
   * @param {WebSocket} socket
   * @param {object} state
   * @param {object} message
   */
  #send(socket, state, message) {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(JSON.stringify(message), (err) => {
      if (err) {
        this.logger.warn(
          { err, connectionId: state.id },
          'Не удалось отправить WebSocket-сообщение',
        );
      }
    });
  }

  #checkHeartbeats() {
    for (const [socket, state] of this.connections) {
      if (socket.readyState !== WebSocket.OPEN) {
        this.connections.delete(socket);
        continue;
      }

      if (!state.isAlive) {
        this.logger.warn(
          { connectionId: state.id },
          'WebSocket-клиент не отвечает, соединение будет закрыто',
        );
        socket.terminate();
        continue;
      }

      state.isAlive = false;

      try {
        socket.ping();
      } catch (err) {
        this.logger.warn(
          { err, connectionId: state.id },
          'Не удалось отправить ping WebSocket-клиенту',
        );
        socket.terminate();
      }
    }
  }

  /**
   * Возвращает текущее количество подключённых клиентов.
   * @returns {number}
   */
  getConnectionCount() {
    return this.connections.size;
  }

  /**
   * Корректно закрывает все WebSocket-соединения.
   * @returns {Promise<void>}
   */
  async close() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    clearInterval(this.heartbeatTimer);

    const sockets = [...this.connections.keys()];

    for (const socket of sockets) {
      try {
        socket.close(CLOSE_CODES.GOING_AWAY, 'Сервер завершает работу');
      } catch {
        // Соединение уже могло быть закрыто.
      }
    }

    await new Promise((resolve) => {
      let settled = false;

      const finish = () => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(forceTimer);
        resolve();
      };

      const forceTimer = setTimeout(() => {
        for (const socket of sockets) {
          try {
            socket.terminate();
          } catch {
            // Соединение уже могло быть закрыто.
          }
        }

        finish();
      }, 3000);

      forceTimer.unref();

      this.wss.close(() => {
        finish();
      });
    });

    this.logger.info('WebSocket-сервер остановлен');
  }
}

/**
 * @param {{
 *   httpServer: import('node:http').Server,
 *   config: Readonly<object>,
 *   logger: import('pino').Logger,
 *   appHandler?: object|null,
 * }} options
 * @returns {WebSocketGateway}
 */
export function createWebSocketGateway(options) {
  return new WebSocketGateway(options);
}
