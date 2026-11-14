# Архитектура сервера MoscowRoleplay Voice

Документ описывает серверную часть MoscowRoleplay Voice: модули, протокол, потоки данных и границы системы. Клиентская часть находится в `app/` и описана в [../../app/docs/DEVELOPMENT.md](../../app/docs/DEVELOPMENT.md).

Проект рассчитан на один VPS с 1 vCPU и 2 GB RAM, поэтому используется модульный монолит без микросервисов и брокеров сообщений.

## 1. Цели и ограничения

Цели:

- голосовое общение по близости на основе реальных координат ER:LC;
- радиоканалы с серверной проверкой прав;
- вход через Discord и привязка Roblox;
- один процесс, одна база, простая эксплуатация;
- безопасность: клиент не считается доверенным.

Ограничения:

- один экземпляр приложения и один голосовой узел;
- PostgreSQL на том же VPS;
- OAuth state хранится в памяти процесса;
- нет кластера, Redis, RabbitMQ, Kubernetes и Socket.IO;
- нет записи голоса, модерации и админ-панели.

## 2. Почему модульный монолит

1. **Ресурсы.** 1 vCPU и 2 GB RAM недостаточны для множества сервисов и service mesh.
2. **Простота.** Один процесс, один образ, одна база, меньше точек отказа.
3. **Задержка.** Proximity и radio работают с общим состоянием в памяти без сетевых вызовов между модулями.
4. **Будущее разделение.** Голосовой узел можно вынести отдельно, не переписывая HTTP, конфигурацию и базу.

`server/src/index.js` только собирает компоненты и управляет жизненным циклом. Бизнес-логика находится в профильных модулях.

## 3. Компоненты сервера

### 3.1. `config`

Файл: `server/src/config/index.js`.

- Загружает `.env` из папки `server/`; переменные окружения имеют приоритет.
- Проверяет типы, диапазоны, URL, IP-адреса и взаимные ограничения.
- Формирует неизменяемый объект конфигурации.
- Не выводит значения секретов в сообщения об ошибках.

Ключевые проверки:

- `POSTGRES_PASSWORD` не короче 12 символов; в production запрещены заглушки и совпадение с именем роли/базы;
- `SESSION_COOKIE_SECURE=true` обязателен в production;
- `DISCORD_*` задаются вместе или не задаются вовсе;
- `BLOXLINK_API_KEY` требует `DISCORD_GUILD_ID`;
- `PROXIMITY_HYSTERESIS < PROXIMITY_MAX_DISTANCE`;
- `GAME_STATE_STALE_AFTER_MS > GAME_POLL_INTERVAL_MS`;
- `MEDIASOUP_RTC_MIN_PORT <= MEDIASOUP_RTC_MAX_PORT`.

### 3.2. `utils/logger`

Файл: `server/src/utils/logger.js`.

Структурированные JSON-логи `pino` с полями `service`, `version`, `env`. Маскируются пароли, токены, `authorization`, `cookie` и похожие поля. `pino-pretty` используется только вне production.

Правило: не логировать содержимое WebSocket-сообщений, токены, пароли и персональные данные.

### 3.3. `http`

Файлы:

- `server/src/http/server.js` — HTTP-сервер и маршрутизация;
- `server/src/http/respond.js` — JSON, HTML, redirect, cookie-заголовки.

