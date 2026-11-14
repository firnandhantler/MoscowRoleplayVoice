import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SNOWFLAKE_PATTERN = /^[0-9]{17,20}$/;
const MAX_ACCESS_GROUPS = 50;
const MAX_ROLES_PER_GROUP = 50;

const DEFAULT_PATH = fileURLToPath(new URL('../../config/radio-channels.json', import.meta.url));

/**
 * Ошибка конфигурации радиоканалов. Сообщение содержит имя канала и причину,
 * но никогда — содержимое секретов (их в файле и нет).
 */
export class RadioConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RadioConfigError';
    this.code = 'RADIO_CONFIG_INVALID';
  }
}

/**
 * @typedef {{label: string, guildId: string|null, roleIds: string[]}} RadioAccessGroup
 * @typedef {{
 *   id: string,
 *   name: string,
 *   description: string,
 *   access: RadioAccessGroup[],
 *   restricted: boolean,
 *   priority: number,
 * }} RadioChannel
 */

/**
 * Проверяет массив Discord ID ролей.
 *
 * @param {unknown} raw
 * @param {string} channelId
 * @param {{field?: string, allowEmpty?: boolean}} options
 * @returns {string[]}
 */
function parseRoleIds(raw, channelId, { field = 'roleIds', allowEmpty = false } = {}) {
  if (!Array.isArray(raw) || raw.length > MAX_ROLES_PER_GROUP) {
    throw new RadioConfigError(
      `Радиоканал ${channelId}: ${field} должен быть массивом до ${MAX_ROLES_PER_GROUP} ролей.`,
    );
  }

  if (!allowEmpty && raw.length === 0) {
    throw new RadioConfigError(`Радиоканал ${channelId}: ${field} не должен быть пустым.`);
  }

  for (const roleId of raw) {
    if (typeof roleId !== 'string' || !SNOWFLAKE_PATTERN.test(roleId)) {
      throw new RadioConfigError(
        `Радиоканал ${channelId}: ${field} должен содержать Discord ID ролей.`,
      );
    }
  }

  return [...new Set(raw)];
}

/**
 * Проверяет одну группу доступа: Discord-сервер и роли на нём.
 *
 * @param {unknown} raw
 * @param {string} channelId
 * @param {number} index
 * @param {Set<string>|null} allowedGuildIds
 * @returns {RadioAccessGroup}
 */
function parseAccessGroup(raw, channelId, index, allowedGuildIds) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RadioConfigError(
      `Радиоканал ${channelId}: группа доступа №${index + 1} должна быть объектом.`,
    );
  }

  const { label = '', guildId, roleIds } = raw;

  if (typeof label !== 'string' || label.length > 64) {
    throw new RadioConfigError(
      `Радиоканал ${channelId}: label группы доступа №${index + 1} должен быть строкой до 64 символов.`,
    );
  }

  if (typeof guildId !== 'string' || !SNOWFLAKE_PATTERN.test(guildId)) {
    throw new RadioConfigError(
      `Радиоканал ${channelId}: группа доступа №${index + 1} должна содержать guildId Discord-сервера.`,
    );
  }

  if (allowedGuildIds !== null && !allowedGuildIds.has(guildId)) {
    throw new RadioConfigError(
      `Радиоканал ${channelId}: группа доступа №${index + 1} ссылается на guildId, которого нет в DISCORD_ROLE_GUILD_IDS или DISCORD_GUILD_ID.`,
    );
  }

  const parsedRoleIds = parseRoleIds(roleIds, channelId, {
    field: `access[${index}].roleIds`,
    allowEmpty: false,
  });

  return {
    label: label.trim(),
    guildId,
    roleIds: parsedRoleIds,
  };
}

/**
 * Проверяет описание одного радиоканала.
 *
 * Новый формат:
 * {
 *   "id": "police",
 *   "name": "Полиция",
 *   "description": "...",
 *   "priority": 1,
 *   "access": [
 *     { "label": "Основной сервер", "guildId": "...", "roleIds": ["..."] }
 *   ]
 * }
 *
 * Пустой массив access означает открытый канал. Устаревшее поле roleIds
 * поддерживается для обратной совместимости и проверяется на всех
 * настроенных Discord-серверах.
 *
 * @param {unknown} raw
 * @param {number} index
 * @param {Set<string>|null} allowedGuildIds
 * @returns {RadioChannel}
 */
