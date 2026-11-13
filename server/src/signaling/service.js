import {
  AudioSource,
  ClientMessageType,
  ProtocolErrorCode,
  ServerMessageType,
  TransportDirection,
} from '../../shared/protocol.js';
import { AppError } from '../utils/errors.js';

const MAX_AUTH_FAILURES = 3;

/**
 * Прикладной уровень WebSocket-сигнализации.
 *
 * Принимает только запросы: любое действие (создание Producer, радиопередача,
 * доступ к каналу) повторно проверяется на сервере. Клиент не может
 * «назначить» себя слышимым, войти в закрытый канал или подменить Roblox ID.
 */
export class SignalingService {
  /**
   * @param {{
   *   config: Readonly<object>,
   *   logger: import('pino').Logger,
   *   authService: import('../auth/service.js').AuthService,
   *   mediasoup: import('../mediasoup/manager.js').MediaSoupManager,
   *   voiceManager: import('../voice/manager.js').VoiceManager,
   *   proximityEngine: import('../proximity/engine.js').ProximityEngine,
   *   radioEngine: import('../radio/engine.js').RadioEngine,
   *   gameState: import('../game/state.js').GameState,
   * }} options
   */
  constructor({
    config,
    logger,
    authService,
    mediasoup,
    voiceManager,
    proximityEngine,
    radioEngine,
    gameState,
  }) {
    this.config = config;
    this.logger = logger.child({ module: 'signaling' });
    this.authService = authService;
    this.mediasoup = mediasoup;
    this.voiceManager = voiceManager;
    this.proximityEngine = proximityEngine;
    this.radioEngine = radioEngine;
    this.gameState = gameState;

    /** @type {Map<string, object>} Активные соединения по userId. */
    this.connections = new Map();
  }

  /**
   * Обрабатывает сообщение клиента.
   *
   * @param {object} connection
   * @param {{type: string, id: string|null, data: object}} message
   * @returns {Promise<void>}
   */
  async handleMessage(connection, message) {
    try {
      if (message.type === ClientMessageType.AUTHENTICATE) {
        await this.#authenticate(connection, message);
        return;
      }

      if (connection.peer === null || connection.user === null) {
        connection.error(
          ProtocolErrorCode.NOT_AUTHENTICATED,
          'Сначала выполните вход: client.authenticate.',
          message.id,
        );
        return;
      }

      switch (message.type) {
        case ClientMessageType.VOICE_CREATE_TRANSPORT:
          await this.#createTransport(connection, message);
          break;
        case ClientMessageType.VOICE_CONNECT_TRANSPORT:
          await this.#connectTransport(connection, message);
          break;
        case ClientMessageType.VOICE_PRODUCE:
          await this.#produce(connection, message);
          break;
        case ClientMessageType.VOICE_CLOSE_PRODUCER:
          await this.#closeProducer(connection, message);
          break;
        case ClientMessageType.VOICE_SET_MUTED:
          await this.#setMuted(connection, message);
          break;
        case ClientMessageType.RADIO_JOIN:
          await this.#radioJoin(connection, message);
          break;
        case ClientMessageType.RADIO_LEAVE:
          await this.#radioLeave(connection, message);
          break;
        case ClientMessageType.RADIO_START_TRANSMISSION:
          await this.#radioStartTransmission(connection, message);
          break;
        case ClientMessageType.RADIO_STOP_TRANSMISSION:
          await this.#radioStopTransmission(connection, message);
          break;
        default:
          connection.error(
            ProtocolErrorCode.UNSUPPORTED_TYPE,
            'Этот тип сообщения не поддерживается.',
            message.id,
          );
      }
    } catch (err) {
      this.#handleError(connection, err, message.id);
    }
  }

