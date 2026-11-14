# Развёртывание сервера на Ubuntu Server 24.04

Инструкция описывает развёртывание MoscowRoleplay Voice на VPS: Ubuntu Server 24.04 LTS, Docker Engine, Docker Compose, PostgreSQL в контейнере, HTTPS reverse proxy и UDP-диапазон mediasoup.

Все команды Docker выполняются из папки `server/`, где находятся `docker-compose.yml`, `Dockerfile` и `.env`. Клиентская часть в серверный образ не копируется.

> Проверки в среде разработки: Docker отсутствовал, поэтому `docker compose build` и запуск контейнеров не выполнялись. Конфигурация проверена статически. Перед публичным запуском обязательно пройдите инструкцию на тестовом VPS.

## 1. Подготовка сервера

```bash
ssh user@SERVER_IP
sudo apt-get update
sudo apt-get upgrade -y
```

Создайте пользователя эксплуатации:

```bash
sudo adduser mrv
sudo usermod -aG sudo mrv
```

Настройте вход по SSH-ключу и отключите парольный вход, если это допускает провайдер. Приватные ключи не должны попадать в проект.

## 2. Установка Docker Engine и Docker Compose plugin

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl

sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y \
  docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin

sudo systemctl enable --now docker
```

Добавьте пользователя в группу Docker:

```bash
sudo usermod -aG docker mrv
```

Выйдите и войдите снова. Проверьте:

```bash
docker --version
docker compose version
docker run --rm hello-world
```

Пользователь в группе `docker` фактически получает права root. Ограничьте доступ к серверу.

## 3. Размещение проекта

```bash
sudo mkdir -p /opt/moscowroleplay-voice
sudo chown mrv:mrv /opt/moscowroleplay-voice

cd /opt
git clone <URL-репозитория> moscowroleplay-voice
cd moscowroleplay-voice/server
```

Не копируйте `.env` из чужой среды. Не коммитьте `.env` в Git.

## 4. Настройка `.env`

```bash
cp .env.example .env
chmod 600 .env
```

Сгенерируйте два пароля:

```bash
openssl rand -base64 32
openssl rand -base64 32
```

Первый — `POSTGRES_SUPERUSER_PASSWORD`, второй — `POSTGRES_PASSWORD`. В production приложение откажется запускаться с заглушкой или с паролем, совпадающим с `POSTGRES_USER`/`POSTGRES_DB`.

Минимально необходимые значения:

```dotenv
NODE_ENV=production

POSTGRES_SUPERUSER=postgres
POSTGRES_SUPERUSER_PASSWORD=...
POSTGRES_DB=moscowroleplay_voice
POSTGRES_USER=mrv_app
POSTGRES_PASSWORD=...

SERVER_HOST=0.0.0.0
SERVER_PORT=3000
TRUST_PROXY=true

DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
DISCORD_REDIRECT_URI=https://voice.example.com/auth/discord/callback
DISCORD_GUILD_ID=...
DISCORD_ROLE_GUILD_IDS=...
DISCORD_BOT_TOKEN=...
BLOXLINK_API_KEY=...
PRC_SERVER_KEY=...

SESSION_COOKIE_SECURE=true

MEDIASOUP_ANNOUNCED_IP=203.0.113.10
```

Пояснения:

- `DISCORD_*` можно оставить пустыми, но тогда вход через Discord отключён, а голосовой клиент не сможет авторизоваться.
- `DISCORD_GUILD_ID` — основной Discord-сервер: нужен Bloxlink и всегда участвует в проверке радиоролей.
- `DISCORD_ROLE_GUILD_IDS` — дополнительные Discord-серверы для радиоролей через запятую. Бот должен состоять на каждом.
- `DISCORD_BOT_TOKEN` нужен только для закрытых радиоканалов.
- `BLOXLINK_API_KEY` нужен для привязки Roblox; без него proximity недоступен.
- `PRC_SERVER_KEY` нужен для координат игроков.
- `MEDIASOUP_ANNOUNCED_IP` — публичный IPv4 VPS. Не `127.0.0.1` и не адрес контейнера.
- `SESSION_COOKIE_SECURE=true` обязателен в production. Вход работает только по HTTPS.

Проверить публичный IP:

```bash
curl -4 https://ifconfig.me
```

Сверьте результат с панелью провайдера.

## 5. Firewall и UDP

### 5.1. UFW

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 40000:40049/udp
sudo ufw enable
sudo ufw status verbose
```

