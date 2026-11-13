import { EventEmitter } from 'node:events';

/** События изменения состава и данных игроков. */
export const GameStateEvent = Object.freeze({
  PLAYER_JOINED: 'player.joined',
  PLAYER_LEFT: 'player.left',
  PLAYER_UPDATED: 'player.updated',
});

function samePosition(a, b) {
  if (a === null || b === null) {
    return a === b;
  }

  return a.x === b.x && a.z === b.z;
}

function playerChanged(prev, next) {
  return (
    prev.name !== next.name ||
    prev.team !== next.team ||
    prev.callsign !== next.callsign ||
    prev.permission !== next.permission ||
    prev.wantedStars !== next.wantedStars ||
    prev.postalCode !== next.postalCode ||
    prev.streetName !== next.streetName ||
    !samePosition(prev.position, next.position)
  );
}

/**
 * Общее состояние игрового сервера в памяти процесса.
 *
 * Координаты и другие оперативные данные в PostgreSQL не записываются.
 * Ошибка опроса не очищает список игроков: состояние только помечается
 * устаревшим (stale), а потребители обязаны проверять этот признак.
 */
export class GameState extends EventEmitter {
  /**
   * @param {{staleAfterMs: number, now?: () => number, logger?: import('pino').Logger}} options
   */
  constructor({ staleAfterMs, now = Date.now, logger = null }) {
    super();
    this.staleAfterMs = staleAfterMs;
    this.now = now;
    this.logger = logger?.child ? logger.child({ module: 'game-state' }) : logger;
    this.players = new Map();
    this.online = null;
    this.currentPlayers = null;
    this.maxPlayers = null;
    this.lastSuccessAt = null;
    this.lastError = null;
    this.consecutiveErrors = 0;
  }

  /**
   * Безопасно уведомляет подписчиков: ошибка подписчика не ломает обновление.
   *
   * @param {string} event
   * @param {unknown} payload
   */
  safeEmit(event, payload) {
    try {
      this.emit(event, payload);
    } catch (err) {
      this.logger?.error({ err, event }, 'Ошибка обработчика события Game State');
    }
  }

  /**
   * Применяет успешный снимок PRC API и вычисляет изменения.
   *
   * @param {{online: boolean, players: object[], fetchedAt?: number, currentPlayers?: number, maxPlayers?: number|null}} snapshot
   * @returns {{joined: object[], left: object[], updated: object[]}}
   */
  applySnapshot(snapshot) {
    if (!snapshot || typeof snapshot.online !== 'boolean' || !Array.isArray(snapshot.players)) {
      throw new TypeError('Некорректный снимок игрового сервера.');
    }

    const at = Number.isFinite(snapshot.fetchedAt) ? snapshot.fetchedAt : this.now();

    // Устаревший снимок не должен перезаписать более свежий.
    if (this.lastSuccessAt !== null && at < this.lastSuccessAt) {
      return { joined: [], left: [], updated: [] };
    }

    const next = new Map();
    const joined = [];
    const updated = [];

    for (const player of snapshot.players) {
      const prev = this.players.get(player.robloxId);
      const record = Object.freeze({
        ...player,
        firstSeenAt: prev ? prev.firstSeenAt : at,
        updatedAt: at,
      });

      next.set(record.robloxId, record);

      if (!prev) {
        joined.push(record);
      } else if (playerChanged(prev, record)) {
        updated.push(record);
      }
    }

    const left = [];

    for (const [robloxId, prev] of this.players) {
      if (!next.has(robloxId)) {
        left.push(prev);
      }
    }

    this.players = next;
    this.online = snapshot.online;
    this.currentPlayers = Number.isSafeInteger(snapshot.currentPlayers) ? snapshot.currentPlayers : next.size;
    this.maxPlayers = Number.isSafeInteger(snapshot.maxPlayers) ? snapshot.maxPlayers : null;
    this.lastSuccessAt = at;
    this.lastError = null;
    this.consecutiveErrors = 0;

    for (const record of left) {
      this.safeEmit(GameStateEvent.PLAYER_LEFT, record);
    }

    for (const record of joined) {
      this.safeEmit(GameStateEvent.PLAYER_JOINED, record);
    }

    for (const record of updated) {
      this.safeEmit(GameStateEvent.PLAYER_UPDATED, record);
    }

    return { joined, left, updated };
  }

  /**
   * Фиксирует ошибку опроса. Список игроков сохраняется без изменений.
   *
   * @param {{code: string, at?: number}} error
   */
  markError({ code, at = this.now() }) {
    this.lastError = Object.freeze({ code: typeof code === 'string' ? code : 'unknown_error', at });
    this.consecutiveErrors += 1;
  }

  /** @returns {number|null} Возраст последнего успешного снимка в миллисекундах. */
  getSnapshotAgeMs() {
    return this.lastSuccessAt === null ? null : Math.max(0, this.now() - this.lastSuccessAt);
  }

  /** @returns {boolean} true, если успешного снимка нет или он старше staleAfterMs. */
  isStale() {
    const age = this.getSnapshotAgeMs();
    return age === null || age > this.staleAfterMs;
  }

  /**
   * @param {string} robloxId
   * @returns {object|null} Данные игрока с признаком stale.
   */
  getPlayer(robloxId) {
    const player = this.players.get(robloxId);
    return player ? { ...player, stale: this.isStale() } : null;
  }

  /** @returns {object[]} Все игроки с признаком stale. */
  listPlayers() {
    const stale = this.isStale();
    return [...this.players.values()].map((player) => ({ ...player, stale }));
  }

  /** Краткое состояние без персональных данных для мониторинга. */
  getStatus() {
    return {
      online: this.online,
      playerCount: this.players.size,
      currentPlayers: this.currentPlayers,
      maxPlayers: this.maxPlayers,
      lastSuccessAt: this.lastSuccessAt === null ? null : new Date(this.lastSuccessAt).toISOString(),
      snapshotAgeMs: this.getSnapshotAgeMs(),
      stale: this.isStale(),
      consecutiveErrors: this.consecutiveErrors,
      lastErrorCode: this.lastError?.code ?? null,
    };
  }
}
