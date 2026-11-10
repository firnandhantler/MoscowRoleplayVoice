/**
 * Менеджер корректного завершения работы.
 * Обработчики вызываются в порядке регистрации.
 */
export class GracefulShutdown {
  /**
   * @param {{logger: import('pino').Logger, timeoutMs?: number}} options
   */
  constructor({ logger, timeoutMs = 10000 }) {
    this.logger = logger.child({ module: 'shutdown' });
    this.timeoutMs = timeoutMs;
    this.handlers = [];
    this.started = false;
  }

  /**
   * Регистрирует обработчик остановки.
   *
   * @param {string} name
   * @param {() => Promise<void> | void} handler
   */
  register(name, handler) {
    if (this.started) {
      throw new Error('Нельзя регистрировать обработчик после начала завершения.');
    }

    this.handlers.push({ name, handler });
  }

  /**
   * Запускает корректное завершение. Повторные вызовы игнорируются.
   *
   * @param {string} reason
   * @param {number} exitCode
   * @returns {Promise<void>}
   */
  async run(reason, exitCode = 0) {
    if (this.started) {
      return;
    }

    this.started = true;
    this.logger.info({ reason }, 'Начинаю корректное завершение работы');

    const forceTimer = setTimeout(() => {
      this.logger.error(
        { timeoutMs: this.timeoutMs },
        'Превышено время корректного завершения, процесс будет остановлен принудительно',
      );
      process.exit(1);
    }, this.timeoutMs);

    forceTimer.unref();

    for (const { name, handler } of this.handlers) {
      const startedAt = Date.now();

      try {
        await handler();
        this.logger.info(
          { component: name, durationMs: Date.now() - startedAt },
          'Компонент остановлен',
        );
      } catch (err) {
        this.logger.error(
          { err, component: name },
          'Ошибка остановки компонента',
        );
        exitCode = 1;
      }
    }

    clearTimeout(forceTimer);
    this.logger.info({ reason }, 'Корректное завершение работы завершено');

    try {
      this.logger.flush();
    } catch {
      // Логгер уже мог быть закрыт — это не должно мешать остановке процесса.
    }

    process.exit(exitCode);
  }
}