Порты:

- `22/tcp` — SSH;
- `80/tcp` — ACME/redirect на HTTPS;
- `443/tcp` — HTTPS и WebSocket через reverse proxy;
- `40000-40049/udp` — mediasoup RTC;
- `3000/tcp` — только локально для reverse proxy.

Если SSH работает на другом порту, сначала разрешите его.

### 5.2. Docker и UFW

Docker управляет iptables и может публиковать порты в обход UFW. Поэтому:

- настройте firewall/security group у облачного провайдера;
- не публикуйте PostgreSQL;
- привяжите TCP-порт приложения к `127.0.0.1`, если используете reverse proxy;
- UDP-диапазон mediasoup должен быть доступен клиентам напрямую.

Пример `server/docker-compose.proxy.yml`:

```yaml
services:
  server:
    ports: !override
      - "127.0.0.1:${SERVER_PORT:-3000}:${SERVER_PORT:-3000}/tcp"
      - "${MEDIASOUP_RTC_MIN_PORT:-40000}-${MEDIASOUP_RTC_MAX_PORT:-40049}:${MEDIASOUP_RTC_MIN_PORT:-40000}-${MEDIASOUP_RTC_MAX_PORT:-40049}/udp"
```

Тег `!override` обязателен: без него Compose **добавляет** порты из override-файла к базовым, и TCP-порт остаётся опубликованным на всех интерфейсах. Тег поддерживается Docker Compose v2.24.4 и новее; проверьте версию командой `docker compose version`. Если версия старше, измените TCP-строку прямо в `docker-compose.yml`:

```yaml
      - "127.0.0.1:${SERVER_PORT:-3000}:${SERVER_PORT:-3000}/tcp"
```

Запуск из папки `server`:

```bash
docker compose -f docker-compose.yml -f docker-compose.proxy.yml up -d
```

Проверьте итоговую конфигурацию перед запуском:

```bash
docker compose -f docker-compose.yml -f docker-compose.proxy.yml config
```

В блоке `ports` TCP-порт должен быть только с `host_ip: 127.0.0.1`, а UDP-диапазон — опубликован наружу.

### 5.3. Проверка UDP

```bash
docker compose ps
sudo ss -lunp | grep -E '400[0-9][0-9]' || true
```

Реальная проверка голоса требует двух клиентов и открытого UDP-диапазона. Локальный `ss` подтверждает только то, что порты заняты процессом.

### 5.4. PostgreSQL SSL

Внутри Docker-сети используется `POSTGRES_SSL=false`: трафик не выходит за пределы bridge-сети, PostgreSQL не публикуется наружу.

Если база вынесена на отдельный сервер:

```dotenv
POSTGRES_SSL=true
POSTGRES_SSL_REJECT_UNAUTHORIZED=true
```

Требования:

- доверенный сертификат или добавленный в контейнер корневой CA;
- нельзя отключать проверку сертификата как постоянное решение;
- ограничьте `5432/tcp` по IP источника;
- не публикуйте PostgreSQL через Compose без необходимости.

## 6. HTTPS reverse proxy

Для Discord OAuth2 и `Secure`-cookie нужен HTTPS. Пример nginx:

```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

server {
  listen 80;
  server_name voice.example.com;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl http2;
  server_name voice.example.com;

  ssl_certificate     /etc/letsencrypt/live/voice.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/voice.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;

    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;

    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
  }
}
```

После настройки:

```dotenv
TRUST_PROXY=true
DISCORD_REDIRECT_URI=https://voice.example.com/auth/discord/callback
```

`TRUST_PROXY=true` разрешает серверу учитывать `X-Forwarded-For` и `X-Forwarded-Host` при ограничении частоты и проверке Origin. Не включайте его, если прокси нет.

WebSocket идёт по тому же домену и порту `443`, отдельный порт не нужен. UDP-диапазон mediasoup через nginx не проксируется.

