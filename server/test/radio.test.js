import assert from 'node:assert/strict';
import test from 'node:test';
import { RadioEngine } from '../src/radio/engine.js';

const logger = {
  child() {
    return logger;
  },
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
};

const CHANNELS = [
  { id: 'dispatch', name: 'Диспетчерская', description: '', roleIds: ['111111111111111111'], priority: 1 },
  { id: 'open', name: 'Общий', description: '', roleIds: [], priority: 2 },
];

function createProducer(source, userId) {
  return {
    id: `producer-${source}-${userId}`,
    appData: { source, userId },
    paused: true,
    async pause() {
      this.paused = true;
    },
    async resume() {
      this.paused = false;
    },
  };
}

function createPeer(userId, { discordId = '222222222222222222', radioProducer = true } = {}) {
  const peer = {
    userId,
    discordId,
    discordUsername: `user${userId}`,
    robloxId: String(1000 + Number(userId)),
    muted: false,
    radioChannelId: null,
    recvTransport: { id: `recv-${userId}` },
    producers: new Map(),
    consumers: new Map(),
  };

  if (radioProducer) {
    peer.producers.set('radio', createProducer('radio', userId));
    peer.producers.set('proximity', createProducer('proximity', userId));
  }

  return peer;
}

function createVoiceManager(peers) {
  let counter = 0;
  return {
    getPeer: (userId) => peers.get(userId) ?? null,
    getProducer: (peer, source) => peer.producers.get(source) ?? null,
    async createConsumer(consumerPeer, producer, { source }) {
      const id = `consumer-${++counter}`;
      consumerPeer.consumers.set(id, {
        source,
        producerId: producer.id,
        producerUserId: producer.appData.userId,
        consumer: { id },
      });
      return {
        created: true,
        consumer: { id, kind: 'audio', rtpParameters: {} },
      };
    },
    closeConsumersBySource(peer, source) {
      const closed = [];

      for (const [consumerId, entry] of [...peer.consumers]) {
        if (entry.source !== source) {
          continue;
        }

        peer.consumers.delete(consumerId);
        closed.push({
          peerUserId: peer.userId,
          consumerId,
          producerId: entry.producerId,
          source: entry.source,
        });
      }

      return closed;
    },
    closeConsumersOfProducer(producerId) {
      const closed = [];

      for (const peer of peers.values()) {
        for (const [consumerId, entry] of [...peer.consumers]) {
          if (entry.producerId === producerId) {
            peer.consumers.delete(consumerId);
            closed.push({
              peerUserId: peer.userId,
              consumerId,
              producerId,
              source: entry.source,
            });
          }
        }
      }

      return closed;
    },
  };
}

function createEngine({ allowed = true, roleError = false } = {}) {
  const peers = new Map([
    ['1', createPeer('1')],
    ['2', createPeer('2')],
  ]);

  const events = { created: [], closed: [], transmissions: [], states: 0 };

  const roleService = {
    isEnabled: () => true,
    async hasAnyRole() {
      if (roleError) {
        return null;
      }

      return allowed;
    },
  };

  const engine = new RadioEngine({
    channels: CHANNELS,
    roleService,
    voiceManager: createVoiceManager(peers),
    logger,
    maxTransmissionMs: 60_000,
    onStateChanged: () => {
      events.states += 1;
    },
    onTransmissionChanged: (event) => events.transmissions.push(event),
    onConsumerCreated: (event) => events.created.push(event),
    onConsumerClosed: (event) => events.closed.push(event),
  });

  return { engine, peers, events };
}

test('вход в канал по роли Discord разрешён', async () => {
  const { engine, peers } = createEngine();

  await engine.join(peers.get('1'), 'dispatch');

  assert.equal(peers.get('1').radioChannelId, 'dispatch');
  assert.equal(engine.members.get('dispatch').has('1'), true);
});

test('вход в канал без нужной роли запрещён', async () => {
  const { engine, peers } = createEngine({ allowed: false });

  await assert.rejects(
    () => engine.join(peers.get('1'), 'dispatch'),
    /Нет доступа/,
  );

  assert.equal(peers.get('1').radioChannelId, null);
});

