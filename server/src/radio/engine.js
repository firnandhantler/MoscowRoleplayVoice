import { AppError } from '../utils/errors.js';
import { AudioSource } from '../../../shared/protocol.js';

/**
 * Радиосистема (режим both-dual).
 *
 * Proximity и радио работают параллельно: это два независимых Producer,
 * поэтому включение радио не отключает близость.
 *
 * Права на канал проверяются на сервере по ролям Discord (DiscordRoleService).
 * Передача в канале эксклюзивна: одновременно говорит только один участник.
 */
export class RadioEngine {
  /**
   * @param {{
   *   channels: {id: string, name: string, description: string, roleIds: string[], priority: number}[],
   *   roleService: import('../discord/roles.js').DiscordRoleService,
   *   voiceManager: import('../voice/manager.js').VoiceManager,
   *   logger: import('pino').Logger,
   *   maxTransmissionMs?: number,
   *   onStateChanged?: (() => void)|null,
   *   onTransmissionChanged?: ((event: object) => void)|null,
   *   onConsumerCreated?: ((event: object) => void)|null,
   *   onConsumerClosed?: ((event: object) => void)|null,
   * }} options
   */
  constructor({
    channels,
    roleService,
    voiceManager,
    logger,
    maxTransmissionMs = 120_000,
    onStateChanged = null,
    onTransmissionChanged = null,
    onConsumerCreated = null,
    onConsumerClosed = null,
  }) {
    this.logger = logger.child({ module: 'radio' });
    this.roleService = roleService;
    this.voiceManager = voiceManager;
    this.maxTransmissionMs = maxTransmissionMs;

    /** @type {Map<string, object>} */
    this.channels = new Map(channels.map((channel) => [channel.id, channel]));
    /** @type {Map<string, Set<string>>} */
    this.members = new Map();
    /** @type {Map<string, {userId: string, timer: NodeJS.Timeout|null}>} */
    this.speakers = new Map();

    this.onStateChanged = onStateChanged;
    this.onTransmissionChanged = onTransmissionChanged;
    this.onConsumerCreated = onConsumerCreated;
    this.onConsumerClosed = onConsumerClosed;
  }