## 7. Первый запуск

```bash
cd /opt/moscowroleplay-voice/server

docker compose build
docker compose up -d
docker compose ps
```

Оба сервиса должны быть `healthy`. PostgreSQL проверяется через `pg_isready`, приложение — через readiness.

Примените миграции:

```bash
docker compose exec server node src/database/migrate-cli.js
```

Проверьте приложение:

```bash
curl -fsS http://127.0.0.1:3000/health/live
curl -fsS http://127.0.0.1:3000/health/ready
curl -fsS https://voice.example.com/health/ready
```

Readiness возвращает `200` и `status: "ok"` при доступной базе. Блоки `checks.game` и `checks.voice` могут быть `degraded`, если PRC или mediasoup недоступны, но это не делает сервер неготовым.

Если ответ `503`:

```bash
docker compose logs --tail=100 server
docker compose logs --tail=100 postgres
```

## 8. Настройка интеграций

### 8.1. Discord OAuth2

1. Создайте приложение в Discord Developer Portal.
2. В **OAuth2** добавьте redirect URI:
   `https://voice.example.com/auth/discord/callback`.
3. Заполните `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`.
4. Укажите `DISCORD_GUILD_ID`.
5. Перезапустите сервер:

```bash
docker compose up -d server
```

Проверка: откройте в браузере `https://voice.example.com/auth/discord/start`. Должна открыться страница Discord. Если сервер отвечает `auth_disabled`, переменные OAuth2 заданы не полностью.

### 8.2. Discord-бот

1. Создайте бота в приложении и скопируйте токен в `DISCORD_BOT_TOKEN`.
2. Включите **Server Members Intent**.
3. Пригласите бота на основной сервер `DISCORD_GUILD_ID` и на каждый сервер из `DISCORD_ROLE_GUILD_IDS` с правом просматривать участников.
4. Проверьте, что бот видит участников и роли на всех этих серверах.

Без бота открытые каналы работают, закрытые — нет. В логе будет предупреждение.

### 8.3. Bloxlink

1. Установите Bloxlink на Discord-сервер проекта.
2. Получите ключ Server API в панели Bloxlink.
3. Заполните `BLOXLINK_API_KEY` и `DISCORD_GUILD_ID`.
4. Перезапустите сервер.

Пользователь должен состоять на сервере и иметь привязку Roblox в Bloxlink. Ключ может требовать платного тарифа Bloxlink. Без ключа вход работает, но `robloxId` пуст и proximity недоступен.

### 8.4. PRC ER:LC API V2

1. Получите ключ игрового сервера в панели PRC.
2. Заполните `PRC_SERVER_KEY`.
3. Убедитесь, что `GAME_POLL_ENABLED=true`.
4. Проверьте `checks.game`:

```bash
curl -fsS https://voice.example.com/health/ready | jq '.checks.game'
```

Если `stale: true` или `consecutiveErrors` растёт:

```bash
docker compose logs -f server | grep game
```

### 8.5. Радиоканалы

Отредактируйте `server/config/radio-channels.json` до сборки образа или смонтируйте файл в контейнер. После изменения пересоберите образ или перезапустите сервер с актуальным файлом.

```json
{
  "channels": [
    {
      "id": "police",
      "name": "Полиция",
      "description": "Канал сотрудников полиции",
      "priority": 1,
      "access": [
        {
          "label": "Полиция — основной сервер",
          "guildId": "123456789012345678",
          "roleIds": ["234567890123456789"]
        },
        {
          "label": "Полиция — второй сервер",
          "guildId": "345678901234567890",
          "roleIds": ["456789012345678901"]
        }
      ]
    }
  ]
}
```

Пустой `access` (`[]`) — открытый канал. Для закрытых каналов нужен бот, корректные ID ролей и сервер, входящий в `DISCORD_GUILD_ID` или `DISCORD_ROLE_GUILD_IDS`. Доступ разрешён при наличии хотя бы одной роли хотя бы в одной группе.

Подробный формат, примеры и поиск ID: `server/config/README.md`.

## 9. Сборка и выдача клиента

Клиент собирается отдельно на Windows из папки `app/`:

```powershell
cd app
npm install
npm run dist
```

