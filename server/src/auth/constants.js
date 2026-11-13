/**
 * Имена cookie модуля авторизации.
 *
 * Обе cookie — HttpOnly: JavaScript клиента и renderer Electron их не читают.
 * Сессионная cookie содержит только случайный токен, сам пользователь определяется
 * исключительно на сервере по хешу токена в PostgreSQL.
 */
export const SESSION_COOKIE_NAME = 'mrv_session';

/** Cookie с одноразовым `state` OAuth2. Живёт только на время входа. */
export const OAUTH_STATE_COOKIE_NAME = 'mrv_oauth_state';
