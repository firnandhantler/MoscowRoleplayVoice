import { AudioSource } from '../../shared/protocol.js';

/**
 * Proximity Engine — серверная логика «кто кого слышит по расстоянию».
 *
 * Принципы:
 * - геометрия считается только на сервере по координатам PRC API; клиент не участвует;
 * - используется пространственная сетка (spatial grid) со стороной ячейки,
 *   равной дистанции слышимости: проверяются только соседние 3×3 ячейки;
 * - сравнение расстояний выполняется по квадрату расстояния, без извлечения корня;
 * - гистерезис не даёт соединению «дребезжать» на границе дистанции:
 *   связь создаётся на maxDistance, а разрывается только дальше maxDistance + hysteresis;
 * - обновления дифференциальные: создаются и закрываются только изменившиеся Consumers,
 *   а не весь граф при каждом цикле.
 */
export class ProximityEngine {
  /**
   * @param {{
   *   gameState: import('../game/state.js').GameState,
   *   voiceManager: import('../voice/manager.js').VoiceManager,
   *   logger: import('pino').Logger,
   *   maxDistance: number,
   *   hysteresis: number,
   *   maxNeighbors: number,
   *   intervalMs: number,
   *   onConsumerCreated?: (event: {userId: string, message: object}) => void,
   *   onConsumerClosed?: (event: {userId: string, message: object}) => void,
   *   onNearbyChanged?: (event: {userId: string, nearbyCount: number}) => void,
   * }} options
   */
  constructor({
    gameState,
    voiceManager,
    logger,
    maxDistance,
    hysteresis,
    maxNeighbors,
    intervalMs,
    onConsumerCreated = null,
    onConsumerClosed = null,
    onNearbyChanged = null,
  }) {
    if (!(maxDistance > 0)) {
      throw new TypeError('maxDistance должна быть положительной.');
    }

    this.gameState = gameState;
    this.voiceManager = voiceManager;
    this.logger = logger.child({ module: 'proximity' });
    this.maxDistance = maxDistance;
    this.hysteresis = Math.max(0, hysteresis);
    this.maxNeighbors = Math.max(1, maxNeighbors);
    this.intervalMs = intervalMs;

    this.linkDistanceSq = maxDistance * maxDistance;
    this.keepDistanceSq = (maxDistance + this.hysteresis) * (maxDistance + this.hysteresis);
    this.cellSize = Math.max(1, maxDistance);

    /** @type {Map<string, {a: string, b: string}>} */
    this.edges = new Map();
    /** @type {Map<string, number>} */
    this.nearbyCounts = new Map();

    this.onConsumerCreated = onConsumerCreated;
    this.onConsumerClosed = onConsumerClosed;
    this.onNearbyChanged = onNearbyChanged;

    this.timer = null;
    this.running = false;
    this.reconciling = false;
    this.pending = false;
    this.cycles = 0;
    this.lastCycleAt = null;
  }

  /** Запускает периодический пересчёт графа связей. */
  start() {
    if (this.running) {
      return false;
    }

    this.running = true;
    this.timer = setInterval(() => {
      void this.reconcile();
    }, this.intervalMs);

    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }

    this.logger.info(
      {
        maxDistance: this.maxDistance,
        hysteresis: this.hysteresis,
        intervalMs: this.intervalMs,
      },
      'Proximity Engine запущен',
    );

