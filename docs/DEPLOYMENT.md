# Развёртывание на Ubuntu Server 24.04

Инструкция рассчитана на VPS: 1 vCPU, 2 GB RAM, Ubuntu Server 24.04 LTS, Docker. Проект использует модульный монолит и один контейнер приложения.

> Проверки в текущей среде разработки: Docker отсутствовал, поэтому команды Docker Compose на реальном сервере ещё не выполнялись. Конфигурация проверена статически. Перед публичным запуском выполните инструкцию на тестовом VPS.

## 1. Подготовка сервера

Подключитесь по SSH:

```bash
ssh user@SERVER_IP
```

Обновите систему:

```bash
sudo apt-get update
sudo apt-get upgrade -y
```

Создайте отдельного пользователя для эксплуатации, если его ещё нет:

```bash
sudo adduser mrv
sudo usermod -aG sudo mrv
```

Настройте вход по SSH-ключу и отключите парольный вход, если это допускает ваш провайдер. Не публикуйте приватные ключи в проекте.

## 2. Установка Docker Engine и Docker Compose plugin

Официальные команды для Ubuntu:

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

Выйдите из сессии и войдите снова, чтобы группа применилась. Проверьте:

```bash
docker --version
docker compose version
docker run --rm hello-world
```

Пользователь в группе `docker` фактически получает права root. Ограничьте доступ к серверу.

## 3. Размещение проекта

Рекомендуемый каталог:

```bash
sudo mkdir -p /opt/moscowroleplay-voice
sudo chown mrv:mrv /opt/moscowroleplay-voice
```

Скопируйте проект одним из способов:

```bash
cd /opt
git clone <URL-репозитория> moscowroleplay-voice
```

или через `rsync`/`scp` с рабочей машины. Не копируйте `.env` из чужой среды.

Перейдите в каталог:

```bash
cd /opt/moscowroleplay-voice
```

## 4. Настройка `.env`

Создайте файл из примера:

```bash
cp .env.example .env
chmod 600 .env
```

Сгенерируйте пароли:

```bash
openssl rand -base64 32
openssl rand -base64 32
```

Первый используйте для `POSTGRES_SUPERUSER_PASSWORD`, второй — для `POSTGRES_PASSWORD`. Не используйте заглушки `change_me_*`. В production приложение откажется запускаться, если `POSTGRES_PASSWORD` содержит заглушку или совпадает с `POSTGRES_USER` либо `POSTGRES_DB`.

Обязательно проверьте:

```dotenv
NODE_ENV=development
SERVER_HOST=127.0.0.1
SERVER_PORT=3000
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=5432
POSTGRES_DB=moscowroleplay_voice
POSTGRES_USER=mrv_app
POSTGRES_PASSWORD=...
POSTGRES_SUPERUSER=postgres
POSTGRES_SUPERUSER_PASSWORD=...
# На этапе фундамента можно оставить пустым; заполнить перед голосовым модулем.
MEDIASOUP_ANNOUNCED_IP=
```

В Docker Compose значения `NODE_ENV`, `SERVER_HOST` и `POSTGRES_HOST` переопределяются на production, `0.0.0.0` и `postgres` соответственно. Это нормально.

`MEDIASOUP_ANNOUNCED_IP` на текущем этапе не используется, но должен быть заполнен до реализации голосового модуля. Укажите публичный IPv4 VPS, который видят клиенты. Не указывайте `127.0.0.1` или внутренний IP Docker.

Проверить публичный IP:

```bash
curl -4 https://ifconfig.me
```

Сверьте результат с панелью провайдера. Не полагайтесь только на внешний сервис.

## 5. Firewall и UDP

### 5.1. UFW

Пример:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 3000/tcp
sudo ufw allow 40000:40049/udp
sudo ufw enable
sudo ufw status verbose
```

Порты:

- `22/tcp` — SSH;
- `3000/tcp` — HTTP/WebSocket;
- `40000-40049/udp` — будущий mediasoup RTC.

Если SSH работает на другом порту, сначала разрешите его, чтобы не потерять доступ.

### 5.2. Важно про Docker и UFW

Docker управляет правилами iptables и может публиковать контейнерные порты в обход ожидаемой логики UFW. Поэтому:

- дополнительно настройте firewall/security group у облачного провайдера;
- не публикуйте PostgreSQL;
- до появления TLS-прокси ограничьте доступ к `3000/tcp` по IP или закройте его для публики;
- для будущего production-варианта привяжите порт приложения к `127.0.0.1` и поставьте reverse proxy с TLS.

Пример привязки только к localhost (изменение в `docker-compose.yml` или override-файле):

```yaml
ports:
  - "127.0.0.1:3000:3000/tcp"