Результат:

```text
app\release\MoscowRoleplay-Voice-Setup-0.5.1.exe
```

Перед выдачей:

1. Установите клиент на тестовый ПК.
2. Создайте `%APPDATA%\MoscowRoleplay Voice\client-config.json`:

```json
{
  "serverUrl": "https://voice.example.com",
  "wsPath": "/ws"
}
```

3. Убедитесь, что сертификат HTTPS доверен Windows.
4. Проверьте вход, устройства, микрофон и радиоканалы.
5. Раздавайте установщик вместе с инструкцией по `client-config.json`.

Подробнее: [../../app/docs/DEVELOPMENT.md](../../app/docs/DEVELOPMENT.md).

## 10. Обновление приложения

Перед обновлением сделайте backup базы (раздел 12).

```bash
cd /opt/moscowroleplay-voice
git pull --ff-only

cd server
docker compose build server
docker compose up -d --remove-orphans
docker compose ps
```

Миграции:

```bash
docker compose exec server node src/database/migrate-cli.js
```

Порядок:

1. Backup.
2. Сборка нового образа.
3. Применение миграций.
4. Перезапуск сервера.
5. Проверка `/health/live`, `/health/ready` и логов.

Миграции forward-only: автоматического отката нет. Для отката используйте backup или отдельную миграцию.

Очистка старых образов:

```bash
docker image prune -f
```

Не используйте `docker system prune -a --volumes` на рабочем сервере.

## 11. Остановка и перезапуск

Из папки `server`:

```bash
docker compose stop
docker compose start
```

Удалить контейнеры, сохранив volume:

```bash
docker compose down
```

Удалить контейнеры **и данные**:

```bash
docker compose down -v
```

Последняя команда необратима.

## 12. Резервное копирование PostgreSQL

### 12.1. Ручной backup

```bash
sudo mkdir -p /var/backups/moscowroleplay-voice
sudo chown mrv:mrv /var/backups/moscowroleplay-voice

cd /opt/moscowroleplay-voice/server

docker compose exec -T postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > /var/backups/moscowroleplay-voice/mrv-$(date +%F-%H%M).dump
```

Проверка:

```bash
ls -lh /var/backups/moscowroleplay-voice/
docker compose exec -T postgres pg_restore --list < /var/backups/moscowroleplay-voice/mrv-2026-01-01-0300.dump | head
```

### 12.2. Восстановление

**Внимание:** `--clean --if-exists` удаляет существующие объекты в целевой базе. Сначала проверьте дамп на тестовой базе.

```bash
docker compose stop server

docker compose exec -T postgres sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' \
  < /var/backups/moscowroleplay-voice/mrv-2026-01-01-0300.dump

docker compose start server
curl -fsS http://127.0.0.1:3000/health/ready
```

### 12.3. Ежедневный backup через cron

```bash
crontab -e
```

```cron
0 3 * * * cd /opt/moscowroleplay-voice/server && docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > /var/backups/moscowroleplay-voice/mrv-$(date +\%F-\%H\%M).dump
```

Ротация:

```bash
find /var/backups/moscowroleplay-voice -type f -name '*.dump' -mtime +14 -delete
```

Не храните единственную копию backup на том же VPS.

## 13. Мониторинг ресурсов

```bash
docker stats
free -h
df -h
uptime
```

Следите за:

- памятью PostgreSQL и Node.js;
- размером volume;
- количеством соединений;
- ошибками в логах;
- health-статусом;
- `checks.game.lastErrorCode` и `checks.voice.mediasoup.ready`.

mediasoup расходует память на каждого участника и транспорты. На 1 vCPU используйте один Worker, пока измерения не покажут необходимость большего.

## 14. Диагностика

### Приложение unhealthy

```bash
docker compose ps
docker compose logs --tail=200 server
docker compose logs --tail=200 postgres
docker compose exec server node scripts/healthcheck.js
```

Проверьте:

- запущен ли PostgreSQL;
- совпадают ли `POSTGRES_USER` и `POSTGRES_PASSWORD` с ролью в базе;
- не изменился ли пароль после создания volume;
- доступен ли порт внутри Docker-сети.

### PostgreSQL unhealthy

