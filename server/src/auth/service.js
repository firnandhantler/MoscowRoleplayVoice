import { createPkcePair, safeEqual } from '../utils/crypto.js';
import { AppError } from '../utils/errors.js';
import { ExternalApiError } from '../utils/http-client.js';

/** Максимальная длина параметров, приходящих из строки запроса. */
const MAX_PARAM_LENGTH = 512;

function readQueryParam(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PARAM_LENGTH
    ? value
    : null;
}

/**
 * Ошибочный OAuth2-callback: пользователь отказал или Discord вернул ошибку.
 * Сообщение безопасно показывать в браузере.
 *
 * @param {string|null} error
 * @returns {AppError}
 */
function oauthError(error) {
  return new AppError('Вход через Discord был отменён или отклонён. Попробуйте снова.', {
    code: error === 'access_denied' ? 'oauth_access_denied' : 'oauth_error',
    statusCode: 400,
    expose: true,
  });
}

/**
 * Сервис авторизации: Discord OAuth2 (Authorization Code + PKCE), привязка Roblox
 * через Bloxlink и серверные сессии.
 *
 * Ключевые правила:
 * - Discord ID берётся только из ответа Discord API, клиент не может его подставить;
 * - access/refresh token Discord не сохраняются и отзываются сразу после получения профиля;
 * - ошибки Bloxlink не блокируют вход: пользователь просто остаётся без привязки,
 *   а повторная проверка доступна отдельным маршрутом;
 * - `state` и PKCE verifier хранятся на сервере и одноразовы.
 */
export class AuthService {
  /**
   * @param {{
   *   config: Readonly<object>,
   *   logger: import('pino').Logger,
   *   discordClient: import('../discord/client.js').DiscordOAuthClient|null,
   *   bloxlinkClient: import('../bloxlink/client.js').BloxlinkClient|null,
   *   robloxClient: import('../roblox/client.js').RobloxUsersClient|null,
   *   sessionStore: import('./session-store.js').SessionStore,
   *   stateStore: import('./state-store.js').OAuthStateStore,
   *   repository: import('./repository.js').AuthRepository,
   *   now?: () => number,
   * }} options
   */
  constructor({
    config,
    logger,
    discordClient = null,
    bloxlinkClient = null,
    robloxClient = null,
    sessionStore,
    stateStore,
    repository,
    now = Date.now,
  }) {
    this.config = config;
    this.logger = logger.child({ module: 'auth' });
    this.discordClient = discordClient;
    this.bloxlinkClient = bloxlinkClient;
    this.robloxClient = robloxClient;
    this.sessionStore = sessionStore;
    this.stateStore = stateStore;
    this.repository = repository;
    this.now = now;
  }

  /** @returns {boolean} true, если Discord OAuth2 настроен. */
  isEnabled() {
    return this.discordClient !== null;
  }

  /**
   * Начинает вход: выдаёт `state`, создаёт PKCE-пару и URL авторизации Discord.
   *
   * @returns {{url: string, state: string, stateTtlMs: number}}
   */
  startAuthorization() {
    if (!this.isEnabled()) {
      throw new AppError('Авторизация через Discord не настроена на сервере.', {
        code: 'auth_disabled',
        statusCode: 503,
        expose: true,
      });
    }

    const pkce = createPkcePair();
    const { state } = this.stateStore.issue({ codeVerifier: pkce.verifier });
    const url = this.discordClient.buildAuthorizeUrl({
      state,
      codeChallenge: pkce.challenge,
    });

    return { url, state, stateTtlMs: this.stateStore.ttlMs };
  }

  /**
   * Завершает вход по callback от Discord.
   *
   * @param {{
   *   code: unknown,
   *   state: unknown,
   *   stateCookie: unknown,
   *   error?: unknown,
   * }} params
   * @returns {Promise<{token: string, expiresAt: Date, user: object, linkStatus: string}>}
   */
  async completeAuthorization({ code, state, stateCookie, error = null }) {
    if (!this.isEnabled()) {
      throw new AppError('Авторизация через Discord не настроена на сервере.', {
        code: 'auth_disabled',
        statusCode: 503,
        expose: true,
      });
    }

    const stateValue = readQueryParam(state);
    const cookieValue = readQueryParam(stateCookie);

    // Защита от CSRF: state из URL обязан совпадать с cookie этого же браузера.
    // Сравнение выполняется за постоянное время.
    if (stateValue === null || cookieValue === null || !safeEqual(stateValue, cookieValue)) {
      throw new AppError(
        'Проверка безопасности входа не пройдена. Начните вход заново.',
        { code: 'oauth_state_mismatch', statusCode: 400, expose: true },
      );
    }

    // Запись одноразовая: даже при ошибке ниже повторно использовать state нельзя.
    const entry = this.stateStore.consume(stateValue);

    if (entry === null) {
      throw new AppError('Срок действия попытки входа истёк. Начните вход заново.', {
        code: 'oauth_state_expired',
        statusCode: 400,
        expose: true,
      });
    }

    if (error !== null && error !== undefined && error !== '') {
      throw oauthError(typeof error === 'string' ? error : null);
    }

    const codeValue = readQueryParam(code);

    if (codeValue === null) {
      throw new AppError('Discord не передал код авторизации. Начните вход заново.', {
        code: 'oauth_missing_code',
        statusCode: 400,
        expose: true,
      });
    }

    const discordUser = await this.#exchangeCode(codeValue, entry.codeVerifier);
    const link = await this.#resolveRobloxLink(discordUser.id);

    const login = await this.repository.applyDiscordLogin({
      discordId: discordUser.id,
      username: discordUser.username,
      globalName: discordUser.globalName,
      roblox: link.roblox,
    });

    const session = await this.sessionStore.create({ userId: login.user.id });

    this.logger.info(
      {
        userId: login.user.id,
        linkStatus: login.linkStatus,
      },
      'Пользователь вошёл через Discord',
    );

    return {
      token: session.token,
      expiresAt: session.expiresAt,
      user: login.user,
      linkStatus: login.linkStatus,
    };
  }