```

UDP-диапазон mediasoup должен быть доступен голосовым клиентам напрямую. Если VPS находится за NAT, настройте проброс UDP на уровне провайдера.

### 5.3. Проверка UDP

После запуска контейнеров:

```bash
docker compose ps
sudo ss -lunp | grep -E '400[0-9][0-9]' || true
```

Точная проверка появится после реализации mediasoup signaling. Сейчас важно, чтобы диапазон был разрешён в firewall и опубликован Compose.

### 5.4. PostgreSQL SSL

Для внутренней Docker-сети используется `POSTGRES_SSL=false`: трафик не выходит за пределы bridge-сети, а PostgreSQL не публикуется наружу. Это значение уже задано в `docker-compose.yml` и не требует сертификатов.

Если PostgreSQL вынесен на отдельный сервер или доступен через публичную сеть, включите TLS:

```dotenv
POSTGRES_SSL=true
POSTGRES_SSL_REJECT_UNAUTHORIZED=true
```

Требования к публичному подключению:

- сертификат должен быть выпущен доверенным CA или добавлен в доверенные корневые сертификаты контейнера;
- нельзя отключать проверку сертификата через `POSTGRES_SSL_REJECT_UNAUTHORIZED=false` как постоянное решение;
- не добавляйте фиктивные или самоподписанные сертификаты «для галочки»;
- ограничьте `5432/tcp` в firewall и security group провайдера по IP источника;
- не публикуйте PostgreSQL через Docker Compose без необходимости.

`POSTGRES_SSL=true` не включается автоматически: без корректного TLS-сертификата приложение не сможет подключиться, и это ожидаемое поведение.

## 6. Первый запуск

Соберите образ:

```bash
docker compose build
```

Запустите контейнеры:

```bash
docker compose up -d
```

Проверьте состояние:

```bash
docker compose ps
```

Оба сервиса должны быть `healthy`. PostgreSQL проверяется через `pg_isready`, приложение — через `GET /health` (readiness, включая доступность базы). Liveness без проверки базы доступен через `GET /health/live`.

Примените миграции:

```bash
docker compose exec server node server/src/database/migrate-cli.js
```

Проверьте приложение:

```bash
curl -fsS http://127.0.0.1:3000/health/live
curl -fsS http://127.0.0.1:3000/health/ready
curl -fsS http://127.0.0.1:3000/health
```

`/health/live` должен вернуть `200` независимо от PostgreSQL. `/health/ready` и `/health` возвращают `200` и `status: "ok"` при доступной базе. Если ответ `503`, смотрите логи:

```bash
docker compose logs --tail=100 server
docker compose logs --tail=100 postgres
```

## 7. Просмотр логов

```bash
docker compose logs -f server
docker compose logs -f postgres
```

Логи приложения — структурированный JSON. В production `LOG_PRETTY` принудительно отключён. Ротация настроена в Compose: `10 MB` на файл, до `3` файлов.

Проверить health из контейнера:

```bash
docker compose exec server node server/scripts/healthcheck.js
```

Скрипт обращается к `/health` и проверяет readiness, включая PostgreSQL. Для диагностики только процесса используйте `curl -fsS http://127.0.0.1:3000/health/live`.

## 8. Обновление приложения

Перед обновлением сделайте резервную копию базы (раздел 10).

```bash
cd /opt/moscowroleplay-voice
git pull --ff-only

docker compose build server
docker compose up -d --remove-orphans
docker compose ps
```

Миграции применяются отдельно:

```bash
docker compose exec server node server/src/database/migrate-cli.js
```

Порядок для схемы с обратной совместимостью:

1. Сделать backup.
2. Собрать новый образ.
3. Применить миграции.
4. Перезапустить сервер.
5. Проверить `/health/live`, `/health/ready` и логи.

Миграции в проекте forward-only: откат схемы автоматически не выполняется. Для отката используйте backup или отдельную миграцию.

Очистка старых образов:

```bash
docker image prune -f
```

Не используйте `docker system prune -a --volumes` на рабочем сервере: это может удалить volume с базой.

## 9. Остановка и перезапуск

Остановить без удаления контейнеров и данных:

```bash
docker compose stop
docker compose start
```

Остановить и удалить контейнеры, сохранив volume:

```bash
docker compose down
```

Удалить контейнеры **и данные**:

```bash
docker compose down -v
```

Последняя команда необратима. Используйте её только при осознанном удалении базы.

## 10. Резервное копирование PostgreSQL

### 10.1. Ручной backup

Создайте каталог:

```bash
sudo mkdir -p /var/backups/moscowroleplay-voice
sudo chown mrv:mrv /var/backups/moscowroleplay-voice
```

Создайте дамп в формате custom:

```bash
cd /opt/moscowroleplay-voice

docker compose exec -T postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > /var/backups/moscowroleplay-voice/mrv-$(date +%F-%H%M).dump
```

Проверьте размер и целостность:

```bash
ls -lh /var/backups/moscowroleplay-voice/
pg_restore --list /var/backups/moscowroleplay-voice/mrv-*.dump | head
```

