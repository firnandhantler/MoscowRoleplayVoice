import { AppError } from './errors.js';

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * Ошибка обращения к внешнему API.
 * Не содержит URL, заголовков и тела ответа, чтобы ключи и персональные данные
 * не попали в логи.
 */
export class ExternalApiError extends AppError {
  /**
   * @param {string} message Сообщение на русском языке.
   * @param {{code: string, service: string, status?: number|null, retryAfterMs?: number|null, cause?: unknown}} options
   */
  constructor(message, { code, service, status = null, retryAfterMs = null, cause } = {}) {
    super(message, { code, statusCode: 502, cause });
    this.name = 'ExternalApiError';
    this.service = service;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Читает тело ответа с ограничением размера.
 *
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<string|null>} null, если тело превышает лимит.
 */
async function readLimitedText(response, maxBytes) {
  const declaredLength = Number(response.headers.get('content-length'));

  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    return null;
  }

  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    total += value.byteLength;

    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks, total).toString('utf8');
}

/**
 * Выполняет HTTP-запрос к внешнему API и разбирает JSON-ответ.
 *
 * HTTP-статусы не считаются ошибкой на этом уровне: их интерпретирует адаптер
 * конкретного API. Исключение выбрасывается только при таймауте, сетевой ошибке,
 * слишком большом ответе или некорректном JSON.
 *
 * @param {{
 *   service: string,
 *   url: string,
 *   method?: string,
 *   headers?: Record<string, string>,
 *   body?: string|URLSearchParams,
 *   timeoutMs: number,
 *   fetchImpl?: typeof fetch,
 *   maxResponseBytes?: number,
 * }} options
 * @returns {Promise<{status: number, headers: Headers, data: unknown}>}
 */
export async function requestJson({
  service,
  url,
  method = 'GET',
  headers = {},
  body,
  timeoutMs,
  fetchImpl = globalThis.fetch,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
}) {
  let response;

  try {
    response = await fetchImpl(url, {
      method,
      headers: { Accept: 'application/json', ...headers },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new ExternalApiError(`Сервис ${service} не ответил вовремя.`, {
        code: 'external_timeout',
        service,
      });
    }

    throw new ExternalApiError(`Сервис ${service} недоступен.`, {
      code: 'external_network_error',
      service,
    });
  }

  let text;

  try {
    text = await readLimitedText(response, maxResponseBytes);
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';

    throw new ExternalApiError(
      timedOut
        ? `Сервис ${service} не ответил вовремя.`
        : `Не удалось прочитать ответ сервиса ${service}.`,
      {
        code: timedOut ? 'external_timeout' : 'external_network_error',
        service,
        status: response.status,
      },
    );
  }

  if (text === null) {
    throw new ExternalApiError(`Ответ сервиса ${service} превышает допустимый размер.`, {
      code: 'external_response_too_large',
      service,
      status: response.status,
    });
  }

  let data = null;

  if (text.trim() !== '') {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ExternalApiError(`Сервис ${service} вернул некорректный JSON.`, {
        code: 'external_invalid_json',
        service,
        status: response.status,
      });
    }
  }

  return { status: response.status, headers: response.headers, data };
}

/**
 * Разбирает заголовок Retry-After (секунды или HTTP-дата) в миллисекунды.
 *
 * @param {string|null} value
 * @param {number} now
 * @returns {number|null}
 */
export function parseRetryAfterMs(value, now = Date.now()) {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  const trimmed = value.trim();

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.ceil(Number(trimmed) * 1000);
  }

  const date = Date.parse(trimmed);

  if (Number.isNaN(date)) {
    return null;
  }

  return Math.max(0, date - now);
}