function parseChannel(raw, index, allowedGuildIds) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RadioConfigError(`Радиоканал №${index + 1} должен быть объектом.`);
  }

  const { id, name, description = '', roleIds, access, priority = 0 } = raw;

  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new RadioConfigError(
      `Радиоканал №${index + 1}: id должен соответствовать [a-z0-9_-] и иметь длину до 64 символов.`,
    );
  }

  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 64) {
    throw new RadioConfigError(`Радиоканал ${id}: name должен быть строкой длиной до 64 символов.`);
  }

  if (typeof description !== 'string' || description.length > 200) {
    throw new RadioConfigError(`Радиоканал ${id}: description должен быть строкой до 200 символов.`);
  }

  if (!Number.isSafeInteger(priority)) {
    throw new RadioConfigError(`Радиоканал ${id}: priority должен быть целым числом.`);
  }

  if (access !== undefined && roleIds !== undefined) {
    throw new RadioConfigError(
      `Радиоканал ${id}: используйте либо access, либо устаревшее поле roleIds, но не оба одновременно.`,
    );
  }

  /** @type {RadioAccessGroup[]} */
  let parsedAccess;

  if (access !== undefined) {
    if (!Array.isArray(access) || access.length > MAX_ACCESS_GROUPS) {
      throw new RadioConfigError(
        `Радиоканал ${id}: access должен быть массивом до ${MAX_ACCESS_GROUPS} групп.`,
      );
    }

    parsedAccess = access.map((group, groupIndex) =>
      parseAccessGroup(group, id, groupIndex, allowedGuildIds),
    );
  } else if (roleIds !== undefined) {
    // Обратная совместимость: старый roleIds проверяется на всех
    // настроенных Discord-серверах.
    const parsedRoleIds = parseRoleIds(roleIds, id, { allowEmpty: true });

    parsedAccess =
      parsedRoleIds.length === 0
        ? []
        : [{ label: '', guildId: null, roleIds: parsedRoleIds }];
  } else {
    parsedAccess = [];
  }

  return {
    id,
    name: name.trim(),
    description,
    access: parsedAccess,
    restricted: parsedAccess.length > 0,
    priority,
  };
}

/**
 * Загружает список радиоканалов из JSON-файла.
 *
 * Формат:
 * {
 *   "channels": [
 *     {
 *       "id": "police",
 *       "name": "Полиция",
 *       "description": "...",
 *       "priority": 1,
 *       "access": [
 *         { "label": "Основной сервер", "guildId": "...", "roleIds": ["..."] },
 *         { "label": "Второй сервер", "guildId": "...", "roleIds": ["..."] }
 *       ]
 *     }
 *   ]
 * }
 *
 * Пустой access означает, что канал доступен любому авторизованному
 * пользователю. Если задан allowedGuildIds, guildId каждой группы должен
 * входить в этот список.
 *
 * @param {{path?: string, logger?: import('pino').Logger|null, allowedGuildIds?: string[]|Set<string>|null}} options
 * @returns {RadioChannel[]}
 */
export function loadRadioChannels({
  path = DEFAULT_PATH,
  logger = null,
  allowedGuildIds = null,
} = {}) {
  let allowed = null;

  if (allowedGuildIds instanceof Set) {
    allowed = allowedGuildIds.size > 0 ? allowedGuildIds : null;
  } else if (Array.isArray(allowedGuildIds) && allowedGuildIds.length > 0) {
    allowed = new Set(allowedGuildIds);
  }

  let text;

  try {
    text = readFileSync(path, 'utf8');
  } catch {
    logger?.warn({ path }, 'Файл радиоканалов не найден, радио будет недоступно');
    return [];
  }

  let parsed;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RadioConfigError('Файл радиоканалов содержит некорректный JSON.');
  }

  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.channels)) {
    throw new RadioConfigError('Файл радиоканалов должен содержать массив channels.');
  }

  const channels = parsed.channels.map((raw, index) => parseChannel(raw, index, allowed));
  const ids = new Set();

  for (const channel of channels) {
    if (ids.has(channel.id)) {
      throw new RadioConfigError(`Радиоканал ${channel.id} описан дважды.`);
    }

    ids.add(channel.id);
  }

  return channels.sort((a, b) => a.priority - b.priority);
}

export { DEFAULT_PATH as DEFAULT_RADIO_CHANNELS_PATH };
