import assert from 'node:assert/strict';
import test from 'node:test';
import { DiscordRoleService } from '../src/discord/roles.js';

const GUILD_A = '111111111111111111';
const GUILD_B = '222222222222222222';
const USER_ID = '333333333333333333';
const ROLE_A = '444444444444444444';
const ROLE_B = '555555555555555555';

const logger = {
  child() {
    return logger;
  },
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
};

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
 * Сервис с подменённым fetch. Ключ карты ответов — точный URL Discord API.
 *
 * @param {Record<string, () => Response>} responses
 * @param {{guildIds?: string[], cacheTtlMs?: number, now?: () => number}} options
 */
function createService(responses, { guildIds = [GUILD_A, GUILD_B], cacheTtlMs = 60_000, now = () => 1_000_000 } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const handler = responses[url];

    if (handler === undefined) {
      throw new Error(`Неожиданный запрос: ${url}`);
    }

    return handler();
  };

  const service = new DiscordRoleService({
    botToken: 'test_bot_token',
    guildIds,
    cacheTtlMs,
    timeoutMs: 1000,
    fetchImpl,
    now,
    logger,
  });

  return { service, calls };
}

test('запрашивает роли отдельно на каждом Discord-сервере и кэширует их', async () => {
  const urlA = `https://discord.com/api/v10/guilds/${GUILD_A}/members/${USER_ID}`;
  const urlB = `https://discord.com/api/v10/guilds/${GUILD_B}/members/${USER_ID}`;
  const { service, calls } = createService({
    [urlA]: () => jsonResponse({ roles: [ROLE_A, 'not-a-snowflake'] }),
    [urlB]: () => jsonResponse({ roles: [ROLE_B] }),
  });

  assert.deepEqual(await service.getRoles(USER_ID, GUILD_A), [ROLE_A]);
  assert.deepEqual(await service.getRoles(USER_ID, GUILD_B), [ROLE_B]);
  assert.deepEqual(await service.getRoles(USER_ID, GUILD_A), [ROLE_A]);
  assert.equal(calls.length, 2);

  assert.deepEqual(service.getStatus(), {
    enabled: true,
    guilds: 2,
    cachedEntries: 2,
    lastErrorCode: null,
  });
});

test('по умолчанию проверяет первый настроенный сервер', async () => {
  const urlA = `https://discord.com/api/v10/guilds/${GUILD_A}/members/${USER_ID}`;
  const { service, calls } = createService({
    [urlA]: () => jsonResponse({ roles: [ROLE_A] }),
  });

  assert.equal(service.guildId, GUILD_A);
  assert.deepEqual(await service.getRoles(USER_ID), [ROLE_A]);
  assert.equal(calls.length, 1);
});

test('кэш истекает через DISCORD_ROLES_CACHE_TTL_MS', async () => {
  const urlA = `https://discord.com/api/v10/guilds/${GUILD_A}/members/${USER_ID}`;
  let currentTime = 1_000_000;
  let requestCount = 0;
  const { service, calls } = createService(
    {
      [urlA]: () => {
        requestCount += 1;
        return jsonResponse({ roles: [ROLE_A] });
      },
    },
    { guildIds: [GUILD_A], cacheTtlMs: 1000, now: () => currentTime },
  );

  await service.getRoles(USER_ID, GUILD_A);
  currentTime += 999;
  await service.getRoles(USER_ID, GUILD_A);
  assert.equal(calls.length, 1);

  currentTime += 2;
  await service.getRoles(USER_ID, GUILD_A);
  assert.equal(calls.length, 2);
  assert.equal(requestCount, 2);
});

test('404 означает, что участника нет на сервере, и кэшируется', async () => {
  const urlA = `https://discord.com/api/v10/guilds/${GUILD_A}/members/${USER_ID}`;
  const { service, calls } = createService({
    [urlA]: () => jsonResponse({ message: 'Unknown Member', code: 10007 }, { status: 404 }),
  });

  assert.deepEqual(await service.getRoles(USER_ID, GUILD_A), []);
  assert.deepEqual(await service.getRoles(USER_ID, GUILD_A), []);
  assert.equal(calls.length, 1);
});

test('429 не кэшируется и возвращает null', async () => {
  const urlA = `https://discord.com/api/v10/guilds/${GUILD_A}/members/${USER_ID}`;
  const { service, calls } = createService({
    [urlA]: () =>
      jsonResponse(
        { message: 'You are being rate limited.', retry_after: 2 },
        { status: 429, headers: { 'retry-after': '2' } },
      ),
  });

  assert.equal(await service.getRoles(USER_ID, GUILD_A), null);
  assert.equal(await service.getRoles(USER_ID, GUILD_A), null);
  assert.equal(calls.length, 2);
  assert.equal(service.getStatus().cachedEntries, 0);
});

