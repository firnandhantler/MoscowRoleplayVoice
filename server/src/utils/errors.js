/**
 * Базовая ошибка приложения с машиночитаемым кодом.
 * Сообщение ошибки не должно содержать секретов.
 */
export class AppError extends Error {
  /**
   * @param {string} message Сообщение на русском языке.
   * @param {{code?: string, statusCode?: number, cause?: unknown, expose?: boolean}} options
   */
  constructor(message, { code = 'internal_error', statusCode = 500, cause, expose = false } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.expose = expose;
  }
}

/**
 * Ограничивает время ожидания асинхронной операции.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {string} message
 * @returns {Promise<T>}
 */
export function withTimeout(
  promise,
  timeoutMs,
  message = 'Операция превысила допустимое время ожидания.',
) {
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new AppError(message, { code: 'timeout', statusCode: 503, expose: true }));
    }, timeoutMs);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Проверяет, что значение является обычным объектом.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
