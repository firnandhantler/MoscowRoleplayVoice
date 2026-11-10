# Разработка на Windows

Документ описывает локальную разработку MoscowRoleplay Voice на Windows 10, обязательные проверки и правила совместной работы. Целевая серверная ОС — Ubuntu Server 24.04 LTS, поэтому все изменения должны оставаться совместимыми с Linux.

## 1. Требования к среде

Проверенные версии инструментов:

| Инструмент | Проверенная версия | Примечание |
|---|---|---|
| Node.js | `24.13.1` | Нужна LTS-ветка Node.js 24 |
| npm | `11.8.0` | Входит в Node.js |
| Git | `2.47.0` | Git for Windows |
| PowerShell | `5.1` | Достаточно для команд ниже |
| Docker Desktop | отсутствовал | Не обязателен для разработки без контейнеров |
| PostgreSQL | `17.11` (переносимый) | Использовался для реальной проверки без Docker |

Дополнительно:

- редактор с поддержкой EditorConfig (`.editorconfig` уже в проекте);
- терминал с кодировкой UTF-8 для корректного отображения русских логов.

### 1.1. Проблема с `npm.ps1`

В некоторых системах политика выполнения PowerShell блокирует `npm.ps1`:

```text
npm.ps1 cannot be loaded because running scripts is disabled on this system
```

Это ограничение среды, а не ошибка проекта. Используйте `npm.cmd`:

```powershell
npm.cmd --version
npm.cmd install
npm.cmd run check
```

Во всех командах документации `npm` можно заменить на `npm.cmd`, если у вас возникает эта ошибка.

### 1.2. Кодировка консоли