  /**
   * Обменивает код на токен, получает профиль и сразу отзывает токен Discord.
   *
   * @param {string} code
   * @param {string} codeVerifier
   * @returns {Promise<{id: string, username: string, globalName: string|null}>}
   */
  async #exchangeCode(code, codeVerifier) {
    const tokens = await this.discordClient.exchangeCode({
      authorizationCode: code,
      codeVerifier,
    });

    try {
      return await this.discordClient.fetchCurrentUser(tokens.accessToken);
    } finally {
      // Токены Discord нужны только для чтения профиля и не хранятся.
      // Ошибка отзыва не должна отменять уже успешный вход.
      try {
        await this.discordClient.revokeToken(tokens.accessToken);
      } catch (err) {
        this.logger.warn(
          { code: err?.code ?? 'discord_revoke_failed' },
          'Не удалось отозвать токен Discord после входа',
        );
      }
    }
  }

  /**
   * Проверяет привязку Discord → Roblox через Bloxlink и уточняет Roblox username.
   *
   * Возвращает описание привязки для репозитория. Ошибки внешних сервисов
   * не прерывают вход: пользователь остаётся без изменения привязки.
   *
   * @param {string} discordId
   * @returns {Promise<{roblox: {id: string, username: string}|{unlink: true}|null, linkStatus: string}>}
   */
  async #resolveRobloxLink(discordId) {
    if (this.bloxlinkClient === null) {
      return { roblox: null, linkStatus: 'bloxlink_disabled' };
    }

    let robloxId;

    try {
      robloxId = await this.bloxlinkClient.getRobloxIdByDiscordId(discordId);
    } catch (err) {
      this.logger.warn(
        { code: err?.code ?? 'bloxlink_error' },
        'Не удалось проверить привязку через Bloxlink',
      );

      return { roblox: null, linkStatus: 'bloxlink_unavailable' };
    }

    if (robloxId === null) {
      return { roblox: { unlink: true }, linkStatus: 'not_linked' };
    }

    if (this.robloxClient === null) {
      return { roblox: null, linkStatus: 'roblox_unavailable' };
    }

    let profile;

    try {
      profile = await this.robloxClient.getUserById(robloxId);
    } catch (err) {
      this.logger.warn(
        { code: err?.code ?? 'roblox_error' },
        'Не удалось получить профиль Roblox',
      );

      return { roblox: null, linkStatus: 'roblox_unavailable' };
    }

    if (profile === null) {
      return { roblox: null, linkStatus: 'roblox_user_not_found' };
    }

    return {
      roblox: { id: profile.id, username: profile.name },
      linkStatus: 'linked',
    };
  }

  /**
   * Проверяет сессию по токену cookie.
   *
   * @param {unknown} token
   * @returns {Promise<{user: object, expiresAt: Date}|null>}
   */
  async getSession(token) {
    const session = await this.sessionStore.find(token);

    if (session === null) {
      return null;
    }

    return { user: session.user, expiresAt: session.expiresAt };
  }

  /**
   * Завершает сессию.
   *
   * @param {unknown} token
   * @returns {Promise<boolean>}
   */
  async logout(token) {
    return this.sessionStore.revoke(token);
  }

  /**
   * Повторно проверяет привязку Roblox для авторизованного пользователя.
   * Roblox ID по-прежнему берётся из Bloxlink, а не из запроса клиента.
   *
   * @param {string} userId
   * @returns {Promise<{user: object|null, linkStatus: string}>}
   */
  async relinkRoblox(userId) {
    const current = await this.repository.getUser(userId);

    if (current === null) {
      throw new AppError('Пользователь не найден.', {
        code: 'user_not_found',
        statusCode: 404,
        expose: true,
      });
    }

    const link = await this.#resolveRobloxLink(current.discordId);

    if (link.roblox === null) {
      return { user: current, linkStatus: link.linkStatus };
    }

    const result = await this.repository.updateRobloxLink({
      userId,
      roblox: link.roblox,
    });

    this.logger.info(
      { userId, linkStatus: result.linkStatus },
      'Привязка Roblox перепроверена',
    );

    return { user: result.user, linkStatus: result.linkStatus };
  }
}

/**
 * Преобразует ошибку сервиса в безопасный HTTP-ответ.
 * Наружу не попадают стек, SQL и внутренние детали внешних API.
 *
 * @param {unknown} err
 * @returns {{statusCode: number, code: string, message: string}}
 */
export function toAuthHttpError(err) {
  if (err instanceof ExternalApiError) {
    return {
      statusCode: err.statusCode,
      code: err.code,
      message: err.message,
    };
  }

  if (err instanceof AppError) {
    return {
      statusCode: err.statusCode,
      code: err.code,
      message: err.expose ? err.message : 'Внутренняя ошибка сервера.',
    };
  }

  return {
    statusCode: 500,
    code: 'internal_error',
    message: 'Внутренняя ошибка сервера.',
  };
}