`pg_restore` должен быть установлен на машине, где выполняется проверка. Если его нет, проверьте дамп внутри контейнера:

```bash
docker compose exec -T postgres pg_restore --list < /var/backups/moscowroleplay-voice/mrv-2026-01-01-0300.dump | head
```

### 10.2. Восстановление

**Внимание:** восстановление с `--clean --if-exists` удаляет существующие объекты в целевой базе. Сначала проверьте дамп на тестовой базе.

Остановите приложение:

```bash
docker compose stop server
```

Восстановите:

```bash
docker compose exec -T postgres sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' \
  < /var/backups/moscowroleplay-voice/mrv-2026-01-01-0300.dump
```

Запустите приложение и проверьте health:

```bash
docker compose start server
curl -fsS http://127.0.0.1:3000/health/live
curl -fsS http://127.0.0.1:3000/health/ready
```

### 10.3. Ежедневный backup через cron

Откройте crontab пользователя `mrv`:

```bash
crontab -e
```

Пример запуска в 03:00:

```cron
0 3 * * * cd /opt/moscowroleplay-voice && docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > /var/backups/moscowroleplay-voice/mrv-$(date +\%F-\%H\%M).dump
```

Символы `%` в cron экранируются обратным слешем.

Настройте ротацию старых дампов, например через `find`:

```bash
find /var/backups/moscowroleplay-voice -type f -name '*.dump' -mtime +14 -delete
```

Не храните единственную копию backup на том же VPS. Периодически копируйте дампы на другую машину или в защищённое хранилище.

## 11. Мониторинг ресурсов

Для 1 vCPU и 2 GB RAM:

```bash
docker stats
free -h
df -h
uptime
```

Следите за:

- потреблением памяти PostgreSQL и Node.js;
- размером volume;
- количеством соединений;
- ошибками в логах;
- health-статусом.

После добавления mediasoup потребление памяти вырастет. На 1 vCPU используйте один Worker, пока измерения не покажут необходимость большего.

## 12. Диагностика

### Приложение unhealthy

```bash
docker compose ps
docker compose logs --tail=200 server
docker compose logs --tail=200 postgres
docker compose exec server node server/scripts/healthcheck.js
```

Проверьте:

- запущен ли PostgreSQL;
- совпадают ли `POSTGRES_USER` и `POSTGRES_PASSWORD` с ролью в базе;
- не изменился ли пароль после первого создания volume;
- доступен ли порт внутри Docker-сети.

### PostgreSQL unhealthy

```bash
docker compose exec postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
docker compose logs --tail=200 postgres
```

Если volume создан со старым паролем, изменение `.env` не обновит пароль автоматически. Смените пароль через `psql` или пересоздайте volume (с потерей данных).

### Порт занят

```bash
sudo ss -ltnp | grep ':3000'
```

Измените `SERVER_PORT` в `.env` и перезапустите Compose. Не забудьте обновить firewall и reverse proxy.

### UDP не проходит

Проверьте:

- диапазон в `.env`;
- публикацию в `docker-compose.yml`;
- firewall VPS и облака;
- NAT провайдера;
- правильность `MEDIASOUP_ANNOUNCED_IP`;
- отсутствие конфликта портов.

## 13. Безопасность эксплуатации

- `.env` должен иметь права `600` и принадлежать пользователю эксплуатации.
- Не публикуйте PostgreSQL.
- Не используйте `host network` без доказанной необходимости.
- Не запускайте контейнеры от root.
- Обновляйте Docker и образы.
- Ограничьте SSH по IP и используйте ключи.
- Не храните backup и `.env` в Git.
- Не добавляйте Python и случайные зависимости.
- Перед публичным запуском настройте TLS-прокси и не выставляйте `3000/tcp` всему интернету без необходимости.
- Проверьте, что логи не содержат секретов.

## 14. Чек-лист первого запуска

- [ ] Docker и Compose установлены.
- [ ] `.env` создан, пароли заменены, права `600`.
- [ ] `POSTGRES_PASSWORD` не является заглушкой и не совпадает с `POSTGRES_USER` или `POSTGRES_DB`.
- [ ] `MEDIASOUP_ANNOUNCED_IP` заполнен публичным IP перед развёртыванием голосового модуля; на этапе фундамента допускается пустое значение.
- [ ] Firewall разрешает SSH, TCP-порт приложения и UDP-диапазон.
- [ ] PostgreSQL не опубликован наружу.
- [ ] `docker compose build` завершился успешно.
- [ ] `docker compose up -d` поднял оба сервиса.
- [ ] `docker compose ps` показывает `healthy`.
- [ ] Миграции применены.
- [ ] `GET /health/live` возвращает `200`, а `GET /health/ready` и `GET /health` — `200` и `status: "ok"`.
- [ ] Backup настроен и проверен.
- [ ] Логи не содержат секретов.