test('401 и 403 помечают ошибку доступа бота', async () => {
  const urlA = `https://discord.com/api/v10/guilds/${GUILD_A}/members/${USER_ID}`;

  for (const status of [401, 403]) {
    const { service } = createService({
      [urlA]: () => jsonResponse({ message: 'Missing Access' }, { status }),
    });

    assert.equal(await service.getRoles(USER_ID, GUILD_A), null);
    assert.equal(service.getStatus().lastErrorCode, 'discord_bot_unauthorized');
  }
});

test('отклоняет guildId, которого нет в списке настроенных серверов', async () => {
  const { service, calls } = createService({});

  assert.equal(await service.getRoles(USER_ID, '999999999999999999'), null);
  assert.equal(calls.length, 0);
  assert.equal(service.getStatus().lastErrorCode, 'discord_guild_not_configured');
});

test('без токена или серверов сервис отключён', async () => {
  const disabled = new DiscordRoleService({
    botToken: null,
    guildIds: [GUILD_A],
    cacheTtlMs: 1000,
    timeoutMs: 1000,
  });

  assert.equal(disabled.isEnabled(), false);
  assert.equal(await disabled.getRoles(USER_ID, GUILD_A), null);
  assert.equal(await disabled.hasAnyRole(USER_ID, [ROLE_A]), null);
});

test('hasAnyRoleInGuilds разрешает доступ по роли на любом из серверов', async () => {
  const urlA = `https://discord.com/api/v10/guilds/${GUILD_A}/members/${USER_ID}`;
  const urlB = `https://discord.com/api/v10/guilds/${GUILD_B}/members/${USER_ID}`;
  const { service, calls } = createService({
    [urlA]: () => jsonResponse({ roles: [] }),
    [urlB]: () => jsonResponse({ roles: [ROLE_B] }),
  });

  const allowed = await service.hasAnyRoleInGuilds(USER_ID, [
    { label: 'Основной', guildId: GUILD_A, roleIds: [ROLE_A] },
    { label: 'Второй', guildId: GUILD_B, roleIds: [ROLE_B] },
  ]);

  assert.equal(allowed, true);
  assert.deepEqual(calls, [urlA, urlB]);
});

test('hasAnyRoleInGuilds запрещает доступ, если ролей нет нигде', async () => {
  const urlA = `https://discord.com/api/v10/guilds/${GUILD_A}/members/${USER_ID}`;
  const urlB = `https://discord.com/api/v10/guilds/${GUILD_B}/members/${USER_ID}`;
  const { service } = createService({
    [urlA]: () => jsonResponse({ roles: ['666666666666666666'] }),
    [urlB]: () => jsonResponse({ roles: [ROLE_B] }),
  });

  const allowed = await service.hasAnyRoleInGuilds(USER_ID, [
    { label: 'Основной', guildId: GUILD_A, roleIds: [ROLE_A] },
    { label: 'Второй', guildId: GUILD_B, roleIds: ['777777777777777777'] },
  ]);

  assert.equal(allowed, false);
});

test('hasAnyRoleInGuilds возвращает null при ошибке проверки', async () => {
  const urlA = `https://discord.com/api/v10/guilds/${GUILD_A}/members/${USER_ID}`;
  const urlB = `https://discord.com/api/v10/guilds/${GUILD_B}/members/${USER_ID}`;
  const { service } = createService({
    [urlA]: () => jsonResponse({ message: 'Server Error' }, { status: 500 }),
    [urlB]: () => jsonResponse({ roles: [] }),
  });

  const allowed = await service.hasAnyRoleInGuilds(USER_ID, [
    { label: 'Основной', guildId: GUILD_A, roleIds: [ROLE_A] },
    { label: 'Второй', guildId: GUILD_B, roleIds: [ROLE_B] },
  ]);

  assert.equal(allowed, null);
});

test('пустой список групп доступа означает открытый канал', async () => {
  const { service, calls } = createService({});

  assert.equal(await service.hasAnyRoleInGuilds(USER_ID, []), true);
  assert.equal(calls.length, 0);
});

test('устаревший roleIds проверяется на всех настроенных серверах', async () => {
  const urlA = `https://discord.com/api/v10/guilds/${GUILD_A}/members/${USER_ID}`;
  const urlB = `https://discord.com/api/v10/guilds/${GUILD_B}/members/${USER_ID}`;
  const { service } = createService({
    [urlA]: () => jsonResponse({ roles: [] }),
    [urlB]: () => jsonResponse({ roles: [ROLE_A] }),
  });

  assert.equal(await service.hasAnyRole(USER_ID, [ROLE_A]), true);
});