Если русский текст в логах отображается как набор символов, переключите кодировку:

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
```

Перенаправленные файлы логов читайте явно:

```powershell
Get-Content .\server.out.log -Encoding UTF8
```

## 2. Первичная настройка

### 2.1. Перейти в корень проекта

```powershell
Set-Location 'C:\Users\maksi\OneDrive\Рабочий стол\MoscowRoleplay Voice'
```

### 2.2. Проверить состояние Git

Перед любыми изменениями:

```powershell
git status
git branch --show-current
```

Не удаляйте и не перезаписывайте чужие незакоммиченные изменения.

### 2.3. Создать `.env`

```powershell
Copy-Item .env.example .env
notepad .env
```

Обязательно замените:

- `POSTGRES_SUPERUSER_PASSWORD` — пароль суперпользователя контейнера PostgreSQL;
- `POSTGRES_PASSWORD` — пароль роли приложения `mrv_app`.

Сгенерировать пароли:

```powershell
function New-StrongPassword {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

"POSTGRES_SUPERUSER_PASSWORD: $(New-StrongPassword)"
"POSTGRES_PASSWORD: $(New-StrongPassword)"
```

Файл `.env` исключён из Git. Никогда не выводите его содержимое в чат, логи и отчёты. В отчётах допустимо указывать только имена переменных.

### 2.4. Установить зависимости

```powershell
Set-Location .\server
npm.cmd install

Set-Location ..\client
npm.cmd install

Set-Location ..
```

`npm ci` использует lock-файлы и подходит для воспроизводимой установки:

```powershell
Set-Location .\server
npm.cmd ci
```

### 2.5. Подготовить PostgreSQL

**Вариант A. Docker Desktop:**

```powershell
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres
```

Порт публикуется только на `127.0.0.1:5432`. Init-скрипт создаёт роль приложения при первом создании тома.

**Вариант B. Локальный PostgreSQL 17:**

Создайте роль и базу под суперпользователем:

```sql
CREATE ROLE mrv_app LOGIN PASSWORD 'сильный_пароль';
CREATE DATABASE moscowroleplay_voice OWNER mrv_app;
```

Укажите в `.env` фактические `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER` и `POSTGRES_PASSWORD`.

**Вариант C. Переносимый PostgreSQL без установки в систему:**

Этот способ использовался при проверке фундамента. Он не требует прав администратора и не изменяет систему:

1. Скачайте официальные Windows-бинарники PostgreSQL 17 с сайта EnterpriseDB.
2. Распакуйте архив во временный каталог.
3. Выполните `initdb` с паролем суперпользователя.
4. Запустите `pg_ctl start` с отдельным портом, например `55432`.
5. Создайте базу и роль приложения.
6. Укажите этот порт в `.env`.

Не храните временные пароли в проекте. Тестовые секреты должны находиться только во временном каталоге вне репозитория.

### 2.6. Применить миграции

```powershell
Set-Location .\server
npm.cmd run migrate
```

Ожидаемый результат при первом запуске:

```json
{"appliedCount":1,"total":1,"msg":"Применение миграций завершено"}
```

При повторном запуске:

```json
{"appliedCount":0,"total":1,"msg":"Применение миграций завершено"}
```

Это подтверждает идемпотентность механизма миграций.

## 3. Команды запуска

### 3.1. Сервер

Режим разработки с автоматическим перезапуском:

```powershell
Set-Location .\server
npm.cmd run dev
```

Обычный запуск:

```powershell
Set-Location .\server
npm.cmd start
```

Сервер читает `.env` из корня проекта. Переменные, уже заданные в окружении, имеют приоритет над файлом.

### 3.2. Electron-клиент

```powershell
Set-Location .\client
npm.cmd start
```

Клиент на текущем этапе — безопасный каркас. Он не подключается к серверу, не запрашивает микрофон и не передаёт голос.

### 3.3. Одновременный запуск

Откройте два терминала PowerShell:

- терминал 1: PostgreSQL и `npm.cmd run dev` в `server`;
- терминал 2: `npm.cmd start` в `client`.

Не запускайте два экземпляра сервера на одном порту: второй завершится с `EADDRINUSE`.

## 4. Команды проверки

### 4.1. Синтаксис

```powershell
Set-Location .\server
npm.cmd run check
```

Скрипт `server/scripts/check-syntax.js` рекурсивно проверяет `server/src`, `server/test`, `server/scripts` и `shared`.

Клиент:

```powershell
Set-Location .\client
npm.cmd run check
```

### 4.2. Тесты

```powershell
Set-Location .\server
npm.cmd test
```

Проверяются:

- валидация конфигурации;
- протокол WebSocket;
- health-check;
- менеджер корректной остановки.

### 4.3. Полная проверка сервера

```powershell
Set-Location .\server
npm.cmd run verify
```

Команда последовательно запускает `check` и `test`.

### 4.4. Health-check

```powershell
curl.exe -i http://127.0.0.1:3000/health
```

Ожидается `HTTP 200` и `status: "ok"`. Если PostgreSQL недоступен — `HTTP 503` и `status: "degraded"`.

### 4.5. Проверка WebSocket

Из каталога `server`:

```powershell
node --input-type=module -e "import WebSocket from 'ws'; const ws = new WebSocket('ws://127.0.0.1:3000/ws'); ws.on('message', (data) => { console.log(data.toString()); ws.close(); });"
```

Ожидается сообщение `server.hello`.

Проверка ping/pong:

```powershell
node --input-type=module -e "import WebSocket from 'ws'; const ws = new WebSocket('ws://127.0.0.1:3000/ws'); ws.on('open', () => ws.send(JSON.stringify({ v: 1, type: 'client.ping', id: 'test_1', data: { nonce: 'hello' } }))); ws.on('message', (data) => { console.log(data.toString()); ws.close(); });"
```

Ожидается `server.hello` и `server.pong` с тем же `id`.

### 4.6. Проверка Docker Compose

При установленном Docker:

```powershell
docker compose config
docker compose build
docker compose up -d
docker compose ps
```

В среде, где создавался фундамент, Docker отсутствовал. Конфигурация Compose проверялась статически: YAML-парсер, наличие сервисов, healthcheck, volume, ограничений логов, TCP/UDP-портов и всех переменных из `.env.example`. Реальная сборка образа не выполнялась.

### 4.7. Проверка mediasoup

```powershell
Set-Location .\server
node --input-type=module -e "import { createWorker } from 'mediasoup'; const worker = await createWorker({ logLevel: 'warn' }); console.log('worker pid:', worker.pid); await worker.close();"
```

На Windows Worker запускался успешно. Это не гарантирует сборку нативных модулей на всех конфигурациях. Для Linux-совместимой проверки используйте Docker или WSL2.

## 5. Структура и правила кода

- Сервер: ES Modules, `import`/`export`, без `require`.
- Клиент: CommonJS для `main.js` и `preload.js`.
- Отступы: 2 пробела.
- Точки с запятой обязательны.
- Строки: одинарные кавычки, кроме JSON и HTML.
- Комментарии и сообщения для пользователя — на русском языке.
- Идентификаторы, имена пакетов и API — на английском.
- Коды ошибок — в стиле `snake_case`.
- Логи — структурированные JSON через `pino`.

Не размещайте бизнес-логику в `server/src/index.js`. Точка входа только собирает компоненты.

Не создавайте фиктивные реализации mediasoup, Discord, Bloxlink или PRC API. Если функция не реализована, она должна отсутствовать и быть задокументирована.

## 6. Правила Git

1. Перед изменениями выполните `git status`.
2. Не трогайте чужие незакоммиченные изменения.
3. Делайте осмысленные коммиты в формате Conventional Commits:

```text
feat: создать фундамент сервера
fix: исправить проверку конфигурации
docs: описать локальный запуск
```

4. Не коммитьте `.env`, секреты, `node_modules`, логи, дампы базы и временные файлы.
5. Не используйте `git reset --hard`, `git push --force` и rebase опубликованной истории без прямого согласия владельца.
6. Не переписывайте историю Git.
7. Перед коммитом проверьте, что попадёт в индекс:

```powershell
git status
git diff --stat
git diff --cached --stat
```

8. Убедитесь, что `.env` игнорируется:

```powershell
git check-ignore -v .env
```

Ожидается строка с правилом из `.gitignore`.

### 6.1. Проверка на секреты

Перед коммитом просмотрите имена файлов и убедитесь, что в индекс не попали:

- `.env` и его локальные варианты;
- `*.pem`, `*.key`, `*.p12`, `*.pfx`;
- `secrets/`, `credentials/`;
- дампы и архивы базы;
- файлы логов и PID-файлы.

Не выводите значения переменных окружения в терминал и отчёты.

## 7. Совместная работа OpenCode и Kilo CLI

Оба инструмента обязаны прочитать `AGENTS.md` перед изменениями.

Порядок работы:

1. Прочитать `AGENTS.md`.
2. Проверить `git status`.
3. Изучить существующие файлы, не перезаписывать их без проверки.
4. Внести изменения.
5. Запустить `npm.cmd run verify` в `server` и `npm.cmd run check` в `client`.
6. Обновить документацию при изменении поведения.
7. Показать список изменённых файлов.
8. Подготовить отдельный коммит.
9. Не переходить к следующему этапу без команды владельца.

Правила для агентов:

- не изменять `opencode.json` и настройки Kilo Gateway без необходимости;
- не создавать конфликтующие конфигурации агентов;
- не имитировать результаты проверок;
- честно сообщать о недоступных инструментах;
- оставлять проект в запускаемом состоянии.

## 8. Отладка типовых проблем

| Симптом | Причина | Решение |
|---|---|---|
| `npm.ps1 cannot be loaded` | Политика PowerShell | Используйте `npm.cmd` |
| `ECONNREFUSED 127.0.0.1:5432` | PostgreSQL не запущен | Запустите базу или проверьте `POSTGRES_PORT` |
| `password authentication failed` | Неверный пароль или старый том | Проверьте `.env`; при необходимости смените пароль роли |
| `EADDRINUSE` | Порт занят | Измените `SERVER_PORT` или остановите лишний процесс |
| `503 degraded` | База недоступна | Смотрите логи `module=database` |
| `Cannot find package 'pino-pretty'` | Нет devDependencies | `npm.cmd install` или `LOG_PRETTY=false` |
| `ERR_MODULE_NOT_FOUND` для `shared/protocol.js` | Повреждена структура `shared` | Проверьте `shared/package.json` и `type: module` |
| Русский текст в логах искажён | Кодировка консоли | `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` |
| `docker: command not found` | Docker не установлен | Установите Docker Desktop с Linux-контейнерами |
| Ошибка сборки mediasoup | Нет prebuilt-бинарника | Используйте Linux-контейнер; Python в проект не добавляется |

### 8.1. Проверка занятого порта

```powershell
Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue |
  Select-Object State, LocalAddress, LocalPort, OwningProcess
```

### 8.2. Остановка зависшего Node.js-процесса

```powershell
Get-Process node -ErrorAction SilentlyContinue |
  Select-Object Id, ProcessName, StartTime
```

Останавливайте только свой процесс, убедившись в его идентификаторе:

```powershell
Stop-Process -Id <PID>
```

Не завершайте процессы других приложений.

## 9. Ограничения локальной среды

- Docker Desktop может отсутствовать; тогда Docker Compose проверяется только статически.
- WSL2 может отсутствовать; тогда Linux-совместимость mediasoup не проверяется локально.
- Windows не доставляет POSIX-сигналы `SIGINT`/`SIGTERM` так же, как Linux. Graceful shutdown проверен unit-тестами; окончательная проверка нужна в Linux/Docker.
- Переносимый PostgreSQL удобен для проверки, но не является рекомендуемым способом эксплуатации.
- Нативная сборка mediasoup на Windows не гарантируется для всех версий Node.js и конфигураций.
- Локальный запуск не заменяет проверку на Ubuntu Server 24.04.

## 10. Чек-лист перед коммитом

- [ ] `git status` просмотрен.
- [ ] `.env` и секреты не в индексе.
- [ ] `node_modules`, логи и временные файлы не в индексе.
- [ ] `npm.cmd run verify` в `server` пройден.
- [ ] `npm.cmd run check` в `client` пройден.
- [ ] Документация обновлена на русском языке.
- [ ] Новые зависимости обоснованы и проверены в npm registry.
- [ ] Границы текущего этапа не нарушены.
- [ ] Изменения оставлены в запускаемом состоянии.