Маршруты:

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/` | краткие сведения о сервисе |
| `GET` | `/health/live` | liveness без проверки PostgreSQL |
| `GET` | `/health/ready` | readiness с проверкой PostgreSQL |
| `GET` | `/health` | совместимость с Docker healthcheck, работает как readiness |
| `GET` | `/auth/discord/start` | начало OAuth2, redirect на Discord |
| `GET` | `/auth/discord/callback` | завершение OAuth2, выдача cookie сессии |
| `GET` | `/auth/session` | текущая сессия или `authenticated: false` |
| `POST` | `/auth/logout` | отзыв сессии |
| `POST` | `/auth/roblox/relink` | повторная проверка привязки через Bloxlink |

Особенности:

- security-заголовки и `X-Request-Id`;
- таймауты запросов и заголовков;
- ограничение частоты запросов к `/auth/*`;
- проверка `Origin` для POST-запросов;
- тело запросов не читается: API, принимающего тело, нет;
- ошибки не раскрывают SQL, стек и параметры подключения.

Liveness возвращает `200`, пока процесс способен обработать запрос. Readiness возвращает `503`, если PostgreSQL недоступен. Информационные блоки `checks.game` и `checks.voice` не влияют на готовность: без PRC или mediasoup сервер продолжает принимать HTTP-запросы.

### 3.4. `websocket`

Файл: `server/src/websocket/server.js`.

WebSocket-шлюз на `ws`:

- тот же HTTP-сервер, путь `WS_PATH`;
- `maxPayload` и запрет двоичных сообщений;
- парсинг и валидация через `server/shared/protocol.js`;
- ограничение частоты и счётчик нарушений;
- heartbeat ping/pong;
- закрытие с кодом `1008` при злоупотреблении;
- корректное закрытие при остановке;
- передача валидированных сообщений в `SignalingService`.

### 3.5. `auth`

Файлы:

- `auth/service.js` — OAuth2, привязка Roblox, проверка сессии;
- `auth/routes.js` — HTTP-маршруты и cookie;
- `auth/session-store.js` — серверные сессии;
- `auth/state-store.js` — одноразовый OAuth state и PKCE verifier;
- `auth/repository.js` — работа с `users`;
- `auth/mappers.js`, `auth/constants.js` — преобразования и имена cookie.

Схема входа:

1. `GET /auth/discord/start` создаёт PKCE-пару и одноразовый `state`.
2. `state` и verifier хранятся в памяти; `state` также записывается в HttpOnly-cookie с путём `/auth`.
3. Пользователь входит в Discord; callback проверяет `state` сравнением за постоянное время.
4. Сервер обменивает код на токен, получает профиль `identify` и сразу отзывает токен Discord.
5. Bloxlink возвращает Roblox ID; Roblox Users API — актуальное имя.
6. Пользователь и связка сохраняются в PostgreSQL.
7. Создаётся серверная сессия: клиенту выдаётся случайный токен, в базе хранится только SHA-256-хеш.
8. Cookie `mrv_session`: `HttpOnly`, `SameSite=Lax`, `Secure` в production, путь `/`.

Сессия имеет скользящий (`SESSION_IDLE_TTL_SECONDS`) и абсолютный (`SESSION_ABSOLUTE_TTL_SECONDS`) срок. Просроченные сессии периодически удаляются.

Ошибки Bloxlink и Roblox не блокируют вход: пользователь остаётся без привязки, а повторная проверка доступна через `/auth/roblox/relink`. Ошибки Discord прерывают вход.

### 3.6. `discord`

Файлы:

- `discord/client.js` — OAuth2-клиент;
- `discord/roles.js` — роли участника через Bot API.

OAuth2 использует Authorization Code + PKCE и scope `identify`. Токены не сохраняются.

Роли проверяются через `GET /guilds/{guild_id}/members/{user_id}` с заголовком `Authorization: Bot ...`. Ответы кэшируются на `DISCORD_ROLES_CACHE_TTL_MS` отдельно по паре `guildId:discordId`.

Список проверяемых серверов собирается из `DISCORD_GUILD_ID` (основной сервер, также используется Bloxlink) и `DISCORD_ROLE_GUILD_IDS` (дополнительные серверы через запятую). Бот должен состоять на каждом из них и иметь право просматривать участников. Пустой список ролей означает открытый канал и не требует бота.

### 3.7. `bloxlink` и `roblox`

- `bloxlink/client.js` вызывает `/guilds/{guildId}/discord-to-roblox/{discordId}` и возвращает только Roblox ID.
- `roblox/client.js` уточняет имя через публичный `https://users.roblox.com`.

Discord ID всегда берётся из ответа Discord API, а не из запроса клиента. Клиент не может подставить чужой Roblox ID.

### 3.8. `prc` и `game`

Файлы:

- `prc/client.js` — адаптер PRC ER:LC API V2;
- `game/state.js` — снимок игрового сервера в памяти;
- `game/poller.js` — единственный опросчик.

PRC-клиент:

- вызывает `GET /v2/server?Players=true` с заголовком `server-key`;
- разбирает `Player: "Name:Id"` и координаты `LocationX`/`LocationZ`;
- код `3002` означает «сервер офлайн», а не ошибку;
- учитывает коды авторизации, лимитов и устаревшего модуля;
- не логирует ключ.

Poller:

- одновременно выполняет не более одного запроса;
- следующий цикл планируется после завершения текущего;
- пропущенные циклы не накапливаются;
- соблюдает `Retry-After` и заголовки лимитов;
- применяет экспоненциальный backoff;
- останавливается при повторном отказе в ключе, чтобы не заблокировать его.

`GameState` хранит текущий снимок и признак устаревания. Устаревший снимок не считается пустым сервером: Proximity Engine разрывает связи, чтобы не создавать ложную тишину или ложную слышимость.

### 3.9. `mediasoup`

Файл: `server/src/mediasoup/manager.js`.

- Один Worker и один Router на процесс.
- Единственный кодек — Opus 48 кГц, стерео, с `useinbandfec`.
- WebRTC-транспорты: UDP и TCP, приоритет UDP, начальный исходящий битрейт 64 кбит/с.
- `listenInfos` использует `MEDIASOUP_LISTEN_IP` и `MEDIASOUP_ANNOUNCED_IP`.
- При смерти Worker голос отключается до перезапуска процесса; остальной сервер продолжает работу.
- `MEDIASOUP_WORKER_COUNT` зарезервирован: сейчас создаётся один Worker.

### 3.10. `voice`

Файл: `server/src/voice/manager.js`.

Управляет ресурсами mediasoup и не знает бизнес-правил:

- `VoicePeer` на пользователя: send/recv транспорты, Producers, Consumers, флаг mute, радиоканал;
- ровно два Producer на пользователя: `proximity` и `radio`;
- лимиты: 2 Producer и 64 Consumer на пользователя;
- создание и замена транспорта;
- закрытие Producer и связанных Consumers;
- `closeConsumersBySource(peer, source)` для сброса только proximity или только radio;
- удаление Peer и возврат списка закрытых входящих потоков.

Server-side микширования нет: клиент присылает два независимых потока с одного микрофона.

### 3.11. `proximity`

Файл: `server/src/proximity/engine.js`.

Алгоритм:

1. Берёт только Peer с активным proximity Producer и валидной позицией из `GameState`.
2. Строит spatial grid со стороной ячейки, равной `PROXIMITY_MAX_DISTANCE`.
3. Проверяет только соседние 3×3 ячейки.
4. Сравнивает квадраты расстояний, без извлечения корня.
5. Создаёт связь на расстоянии `maxDistance`, разрывает только дальше `maxDistance + hysteresis`.
6. Ограничивает число соседей `PROXIMITY_MAX_NEIGHBORS` (ближайшие).
7. Создаёт и закрывает только изменившиеся Consumers.
8. При устаревшем снимке, выходе игрока или отключении клиента закрывает связи.

Граф хранится в памяти. Координаты в PostgreSQL не пишутся.

### 3.12. `radio`

Файлы:

- `server/src/radio/channels.js` — загрузка и валидация `server/config/radio-channels.json`;
- `server/src/radio/engine.js` — доступ, участники, передачи, Consumers.

Модель:

- канал имеет `id`, `name`, `description`, `access`, `restricted`, `priority`;
- `access` — массив групп `{label, guildId, roleIds}`; группа привязана к конкретному Discord-серверу;
- пустой `access` — открытый канал;
- непустой `access` — доступ при наличии хотя бы одной роли хотя бы в одной группе;
- `guildId` группы должен входить в `DISCORD_GUILD_ID` или `DISCORD_ROLE_GUILD_IDS`, иначе конфигурация отклоняется;
- устаревшее поле `roleIds` без `guildId` поддерживается и проверяется на всех настроенных серверах;
- клиенту отправляется только признак `restricted`, без ID ролей и серверов;
- одновременно в канале передаёт только один участник;
- передача ограничена `RADIO_MAX_TRANSMISSION_MS`;
- при входе в канал участник получает Consumer текущего говорящего, если он есть;
- при начале передачи сервер создаёт radio-Consumers всем участникам канала;
- при завершении передачи Consumers закрываются;
- выход из канала закрывает входящие radio-Consumers и освобождает говорящего.

Режим `both-dual`: radio Producer не заменяет proximity Producer. Пользователь может одновременно слышать окружение и радио; приглушение окружения — настройка клиента.

### 3.13. `signaling`

Файл: `server/src/signaling/service.js`.

Прикладной уровень WebSocket:

- `client.authenticate` проверяет токен сессии;
- одно активное соединение на пользователя: новое заменяет старое;
- создаёт `VoicePeer` и отправляет `server.authenticated`;
- обрабатывает транспорты, Producers, mute и радиодействия;
- проверяет принадлежность транспортов и Producers пользователю;
- после пересоздания транспорта сбрасывает прежние Consumers и пересчитывает граф;
- рассылает состояние радио и близости;
- при закрытии соединения освобождает радио, proximity и голосовые ресурсы.

Радиодействия выполняются через `#runRadioOperation`: инициатор получает `server.radio.state` с `id` запроса, а общая рассылка пропускает это соединение, чтобы не дублировать ответ.

### 3.14. `monitoring` и `utils/shutdown`

`monitoring/health.js` формирует liveness и readiness. Readiness включает `database`, `game` и `voice`; готовность определяется только базой.

`utils/shutdown.js` выполняет обработчики в порядке регистрации, не прерывается ошибкой одного из них и принудительно завершает процесс по таймауту. Порядок остановки: proximity → signaling → voice → mediasoup → poller → WebSocket → HTTP → PostgreSQL.

## 4. Общий протокол

Канонический файл: `server/shared/protocol.js`.
Копия клиента: `app/shared/protocol.js`.

Формат:

```json
{
  "v": 1,
  "type": "client.voice.produce",
  "id": "необязательный_идентификатор",
  "data": { }
}
```

Правила:

- `v` обязательна и равна `PROTOCOL_VERSION`;
- `type` входит в белый список;
- `id` — `[A-Za-z0-9_-]`, до 64 символов;
- `data` — только объект;
- неизвестные поля запрещены;
- размер ограничен `WS_MAX_PAYLOAD_BYTES`;
- двоичные сообщения запрещены.

Клиентские типы:

| Тип | Назначение |
|---|---|
| `client.ping` | проверка соединения |
| `client.authenticate` | вход по токену сессии |
| `client.voice.createTransport` | создать send/recv транспорт |
| `client.voice.connectTransport` | подключить DTLS-транспорт |
| `client.voice.produce` | создать Producer `proximity` или `radio` |
| `client.voice.closeProducer` | закрыть свой Producer |
| `client.voice.setMuted` | сообщить о mute |
| `client.radio.join` | войти в канал |
| `client.radio.leave` | выйти из канала |
| `client.radio.startTransmission` | начать передачу |
| `client.radio.stopTransmission` | завершить передачу |

Серверные типы:

| Тип | Назначение |
|---|---|
| `server.hello` | параметры соединения |
| `server.pong` | ответ на ping |
| `server.error` | код и русское сообщение |
| `server.authenticated` | пользователь, RTP capabilities, радио и игра |
| `server.voice.transportCreated` | параметры транспорта |
| `server.voice.transportConnected` | подтверждение подключения |
| `server.voice.produced` | созданный Producer |
| `server.voice.producerClosed` | закрытый Producer |
| `server.voice.consumerCreated` | входящий поток |
| `server.voice.consumerClosed` | закрытие входящего потока |
| `server.voice.muted` | подтверждение mute |
| `server.radio.state` | каналы, участники, говорящий |
| `server.radio.transmission` | начало/конец передачи |
| `server.proximity.state` | количество слышимых игроков |
| `server.game.state` | присутствие и публичные игровые данные |

Синхронизация копий:

```powershell
cd server
npm run shared:sync
npm run shared:check
```

`npm run verify` включает проверку совпадения SHA-256.

## 5. Потоки выполнения

### 5.1. Запуск сервера

```text
index.js
  → loadConfig()
  → createLogger()
  → createDatabase().connect()
  → auth module (если настроен Discord)
  → GameState + PRC poller
  → MediaSoupManager.start()
  → VoiceManager, RadioEngine, ProximityEngine
  → SignalingService
  → createHttpServer()
  → createWebSocketGateway()
  → listen()
  → poller.start(), proximity.start()
  → graceful shutdown
```

Ошибка подключения к PostgreSQL останавливает запуск. Ошибка mediasoup не останавливает сервер: голос отключается, остальные функции работают.

### 5.2. Авторизация

```text
Клиент → /auth/discord/start → Discord
Discord → /auth/discord/callback → проверка state
  → обмен кода на токен → профиль → отзыв токена
  → Bloxlink → Roblox Users API
  → users + user_sessions
  → Set-Cookie mrv_session
Клиент (главный процесс) → читает cookie → /auth/session
```

### 5.3. WebSocket-сообщение

```text
WebSocket frame
  → maxPayload
  → проверка binary
  → ограничение частоты
  → JSON.parse
  → parseClientMessage()
  → SignalingService
  → проверка сессии и прав
  → mediasoup / proximity / radio
  → ответ или server.error
```

### 5.4. Proximity-цикл

```text
PRC poller (500 мс) → GameState
Proximity Engine (500 мс)
  → активные proximity Producers
  → spatial grid
  → квадраты расстояний
  → гистерезис и лимит соседей
  → diff: создать/закрыть Consumers
  → signaling → клиенты
```

### 5.5. Радиопередача

```text
client.radio.startTransmission
  → проверка канала
  → проверка роли (Discord Bot API или открытый канал)
  → повторная проверка занятости
  → radio Producer уже существует
  → Consumers всем участникам
  → server.radio.transmission
  → таймер RADIO_MAX_TRANSMISSION_MS
  → stop / timeout / disconnect
  → закрытие Consumers
```

## 6. Данные и PostgreSQL

Таблицы:

- `service_metadata` — служебная информация;
- `users` — Discord-профиль и связка Roblox;
- `user_sessions` — хеши токенов, сроки, флаг отзыва.

Правила:

- PostgreSQL хранит только долговременные данные;
- координаты, граф близости, состояние передач и метрики живут в памяти;
- миграции forward-only, с контрольными суммами и advisory lock;
- окончательная бизнес-схема может расширяться новыми миграциями.

## 7. Безопасность

- все входящие сообщения валидируются;
- размер и частота ограничены;
- права, расстояние и занятость канала проверяются на сервере;
- токен сессии хранится только в виде хеша;
- OAuth state одноразовый, PKCE обязателен;
- секреты не попадают в логи и ответы;
- PostgreSQL не публикуется наружу;
- health-check не раскрывает внутренние ошибки;
- контейнер работает от пользователя `node`, с `no-new-privileges`.

## 8. Docker и mediasoup

- контекст сборки — папка `server/`; Electron-клиент в образ не попадает;
- PostgreSQL не публикуется наружу;
- сервер публикует TCP-порт приложения и UDP-диапазон mediasoup;
- `server/config/` копируется в образ;
- `server/database/migrations/` копируется в образ;
- healthcheck проверяет readiness;
- логи ограничены `10 MB × 3`;
- bridge-сеть, без `host network`;
- `MEDIASOUP_ANNOUNCED_IP` обязателен на VPS;
- UDP-диапазон должен быть открыт в firewall и security group провайдера.

## 9. Точки масштабирования

1. **Отдельный voice node.** Вынести mediasoup на другой VPS, оставив control plane на основном сервере.
2. **Несколько Worker.** Запускать по Worker на ядро; потребуется доработка `MediaSoupManager`.
3. **Общий OAuth state.** Для нескольких экземпляров control plane перенести state в PostgreSQL или специализированное хранилище.
4. **Разделение Router.** Router на комнату или крупный канал для изоляции нагрузки.
5. **Наблюдаемость.** Метрики, трассировка и централизованные логи при появлении нескольких узлов.
6. **Кэш состояния.** Только после измерений и доказанной необходимости.

Все шаги должны сопровождаться измерениями. Инфраструктура «на будущее» не добавляется.

## 10. Границы текущей реализации

Реализовано: Discord OAuth2, Bloxlink, Roblox Users API, PRC polling, Proximity Engine, Radio Engine, mediasoup signaling, передача голоса, Electron UI, сборка `.exe`, Docker Compose.

Не реализовано:

- кластер и несколько голосовых узлов;
- запись голоса и модерация;
- админ-панель и веб-клиент;
- автоматическое обновление клиента;
- альтернатива Bloxlink без внешнего сервиса;
- мобильная версия.

Внешние интеграции требуют реальных ключей и не имитируются. Если ключ не задан, функция отключается и пишет предупреждение в лог.