    return true;
  }

  /** Останавливает пересчёт и разрывает все связи. */
  stop() {
    this.running = false;

    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.closeAllEdges();
    this.logger.info('Proximity Engine остановлен');
  }

  /**
   * Просит выполнить пересчёт вне очереди (например, после нового Producer).
   * Защита от лавины: одновременно выполняется не более одного пересчёта.
   */
  requestReconcile() {
    if (!this.running || this.reconciling) {
      this.pending = true;
      return;
    }

    void this.reconcile();
  }

  /**
   * Один цикл: построение желаемого графа и применение разницы.
   *
   * @returns {Promise<void>}
   */
  async reconcile() {
    if (this.reconciling) {
      this.pending = true;
      return;
    }

    this.reconciling = true;

    try {
      this.#reconcileSync();
    } catch (err) {
      this.logger.error({ err }, 'Ошибка пересчёта proximity');
    } finally {
      this.reconciling = false;
      this.cycles += 1;
      this.lastCycleAt = Date.now();

      if (this.pending && this.running) {
        this.pending = false;
        void this.reconcile();
      }
    }
  }

  /**
   * Строит список участников proximity: пользователь должен иметь активный
   * Producer и находиться в актуальном состоянии игры.
   *
   * @returns {{peer: object, x: number, z: number}[]}
   */
  #collectNodes() {
    const nodes = [];

    for (const peer of this.voiceManager.listPeers()) {
      if (peer.robloxId === null || !peer.producers.has(AudioSource.PROXIMITY)) {
        continue;
      }

      const player = this.gameState.getPlayer(peer.robloxId);

      if (player === null || player.position === null) {
        continue;
      }

      nodes.push({ peer, x: player.position.x, z: player.position.z });
    }

    return nodes;
  }

  /**
   * @param {{peer: object, x: number, z: number}[]} nodes
   * @returns {Map<string, number>} Пары пользователей и квадрат расстояния между ними.
   */
  #buildCandidatePairs(nodes) {
    const grid = new Map();

    for (const node of nodes) {
      const cellX = Math.floor(node.x / this.cellSize);
      const cellZ = Math.floor(node.z / this.cellSize);
      const key = `${cellX}:${cellZ}`;
      let bucket = grid.get(key);

      if (!bucket) {
        bucket = [];
        grid.set(key, bucket);
      }

      bucket.push(node);
    }

    const pairs = new Map();

    for (const node of nodes) {
      const cellX = Math.floor(node.x / this.cellSize);
      const cellZ = Math.floor(node.z / this.cellSize);

      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const bucket = grid.get(`${cellX + dx}:${cellZ + dz}`);

          if (!bucket) {
            continue;
          }

          for (const other of bucket) {
            if (other.peer.userId === node.peer.userId) {
              continue;
            }

            const deltaX = node.x - other.x;
            const deltaZ = node.z - other.z;
            const distanceSq = deltaX * deltaX + deltaZ * deltaZ;

            // Берём максимальную дистанцию: связь симметрична, гистерезис применяется
            // одинаково для пары независимо от того, с чьей стороны считали.
            const key = pairKey(node.peer.userId, other.peer.userId);

            if (distanceSq > this.keepDistanceSq) {
              continue;
            }

            const previous = pairs.get(key);

            if (previous === undefined || distanceSq > previous) {
              pairs.set(key, distanceSq);
            }
          }
        }
      }
    }

    return pairs;
  }

  /** Синхронная часть пересчёта (создание Consumers — асинхронное, но не блокирует цикл). */
  #reconcileSync() {
    // Устаревшие данные PRC: не рискуем держать открытыми голосовые связи,
    // которые могли остаться от игроков, уже покинувших сервер.
    if (this.gameState.isStale()) {
      this.logger.debug('Снимок игрового состояния устарел, proximity-связи закрываются');
      this.closeAllEdges();

      for (const userId of [...this.nearbyCounts.keys()]) {
        this.nearbyCounts.delete(userId);
        this.onNearbyChanged?.({ userId, nearbyCount: 0 });
      }

      return;
    }

    const nodes = this.#collectNodes();
    const nodesById = new Map(nodes.map((node) => [node.peer.userId, node]));

    // Удаляем связи, у которых пропал участник (вышел из игры или отключился Producer).
    for (const [key, edge] of [...this.edges]) {
      if (!nodesById.has(edge.a) || !nodesById.has(edge.b)) {
        this.#closeEdge(key, edge);
      }
    }

    const candidates = this.#buildCandidatePairs(nodes);

    // Желаемый граф: новые связи — в пределах maxDistance,
    // существующие — пока не превышен порог с гистерезисом.
    const desired = new Map();

    for (const [key, distanceSq] of candidates) {
      const edge = this.edges.get(key);
      const limit = edge ? this.keepDistanceSq : this.linkDistanceSq;

      if (distanceSq <= limit) {
        desired.set(key, distanceSq);
      }
    }

    // Ограничение числа соседей: ближайшие связи имеют приоритет.
    const degree = new Map();
    const accepted = [];

    for (const [key, distanceSq] of [...desired.entries()].sort((a, b) => a[1] - b[1])) {
      const [a, b] = splitKey(key);
      const degreeA = degree.get(a) ?? 0;
      const degreeB = degree.get(b) ?? 0;

      if (degreeA >= this.maxNeighbors || degreeB >= this.maxNeighbors) {
        continue;
      }

      degree.set(a, degreeA + 1);
      degree.set(b, degreeB + 1);
      accepted.push([key, a, b]);
    }

    const acceptedKeys = new Set(accepted.map(([key]) => key));

    // Закрываем связи, которых больше нет в желаемом графе.
    for (const [key, edge] of [...this.edges]) {
      if (!acceptedKeys.has(key)) {
        this.#closeEdge(key, edge);
      }
    }

    // Создаём новые связи.
    for (const [key, a, b] of accepted) {
      if (this.edges.has(key)) {
        continue;
      }

      this.#openEdge(key, a, b, nodesById);
    }

    this.#publishNearbyCounts(nodesById);
  }

  /**
   * Создаёт Consumers в обе стороны и запоминает связь.
   *
   * @param {string} key
   * @param {string} aUserId
   * @param {string} bUserId
   * @param {Map<string, object>} nodesById
   */
  #openEdge(key, aUserId, bUserId, nodesById) {
    const a = nodesById.get(aUserId);
    const b = nodesById.get(bUserId);

    if (!a || !b) {
      return;
    }

    const producerA = this.voiceManager.getProducer(a.peer, AudioSource.PROXIMITY);
    const producerB = this.voiceManager.getProducer(b.peer, AudioSource.PROXIMITY);

    if (producerA === null || producerB === null) {
      return;
    }

    // Регистрируем связь сразу, чтобы следующий цикл не создал её повторно.
    const edge = { a: aUserId, b: bUserId };

    this.edges.set(key, edge);

    const onFailure = (err) => {
      this.logger.warn({ err }, 'Не удалось создать proximity Consumer');

      // Закрываем связь, только если это всё ещё та же связь: она могла быть
      // уже пересоздана следующим циклом.
      if (this.edges.get(key) === edge) {
        this.#closeEdge(key, edge);
      }
    };

    this.#createConsumer(key, edge, a.peer, producerB, b.peer).catch(onFailure);
    this.#createConsumer(key, edge, b.peer, producerA, a.peer).catch(onFailure);
  }

  /**
   * @param {string} key
   * @param {{a: string, b: string}} edge
   * @param {object} consumerPeer
   * @param {import('mediasoup').types.Producer} producer
   * @param {object} producerPeer
   * @returns {Promise<void>}
   */
  async #createConsumer(key, edge, consumerPeer, producer, producerPeer) {
    const result = await this.voiceManager.createConsumer(consumerPeer, producer, {
      source: AudioSource.PROXIMITY,
    });

    if (!result.created) {
      return;
    }

    // Пока создавался Consumer, связь могли закрыть (устаревший снимок,
    // выход из игры или ошибка второй стороны). Не оставляем «осиротевший»
    // поток и не сообщаем о нём клиенту.
    if (this.edges.get(key) !== edge) {
      this.voiceManager.closeConsumer(consumerPeer, result.consumer.id);
      return;
    }

    this.onConsumerCreated?.({
      userId: consumerPeer.userId,
      message: {
        consumerId: result.consumer.id,
        producerId: producer.id,
        kind: result.consumer.kind,
        rtpParameters: result.consumer.rtpParameters,
        source: AudioSource.PROXIMITY,
        peer: { robloxId: producerPeer.robloxId },
      },
    });
  }

  /**
   * @param {string} key
   * @param {{a: string, b: string}} edge
   */
  #closeEdge(key, edge) {
    this.edges.delete(key);

    for (const [consumerId, userId, producerUserId] of this.#findConsumersOfEdge(edge)) {
      const consumerPeer = this.voiceManager.getPeer(userId);

      if (consumerPeer === null) {
        continue;
      }

      const meta = this.voiceManager.closeConsumer(consumerPeer, consumerId);

      if (meta !== null) {
        this.onConsumerClosed?.({
          userId,
          message: { consumerId, source: AudioSource.PROXIMITY, producerUserId },
        });
      }
    }
  }

  /**
   * Ищет Consumers обеих сторон связи.
   *
   * @param {{a: string, b: string}} edge
   * @returns {[string, string, string][]} [consumerId, consumerUserId, producerUserId]
   */
  #findConsumersOfEdge(edge) {
    const result = [];

    for (const [consumerUserId, producerUserId] of [
      [edge.a, edge.b],
      [edge.b, edge.a],
    ]) {
      const peer = this.voiceManager.getPeer(consumerUserId);

      if (peer === null) {
        continue;
      }

      for (const [consumerId, entry] of peer.consumers) {
        if (entry.source === AudioSource.PROXIMITY && entry.producerUserId === producerUserId) {
          result.push([consumerId, consumerUserId, producerUserId]);
        }
      }
    }

    return result;
  }

  /** Закрывает все связи (остановка сервера). */
  closeAllEdges() {
    for (const [key, edge] of [...this.edges]) {
      this.#closeEdge(key, edge);
    }
  }

  /**
   * Сообщает клиентам число слышимых соседей, если оно изменилось.
   *
   * @param {Map<string, object>} nodesById
   */
  #publishNearbyCounts(nodesById) {
    const counts = new Map();

    for (const { a, b } of this.edges.values()) {
      counts.set(a, (counts.get(a) ?? 0) + 1);
      counts.set(b, (counts.get(b) ?? 0) + 1);
    }

    for (const userId of nodesById.keys()) {
      const count = counts.get(userId) ?? 0;
      const previous = this.nearbyCounts.get(userId) ?? 0;

      if (count !== previous) {
        this.nearbyCounts.set(userId, count);
        this.onNearbyChanged?.({ userId, nearbyCount: count });
      }
    }

    for (const userId of [...this.nearbyCounts.keys()]) {
      if (!nodesById.has(userId)) {
        this.nearbyCounts.delete(userId);
      }
    }
  }

  /**
   * Полностью убирает связи пользователя при пересоздании его транспорта.
   *
   * @param {string} userId
   */
  resetPeer(userId) {
    for (const [key, edge] of [...this.edges]) {
      if (edge.a === userId || edge.b === userId) {
        this.#closeEdge(key, edge);
      }
    }

    this.nearbyCounts.delete(userId);
  }

  /**
   * Убирает пользователя из графа (например, при отключении).
   *
   * @param {string} userId
   */
  removeUser(userId) {
    for (const [key, edge] of [...this.edges]) {
      if (edge.a === userId || edge.b === userId) {
        this.edges.delete(key);
      }
    }

    this.nearbyCounts.delete(userId);
  }

  /** Состояние для health-check и отладки. */
  getStatus() {
    return {
      running: this.running,
      edges: this.edges.size,
      cycles: this.cycles,
      lastCycleAt: this.lastCycleAt === null ? null : new Date(this.lastCycleAt).toISOString(),
      maxDistance: this.maxDistance,
      hysteresis: this.hysteresis,
    };
  }
}

/**
 * Ключ неориентированной пары пользователей.
 *
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
export function pairKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * @param {string} key
 * @returns {[string, string]}
 */
export function splitKey(key) {
  const index = key.indexOf(':');
  return [key.slice(0, index), key.slice(index + 1)];
}
