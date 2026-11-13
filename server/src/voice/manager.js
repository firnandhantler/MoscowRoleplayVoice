import { AppError } from '../utils/errors.js';
import { AudioSource, TransportDirection } from '../../shared/protocol.js';

/** Защита от исчерпания ресурсов одним клиентом. */
const MAX_PRODUCERS_PER_PEER = 2;
const MAX_CONSUMERS_PER_PEER = 64;

/**
 * Состояние голосового подключения одного пользователя.
 *
 * У пользователя ровно два Producer: proximity и radio. Один физический микрофон
 * на клиенте разделяется на два аудиопотока, поэтому server-side микширование не нужно.
 */
class VoicePeer {
  /**
   * @param {{userId: string, discordId: string|null, robloxId: string|null, discordUsername: string|null}} user
   */
  constructor(user) {
    this.userId = user.userId;
    this.discordId = user.discordId ?? null;
    this.robloxId = user.robloxId ?? null;
    this.discordUsername = user.discordUsername ?? null;
    this.sendTransport = null;
    this.recvTransport = null;
    this.producers = new Map();
    this.consumers = new Map();
    this.muted = false;
    this.radioChannelId = null;
    this.joinedAt = Date.now();
  }

  /** @returns {import('mediasoup').types.WebRtcTransport|null} */
  getTransport(direction) {
    return direction === TransportDirection.SEND ? this.sendTransport : this.recvTransport;
  }
}

/**
 * Управление голосовыми подключениями: транспорты, Producers и Consumers.
 *
 * Модуль не знает о бизнес-правилах (кто кого должен слышать) — это решают
 * proximity и radio. Здесь только ресурсы mediasoup и проверка их принадлежности.
 */
export class VoiceManager {
  /**
   * @param {{mediasoup: import('../mediasoup/manager.js').MediaSoupManager, logger: import('pino').Logger}} options
   */
  constructor({ mediasoup, logger }) {
    this.mediasoup = mediasoup;
    this.logger = logger.child({ module: 'voice' });
    /** @type {Map<string, VoicePeer>} */
    this.peers = new Map();
  }

  /**
   * Возвращает или создаёт голосовое подключение пользователя.
   *
   * @param {{userId: string, discordId?: string|null, robloxId?: string|null, discordUsername?: string|null}} user
   * @returns {VoicePeer}
   */
  ensurePeer(user) {
    let peer = this.peers.get(user.userId);

    if (!peer) {
      peer = new VoicePeer(user);
      this.peers.set(user.userId, peer);
    } else {
      // Профиль мог обновиться после повторной привязки Roblox.
      peer.robloxId = user.robloxId ?? peer.robloxId;
      peer.discordUsername = user.discordUsername ?? peer.discordUsername;
    }

    return peer;
  }

  /**
   * @param {string} userId
   * @returns {VoicePeer|null}
   */
  getPeer(userId) {
    return this.peers.get(userId) ?? null;
  }

  /** @returns {VoicePeer[]} */
  listPeers() {
    return [...this.peers.values()];
  }

  /** @returns {VoicePeer[]} Пользователи с активным proximity Producer. */
  listProximityPeers() {
    return this.listPeers().filter((peer) =>
      peer.producers.has(AudioSource.PROXIMITY),
    );
  }

  /**
   * Создаёт транспорт и заменяет прежний транспорт того же направления.
   *
   * @param {VoicePeer} peer
   * @param {'send'|'recv'} direction
   * @returns {Promise<import('mediasoup').types.WebRtcTransport>}
   */
  async createTransport(peer, direction) {
    const transport = await this.mediasoup.createWebRtcTransport({ direction });
    const current = peer.getTransport(direction);

    if (current !== null) {
      // Повторное подключение: старый транспорт и его ресурсы больше не нужны.
      this.#closeTransport(peer, direction);
    }

    if (direction === TransportDirection.SEND) {
      peer.sendTransport = transport;
    } else {
      peer.recvTransport = transport;
    }

    return transport;
  }

  /**
   * @param {VoicePeer} peer
   * @param {'send'|'recv'} direction
   */
  #closeTransport(peer, direction) {
    const transport = peer.getTransport(direction);

    if (transport === null) {
      return;
    }

    if (direction === TransportDirection.SEND) {
      peer.producers.clear();
      peer.sendTransport = null;
    } else {
      peer.consumers.clear();
      peer.recvTransport = null;
    }