test('недоступность проверки ролей не даёт войти в закрытый канал', async () => {
  const { engine, peers } = createEngine({ roleError: true });

  await assert.rejects(
    () => engine.join(peers.get('1'), 'dispatch'),
    /Не удалось проверить роли/,
  );
});

test('канал без ролей доступен авторизованному пользователю', async () => {
  const { engine, peers } = createEngine({ allowed: false });

  await engine.join(peers.get('1'), 'open');

  assert.equal(peers.get('1').radioChannelId, 'open');
});

test('передача создаёт поток у второго участника и завершается по stop', async () => {
  const { engine, peers, events } = createEngine();

  await engine.join(peers.get('1'), 'open');
  await engine.join(peers.get('2'), 'open');

  await engine.startTransmission(peers.get('1'), 'open');

  assert.equal(peers.get('1').producers.get('radio').paused, false);
  assert.equal(events.created.length, 1);
  assert.equal(events.created[0].userId, '2');
  assert.equal(events.created[0].message.source, 'radio');
  assert.equal(engine.speakers.get('open').userId, '1');

  await engine.stopTransmission(peers.get('1'), 'open');

  assert.equal(peers.get('1').producers.get('radio').paused, true);
  assert.equal(peers.get('2').consumers.size, 0);
  assert.equal(engine.speakers.has('open'), false);
  assert.equal(events.closed.length, 1);
  assert.equal(events.transmissions.at(-1).active, false);
});

test('одновременная передача второго участника отклоняется', async () => {
  const { engine, peers } = createEngine();

  await engine.join(peers.get('1'), 'open');
  await engine.join(peers.get('2'), 'open');
  await engine.startTransmission(peers.get('1'), 'open');

  await assert.rejects(
    () => engine.startTransmission(peers.get('2'), 'open'),
    /Канал занят/,
  );
});

test('передача без входа в канал отклоняется', async () => {
  const { engine, peers } = createEngine();

  await assert.rejects(
    () => engine.startTransmission(peers.get('1'), 'open'),
    /Сначала войдите/,
  );
});

test('выключенный микрофон блокирует радиопередачу', async () => {
  const { engine, peers } = createEngine();

  await engine.join(peers.get('1'), 'open');
  peers.get('1').muted = true;

  await assert.rejects(
    () => engine.startTransmission(peers.get('1'), 'open'),
    /Микрофон выключен/,
  );
});

test('передача без созданного радиопотока отклоняется', async () => {
  const { engine, peers } = createEngine();

  peers.get('1').producers.delete('radio');
  await engine.join(peers.get('1'), 'open');

  await assert.rejects(
    () => engine.startTransmission(peers.get('1'), 'open'),
    /Аудиопоток радио не создан/,
  );
});

test('выход из канала закрывает входящие радиопотоки', async () => {
  const { engine, peers, events } = createEngine();

  await engine.join(peers.get('1'), 'open');
  await engine.join(peers.get('2'), 'open');
  await engine.startTransmission(peers.get('1'), 'open');

  assert.equal(peers.get('2').consumers.size, 1);

  await engine.leave(peers.get('2'), 'open');

  assert.equal(peers.get('2').radioChannelId, null);
  assert.equal(peers.get('2').consumers.size, 0);
  assert.equal(events.closed.length, 1);
  assert.equal(events.closed[0].message.channelId, 'open');
  assert.equal(events.closed[0].message.source, 'radio');

  // Говорящий продолжает передачу: выход слушателя её не останавливает.
  assert.equal(engine.speakers.get('open').userId, '1');
});

test('отключение говорящего освобождает канал', async () => {
  const { engine, peers } = createEngine();

  await engine.join(peers.get('1'), 'open');
  await engine.join(peers.get('2'), 'open');
  await engine.startTransmission(peers.get('1'), 'open');

  await engine.handlePeerRemoved(peers.get('1'));

  assert.equal(engine.speakers.has('open'), false);
  assert.equal(engine.members.get('open').has('1'), false);
  assert.equal(peers.get('2').consumers.size, 0);
});

test('клиент не видит чужих ролей и служебных полей', async () => {
  const { engine, peers } = createEngine();

  const state = engine.getStateFor(peers.get('1'));

  assert.equal(state.enabled, true);
  assert.equal(state.channels.length, 2);
  assert.equal(Object.hasOwn(state.channels[0], 'roleIds'), false);
});
