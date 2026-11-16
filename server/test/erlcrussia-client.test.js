import assert from 'node:assert/strict';
import test from 'node:test';
import { ErlcRussiaVerificationClient } from '../src/erlcrussia/client.js';

const DISCORD_ID = '123456789012345678';
const API_BASE_URL = 'https://api.erlcrussia.com/v3';

/**
 * Создаёт ответ, совместимый с fetch/Response.
 *
 * @param {unknown} data
 * @param {{status?: number, headers?: Record<string, string>}} options
 * @returns {Response}
 */
function jsonResponse(data, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * Клиент с подменённым fetch. Вызовы сохраняются для проверки URL и заголовков.
 *
 * @param {Response} response
 * @param {Array<{url: string, init: object}>} calls
 * @returns {ErlcRussiaVerificationClient}
 */
function createClient(response, calls) {
  return new ErlcRussiaVerificationClient({
    apiKey: 'test-key',
    apiBaseUrl: API_BASE_URL,
    timeoutMs: 1000,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response;
    },
  });
}

/**
 * @param {Promise<unknown>} promise
 * @param {string} code
 */
async function assertClientError(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code);
    return true;
  });
}

test('возвращает Roblox ID и передаёт ключ в заголовке', async () => {
  const calls = [];
  const client = createClient(jsonResponse({ robloxId: '156' }), calls);

  assert.equal(await client.getRobloxIdByDiscordId(DISCORD_ID), '156');
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `${API_BASE_URL}/users?discordId=${DISCORD_ID}`,
  );
  assert.equal(calls[0].init.headers['erlcrussia-api-key'], 'test-key');
});

test('принимает Roblox ID числом и приводит его к строке', async () => {
  const calls = [];
  const client = createClient(jsonResponse({ robloxId: 156 }), calls);

  assert.equal(await client.getRobloxIdByDiscordId(DISCORD_ID), '156');
});

test('возвращает null, если сервис ответил 404', async () => {
  const calls = [];
  const client = createClient(new Response(null, { status: 404 }), calls);

  assert.equal(await client.getRobloxIdByDiscordId(DISCORD_ID), null);
});

test('возвращает null, если Roblox не привязан (5012, 5050)', async () => {
  for (const code of [5012, 5050]) {
    const calls = [];
    const client = createClient(jsonResponse({ code, message: 'нет связки' }, { status: 400 }), calls);

    assert.equal(await client.getRobloxIdByDiscordId(DISCORD_ID), null);
  }
});

test('возвращает null, если в ответе нет robloxId', async () => {
  const calls = [];
  const client = createClient(jsonResponse({}), calls);

  assert.equal(await client.getRobloxIdByDiscordId(DISCORD_ID), null);
});

test('различает ошибку ключа', async () => {
  const calls = [];
  const client = createClient(
    jsonResponse({ code: 5008, message: 'Invalid Token' }, { status: 401 }),
    calls,
  );

  await assertClientError(client.getRobloxIdByDiscordId(DISCORD_ID), 'erlcrussia_unauthorized');
});

test('различает ограничение частоты и читает Retry-After', async () => {
  const calls = [];
  const client = createClient(
    jsonResponse({ code: 5016, message: 'Rate Limit Exceeded' }, {
      status: 429,
      headers: { 'retry-after': '2' },
    }),
    calls,
  );

  await assert.rejects(client.getRobloxIdByDiscordId(DISCORD_ID), (err) => {
    assert.equal(err.code, 'erlcrussia_rate_limited');
    assert.equal(err.retryAfterMs, 2000);
    return true;
  });
});

test('различает временную недоступность сервиса', async () => {
  const calls = [];
  const client = createClient(
    jsonResponse({ code: 5018, message: 'Server Error' }, { status: 503 }),
    calls,
  );

  await assertClientError(client.getRobloxIdByDiscordId(DISCORD_ID), 'erlcrussia_unavailable');
});

test('не раскрывает неизвестный код ошибки наружу', async () => {
  const calls = [];
  const client = createClient(
    jsonResponse({ code: 9999, message: 'Unknown' }, { status: 400 }),
    calls,
  );

  await assertClientError(client.getRobloxIdByDiscordId(DISCORD_ID), 'erlcrussia_request_failed');
});

test('отклоняет некорректный ответ сервиса', async () => {
  const calls = [];
  const client = createClient(jsonResponse({ robloxId: 'not-a-number' }), calls);

  await assertClientError(client.getRobloxIdByDiscordId(DISCORD_ID), 'erlcrussia_invalid_response');
});

test('не выполняет запрос при некорректном Discord ID', async () => {
  const calls = [];
  const client = createClient(jsonResponse({ robloxId: '156' }), calls);

  await assert.rejects(client.getRobloxIdByDiscordId('discord-user'), TypeError);
  assert.equal(calls.length, 0);
});
