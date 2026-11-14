import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadRadioChannels, RadioConfigError } from '../src/radio/channels.js';

const GUILD_A = '111111111111111111';
const GUILD_B = '222222222222222222';
const ROLE_A = '333333333333333333';
const ROLE_B = '444444444444444444';

/**
 * Создаёт временный файл конфигурации и удаляет его после проверки.
 *
 * @param {object} content
 * @param {(path: string) => Promise<void>} run
 */
async function withConfig(content, run) {
  const directory = await mkdtemp(join(tmpdir(), 'mrv-radio-'));
  const path = join(directory, 'radio-channels.json');

  await writeFile(path, JSON.stringify(content), 'utf8');

  try {
    await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('загружает открытые каналы и сортирует по priority', async () => {
  await withConfig(
    {
      channels: [
        { id: 'second', name: 'Второй', access: [], priority: 2 },
        { id: 'first', name: 'Первый', access: [], priority: 1 },
      ],
    },
    async (path) => {
      const channels = loadRadioChannels({ path });

      assert.deepEqual(
        channels.map((channel) => channel.id),
        ['first', 'second'],
      );
      assert.equal(channels[0].restricted, false);
      assert.deepEqual(channels[0].access, []);
    },
  );
});

test('загружает группы доступа с ролями нескольких Discord-серверов', async () => {
  await withConfig(
    {
      channels: [
        {
          id: 'police',
          name: 'Полиция',
          access: [
            { label: 'Основной', guildId: GUILD_A, roleIds: [ROLE_A] },
            { label: 'Второй', guildId: GUILD_B, roleIds: [ROLE_B, ROLE_B] },
          ],
        },
      ],
    },
    async (path) => {
      const [channel] = loadRadioChannels({
        path,
        allowedGuildIds: [GUILD_A, GUILD_B],
      });

      assert.equal(channel.restricted, true);
      assert.deepEqual(channel.access, [
        { label: 'Основной', guildId: GUILD_A, roleIds: [ROLE_A] },
        { label: 'Второй', guildId: GUILD_B, roleIds: [ROLE_B] },
      ]);
    },
  );
});

test('отклоняет guildId, которого нет в списке разрешённых серверов', async () => {
  await withConfig(
    {
      channels: [
        {
          id: 'police',
          name: 'Полиция',
          access: [{ guildId: GUILD_B, roleIds: [ROLE_B] }],
        },
      ],
    },
    async (path) => {
      assert.throws(
        () => loadRadioChannels({ path, allowedGuildIds: [GUILD_A] }),
        (err) => {
          assert.equal(err instanceof RadioConfigError, true);
          assert.match(err.message, /DISCORD_ROLE_GUILD_IDS/);
          return true;
        },
      );
    },
  );
});

test('поддерживает устаревшее поле roleIds', async () => {
  await withConfig(
    {
      channels: [
        {
          id: 'police',
          name: 'Полиция',
          roleIds: [ROLE_A],
        },
      ],
    },
    async (path) => {
      const [channel] = loadRadioChannels({ path });

      assert.equal(channel.restricted, true);
      assert.deepEqual(channel.access, [
        { label: '', guildId: null, roleIds: [ROLE_A] },
      ]);
    },
  );
});

test('отклоняет одновременное использование access и roleIds', async () => {
  await withConfig(
    {
      channels: [
        {
          id: 'police',
          name: 'Полиция',
          access: [{ guildId: GUILD_A, roleIds: [ROLE_A] }],
          roleIds: [ROLE_B],
        },
      ],
    },
    async (path) => {
      assert.throws(
        () => loadRadioChannels({ path }),
        /либо access, либо устаревшее поле roleIds/,
      );
    },
  );
});

test('отклоняет пустой roleIds внутри группы доступа', async () => {
  await withConfig(
    {
      channels: [
        {
          id: 'police',
          name: 'Полиция',
          access: [{ guildId: GUILD_A, roleIds: [] }],
        },
      ],
    },
    async (path) => {
      assert.throws(
        () => loadRadioChannels({ path }),
        /не должен быть пустым/,
      );
    },
  );
});
