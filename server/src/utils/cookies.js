const MAX_COOKIE_HEADER_LENGTH = 8192;
const MAX_COOKIES = 50;
const COOKIE_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const COOKIE_VALUE_PATTERN = /^[A-Za-z0-9_.~-]{0,4096}$/;
const SAME_SITE_VALUES = new Set(['Strict', 'Lax', 'None']);

/**
 * Разбирает заголовок Cookie.
 * Слишком длинный заголовок и значения с недопустимыми символами игнорируются.
 *
 * @param {string|undefined} header
 * @returns {Map<string, string>}
 */
export function parseCookies(header) {
  const cookies = new Map();

  if (typeof header !== 'string' || header.length === 0 || header.length > MAX_COOKIE_HEADER_LENGTH) {
    return cookies;
  }

  for (const part of header.split(';')) {
    if (cookies.size >= MAX_COOKIES) {
      break;
    }

    const separatorIndex = part.indexOf('=');

    if (separatorIndex <= 0) {
      continue;
    }

    const name = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();

    // Первое вхождение имеет приоритет: дубликаты не перезаписывают значение.
    if (!COOKIE_NAME_PATTERN.test(name) || !COOKIE_VALUE_PATTERN.test(value) || cookies.has(name)) {
      continue;
    }

    cookies.set(name, value);
  }

  return cookies;
}

/**
 * Формирует значение заголовка Set-Cookie.
 * Значение должно быть безопасным (base64url), кодирование не выполняется.
 *
 * @param {string} name
 * @param {string} value
 * @param {{maxAgeSeconds?: number, httpOnly?: boolean, secure?: boolean, sameSite?: 'Strict'|'Lax'|'None', path?: string}} options
 * @returns {string}
 */
export function serializeCookie(
  name,
  value,
  { maxAgeSeconds, httpOnly = true, secure = true, sameSite = 'Lax', path = '/' } = {},
) {
  if (!COOKIE_NAME_PATTERN.test(name)) {
    throw new TypeError('Недопустимое имя cookie.');
  }

  if (!COOKIE_VALUE_PATTERN.test(value)) {
    throw new TypeError('Недопустимое значение cookie.');
  }

  if (!SAME_SITE_VALUES.has(sameSite)) {
    throw new TypeError('Недопустимое значение SameSite.');
  }

  if (sameSite === 'None' && !secure) {
    throw new TypeError('SameSite=None требует флаг Secure.');
  }

  const parts = [`${name}=${value}`, `Path=${path}`, `SameSite=${sameSite}`];

  if (maxAgeSeconds !== undefined) {
    const maxAge = Math.max(0, Math.floor(maxAgeSeconds));
    parts.push(`Max-Age=${maxAge}`);

    if (maxAge === 0) {
      parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    }
  }

  if (httpOnly) {
    parts.push('HttpOnly');
  }

  if (secure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

/**
 * Формирует Set-Cookie, удаляющий cookie.
 *
 * @param {string} name
 * @param {{secure?: boolean, sameSite?: 'Strict'|'Lax'|'None', path?: string}} options
 * @returns {string}
 */
export function clearCookie(name, { secure = true, sameSite = 'Lax', path = '/' } = {}) {
  return serializeCookie(name, '', { maxAgeSeconds: 0, secure, sameSite, path });
}