  /**
   * Аутентификация по токену сессии.
   *
   * @param {object} connection
   * @param {{id: string|null, data: {token: string}}} message
   * @returns {Promise<void>}
   */
  async #authenticate(connection, message) {
    if (connection.user !== null) {
      connection.error('already_authenticated', 'Соединение уже авторизовано.', message.id);
      return;
    }

    const session = await this.authService.getSession(message.data.token);

    if (session === null) {
      connection.authFailures += 1;

      if (connection.authFailures >= MAX_AUTH_FAILURES) {
        connection.error(
          ProtocolErrorCode.NOT_AUTHENTICATED,
          'Не удалось подтвердить сессию. Войдите заново.',
          message.id,
        );
        connection.close(1008, 'Требуется авторизация');
        return;
      }

      connection.error(
        ProtocolErrorCode.NOT_AUTHENTICATED,
        'Сессия недействительна или истекла. Войдите заново.',
        message.id,
      );
      return;
    }

    const user = session.user;
    const previous = this.connections.get(user.id);

    const peer = this.voiceManager.ensurePeer({
      userId: user.id,
      discordId: user.discordId,
      robloxId: user.roblox?.id ?? null,
      discordUsername: user.discordUsername,
    });

    connection.user = user;
    connection.peer = peer;
    connection.gameSignature = null;

    // Новое подключение становится владельцем ресурсов пользователя до того,
    // как будет закрыто старое. Иначе обработчик закрытия старого соединения
    // успел бы удалить Peer, созданный для нового.
    this.connections.set(user.id, connection);

    // Одновременно разрешено одно голосовое соединение на пользователя.
    if (previous && previous !== connection) {
      previous.error(
        'session_replaced',
        'Выполнен вход с другого подключения.',
        null,
      );
      previous.close(4001, 'Сессия заменена');
    }

    const game = this.#buildGameState(peer);

    connection.gameSignature = game.signature;

    connection.send(ServerMessageType.AUTHENTICATED, {
      user: {
        id: user.id,
        discordId: user.discordId,
        discordUsername: user.discordUsername,
        discordGlobalName: user.discordGlobalName,
        roblox: user.roblox,
      },
      voice: {
        enabled: this.mediasoup.isReady(),
        rtpCapabilities: this.mediasoup.isReady() ? this.mediasoup.getRtpCapabilities() : null,
        proximity: {
          maxDistance: this.config.proximity.maxDistance,
          hysteresis: this.config.proximity.hysteresis,
        },
        maxProducers: 2,
      },
      radio: this.radioEngine.getStateFor(peer),
      game: game.state,
    }, message.id);

    this.logger.info({ userId: user.id }, 'WebSocket-клиент авторизован');

