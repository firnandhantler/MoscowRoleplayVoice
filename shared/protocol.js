/**
 * Общий протокол обмена сообщениями между сервером и клиентом.
 *
 * Файл не зависит от Node.js или браузера, чтобы его можно было использовать
 * и в серверном коде, и в будущем Electron-клиенте.
 *
 * Формат сообщения:
 * {
 *   "v": 1,
 *   "type": "client.ping",
 *   "id": "необязательный-идентификатор",
 *   "data": { ... }
 * }
 *
 * Правила:
 * - версия протокола обязательна и должна совпадать с PROTOCOL_VERSION;
 * - тип сообщения обязателен и должен входить в список разрешённых;
 * - идентификатор необязателен, но если указан — должен быть безопасной строкой;
 * - data необязательна, но если указана — должна быть объектом;
 * - неизвестные поля запрещены, чтобы не создавать неоднозначность.
 */

export const PROTOCOL_NAME = 'moscowroleplay-voice';
export const PROTOCOL_VERSION = 1;
export const WS_PATH = '/ws';
export const MAX_MESSAGE_BYTES = 16 * 1024;
export const MAX_MESSAGE_ID_LENGTH = 64;
export const MAX_NONCE_LENGTH = 64;

/** Типы сообщений, которые клиент может отправить серверу. */
export const ClientMessageType = Object.freeze({
  PING: 'client.ping',
});

/** Типы сообщений, которые сервер может отправить клиенту. */
export const ServerMessageType = Object.freeze({
  HELLO: 'server.hello',
  PONG: 'server.pong',
  ERROR: 'server.error',
});

/** Машиночитаемые коды ошибок протокола. */
export const ProtocolErrorCode = Object.freeze({
  INVALID_JSON: 'invalid_json',
  INVALID_MESSAGE: 'invalid_message',
  UNSUPPORTED_VERSION: 'unsupported_protocol_version',
  UNSUPPORTED_TYPE: 'unsupported_message_type',
  MESSAGE_TOO_LARGE: 'message_too_large',
  BINARY_NOT_SUPPORTED: 'binary_not_supported',
  RATE_LIMITED: 'rate_limited',
  INTERNAL_ERROR: 'internal_error',
  SERVER_SHUTTING_DOWN: 'server_shutting_down',
});

const CLIENT_MESSAGE_TYPES = new Set(Object.values(ClientMessageType));
const ALLOWED_ENVELOPE_KEYS = new Set(['v', 'type', 'id', 'data']);
const ALLOWED_DATA_KEYS_BY_TYPE = new Map([
  [ClientMessageType.PING, new Set(['nonce'])],
]);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const textEncoder = new TextEncoder();

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyAllowedKeys(object, allowedKeys) {
  return Object.keys(object).every((key) => allowedKeys.has(key));
}

function fail(code, message) {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}

function validateData(type, data) {
  const allowedKeys = ALLOWED_DATA_KEYS_BY_TYPE.get(type);

  if (!allowedKeys) {
    return fail(
      ProtocolErrorCode.UNSUPPORTED_TYPE,
      'Этот тип сообщения пока не поддерживается сервером.',
    );
  }

  if (!hasOnlyAllowedKeys(data, allowedKeys)) {
    return fail(
      ProtocolErrorCode.INVALID_MESSAGE,
      'Сообщение содержит недопустимые поля данных.',
    );
  }

  if (type === ClientMessageType.PING && Object.hasOwn(data, 'nonce')) {
    if (typeof data.nonce !== 'string' || data.nonce.length > MAX_NONCE_LENGTH) {
      return fail(
        ProtocolErrorCode.INVALID_MESSAGE,
        'Поле nonce должно быть строкой длиной не более 64 символов.',
      );
    }
  }

  return { ok: true };
}

/**
 * Разбирает и валидирует текстовое сообщение клиента.
 *
 * @param {unknown} raw Сырое значение, полученное от WebSocket.
 * @returns {{ok: true, message: {v: number, type: string, id: string|null, data: object}}
 *   | {ok: false, error: {code: string, message: string}}}
 */
export function parseClientMessage(raw) {
  if (typeof raw !== 'string') {
    return fail(
      ProtocolErrorCode.BINARY_NOT_SUPPORTED,
      'Двоичные сообщения не поддерживаются. Отправьте текстовый JSON.',
    );
  }

  const byteLength = textEncoder.encode(raw).byteLength;

  if (byteLength > MAX_MESSAGE_BYTES) {
    return fail(
      ProtocolErrorCode.MESSAGE_TOO_LARGE,
      'Сообщение превышает допустимый размер.',
    );
  }

  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail(
      ProtocolErrorCode.INVALID_JSON,
      'Сообщение не является корректным JSON.',
    );
  }

  if (!isPlainObject(parsed)) {
    return fail(
      ProtocolErrorCode.INVALID_MESSAGE,
      'Сообщение должно быть JSON-объектом.',
    );
  }

  if (!hasOnlyAllowedKeys(parsed, ALLOWED_ENVELOPE_KEYS)) {
    return fail(
      ProtocolErrorCode.INVALID_MESSAGE,
      'Сообщение содержит недопустимые поля.',
    );
  }

  if (parsed.v !== PROTOCOL_VERSION) {
    return fail(
      ProtocolErrorCode.UNSUPPORTED_VERSION,
      `Поддерживается только версия протокола ${PROTOCOL_VERSION}.`,
    );
  }

  if (typeof parsed.type !== 'string' || !CLIENT_MESSAGE_TYPES.has(parsed.type)) {
    return fail(
      ProtocolErrorCode.UNSUPPORTED_TYPE,
      'Неизвестный или неподдерживаемый тип сообщения.',
    );
  }

  let id = null;

  if (Object.hasOwn(parsed, 'id')) {
    if (typeof parsed.id !== 'string' || !ID_PATTERN.test(parsed.id)) {
      return fail(
        ProtocolErrorCode.INVALID_MESSAGE,
        'Идентификатор сообщения должен соответствовать шаблону [A-Za-z0-9_-] и иметь длину до 64 символов.',
      );
    }

    id = parsed.id;
  }

  let data = {};

  if (Object.hasOwn(parsed, 'data')) {
    if (!isPlainObject(parsed.data)) {
      return fail(
        ProtocolErrorCode.INVALID_MESSAGE,
        'Поле data должно быть JSON-объектом.',
      );
    }

    data = parsed.data;
  }

  const dataValidation = validateData(parsed.type, data);

  if (!dataValidation.ok) {
    return dataValidation;
  }

  return {
    ok: true,
    message: {
      v: PROTOCOL_VERSION,
      type: parsed.type,
      id,
      data,
    },
  };
}

/**
 * Создаёт объект серверного сообщения.
 *
 * @param {string} type Тип из ServerMessageType.
 * @param {object} data Полезная нагрузка.
 * @param {string|null} id Идентификатор исходного сообщения клиента.
 * @returns {{v: number, type: string, data: object, id?: string}}
 */
export function createServerMessage(type, data = {}, id = null) {
  const message = {
    v: PROTOCOL_VERSION,
    type,
    data,
  };

  if (id) {
    message.id = id;
  }

  return message;
}

/**
 * Проверяет, является ли значение допустимым идентификатором сообщения.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isMessageId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}
