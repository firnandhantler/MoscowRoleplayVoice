import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SNOWFLAKE_PATTERN = /^[0-9]{17,20}$/;

const DEFAULT_PATH = fileURLToPath(new URL('../../../config/radio-channels.json', import.meta.url));

/**
 * Ошибка конфигурации радиоканалов. Сообщение содержит имя файла и причину,
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
 * Проверяет описание одного радиоканала.
 *
 * @param {unknown} raw
 * @param {number} index
 * @returns {{id: string, name: string, description: string, roleIds: string[], priority: number}}
 */
function parseChannel(raw, index) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RadioConfigError(`Радиоканал №${index + 1} должен быть объектом.`);
  }

  const { id, name, description = '', roleIds = [], priority = 0 } = raw;

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

  if (!Array.isArray(roleIds) || roleIds.length > 50) {
    throw new RadioConfigError(`Радиоканал ${id}: roleIds должен быть массивом до 50 ролей.`);
  }

  for (const roleId of roleIds) {
    if (typeof roleId !== 'string' || !SNOWFLAKE_PATTERN.test(roleId)) {
      throw new RadioConfigError(`Радиоканал ${id}: roleIds должен содержать Discord ID ролей.`);
    }
  }

  if (!Number.isSafeInteger(priority)) {
    throw new RadioConfigError(`Радиоканал ${id}: priority должен быть целым числом.`);
  }

  return { id, name: name.trim(), description, roleIds: [...new Set(roleIds)], priority };
}

/**
 * Загружает список радиоканалов из JSON-файла.
 *
 * Формат:
 * {
 *   "channels": [
 *     { "id": "police", "name": "Полиция", "description": "...", "roleIds": ["..."], "priority": 1 }
 *   ]
 * }
 *
 * Пустой массив roleIds означает, что канал доступен любому авторизованному пользователю.
 *
 * @param {{path?: string, logger?: import('pino').Logger|null}} options
 * @returns {{id: string, name: string, description: string, roleIds: string[], priority: number}[]}
 */
export function loadRadioChannels({ path = DEFAULT_PATH, logger = null } = {}) {
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

  const channels = parsed.channels.map(parseChannel);
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