  /** @returns {boolean} */
  isEnabled() {
    if (this.channels.size === 0) {
      return false;
    }

    // Открытые каналы (без roleIds) не требуют Discord-бота: они доступны
    // любому авторизованному пользователю через Discord OAuth2.
    if (this.roleService.isEnabled()) {
      return true;
    }

    for (const channel of this.channels.values()) {
      if (channel.roleIds.length === 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * Публичный список каналов для клиента. Роли наружу не отдаются.
   *
   * @param {object} peer
   * @returns {{id: string, name: string, description: string, restricted: boolean, joined: boolean, speaker: object|null}[]}
   */
  listChannelsFor(peer) {
    const result = [];

    for (const channel of this.channels.values()) {
      const speaker = this.speakers.get(channel.id);
      result.push({
        id: channel.id,
        name: channel.name,
        description: channel.description,
        restricted: channel.roleIds.length > 0,
        joined: peer.radioChannelId === channel.id,
        speaker:
          speaker && speaker.userId !== peer.userId
            ? { userId: speaker.userId, name: this.#displayName(speaker.userId) }
            : null,
      });
    }

    return result;
  }

  /**
   * @param {string} userId
   * @returns {string}
   */
  #displayName(userId) {
    return this.voiceManager.getPeer(userId)?.discordUsername ?? 'Неизвестный';
  }

  /**
   * Проверяет доступ к каналу по ролям Discord.
   *
   * @param {object} peer
   * @param {object} channel
   * @returns {Promise<void>}
   */
  async #assertAccess(peer, channel) {
    // Пустой roleIds — открытый канал для любого авторизованного пользователя.
    if (channel.roleIds.length === 0) {
      return;
    }

    if (!this.roleService.isEnabled()) {
      throw new AppError(
        'Радио недоступно: на сервере не настроен Discord-бот для проверки ролей.',
        { code: 'radio_unavailable', statusCode: 503, expose: true },
      );
    }

    if (peer.discordId === null) {
      throw new AppError('Не удалось определить Discord-аккаунт пользователя.', {
        code: 'radio_forbidden',
        statusCode: 403,
        expose: true,
      });
    }

    const allowed = await this.roleService.hasAnyRole(peer.discordId, channel.roleIds);

    if (allowed === null) {
      throw new AppError(
        'Не удалось проверить роли Discord. Попробуйте позже.',
        { code: 'roles_unavailable', statusCode: 503, expose: true },
      );
    }

    if (!allowed) {
      throw new AppError('Нет доступа к этому радиоканалу.', {
        code: 'radio_forbidden',
        statusCode: 403,
        expose: true,
      });
    }
  }

  /**
   * @param {string} channelId
   * @returns {object}
   */
  #channel(channelId) {
    const channel = this.channels.get(channelId);

    if (!channel) {
      throw new AppError('Радиоканал не найден.', {
        code: 'radio_channel_not_found',
        statusCode: 404,
        expose: true,
      });
    }

    return channel;
  }

  /**
   * Включает пользователя в радиоканал.
   *
   * @param {object} peer
   * @param {string} channelId
   * @returns {Promise<void>}
   */
  async join(peer, channelId) {
    const channel = this.#channel(channelId);

    if (peer.radioChannelId !== null) {
      throw new AppError('Сначала покиньте текущий радиоканал.', {
        code: 'radio_already_joined',
        statusCode: 409,
        expose: true,
      });
    }

    await this.#assertAccess(peer, channel);

    let members = this.members.get(channelId);

    if (!members) {
      members = new Set();
      this.members.set(channelId, members);
    }

    members.add(peer.userId);
    peer.radioChannelId = channelId;

    this.logger.info({ userId: peer.userId, channelId }, 'Пользователь вошёл в радиоканал');

    // Если в канале уже идёт передача, новый участник должен слышать говорящего
    // сразу, а не после следующего нажатия PTT.
    const speaker = this.speakers.get(channelId);

    if (speaker && speaker.userId !== peer.userId) {
      await this.#createConsumerForMember(peer, channelId, speaker.userId);
    }

    this.onStateChanged?.();
  }

  /**
   * @param {object} peer
   * @param {string} channelId
   * @returns {Promise<void>}
   */
  async leave(peer, channelId) {
    if (peer.radioChannelId !== channelId) {
      return;
    }

    if (this.speakers.get(channelId)?.userId === peer.userId) {
      await this.stopTransmission(peer, channelId, 'left_channel');
    }

    this.members.get(channelId)?.delete(peer.userId);
    peer.radioChannelId = null;

    // Пользователь больше не должен слышать канал: закрываем его входящие
    // радиопотоки, не дожидаясь завершения текущей передачи.
    for (const closed of this.voiceManager.closeConsumersBySource(peer, AudioSource.RADIO)) {
      this.onConsumerClosed?.({
        userId: closed.peerUserId,
        message: {
          consumerId: closed.consumerId,
          source: AudioSource.RADIO,
          channelId,
        },
      });
    }

    this.logger.info({ userId: peer.userId, channelId }, 'Пользователь покинул радиоканал');
    this.onStateChanged?.();
  }

  /**
   * Начинает передачу в канале. Требуется Producer с источником radio.
   *
   * @param {object} peer
   * @param {string} channelId
   * @returns {Promise<void>}
   */
  async startTransmission(peer, channelId) {
    const channel = this.#channel(channelId);

    if (peer.radioChannelId !== channelId) {
      throw new AppError('Сначала войдите в радиоканал.', {
        code: 'radio_not_joined',
        statusCode: 409,
        expose: true,
      });
    }

    if (peer.muted) {
      throw new AppError('Микрофон выключен.', {
        code: 'microphone_muted',
        statusCode: 409,
        expose: true,
      });
    }

    const current = this.speakers.get(channelId);

    if (current && current.userId !== peer.userId) {
      throw new AppError('Канал занят: говорит другой участник.', {
        code: 'radio_channel_busy',
        statusCode: 409,
        expose: true,
      });
    }

    if (current && current.userId === peer.userId) {
      return;
    }

    await this.#assertAccess(peer, channel);

    // Проверка ролей асинхронна: пока она выполнялась, канал мог занять
    // другой участник, а пользователь — выйти из канала.
    if (peer.radioChannelId !== channelId) {
      throw new AppError('Сначала войдите в радиоканал.', {
        code: 'radio_not_joined',
        statusCode: 409,
        expose: true,
      });
    }

    const fresh = this.speakers.get(channelId);

    if (fresh && fresh.userId !== peer.userId) {
      throw new AppError('Канал занят: говорит другой участник.', {
        code: 'radio_channel_busy',
        statusCode: 409,
        expose: true,
      });
    }

    if (fresh && fresh.userId === peer.userId) {
      return;
    }

    const producer = this.voiceManager.getProducer(peer, AudioSource.RADIO);

    if (producer === null) {
      throw new AppError(
        'Аудиопоток радио не создан. Переподключитесь к голосовому серверу.',
        { code: 'radio_producer_missing', statusCode: 409, expose: true },
      );
    }

    await producer.resume();

    const timer = setTimeout(() => {
      void this.stopTransmission(peer, channelId, 'timeout');
    }, this.maxTransmissionMs);

    timer.unref();

    this.speakers.set(channelId, { userId: peer.userId, timer });
    this.onTransmissionChanged?.({
      channelId,
      speakerUserId: peer.userId,
      speakerName: this.#displayName(peer.userId),
      active: true,
    });

    await this.#createConsumersForChannel(peer, channelId);

    this.logger.info({ userId: peer.userId, channelId }, 'Начата радиопередача');
    this.onStateChanged?.();
  }

  /**
   * Создаёт Consumers радиопотока у всех участников канала, кроме говорящего.
   *
   * @param {object} speakerPeer
   * @param {string} channelId
   * @returns {Promise<void>}
   */
  async #createConsumersForChannel(speakerPeer, channelId) {
    const members = this.members.get(channelId);

    if (!members) {
      return;
    }

    for (const userId of members) {
      if (userId === speakerPeer.userId) {
        continue;
      }

      const member = this.voiceManager.getPeer(userId);

      if (member === null) {
        continue;
      }

      await this.#createConsumerForMember(member, channelId, speakerPeer.userId);
    }
  }

