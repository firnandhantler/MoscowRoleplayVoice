import { ExternalApiError, parseRetryAfterMs, requestJson } from '../utils/http-client.js';
import { isPlainObject } from '../utils/errors.js';

const SERVICE = 'Discord';
const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/oauth2/token';
const REVOKE_URL = 'https://discord.com/api/oauth2/token/revoke';
const CURRENT_USER_URL = 'https://discord.com/api/v10/users/@me';

/** Издатель ответа авторизации (RFC 9207), объявлен в метаданных сервера авторизации Discord. */
export const DISCORD_ISSUER = 'https://discord.com';

/** Минимально необходимый scope: только идентификация пользователя. */
export const DISCORD_SCOPE = 'identify';

const SNOWFLAKE_PATTERN = /^[0-9]{17,20}$/;
const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{1,512}$/;

/**
 * Преобразует неуспешный HTTP-ответ Discord во внутреннюю ошибку.
 *
 * @param {{status: number, headers: Headers, data: unknown}} response
 * @param {string} operation
 * @returns {ExternalApiError}
 */
function toDiscordError(response, operation) {
  const { status, headers, data } = response;

  if (status === 429) {
    return new ExternalApiError('Discord временно ограничил число запросов. Повторите попытку позже.', {
      code: 'discord_rate_limited',
      service: SERVICE,
      status,
      retryAfterMs: parseRetryAfterMs(headers.get('retry-after')),
    });
  }

  if (status >= 500) {
    return new ExternalApiError('Discord временно недоступен.', {
      code: 'discord_unavailable',
      service: SERVICE,
      status,
    });
  }

  // invalid_grant: код авторизации просрочен, уже использован или не совпадает с PKCE.
  if (operation === 'token' && status === 400 && isPlainObject(data) && data.error === 'invalid_grant') {
    return new ExternalApiError('Код авторизации Discord недействителен или устарел. Войдите заново.', {
      code: 'discord_invalid_grant',
      service: SERVICE,
      status,
    });
  }

  if (status === 401 || status === 403) {
    return new ExternalApiError('Discord отклонил запрос авторизации.', {
      code: 'discord_unauthorized',
      service: SERVICE,
      status,
    });
  }

  return new ExternalApiError('Discord отклонил запрос.', {
    code: 'discord_request_failed',
    service: SERVICE,
    status,
  });
}

function invalidResponse(status) {
  return new ExternalApiError('Discord вернул ответ неожиданного формата.', {
    code: 'discord_invalid_response',
    service: SERVICE,
    status,
  });
}

/**
 * Проверяет ответ token endpoint.
 *
 * @param {unknown} data
 * @param {number} status
 * @returns {{accessToken: string, tokenType: string, expiresIn: number, refreshToken: string|null, scope: string}}
 */
function parseTokenResponse(data, status) {
  if (!isPlainObject(data)) {
    throw invalidResponse(status);
  }

  const { access_token: accessToken, token_type: tokenType, expires_in: expiresIn } = data;

  if (typeof accessToken !== 'string' || !ACCESS_TOKEN_PATTERN.test(accessToken)) {
    throw invalidResponse(status);
  }

  if (typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer') {
    throw invalidResponse(status);
  }

  if (!Number.isSafeInteger(expiresIn) || expiresIn <= 0) {
    throw invalidResponse(status);
  }

  const scope = typeof data.scope === 'string' ? data.scope : '';

  // Discord обязан выдать как минимум запрошенный scope identify.
  if (!scope.split(' ').includes(DISCORD_SCOPE)) {
    throw invalidResponse(status);
  }

  return {
    accessToken,
    tokenType: 'Bearer',
    expiresIn,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : null,
    scope,
  };
}

/**
 * Проверяет объект пользователя Discord и оставляет только нужные поля.
 *
 * @param {unknown} data
 * @param {number} status
 * @returns {{id: string, username: string, globalName: string|null}}
 */
function parseUser(data, status) {
  if (!isPlainObject(data)) {
    throw invalidResponse(status);
  }

  const { id, username } = data;

  if (typeof id !== 'string' || !SNOWFLAKE_PATTERN.test(id)) {
    throw invalidResponse(status);
  }

  if (typeof username !== 'string' || username.length < 1 || username.length > 32) {
    throw invalidResponse(status);
  }

  let globalName = null;

  if (typeof data.global_name === 'string' && data.global_name.length > 0 && data.global_name.length <= 32) {
    globalName = data.global_name;
  }

  // Боты не могут проходить пользовательскую авторизацию.
  if (data.bot === true) {
    throw invalidResponse(status);
  }

  return { id, username, globalName };
}

/**
 * Клиент Discord OAuth2 (Authorization Code + PKCE).
 * Токены Discord не сохраняются: после получения профиля они отзываются.
 */
export class DiscordOAuthClient {
  /**
   * @param {{clientId: string, clientSecret: string, redirectUri: string, timeoutMs: number, fetchImpl?: typeof fetch}} options
   */
  constructor({ clientId, clientSecret, redirectUri, timeoutMs, fetchImpl = globalThis.fetch }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  /** Заголовок Basic-аутентификации клиента (client_secret_basic). */
  basicAuthHeader() {
    const credentials = `${encodeURIComponent(this.clientId)}:${encodeURIComponent(this.clientSecret)}`;
    return `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`;
  }

  /**
   * Формирует URL страницы авторизации Discord.
   *
   * @param {{state: string, codeChallenge: string}} params
   * @returns {string}
   */
  buildAuthorizeUrl({ state, codeChallenge }) {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('scope', DISCORD_SCOPE);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('prompt', 'consent');
    return url.toString();
  }

  /**
   * Обменивает код авторизации на access token.
   *
   * @param {{authorizationCode: string, codeVerifier: string}} params
   */
  async exchangeCode({ authorizationCode, codeVerifier }) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorizationCode,
      redirect_uri: this.redirectUri,
      code_verifier: codeVerifier,
    });

    const response = await requestJson({
      service: SERVICE,
      url: TOKEN_URL,
      method: 'POST',
      headers: {
        Authorization: this.basicAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      maxResponseBytes: 16 * 1024,
    });

    if (response.status !== 200) {
      throw toDiscordError(response, 'token');
    }

    return parseTokenResponse(response.data, response.status);
  }

  /**
   * Получает профиль текущего пользователя по access token.
   *
   * @param {string} accessToken
   * @returns {Promise<{id: string, username: string, globalName: string|null}>}
   */
  async fetchCurrentUser(accessToken) {
    const response = await requestJson({
      service: SERVICE,
      url: CURRENT_USER_URL,
      headers: { Authorization: `Bearer ${accessToken}` },
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      maxResponseBytes: 64 * 1024,
    });

    if (response.status !== 200) {
      throw toDiscordError(response, 'user');
    }

    return parseUser(response.data, response.status);
  }

  /**
   * Отзывает токен Discord. Discord отзывает связанную пару access/refresh.
   *
   * @param {string} token
   * @returns {Promise<void>}
   */
  async revokeToken(token) {
    const response = await requestJson({
      service: SERVICE,
      url: REVOKE_URL,
      method: 'POST',
      headers: {
        Authorization: this.basicAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ token, token_type_hint: 'access_token' }),
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      maxResponseBytes: 16 * 1024,
    });

    if (response.status !== 200) {
      throw toDiscordError(response, 'revoke');
    }
  }
}
