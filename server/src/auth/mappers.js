/**
 * Преобразование строк PostgreSQL в объекты, которые отдаются наружу.
 *
 * Наружу не попадают хеш токена сессии, флаг revoked, внутренние служебные поля
 * и любые секреты. Формат один для всех маршрутов авторизации.
 */

function toIso(value) {
  if (value === null || value === undefined) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : value;
}

/**
 * @param {object} row Строка из таблицы users (алиасы колонок — как в запросах auth).
 * @returns {object}
 */
export function mapUserRow(row) {
  return {
    id: String(row.user_id),
    discordId: row.discord_id,
    discordUsername: row.discord_username,
    discordGlobalName: row.discord_global_name ?? null,
    roblox:
      row.roblox_id === null || row.roblox_id === undefined
        ? null
        : {
            id: row.roblox_id,
            username: row.roblox_username,
            linkedAt: toIso(row.roblox_linked_at),
          },
    createdAt: toIso(row.user_created_at),
    lastLoginAt: toIso(row.last_login_at),
  };
}
