# Модуль voice

Реализован на этапе 5/5.

Назначение:

- mediasoup Worker и Router;
- WebRTC-транспорты send/recv;
- Producers и Consumers;
- согласование Opus и RTP-параметров;
- освобождение ресурсов при отключении и пересоздании транспорта.

Файлы:

- `../mediasoup/manager.js` — Worker, Router, транспорт, RTP capabilities;
- `manager.js` — `VoicePeer`, транспорты, Producers, Consumers, лимиты.

Правила:

- один Worker и один Router на процесс;
- ровно два Producer на пользователя: `proximity` и `radio`;
- не более 64 Consumers на пользователя;
- сервер не доверяет идентификаторам транспортов и Producers от клиента и проверяет принадлежность;
- при смерти Worker голос отключается, остальной сервер продолжает работу;
- `MEDIASOUP_ANNOUNCED_IP` обязателен на VPS;
- `MEDIASOUP_WORKER_COUNT` зарезервирован: сейчас создаётся один Worker.

Docker Compose публикует UDP-диапазон. При установке `mediasoup` скачивает заранее собранный Worker для поддерживаемой платформы; при отсутствии готового бинарника может потребоваться локальная сборка C++. Python в проект не добавляется.
