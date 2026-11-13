import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Генерирует криптографически стойкий случайный токен в формате base64url.
 *
 * @param {number} bytes Количество случайных байт.
 * @returns {string}
 */
export function generateToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Возвращает SHA-256-хеш строки в hex.
 *
 * @param {string} value
 * @returns {string}
 */
export function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Создаёт пару PKCE (RFC 7636) с методом S256.
 *
 * @returns {{verifier: string, challenge: string, method: 'S256'}}
 */
export function createPkcePair() {
  // 32 байта дают verifier длиной 43 символа — минимально допустимую по RFC 7636.
  const verifier = generateToken(32);
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');

  return { verifier, challenge, method: 'S256' };
}

/**
 * Сравнивает строки за постоянное время, не раскрывая длину через тайминг.
 * Обе строки предварительно хешируются, поэтому длины буферов всегда равны.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }

  const hashA = createHash('sha256').update(a, 'utf8').digest();
  const hashB = createHash('sha256').update(b, 'utf8').digest();

  return timingSafeEqual(hashA, hashB);
}
