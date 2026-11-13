import { isIP } from 'node:net';
import { clearCookie, parseCookies, serializeCookie } from '../utils/cookies.js';
import { FixedWindowRateLimiter } from '../utils/rate-limit.js';
import { errorResponse, sendHtml, sendJson, sendRedirect } from '../http/respond.js';
import { OAUTH_STATE_COOKIE_NAME, SESSION_COOKIE_NAME } from './constants.js';
import { toAuthHttpError } from './service.js';

/** Путь, на котором выставляются cookie OAuth2: ограничивает их отправку только маршрутами входа. */
const AUTH_COOKIE_PATH = '/auth';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Страница успешного входа. Не содержит пользовательских данных и внешних ресурсов.
 *
 * @returns {string}
 */
function successPage() {
  return [
    '<!doctype html>',
    '<html lang="ru">',
    '<head><meta charset="utf-8"><title>Вход выполнен</title></head>',
    '<body>',
    '<h1>Вход выполнен</h1>',
    '<p>Можно закрыть эту страницу и вернуться в клиент MoscowRoleplay Voice.</p>',
    '</body>',
    '</html>',
  ].join('');
}

/**
 * Извлекает IP клиента для ограничения частоты запросов.
 * X-Forwarded-For учитывается только при TRUST_PROXY=true.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {boolean} trustProxy
 * @returns {string}
 */
function resolveClientKey(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];

    if (typeof forwarded === 'string' && forwarded.length > 0) {
      const first = forwarded.split(',')[0].trim();

      if (isIP(first) !== 0) {
        return first;
      }
    }
  }

  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * Дочитывает и отбрасывает тело запроса, чтобы соединение можно было использовать дальше.
 *
 * @param {import('node:http').IncomingMessage} req
 */
function drainBody(req) {
  if (req.readableEnded) {
    return;
  }

  req.resume();
}

/**
 * Проверяет Origin у небезопасных методов (POST).
 * Если браузер прислал Origin, он должен совпадать с хостом запроса.
 * Запросы без Origin (curl, тесты, Electron main process) допускаются:
 * сессионная cookie имеет SameSite=Lax и не отправляется с чужих сайтов.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {boolean} trustProxy
 * @returns {boolean}
 */
function isOriginAllowed(req, trustProxy) {
  const origin = req.headers.origin;

  if (origin === undefined || origin === '') {
    return true;
  }

  let parsed;

  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  const forwardedHost = req.headers['x-forwarded-host'];
  const host =
    trustProxy && typeof forwardedHost === 'string' && forwardedHost !== ''
      ? forwardedHost
      : req.headers.host;

  if (typeof host !== 'string' || host === '') {
    return false;
  }

  return parsed.host === host;
}

/**
 * Достаёт токен сессии из cookie или заголовка Authorization: Bearer.
 * Клиент не может передать свой Discord ID — только токен, выданный сервером.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {string|null}
 */
function extractSessionToken(req) {
  const cookies = parseCookies(req.headers.cookie);
  const fromCookie = cookies.get(SESSION_COOKIE_NAME);

  if (typeof fromCookie === 'string' && TOKEN_PATTERN.test(fromCookie)) {
    return fromCookie;
  }

  const authorization = req.headers.authorization;

  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    const token = authorization.slice('Bearer '.length).trim();

    if (TOKEN_PATTERN.test(token)) {
      return token;
    }
  }

  return null;
}

/**
 * Маршрутизатор авторизации.
 *
 * Маршруты:
 * - GET  /auth/discord/start    — начало входа, редирект на Discord;
 * - GET  /auth/discord/callback — завершение входа;
 * - GET  /auth/session          — текущая сессия или { authenticated: false };
 * - POST /auth/logout           — завершение сессии;
 * - POST /auth/roblox/relink    — повторная проверка привязки через Bloxlink.
 */