  /**
   * Создаёт входящий радиопоток одному участнику канала.
   *
   * @param {object} member Получатель.
   * @param {string} channelId
   * @param {string} speakerUserId
   * @returns {Promise<boolean>} true, если Consumer создан.
   */
  async #createConsumerForMember(member, channelId, speakerUserId) {
    if (member.radioChannelId !== channelId) {
      return false;
    }

    const speakerPeer = this.voiceManager.getPeer(speakerUserId);

    if (speakerPeer === null || member.recvTransport === null) {
      return false;
    }

    const producer = this.voiceManager.getProducer(speakerPeer, AudioSource.RADIO);

    if (producer === null) {
      return false;
    }

    try {
      const result = await this.voiceManager.createConsumer(member, producer, {
        source: AudioSource.RADIO,
      });

      if (!result.created) {
        return false;
      }

      this.onConsumerCreated?.({
        userId: member.userId,
        message: {
          consumerId: result.consumer.id,
          producerId: producer.id,
          kind: result.consumer.kind,
          rtpParameters: result.consumer.rtpParameters,
          source: AudioSource.RADIO,
          channelId,
          peer: {
            userId: speakerPeer.userId,
            name: speakerPeer.discordUsername,
          },
        },
      });

      return true;
    } catch (err) {
      this.logger.warn(
        { err, userId: member.userId, channelId },
        'Не удалось создать радиопоток для участника',
      );

      return false;
    }
  }

  /**
   * Завершает передачу.
   *
   * @param {object} peer
   * @param {string} [channelId]
   * @param {string} [reason]
   * @returns {Promise<void>}
   */
  async stopTransmission(peer, channelId = peer.radioChannelId, reason = 'stopped') {
    if (channelId === null || channelId === undefined) {
      return;
    }

    const speaker = this.speakers.get(channelId);

    if (!speaker || speaker.userId !== peer.userId) {
      return;
    }

    if (speaker.timer !== null) {
      clearTimeout(speaker.timer);
    }

    this.speakers.delete(channelId);

    const producer = this.voiceManager.getProducer(peer, AudioSource.RADIO);

    if (producer !== null) {
      try {
        await producer.pause();
      } catch (err) {
        // Producer мог быть закрыт вместе с транспортом.
        this.logger.warn({ err, userId: peer.userId, channelId }, 'Не удалось поставить радиопоток на паузу');
      }

      for (const closed of this.voiceManager.closeConsumersOfProducer(producer.id)) {
        this.onConsumerClosed?.({
          userId: closed.peerUserId,
          message: {
            consumerId: closed.consumerId,
            source: AudioSource.RADIO,
            channelId,
          },
        });
      }
    }

    this.onTransmissionChanged?.({
      channelId,
      speakerUserId: peer.userId,
      speakerName: this.#displayName(peer.userId),
      active: false,
      reason,
    });

    this.logger.info({ userId: peer.userId, channelId, reason }, 'Радиопередача завершена');
    this.onStateChanged?.();
  }

  /**
   * Реакция на пересоздание WebRTC-транспорта пользователя.
   *
   * Старые Producers и Consumers закрываются вместе с транспортом, поэтому
   * состояние передачи и входящие радиопотоки нужно привести в порядок.
   *
   * @param {object} peer
   * @param {'send'|'recv'} direction
   * @returns {Promise<void>}
   */
  async handleTransportReset(peer, direction) {
    const channelId = peer.radioChannelId;

    if (channelId === null) {
      return;
    }

    if (this.speakers.get(channelId)?.userId === peer.userId) {
      await this.stopTransmission(peer, channelId, 'transport_reset');
    }

    // Новый recv-транспорт не содержит прежних Consumers. Если в канале
    // кто-то говорит, восстанавливаем входящий поток сразу.
    if (direction === 'recv') {
      const speaker = this.speakers.get(channelId);

      if (speaker && speaker.userId !== peer.userId) {
        await this.#createConsumerForMember(peer, channelId, speaker.userId);
      }
    }
  }

  /**
   * Полная очистка при отключении пользователя.
   *
   * @param {object} peer
   * @returns {Promise<void>}
   */
  async handlePeerRemoved(peer) {
    const channelId = peer.radioChannelId;

    if (channelId === null) {
      return;
    }

    if (this.speakers.get(channelId)?.userId === peer.userId) {
      await this.stopTransmission(peer, channelId, 'disconnected');
    }

    this.members.get(channelId)?.delete(peer.userId);
    peer.radioChannelId = null;
    this.onStateChanged?.();
  }

  /**
   * Состояние каналов для клиента.
   *
   * @param {object} peer
   * @returns {object}
   */
  getStateFor(peer) {
    return {
      enabled: this.isEnabled(),
      channels: this.listChannelsFor(peer),
    };
  }

  /** @returns {object} */
  getStatus() {
    const speakers = {};

    for (const [channelId, speaker] of this.speakers) {
      speakers[channelId] = speaker.userId;
    }

    return {
      enabled: this.isEnabled(),
      channels: this.channels.size,
      members: this.members.size,
      speakers,
    };
  }
}
