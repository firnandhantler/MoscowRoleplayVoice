# Модуль auth

Реализован на этапе 5/5.

Назначение:

- Discord OAuth2 Authorization Code + PKCE, scope `identify`;
- одноразовый `state` и PKCE verifier;
- серверные сессии с хранением только SHA-256-хеша токена;
- связывание Discord-аккаунта с Roblox через Bloxlink;
- повторная проверка привязки.

Файлы:

- `service.js` — сценарий входа и привязки;
- `routes.js` — HTTP-маршруты `/auth/*`, cookie и ограничение частоты;
- `session-store.js` — сессии в PostgreSQL;
- `state-store.js` — OAuth state в памяти;
- `repository.js` — таблица `users`;
- `mappers.js`, `constants.js` — преобразования и имена cookie.

Правила:

- Discord ID берётся только из ответа Discord API;
- access/refresh-токены Discord не сохраняются и отзываются после входа;
- `state` сравнивается за постоянное время и используется один раз;
- ошибки Bloxlink и Roblox не блокируют вход;
- секреты не попадают в логи и renderer Electron;
- права определяются на сервере, а не по сообщению клиента.

Ограничение: OAuth state хранится в памяти процесса, поэтому схема рассчитана на один экземпляр сервера.