    transport.close();
  }

  /**
   * @param {VoicePeer} peer
   * @param {string} transportId
   * @param {object} dtlsParameters
   * @returns {Promise<void>}
   */
  async connectTransport(peer, transportId, dtlsParameters) {
    const transport = this.#findTransport(peer, transportId);

    if (transport === null) {
      throw new AppError('Транспорт не найден.', {
        code: 'transport_not_found',
        statusCode: 400,
        expose: true,
      });
    }

    await transport.connect({ dtlsParameters });
  }

  /**
   * @param {VoicePeer} peer
   * @param {string} transportId
   * @returns {import('mediasoup').types.WebRtcTransport|null}
   */
  #findTransport(peer, transportId) {
    for (const direction of [TransportDirection.SEND, TransportDirection.RECV]) {
      const transport = peer.getTransport(direction);

      if (transport !== null && transport.id === transportId) {
        return transport;
      }
    }

    return null;
  }

  /**
   * Создаёт Producer указанного источника. Один Producer на источник.
   *
   * @param {VoicePeer} peer
   * @param {{transportId: string, kind: string, rtpParameters: object, source: 'proximity'|'radio'}} params
   * @returns {Promise<import('mediasoup').types.Producer>}
   */
  async produce(peer, { transportId, kind, rtpParameters, source }) {
    if (kind !== 'audio') {
      throw new AppError('Поддерживается только аудио.', {
        code: 'unsupported_kind',
        statusCode: 400,
        expose: true,
      });
    }

    if (!Object.values(AudioSource).includes(source)) {
      throw new AppError('Неизвестный источник аудио.', {
        code: 'invalid_source',
        statusCode: 400,
        expose: true,
      });
    }

    if (peer.producers.size >= MAX_PRODUCERS_PER_PEER && !peer.producers.has(source)) {
      throw new AppError('Превышено число аудиопотоков пользователя.', {
        code: 'too_many_producers',
        statusCode: 429,
        expose: true,
      });
    }

    const transport = this.#findTransport(peer, transportId);

    if (transport === null || transport !== peer.sendTransport) {
      throw new AppError('Producer можно создать только на send-транспорте пользователя.', {
        code: 'invalid_transport',
        statusCode: 400,
        expose: true,
      });
    }

    const existing = peer.producers.get(source);

    if (existing) {
      existing.close();
      peer.producers.delete(source);
    }

    const producer = await transport.produce({
      kind: 'audio',
      rtpParameters,
      appData: { source, userId: peer.userId, robloxId: peer.robloxId },
    });

    // Микрофон выключен или радиопередача ещё не начата — поток приостановлен.
    if (peer.muted || (source === AudioSource.RADIO && peer.radioChannelId === null)) {
      await producer.pause();
    }

    peer.producers.set(source, producer);

    producer.on('transportclose', () => {
      if (peer.producers.get(source) === producer) {
        peer.producers.delete(source);
      }
    });

    return producer;
  }

  /**
   * @param {VoicePeer} peer
   * @param {string} producerId
   * @returns {import('mediasoup').types.Producer|null}
   */
  closeProducer(peer, producerId) {
    for (const [source, producer] of peer.producers) {
      if (producer.id === producerId) {
        producer.close();
        peer.producers.delete(source);
        return producer;
      }
    }

    return null;
  }

  /**
   * @param {VoicePeer} peer
   * @param {string} source
   * @returns {import('mediasoup').types.Producer|null}
   */
  getProducer(peer, source) {
    return peer.producers.get(source) ?? null;
  }

  /**
   * Приостанавливает или возобновляет Producers пользователя.
   *
   * @param {VoicePeer} peer
   * @param {{source?: 'proximity'|'radio', paused: boolean}} params
   */
  async setProducerPaused(peer, { source = null, paused }) {
    const producers = source === null ? [...peer.producers.values()] : [peer.producers.get(source)];

    for (const producer of producers) {
      if (!producer) {
        continue;
      }

      if (paused) {
        await producer.pause();
      } else {
        await producer.resume();
      }
    }
  }

  /**
   * Создаёт Consumer на recv-транспорте получателя.
   *
   * @param {VoicePeer} consumerPeer Получатель аудио.
   * @param {import('mediasoup').types.Producer} producer
   * @param {{source: 'proximity'|'radio', appData?: object}} options
   * @returns {Promise<{consumer: import('mediasoup').types.Consumer, created: boolean}>}
   */
  async createConsumer(consumerPeer, producer, { source, appData = {} }) {
    const existing = this.findConsumerByProducer(consumerPeer, producer.id);

    if (existing !== null) {
      return { consumer: existing, created: false };
    }

    if (consumerPeer.consumers.size >= MAX_CONSUMERS_PER_PEER) {
      throw new AppError('Превышено число входящих потоков.', {
        code: 'too_many_consumers',
        statusCode: 429,
        expose: true,
      });
    }

    const transport = consumerPeer.recvTransport;

    if (transport === null) {
      throw new AppError('Recv-транспорт не создан.', {
        code: 'transport_not_found',
        statusCode: 400,
        expose: true,
      });
    }

    const router = this.mediasoup.getRouter();

    if (router === null) {
      throw new AppError('Голосовой сервер временно недоступен.', {
        code: 'voice_unavailable',
        statusCode: 503,
        expose: true,
      });
    }

    const consumer = await transport.consume({
      producerId: producer.id,
      rtpCapabilities: router.rtpCapabilities,
      paused: false,
      appData: { source, producerUserId: producer.appData?.userId ?? null, ...appData },
    });

    consumerPeer.consumers.set(consumer.id, {
      consumer,
      producerId: producer.id,
      producerUserId: producer.appData?.userId ?? null,
      source,
    });

    consumer.on('transportclose', () => {
      consumerPeer.consumers.delete(consumer.id);
    });

    consumer.on('producerclose', () => {
      consumerPeer.consumers.delete(consumer.id);
    });

    return { consumer, created: true };
  }

  /**
   * @param {VoicePeer} peer
   * @param {string} producerId
   * @returns {import('mediasoup').types.Consumer|null}
   */
  findConsumerByProducer(peer, producerId) {
    for (const entry of peer.consumers.values()) {
      if (entry.producerId === producerId) {
        return entry.consumer;
      }
    }

    return null;
  }

  /**
   * @param {VoicePeer} peer
   * @param {string} consumerId
   * @returns {{peerUserId: string, consumerId: string, producerId: string}|null}
   */
  closeConsumer(peer, consumerId) {
    const entry = peer.consumers.get(consumerId);

    if (!entry) {
      return null;
    }

    const meta = {
      peerUserId: peer.userId,
      consumerId,
      producerId: entry.producerId,
      source: entry.source,
    };

    entry.consumer.close();
    peer.consumers.delete(consumerId);

    return meta;
  }

  /**
   * Закрывает все Consumers указанного источника у одного получателя.
   *
   * @param {VoicePeer} peer
   * @param {string} source
   * @returns {{peerUserId: string, consumerId: string, producerId: string, source: string}[]}
   */
  closeConsumersBySource(peer, source) {
    const closed = [];

    for (const [consumerId, entry] of [...peer.consumers]) {
      if (entry.source !== source) {
        continue;
      }

      entry.consumer.close();
      peer.consumers.delete(consumerId);
      closed.push({
        peerUserId: peer.userId,
        consumerId,
        producerId: entry.producerId,
        source: entry.source,
      });
    }

    return closed;
  }

  /**
   * Закрывает все Consumers указанного Producer у всех получателей.
   *
   * @param {string} producerId
   * @returns {{peerUserId: string, consumerId: string, producerId: string, source: string}[]}
   */
  closeConsumersOfProducer(producerId) {
    const closed = [];

    for (const peer of this.peers.values()) {
      for (const [consumerId, entry] of [...peer.consumers]) {
        if (entry.producerId !== producerId) {
          continue;
        }

        entry.consumer.close();
        peer.consumers.delete(consumerId);
        closed.push({
          peerUserId: peer.userId,
          consumerId,
          producerId,
          source: entry.source,
        });
      }
    }

    return closed;
  }

  /**
   * Полностью удаляет голосовое подключение пользователя.
   *
   * @param {string} userId
   * @returns {{removed: boolean, closed: {peerUserId: string, consumerId: string, producerId: string, source: string}[]}}
   */
  removePeer(userId) {
    const peer = this.peers.get(userId);

    if (!peer) {
      return { removed: false, closed: [] };
    }

    const closed = [];

    // Сначала закрываем чужие Consumers этого пользователя у остальных участников.
    for (const [source, producer] of peer.producers) {
      void source;
      closed.push(...this.closeConsumersOfProducer(producer.id));
    }

    peer.producers.clear();
    peer.consumers.clear();
    peer.sendTransport?.close();
    peer.recvTransport?.close();
    peer.sendTransport = null;
    peer.recvTransport = null;
    this.peers.delete(userId);

    return { removed: true, closed };
  }

  /** Краткая статистика для логирования и health-check. */
  getStatus() {
    let producers = 0;
    let consumers = 0;

    for (const peer of this.peers.values()) {
      producers += peer.producers.size;
      consumers += peer.consumers.size;
    }

    return {
      peers: this.peers.size,
      producers,
      consumers,
    };
  }

  /** Закрывает все подключения при остановке сервера. */
  closeAll() {
    for (const userId of [...this.peers.keys()]) {
      this.removePeer(userId);
    }
  }
}