export class AuthRouter {
  /**
   * @param {{
   *   authService: import('./service.js').AuthService,
   *   config: Readonly<object>,
   *   logger: import('pino').Logger,
   *   rateLimiter?: FixedWindowRateLimiter,
   * }} options
   */
  constructor({ authService, config, logger, rateLimiter = null }) {
    this.authService = authService;
    this.config = config;
    this.logger = logger.child({ module: 'auth-routes' });
    this.trustProxy = config.auth?.trustProxy === true;
    this.cookieSecure = config.auth?.cookieSecure === true;
    this.sessionIdleTtlSeconds = config.auth?.sessionIdleTtlSeconds ?? 7 * 24 * 60 * 60;
    this.postLoginRedirectUrl = config.auth?.postLoginRedirectUrl ?? null;
    this.stateTtlSeconds = config.auth?.stateTtlSeconds ?? 600;
    this.rateLimiter =
      rateLimiter ??
      new FixedWindowRateLimiter({
        maxRequests: config.auth?.rateLimitMaxRequests ?? 20,
        windowMs: config.auth?.rateLimitWindowMs ?? 60_000,
      });
  }

  /**
   * Cookie с состоянием входа: HttpOnly, привязана к пути /auth.
   *
   * @param {string} state
   * @returns {string}
   */
  #stateCookie(state) {
    return serializeCookie(OAUTH_STATE_COOKIE_NAME, state, {
      maxAgeSeconds: this.stateTtlSeconds,
      httpOnly: true,
      secure: this.cookieSecure,
      sameSite: 'Lax',
      path: AUTH_COOKIE_PATH,
    });
  }

  /** @returns {string} */
  #clearStateCookie() {
    return clearCookie(OAUTH_STATE_COOKIE_NAME, {
      secure: this.cookieSecure,
      sameSite: 'Lax',
      path: AUTH_COOKIE_PATH,
    });
  }

  /**
   * @param {string} token
   * @returns {string}
   */
  #sessionCookie(token) {
    return serializeCookie(SESSION_COOKIE_NAME, token, {
      maxAgeSeconds: this.sessionIdleTtlSeconds,
      httpOnly: true,
      secure: this.cookieSecure,
      sameSite: 'Lax',
      path: '/',
    });
  }

  /** @returns {string} */
  #clearSessionCookie() {
    return clearCookie(SESSION_COOKIE_NAME, {
      secure: this.cookieSecure,
      sameSite: 'Lax',
      path: '/',
    });
  }

  /**
   * Проверяет ограничение частоты. Возвращает null, если запрос можно продолжать.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} bucket
   * @returns {boolean} true — лимит превышен, ответ уже отправлен.
   */
  #rateLimited(req, res, bucket) {
    const key = `${bucket}:${resolveClientKey(req, this.trustProxy)}`;
    const result = this.rateLimiter.consume(key);

    if (result.allowed) {
      return false;
    }

    const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));

    this.logger.warn({ bucket }, 'Превышен лимит запросов к маршрутам авторизации');

    sendJson(
      res,
      429,
      {
        error: {
          code: 'rate_limited',
          message: 'Слишком много попыток. Повторите позже.',
        },
      },
      { 'Retry-After': String(retryAfterSeconds) },
    );

    return true;
  }

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {unknown} err
   * @param {string[]} cookies
   */
  #sendAuthError(res, err, cookies = []) {
    const safe = toAuthHttpError(err);

    this.logger.warn({ code: safe.code, statusCode: safe.statusCode }, 'Ошибка авторизации');

    sendJson(
      res,
      safe.statusCode,
      { error: { code: safe.code, message: safe.message } },
      cookies.length > 0 ? { 'Set-Cookie': cookies } : {},
    );
  }

  /**
   * Обрабатывает запрос, если он относится к /auth/*.
   *
   * @param {{
   *   req: import('node:http').IncomingMessage,
   *   res: import('node:http').ServerResponse,
   *   url: URL,
   *   method: string,
   * }} ctx
   * @returns {Promise<boolean>} true, если маршрут обработан.
   */
  async handle({ req, res, url, method }) {
    const path = url.pathname;

    if (!path.startsWith('/auth/')) {
      return false;
    }

    if (method === 'POST') {
      drainBody(req);
    }

    if (path === '/auth/discord/start') {
      if (method !== 'GET') {
        this.#methodNotAllowed(res, 'GET');
        return true;
      }

      if (this.#rateLimited(req, res, 'start')) {
        return true;
      }

      try {
        const { url: authorizeUrl, state } = this.authService.startAuthorization();

        sendRedirect(res, authorizeUrl, {
          statusCode: 302,
          headers: { 'Set-Cookie': this.#stateCookie(state) },
        });
      } catch (err) {
        this.#sendAuthError(res, err);
      }

      return true;
    }

    if (path === '/auth/discord/callback') {
      if (method !== 'GET') {
        this.#methodNotAllowed(res, 'GET');
        return true;
      }

      if (this.#rateLimited(req, res, 'callback')) {
        return true;
      }

      const cookies = parseCookies(req.headers.cookie);
      const stateCookie = cookies.get(OAUTH_STATE_COOKIE_NAME) ?? null;

      try {
        const result = await this.authService.completeAuthorization({
          code: url.searchParams.get('code'),
          state: url.searchParams.get('state'),
          stateCookie,
          error: url.searchParams.get('error'),
        });

        const setCookies = [this.#sessionCookie(result.token), this.#clearStateCookie()];

        if (this.postLoginRedirectUrl !== null) {
          sendRedirect(res, this.postLoginRedirectUrl, {
            statusCode: 303,
            headers: { 'Set-Cookie': setCookies },
          });
        } else {
          sendHtml(res, 200, successPage(), { 'Set-Cookie': setCookies });
        }
      } catch (err) {
        this.#sendAuthError(res, err, [this.#clearStateCookie()]);
      }

      return true;
    }

    if (path === '/auth/session') {
      if (method !== 'GET') {
        this.#methodNotAllowed(res, 'GET');
        return true;
      }

      if (!this.authService.isEnabled()) {
        sendJson(res, 200, { authenticated: false, authEnabled: false });
        return true;
      }

      try {
        const session = await this.authService.getSession(extractSessionToken(req));

        if (session === null) {
          sendJson(res, 200, { authenticated: false, authEnabled: true });
          return true;
        }

        sendJson(res, 200, {
          authenticated: true,
          authEnabled: true,
          user: session.user,
          expiresAt:
            session.expiresAt instanceof Date
              ? session.expiresAt.toISOString()
              : session.expiresAt,
        });
      } catch (err) {
        this.#sendAuthError(res, err);
      }

      return true;
    }

    if (path === '/auth/logout') {
      if (method !== 'POST') {
        this.#methodNotAllowed(res, 'POST');
        return true;
      }

      if (!isOriginAllowed(req, this.trustProxy)) {
        sendJson(res, 403, {
          error: { code: 'invalid_origin', message: 'Источник запроса не разрешён.' },
        });
        return true;
      }

      if (this.#rateLimited(req, res, 'logout')) {
        return true;
      }

      try {
        const revoked = await this.authService.logout(extractSessionToken(req));

        sendJson(
          res,
          200,
          { ok: true, revoked },
          { 'Set-Cookie': this.#clearSessionCookie() },
        );
      } catch (err) {
        this.#sendAuthError(res, err, [this.#clearSessionCookie()]);
      }

      return true;
    }

    if (path === '/auth/roblox/relink') {
      if (method !== 'POST') {
        this.#methodNotAllowed(res, 'POST');
        return true;
      }

      if (!isOriginAllowed(req, this.trustProxy)) {
        sendJson(res, 403, {
          error: { code: 'invalid_origin', message: 'Источник запроса не разрешён.' },
        });
        return true;
      }

      if (this.#rateLimited(req, res, 'relink')) {
        return true;
      }

      try {
        const session = await this.authService.getSession(extractSessionToken(req));

        if (session === null) {
          sendJson(res, 401, {
            error: { code: 'not_authenticated', message: 'Требуется вход через Discord.' },
          });
          return true;
        }

        const result = await this.authService.relinkRoblox(session.user.id);

        sendJson(res, 200, {
          ok: true,
          linkStatus: result.linkStatus,
          user: result.user ?? session.user,
        });
      } catch (err) {
        this.#sendAuthError(res, err);
      }

      return true;
    }

    sendJson(res, 404, {
      error: { code: 'not_found', message: 'Маршрут не найден.' },
    });

    return true;
  }

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {'GET'|'POST'} allowed
   */
  #methodNotAllowed(res, allowed) {
    const error = errorResponse(
      405,
      'method_not_allowed',
      `Для этого маршрута разрешён только метод ${allowed}.`,
      { Allow: allowed },
    );

    sendJson(res, error.statusCode, error.payload, error.headers);
  }
}

/**
 * @param {ConstructorParameters<typeof AuthRouter>[0]} options
 * @returns {AuthRouter}
 */
export function createAuthRouter(options) {
  return new AuthRouter(options);
}