    // Пользователь мог появиться в игре — сразу пересчитываем близость.
    this.proximityEngine.requestReconcile();
  }

  /**
   * @param {object} connection
   * @param {{id: string|null, data: {direction: string}}} message
   */
  async #createTransport(connection, message) {
    if (!this.mediasoup.isReady()) {
      throw new AppError('Голосовой сервер временно недоступен.', {
        code: 'voice_unavailable',
        statusCode: 503,
        expose: true,
      });
    }

    const peer = connection.peer;
    const transport = await this.voiceManager.createTransport(peer, message.data.direction);

    // Новый транспорт не содержит прежних Producers и Consumers. Приводим
    // производные состояния в порядок: связи близости и радиопотоки.
    this.proximityEngine.resetPeer(peer.userId);
    await this.radioEngine.handleTransportReset(peer, message.data.direction);
    this.proximityEngine.requestReconcile();

    connection.send(
      ServerMessageType.VOICE_TRANSPORT_CREATED,
      {
        direction: message.data.direction,
        transportId: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        sctpParameters: null,
      },
      message.id,
    );
  }

  /**
   * @param {object} connection
   * @param {{id: string|null, data: {transportId: string, dtlsParameters: object}}} message
   */
  async #connectTransport(connection, message) {
    await this.voiceManager.connectTransport(
      connection.peer,
      message.data.transportId,
      message.data.dtlsParameters,
    );

    // Клиент обязан дождаться подтверждения: только после него DTLS-соединение
    // действительно установлено на сервере.
    connection.send(
      ServerMessageType.VOICE_TRANSPORT_CONNECTED,
      { transportId: message.data.transportId },
      message.id,
    );
  }

  /**
   * @param {object} connection
   * @param {{id: string|null, data: {transportId: string, kind: string, rtpParameters: object, source: string}}} message
   */
  async #produce(connection, message) {
    const peer = connection.peer;

    if (peer.robloxId === null) {
      throw new AppError(
        'Roblox-аккаунт не привязан. Привяжите аккаунт через Bloxlink и войдите снова.',
        { code: 'roblox_not_linked', statusCode: 409, expose: true },
      );
    }

    if (message.data.source === AudioSource.PROXIMITY) {
      const player = this.gameState.getPlayer(peer.robloxId);

      if (player === null) {
        throw new AppError(
          'Вы не найдены на игровом сервере. Proximity-голос доступен только в игре.',
          { code: 'player_not_in_game', statusCode: 409, expose: true },
        );
      }
    }

    const producer = await this.voiceManager.produce(peer, {
      transportId: message.data.transportId,
      kind: message.data.kind,
      rtpParameters: message.data.rtpParameters,
      source: message.data.source,
    });

    connection.send(
      ServerMessageType.VOICE_PRODUCED,
      { producerId: producer.id, source: message.data.source },
      message.id,
    );

    if (message.data.source === AudioSource.PROXIMITY) {
      this.proximityEngine.requestReconcile();
    }
  }

  /**
   * @param {object} connection
   * @param {{id: string|null, data: {producerId: string}}} message
   */
  async #closeProducer(connection, message) {
    const peer = connection.peer;
    const producer = this.voiceManager.closeProducer(peer, message.data.producerId);

    if (producer === null) {
      return;
    }

    for (const closed of this.voiceManager.closeConsumersOfProducer(producer.id)) {
      this.sendToUser(closed.peerUserId, ServerMessageType.VOICE_CONSUMER_CLOSED, {
        consumerId: closed.consumerId,
        source: closed.source,
      });
    }

    connection.send(
      ServerMessageType.VOICE_PRODUCER_CLOSED,
      { producerId: producer.id },
      message.id,
    );

    this.proximityEngine.requestReconcile();
  }

  /**
   * @param {object} connection
   * @param {{id: string|null, data: {muted: boolean}}} message
   */
  async #setMuted(connection, message) {
    const peer = connection.peer;
    const muted = message.data.muted;

    peer.muted = muted;

    if (muted && peer.radioChannelId !== null) {
      await this.radioEngine.stopTransmission(peer, peer.radioChannelId, 'muted');
    }

    for (const source of [AudioSource.PROXIMITY, AudioSource.RADIO]) {
      const producer = this.voiceManager.getProducer(peer, source);

      if (producer === null) {
        continue;
      }

      if (muted) {
        await producer.pause();
      } else if (source === AudioSource.PROXIMITY) {
        await producer.resume();
      }
    }

    connection.send(
      ServerMessageType.VOICE_MUTED,
      { muted },
      message.id,
    );
  }

  /**
   * @param {object} connection
   * @param {{id: string|null, data: {channelId: string}}} message
   */
  async #radioJoin(connection, message) {
    await this.#runRadioOperation(connection, message, () =>
      this.radioEngine.join(connection.peer, message.data.channelId),
    );
  }

  /**
   * @param {object} connection
   * @param {{id: string|null, data: {channelId: string}}} message
   */
  async #radioLeave(connection, message) {
    await this.#runRadioOperation(connection, message, () =>
      this.radioEngine.leave(connection.peer, message.data.channelId),
    );
  }

  /**
   * @param {object} connection
   * @param {{id: string|null, data: {channelId: string}}} message
   */
  async #radioStartTransmission(connection, message) {
    await this.#runRadioOperation(connection, message, () =>
      this.radioEngine.startTransmission(connection.peer, message.data.channelId),
    );
  }

  /**
   * @param {object} connection
   * @param {{id: string|null, data: {channelId: string}}} message
   */
  async #radioStopTransmission(connection, message) {
    await this.#runRadioOperation(connection, message, () =>
      this.radioEngine.stopTransmission(connection.peer, message.data.channelId, 'stopped'),
    );
  }

  /**
   * Выполняет радиодействие и подтверждает его состоянием каналов.
   *
   * Пока операция выполняется, широковещательная рассылка пропускает
   * инициатора: он получит одно сообщение с идентификатором запроса, поэтому
   * клиент сможет отличить успех от ошибки и не обработает состояние дважды.
   *
   * @param {object} connection
   * @param {{id: string|null}} message
   * @param {() => Promise<void>} operation
   * @returns {Promise<void>}
   */
  async #runRadioOperation(connection, message, operation) {
    connection.radioOperation = true;

    try {
      await operation();
    } finally {
      connection.radioOperation = false;
    }

    if (connection.peer === null) {
      return;
    }

    connection.send(
      ServerMessageType.RADIO_STATE,
      this.radioEngine.getStateFor(connection.peer),
      message.id,
    );
  }

  /**
   * Собирает игровое состояние пользователя для клиента.
   *
   * Клиенту нужен только факт присутствия в игре и публичные игровые данные:
   * по ним он решает, создавать ли proximity Producer. Координаты не передаются —
   * расстояние считает исключительно сервер.
   *
   * @param {object} peer
   * @returns {{state: object, signature: string}}
   */
  #buildGameState(peer) {
    const stale = this.gameState.isStale();
    const playerCount = this.gameState.getStatus().playerCount;

    if (peer.robloxId === null) {
      return {
        state: { linked: false, inGame: false, stale, playerCount: 0, player: null },
        signature: JSON.stringify({ linked: false, stale, playerCount: 0 }),
      };
    }

    const player = this.gameState.getPlayer(peer.robloxId);

    const summary =
      player === null
        ? null
        : {
            name: player.name,
            team: player.team,
            callsign: player.callsign,
            postalCode: player.postalCode,
            streetName: player.streetName,
            wantedStars: player.wantedStars,
          };

    const state = {
      linked: true,
      inGame: player !== null,
      stale,
      playerCount,
      player: summary,
    };

    return { state, signature: JSON.stringify({ ...summary, inGame: player !== null }) };
  }

  /**
   * Уведомляет соединения пользователя об изменении его игрового состояния.
   *
   * Вызывается игровым poller-ом через события GameState. Сообщение отправляется
   * только при реальном изменении данных, чтобы не слать пакеты 2 раза в секунду.
   *
   * @param {string} robloxId
   */
  handleGameUpdate(robloxId) {
    for (const connection of this.connections.values()) {
      const peer = connection.peer;

      if (peer === null || peer.robloxId !== robloxId) {
        continue;
      }

      const game = this.#buildGameState(peer);

      if (game.signature === connection.gameSignature) {
        continue;
      }

      connection.gameSignature = game.signature;
      connection.send(ServerMessageType.GAME_STATE, game.state);
    }
  }

  /**
   * Отправляет сообщение авторизованному пользователю, если он подключён.
   *
   * @param {string} userId
   * @param {string} type
   * @param {object} data
   */
  sendToUser(userId, type, data) {
    const connection = this.connections.get(userId);

    if (connection) {
      connection.send(type, data);
    }
  }

  /**
   * Рассылает состояние радиоканалов всем клиентам (каналы у каждого свои).
   *
   * Соединение, выполняющее сейчас радиодействие, пропускается: оно получит
   * подтверждение отдельно, вместе с идентификатором запроса.
   */
  broadcastRadioState() {
    for (const [userId, connection] of this.connections) {
      if (connection.radioOperation === true) {
        continue;
      }

      const peer = this.voiceManager.getPeer(userId);

      if (!peer) {
        continue;
      }

      connection.send(ServerMessageType.RADIO_STATE, this.radioEngine.getStateFor(peer));
    }
  }

  /**
   * Событие Proximity: создан входящий поток.
   *
   * @param {{userId: string, message: object}} event
   */
  handleProximityConsumerCreated(event) {
    this.sendToUser(event.userId, ServerMessageType.VOICE_CONSUMER_CREATED, event.message);
  }

  /**
   * @param {{userId: string, message: object}} event
   */
  handleConsumerClosed(event) {
    this.sendToUser(event.userId, ServerMessageType.VOICE_CONSUMER_CLOSED, event.message);
  }

  /**
   * @param {{userId: string, nearbyCount: number}} event
   */
  handleNearbyChanged(event) {
    this.sendToUser(event.userId, ServerMessageType.PROXIMITY_STATE, {
      nearbyCount: event.nearbyCount,
    });
  }

  /**
   * Событие Radio: начата или завершена передача.
   *
   * @param {{channelId: string, speakerUserId: string, speakerName: string, active: boolean}} event
   */
  handleTransmissionChanged(event) {
    const members = this.radioEngine.members.get(event.channelId);

    if (!members) {
      return;
    }

    for (const userId of members) {
      this.sendToUser(userId, ServerMessageType.RADIO_TRANSMISSION, {
        channelId: event.channelId,
        speakerUserId: event.speakerUserId,
        speakerName: event.speakerName,
        active: event.active,
      });
    }
  }

  /**
   * Корректно завершает соединение и освобождает ресурсы пользователя.
   *
   * @param {object} connection
   * @returns {Promise<void>}
   */
  async handleClose(connection) {
    const user = connection.user;

    connection.user = null;

    if (user === null) {
      return;
    }

    // Соединение заменено новым входом: голосовые ресурсы принадлежат
    // новому подключению и удалять их нельзя.
    if (this.connections.get(user.id) !== connection) {
      connection.peer = null;
      return;
    }

    this.connections.delete(user.id);

    const peer = connection.peer;

    connection.peer = null;

    if (!peer) {
      return;
    }

    await this.radioEngine.handlePeerRemoved(peer);
    this.proximityEngine.removeUser(peer.userId);

    const { closed } = this.voiceManager.removePeer(peer.userId);

    for (const item of closed) {
      this.sendToUser(item.peerUserId, ServerMessageType.VOICE_CONSUMER_CLOSED, {
        consumerId: item.consumerId,
        source: item.source,
      });
    }

    this.broadcastRadioState();
    this.proximityEngine.requestReconcile();

    this.logger.info({ userId: user.id }, 'WebSocket-клиент отключён от голоса');
  }

  /**
   * @param {object} connection
   * @param {unknown} err
   * @param {string|null} requestId
   */
  #handleError(connection, err, requestId) {
    if (err instanceof AppError) {
      connection.error(err.code, err.message, requestId);
      return;
    }

    this.logger.error({ err }, 'Ошибка обработки сообщения сигнализации');
    connection.error(
      ProtocolErrorCode.INTERNAL_ERROR,
      'Внутренняя ошибка сервера.',
      requestId,
    );
  }

  /** Закрывает все соединения при остановке сервера. */
  closeAll() {
    for (const connection of [...this.connections.values()]) {
      connection.close(1012, 'Сервер завершает работу');
    }

    this.connections.clear();
  }

  /** @returns {object} */
  getStatus() {
    return {
      connections: this.connections.size,
      voice: this.voiceManager.getStatus(),
      proximity: this.proximityEngine.getStatus(),
      radio: this.radioEngine.getStatus(),
    };
  }
}

export { TransportDirection };