```bash
docker compose exec postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
docker compose logs --tail=200 postgres
```

Если volume создан со старым паролем, изменение `.env` не обновит пароль автоматически.

### Вход не работает

Проверьте:

- `DISCORD_REDIRECT_URI` совпадает с Developer Portal;
- HTTPS настроен, сертификат доверенный;
- `SESSION_COOKIE_SECURE=true`;
- `TRUST_PROXY=true`, если используется прокси;
- `DISCORD_*` заданы все три;
- логи `module=auth-routes` и `module=auth`.

### Голос не подключается

Проверьте:

- `MEDIASOUP_ANNOUNCED_IP` — публичный IP;
- UDP-диапазон открыт в UFW и security group;
- `checks.voice.mediasoup.ready === true`;
- логи `module=mediasoup` и `module=signaling`;
- клиент использует `wss://` и доверенный сертификат.

### Proximity не работает

Проверьте:

- `PRC_SERVER_KEY` задан;
- `checks.game.stale === false`;
- пользователь привязан к Roblox;
- пользователь находится на игровом сервере ER:LC;
- логи `module=game` и `module=proximity`.

### Радио недоступно

Проверьте:

- `RADIO_ENABLED=true`;
- файл `server/config/radio-channels.json` существует в контейнере;
- для закрытых каналов — `DISCORD_BOT_TOKEN`, Server Members Intent и роли;
- `guildId` каждой группы доступа входит в `DISCORD_GUILD_ID` или `DISCORD_ROLE_GUILD_IDS`;
- бот состоит на каждом сервере из этого списка и видит участников;
- логи `module=radio` и `module=discord-roles`.

### Порт занят

```bash
sudo ss -ltnp | grep ':3000'
```

Измените `SERVER_PORT` и обновите reverse proxy.

## 15. Безопасность эксплуатации

- `.env` — права `600`, владелец — пользователь эксплуатации.
- Не публикуйте PostgreSQL.
- Не используйте `host network` без доказанной необходимости.
- Не запускайте контейнеры от root.
- Обновляйте Docker и образы.
- Ограничьте SSH по IP и используйте ключи.
- Не храните backup и `.env` в Git.
- Не добавляйте Python и случайные зависимости.
- Используйте HTTPS и не выставляйте `3000/tcp` всему интернету.
- Проверьте, что логи не содержат секретов.
- Храните ключи Discord, Bloxlink и PRC только в `.env` и менеджере секретов.

## 16. Чек-лист первого запуска

- [ ] Docker и Compose установлены.
- [ ] Проект склонирован, команды выполняются из `server/`.
- [ ] `.env` создан, пароли заменены, права `600`.
- [ ] `POSTGRES_PASSWORD` не является заглушкой.
- [ ] `MEDIASOUP_ANNOUNCED_IP` содержит публичный IPv4.
- [ ] `SESSION_COOKIE_SECURE=true`, HTTPS настроен.
- [ ] `DISCORD_*` заполнены, redirect URI совпадает.
- [ ] `DISCORD_BOT_TOKEN` и Server Members Intent настроены, если нужны закрытые каналы.
- [ ] Бот приглашён на каждый сервер из `DISCORD_GUILD_ID` и `DISCORD_ROLE_GUILD_IDS`.
- [ ] `BLOXLINK_API_KEY` и `DISCORD_GUILD_ID` заполнены, если нужна привязка Roblox.
- [ ] `PRC_SERVER_KEY` заполнен.
- [ ] `server/config/radio-channels.json` содержит корректные каналы и роли.
- [ ] Firewall разрешает SSH, 80/443/tcp и UDP-диапазон.
- [ ] PostgreSQL не опубликован наружу.
- [ ] `docker compose build` завершился успешно.
- [ ] `docker compose up -d` поднял оба сервиса.
- [ ] `docker compose ps` показывает `healthy`.
- [ ] Миграции применены.
- [ ] `/health/live` и `/health/ready` отвечают `200`.
- [ ] Вход через Discord проверен в браузере и в клиенте.
- [ ] Голос проверен двумя клиентами.
- [ ] Backup настроен и проверен.
- [ ] Логи не содержат секретов.
