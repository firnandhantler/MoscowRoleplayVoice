/**
 * Простой rate limiter с фиксированным окном в памяти процесса.
 * Подходит для одного экземпляра сервера (модульный монолит).
 * Число отслеживаемых ключей ограничено, чтобы атака с множества адресов
 * не исчерпала память.
 */
export class FixedWindowRateLimiter {
  /**
   * @param {{maxRequests: number, windowMs: number, maxKeys?: number, now?: () => number}} options
   */
  constructor({ maxRequests, windowMs, maxKeys = 10000, now = Date.now }) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.now = now;
    this.buckets = new Map();
    this.lastSweepAt = now();
  }

  /**
   * Удаляет истёкшие окна. Выполняется не чаще одного раза за окно.
   *
   * @param {number} now
   */
  sweep(now) {
    if (now - this.lastSweepAt < this.windowMs && this.buckets.size < this.maxKeys) {
      return;
    }

    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.resetAt) {
        this.buckets.delete(key);
      }
    }

    this.lastSweepAt = now;
  }

  /**
   * Учитывает запрос и сообщает, разрешён ли он.
   *
   * @param {string} key
   * @returns {{allowed: boolean, remaining: number, retryAfterMs: number}}
   */
  consume(key) {
    const now = this.now();
    this.sweep(now);

    let bucket = this.buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      // При переполнении таблицы новые ключи отклоняются, а не вытесняют существующие.
      if (!bucket && this.buckets.size >= this.maxKeys) {
        return { allowed: false, remaining: 0, retryAfterMs: this.windowMs };
      }

      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, bucket);
    }

    bucket.count += 1;

    if (bucket.count > this.maxRequests) {
      return { allowed: false, remaining: 0, retryAfterMs: bucket.resetAt - now };
    }

    return {
      allowed: true,
      remaining: this.maxRequests - bucket.count,
      retryAfterMs: 0,
    };
  }

  /** Очищает все окна (используется при остановке и в тестах). */
  clear() {
    this.buckets.clear();
  }
}
