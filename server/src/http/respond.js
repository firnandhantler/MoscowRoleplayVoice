/**
 * Общие ответы HTTP-сервера.
 *
 * Все ответы (JSON, HTML, редиректы) получают одинаковый набор защитных заголовков:
 * запрет MIME-sniffing, запрет встраивания во фрейм, запрет кэширования
 * и строгая Content-Security-Policy.
 */
export const COMMON_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
});

/**
 * @param {import('node:http').ServerResponse} res
 * @param {Record<string, string|string[]>} headers
 */
function applyHeaders(res, headers) {
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
}

/**
 * Отправляет JSON-ответ с безопасными заголовками.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} statusCode
 * @param {unknown} payload
 * @param {Record<string, string|string[]>} extraHeaders
 */
export function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);

  applyHeaders(res, COMMON_HEADERS);
  applyHeaders(res, extraHeaders);

  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body, 'utf8'));
  res.end(body);
}

/**
 * Отправляет HTML-страницу. Используется только для страницы завершения входа,
 * где нет внешних ресурсов и пользовательских данных.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} statusCode
 * @param {string} html
 * @param {Record<string, string|string[]>} extraHeaders
 */
export function sendHtml(res, statusCode, html, extraHeaders = {}) {
  const body = Buffer.from(html, 'utf8');

  applyHeaders(res, COMMON_HEADERS);
  applyHeaders(res, extraHeaders);

  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Length', body.byteLength);
  res.end(body);
}

/**
 * Отправляет редирект.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {string} location
 * @param {{statusCode?: number, headers?: Record<string, string|string[]>}} options
 */
export function sendRedirect(res, location, { statusCode = 302, headers = {} } = {}) {
  applyHeaders(res, COMMON_HEADERS);
  applyHeaders(res, headers);

  res.statusCode = statusCode;
  res.setHeader('Location', location);
  res.setHeader('Content-Length', '0');
  res.end();
}

/**
 * Отправляет пустой ответ (например, для OPTIONS или успешного logout без тела).
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} statusCode
 * @param {Record<string, string|string[]>} extraHeaders
 */
export function sendEmpty(res, statusCode, extraHeaders = {}) {
  applyHeaders(res, COMMON_HEADERS);
  applyHeaders(res, extraHeaders);

  res.statusCode = statusCode;
  res.setHeader('Content-Length', '0');
  res.end();
}

/**
 * Ошибка в едином формате API.
 *
 * @param {number} statusCode
 * @param {string} code
 * @param {string} message
 * @param {Record<string, string|string[]>} headers
 * @returns {{statusCode: number, payload: object, headers: Record<string, string|string[]>}}
 */
export function errorResponse(statusCode, code, message, headers = {}) {
  return {
    statusCode,
    payload: { error: { code, message } },
    headers,
  };
}
