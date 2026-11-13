import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ClientMessageType,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  ProtocolErrorCode,
  ServerMessageType,
  createServerMessage,
  parseClientMessage,
} from '../shared/protocol.js';

test('принимает корректный client.ping', () => {
  const result = parseClientMessage(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: ClientMessageType.PING,
      id: 'ping_1',
      data: { nonce: 'abc' },
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.message.type, ClientMessageType.PING);
  assert.equal(result.message.id, 'ping_1');
  assert.equal(result.message.data.nonce, 'abc');
});

test('принимает минимальный client.ping без id и data', () => {
  const result = parseClientMessage(
    JSON.stringify({ v: PROTOCOL_VERSION, type: ClientMessageType.PING }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.message.id, null);
  assert.deepEqual(result.message.data, {});
});

test('отклоняет некорректный JSON', () => {
  const result = parseClientMessage('{');

  assert.equal(result.ok, false);
  assert.equal(result.error.code, ProtocolErrorCode.INVALID_JSON);
});

test('отклоняет неподдерживаемую версию протокола', () => {
  const result = parseClientMessage(
    JSON.stringify({ v: 999, type: ClientMessageType.PING }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, ProtocolErrorCode.UNSUPPORTED_VERSION);
});

test('отклоняет неизвестный тип сообщения', () => {
  const result = parseClientMessage(
    JSON.stringify({ v: PROTOCOL_VERSION, type: 'client.unknown' }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, ProtocolErrorCode.UNSUPPORTED_TYPE);
});

test('отклоняет лишние поля конверта', () => {
  const result = parseClientMessage(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: ClientMessageType.PING,
      extra: true,
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, ProtocolErrorCode.INVALID_MESSAGE);
});

test('отклоняет лишние поля data', () => {
  const result = parseClientMessage(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: ClientMessageType.PING,
      data: { nonce: 'abc', extra: true },
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, ProtocolErrorCode.INVALID_MESSAGE);
});

test('отклоняет недопустимый id', () => {
  const result = parseClientMessage(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: ClientMessageType.PING,
      id: 'недопустимый id',
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, ProtocolErrorCode.INVALID_MESSAGE);
});

test('отклоняет бинарное сообщение', () => {
  const result = parseClientMessage(Buffer.from('test'));

  assert.equal(result.ok, false);
  assert.equal(result.error.code, ProtocolErrorCode.BINARY_NOT_SUPPORTED);
});

test('отклоняет сообщение больше лимита', () => {
  const result = parseClientMessage(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: ClientMessageType.PING,
      data: { nonce: 'a'.repeat(MAX_MESSAGE_BYTES) },
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, ProtocolErrorCode.MESSAGE_TOO_LARGE);
});

test('создаёт серверное сообщение без id', () => {
  const message = createServerMessage(ServerMessageType.PONG, { ok: true });

  assert.equal(message.v, PROTOCOL_VERSION);
  assert.equal(message.type, ServerMessageType.PONG);
  assert.deepEqual(message.data, { ok: true });
  assert.equal(Object.hasOwn(message, 'id'), false);
});

test('создаёт серверное сообщение с id', () => {
  const message = createServerMessage(
    ServerMessageType.ERROR,
    { code: 'test' },
    'request_1',
  );

  assert.equal(message.id, 'request_1');
});
