import { generateToken } from '../utils/crypto.js';

/**
 * Хранилище состояния OAuth2 (параметр `state` и PKCE verifier) в памяти процесса.
 *
 * Зачем это нужно:
 * - `state` связывает ответ Discord с конкретным браузером и защищает от CSRF;
 * - PKCE verifier нельзя передавать клиенту, поэтому он хранится только на сервере;
 * - каждая запись одноразовая: повторный callback с тем же `state` отклоняется.
 *
 * Записи живут считанные минуты, поэтому база данных не нужна.
 * Перезапуск сервера обнуляет хранилище — это штатное поведение: пользователь начинает вход заново.
 */
export class OAuthStateStore {
  /**
   * @param {{ttlMs?: number, maxEntries?: number, now?: () => number}} options
   */
  constructor({ ttlMs = 10 * 60 * 1000, maxEntries = 1000, now = Date.now } = {}) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new TypeError('ttlMs должен быть положительным числом.');
    }

    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  /**
   * Создаёт новую запись и возвращает `state` для URL авторизации.
   *
   * @param {{codeVerifier: string}} params
   * @returns {{state: string, expiresAt: number}}
   */
  issue({ codeVerifier }) {
    if (typeof codeVerifier !== 'string' || codeVerifier.length < 43 || codeVerifier.length > 128) {
      throw new TypeError('Некорректный code_verifier.');
    }

    const now = this.now();
    this.sweep(now);

    // Хранилище ограничено: при переполнении сначала удаляются истёкшие записи,
    // затем самые старые, чтобы память не росла при потоке запросов.
    while (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
    }

    // 32 случайных байта дают 43 символа base64url — достаточно для state.
    const state = generateToken(32);
    const expiresAt = now + this.ttlMs;

    this.entries.set(state, { codeVerifier, expiresAt });

    return { state, expiresAt };
  }

  /**
   * Забирает запись по `state`. Повторный вызов с тем же значением вернёт null.
   *
   * @param {unknown} state
   * @returns {{codeVerifier: string, expiresAt: number}|null}
   */
  consume(state) {
    if (typeof state !== 'string' || state.length === 0 || state.length > 512) {
      return null;
    }

    const entry = this.entries.get(state);

    if (!entry) {
      return null;
    }

    this.entries.delete(state);

    if (entry.expiresAt <= this.now()) {
      return null;
    }

    return entry;
  }

  /**
   * Удаляет истёкшие записи. Вызывается при выдаче нового state.
   *
   * @param {number} now
   */
  sweep(now = this.now()) {
    for (const [state, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(state);
      }
    }
  }

  /** @returns {number} Количество ожидающих входов. */
  get size() {
    return this.entries.size;
  }

  /** Очищает хранилище (используется при остановке сервера и в тестах). */
  clear() {
    this.entries.clear();
  }
}
