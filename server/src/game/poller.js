/**
 * Единственный опросчик PRC API для одного игрового сервера.
 *
 * Гарантии:
 * - одновременно выполняется не больше одного запроса (следующий цикл
 *   планируется только после завершения текущего, без setInterval);
 * - пропущенные циклы не накапливаются;
 * - интервал отсчитывается от начала запроса (цель — GAME_POLL_INTERVAL_MS);
 * - ошибка не превращается в пустой снимок, а только помечает состояние;
 * - при ошибках применяется экспоненциальный backoff;
 * - заголовки лимитов и Retry-After соблюдаются полностью, даже если это
 *   дольше GAME_POLL_MAX_BACKOFF_MS;
 * - при повторяющемся отказе в ключе или отсутствии ключа опрос
 *   останавливается, чтобы PRC не заблокировал ключ.
 */
export class GamePoller {
  /**
   * @param {{
   *   prcClient: {fetchServerSnapshot: () => Promise<object>},
   *   gameState: import('./state.js').GameState,
   *   logger: import('pino').Logger,
   *   intervalMs: number,
   *   maxBackoffMs: number,
   *   maxConsecutiveUnauthorized?: number,
   *   now?: () => number,
   *   setTimer?: typeof setTimeout,
   *   clearTimer?: typeof clearTimeout,
   * }} options
   */
  constructor({
    prcClient,
    gameState,
    logger,
    intervalMs,
    maxBackoffMs,
    maxConsecutiveUnauthorized = 3,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    this.prcClient = prcClient;
    this.gameState = gameState;
    this.logger = logger.child({ module: 'game-poller' });
    this.intervalMs = intervalMs;
    this.maxBackoffMs = maxBackoffMs;
    this.maxConsecutiveUnauthorized = maxConsecutiveUnauthorized;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;

    this.running = false;
    this.halted = false;
    this.haltReason = null;
    this.timer = null;
    this.inFlight = null;
    this.consecutiveFailures = 0;
    this.consecutiveUnauthorized = 0;
    this.cycles = 0;
  }

  /**
   * Запускает опрос. Повторный вызов не создаёт второй цикл.
   *
   * @returns {boolean} true, если опрос был запущен этим вызовом.
   */
  start() {
    if (this.running) {
      return false;
    }

    this.running = true;
    this.halted = false;
    this.haltReason = null;
    this.consecutiveFailures = 0;
    this.consecutiveUnauthorized = 0;
    this.logger.info({ intervalMs: this.intervalMs }, 'Опрос PRC API запущен');
    this.schedule(0);
    return true;
  }

  /**
   * Останавливает опрос и дожидается завершения текущего запроса.
   *
   * @returns {Promise<void>}
   */
  async stop() {
    const wasRunning = this.running;
    this.running = false;

    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }

    if (this.inFlight) {
      await this.inFlight.catch(() => {});
    }

    if (wasRunning) {
      this.logger.info('Опрос PRC API остановлен');
    }
  }

  /**
   * Планирует следующий цикл. Одновременно существует не больше одного таймера.
   *
   * @param {number} delayMs
   */
  schedule(delayMs) {
    if (!this.running || this.timer !== null) {
      return;
    }

    this.timer = this.setTimer(() => {
      this.timer = null;
      this.inFlight = this.runCycle().finally(() => {
        this.inFlight = null;
      });
    }, Math.max(0, Math.ceil(delayMs)));

    if (typeof this.timer?.unref === 'function') {
      this.timer.unref();
    }
  }

  /**
   * Выполняет один цикл опроса и планирует следующий.
   *
   * @returns {Promise<void>}
   */
  async runCycle() {
    if (!this.running) {
      return;
    }

    const startedAt = this.now();
    this.cycles += 1;
    let delayMs;

    try {
      const snapshot = await this.prcClient.fetchServerSnapshot();

      // Остановка во время запроса: результат не применяется.
      if (!this.running) {
        return;
      }

      this.gameState.applySnapshot(snapshot);

      if (this.consecutiveFailures > 0) {
        this.logger.info(
          { failures: this.consecutiveFailures },
          'Опрос PRC API восстановлен после ошибок',
        );
      }

      this.consecutiveFailures = 0;
      this.consecutiveUnauthorized = 0;
      delayMs = this.computeSuccessDelay(snapshot.rateLimit, startedAt);
    } catch (err) {
      if (!this.running) {
        return;
      }

      const code = typeof err?.code === 'string' ? err.code : 'prc_unknown_error';
      this.consecutiveFailures += 1;
      this.gameState.markError({ code });

      if (code === 'prc_missing_key') {
        this.halt(code);
        return;
      }

      if (code === 'prc_unauthorized') {
        this.consecutiveUnauthorized += 1;

        if (this.consecutiveUnauthorized >= this.maxConsecutiveUnauthorized) {
          this.halt(code);
          return;
        }
      } else {
        this.consecutiveUnauthorized = 0;
      }

      delayMs = this.computeErrorDelay(err);
      this.logFailure(code, err?.status ?? null, delayMs);
    }

    this.schedule(delayMs);
  }

  /**
   * Задержка после успешного запроса с учётом заголовков лимитов.
   *
   * @param {{remaining: number|null, resetAt: number|null}|null|undefined} rateLimit
   * @param {number} startedAt
   * @returns {number}
   */
  computeSuccessDelay(rateLimit, startedAt) {
    const now = this.now();
    let delayMs = Math.max(0, this.intervalMs - (now - startedAt));

    // Лимит исчерпан: ждём сброса окна, а не делаем заведомо отклоняемый запрос.
    if (rateLimit && rateLimit.remaining !== null && rateLimit.remaining <= 0 && rateLimit.resetAt !== null) {
      delayMs = Math.max(delayMs, rateLimit.resetAt - now);
    }

    return delayMs;
  }

  /**
   * Задержка после ошибки: экспоненциальный backoff, но не меньше Retry-After.
   *
   * @param {{retryAfterMs?: number|null, rateLimit?: object|null}} err
   * @returns {number}
   */
  computeErrorDelay(err) {
    const exponent = Math.min(this.consecutiveFailures, 16);
    let delayMs = Math.min(this.intervalMs * 2 ** exponent, this.maxBackoffMs);

    if (Number.isFinite(err?.retryAfterMs) && err.retryAfterMs > 0) {
      delayMs = Math.max(delayMs, err.retryAfterMs);
    }

    const rateLimit = err?.rateLimit;
    const now = this.now();

    if (rateLimit && rateLimit.remaining !== null && rateLimit.remaining <= 0 && rateLimit.resetAt !== null) {
      delayMs = Math.max(delayMs, rateLimit.resetAt - now);
    }

    return delayMs;
  }

  /**
   * Останавливает опрос без автоматического перезапуска.
   *
   * @param {string} reason
   */
  halt(reason) {
    this.running = false;
    this.halted = true;
    this.haltReason = reason;
    this.logger.error(
      { code: reason },
      'Опрос PRC API остановлен: ключ отсутствует или отклонён. Проверьте PRC_SERVER_KEY и перезапустите сервер.',
    );
  }

  /**
   * Логирует ошибку без спама: первая ошибка и каждая степень двойки — warn, остальные — debug.
   */
  logFailure(code, status, delayMs) {
    const failures = this.consecutiveFailures;
    const level = (failures & (failures - 1)) === 0 ? 'warn' : 'debug';

    this.logger[level](
      { code, status, failures, nextAttemptInMs: delayMs },
      'Ошибка опроса PRC API',
    );
  }

  /** Состояние опросчика для мониторинга. */
  getStatus() {
    return {
      running: this.running,
      halted: this.halted,
      haltReason: this.haltReason,
      requestInFlight: this.inFlight !== null,
      consecutiveFailures: this.consecutiveFailures,
      cycles: this.cycles,
      intervalMs: this.intervalMs,
    };
  }
}
