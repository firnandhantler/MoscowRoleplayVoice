import assert from 'node:assert/strict';
import test from 'node:test';
import { ProximityEngine, pairKey, splitKey } from '../src/proximity/engine.js';

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

/**
 * @param {string} userId
 * @param {string} robloxId
 */
function createPeer(userId, robloxId) {
  return {
    userId,
    robloxId,
    discordId: '111111111111111111',
    discordUsername: `user${userId}`,
    producers: new Map([['proximity', { id: `producer-${userId}`, appData: { userId } }]]),
    consumers: new Map(),
  };
}

function createVoiceManager(peers) {
  let counter = 0;
  return {
    listPeers: () => [...peers.values()],
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
        consumer: { id, kind: 'audio', rtpParameters: { codecs: [] } },
      };
    },
    closeConsumer(consumerPeer, consumerId) {
      const entry = consumerPeer.consumers.get(consumerId);

      if (!entry) {
        return null;
      }

      consumerPeer.consumers.delete(consumerId);
      return {
        peerUserId: consumerPeer.userId,
        consumerId,
        producerId: entry.producerId,
        source: entry.source,
      };
    },
  };
}

function createGameState(positions, { stale = false } = {}) {
  return {
    isStale: () => stale,
    getPlayer: (robloxId) =>
      positions.has(robloxId)
        ? { robloxId, position: positions.get(robloxId), stale }
        : null,
  };
}

function createEngine({ positions, peers, stale = false, options = {} }) {
  const voiceManager = createVoiceManager(peers);
  const engine = new ProximityEngine({
    gameState: createGameState(positions, { stale }),
    voiceManager,
    logger,
    maxDistance: 30,
    hysteresis: 5,
    maxNeighbors: 16,
    intervalMs: 500,
    ...options,
  });

  return { engine, voiceManager };
}

test('пара в пределах дистанции получает по одному Consumer в обе стороны', async () => {
  const peers = new Map([
    ['1', createPeer('1', '101')],
    ['2', createPeer('2', '102')],
  ]);
  const positions = new Map([
    ['101', { x: 0, z: 0 }],
    ['102', { x: 10, z: 0 }],
  ]);

  const { engine } = createEngine({ positions, peers });
  await engine.reconcile();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(engine.getStatus().edges, 1);
  assert.equal(peers.get('1').consumers.size, 1);
  assert.equal(peers.get('2').consumers.size, 1);
});

test('пара за пределами дистанции не соединяется', async () => {
  const peers = new Map([
    ['1', createPeer('1', '101')],
    ['2', createPeer('2', '102')],
  ]);
  const positions = new Map([
    ['101', { x: 0, z: 0 }],
    ['102', { x: 100, z: 0 }],
  ]);

  const { engine } = createEngine({ positions, peers });
  await engine.reconcile();

  assert.equal(engine.getStatus().edges, 0);
  assert.equal(peers.get('1').consumers.size, 0);
});

test('гистерезис удерживает связь чуть дальше дистанции слышимости', async () => {
  const peers = new Map([
    ['1', createPeer('1', '101')],
    ['2', createPeer('2', '102')],
  ]);
  const positions = new Map([
    ['101', { x: 0, z: 0 }],
    ['102', { x: 10, z: 0 }],
  ]);

  const { engine } = createEngine({ positions, peers });
  await engine.reconcile();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(engine.getStatus().edges, 1);

  // 33 > 30, но меньше 35 (30 + 5) — связь должна сохраниться.
  positions.set('102', { x: 33, z: 0 });
  await engine.reconcile();
  assert.equal(engine.getStatus().edges, 1);

  // 40 > 35 — связь разрывается, Consumers закрываются.
  positions.set('102', { x: 40, z: 0 });
  await engine.reconcile();
  assert.equal(engine.getStatus().edges, 0);
  assert.equal(peers.get('1').consumers.size, 0);
});

test('новые пары за пределами maxDistance + гистерезис не создаются', async () => {
  const peers = new Map([
    ['1', createPeer('1', '101')],
    ['2', createPeer('2', '102')],
  ]);
  const positions = new Map([
    ['101', { x: 0, z: 0 }],
    ['102', { x: 32, z: 0 }],
  ]);

  const { engine } = createEngine({ positions, peers });
  await engine.reconcile();

  assert.equal(engine.getStatus().edges, 0);
});

test('устаревший снимок не меняет граф связей', async () => {
  const peers = new Map([
    ['1', createPeer('1', '101')],
    ['2', createPeer('2', '102')],
  ]);
  const positions = new Map([
    ['101', { x: 0, z: 0 }],
    ['102', { x: 10, z: 0 }],
  ]);

  const voiceManager = createVoiceManager(peers);
  const engine = new ProximityEngine({
    gameState: createGameState(positions, { stale: true }),
    voiceManager,
    logger,
    maxDistance: 30,
    hysteresis: 5,
    maxNeighbors: 16,
    intervalMs: 500,
  });

  await engine.reconcile();

  assert.equal(engine.getStatus().edges, 0);
  assert.equal(peers.get('1').consumers.size, 0);
});

test('выход игрока из игры закрывает связь', async () => {
  const peers = new Map([
    ['1', createPeer('1', '101')],
    ['2', createPeer('2', '102')],
  ]);
  const positions = new Map([
    ['101', { x: 0, z: 0 }],
    ['102', { x: 10, z: 0 }],
  ]);

  const { engine } = createEngine({ positions, peers });
  await engine.reconcile();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(engine.getStatus().edges, 1);

  positions.delete('102');
  await engine.reconcile();

  assert.equal(engine.getStatus().edges, 0);
  assert.equal(peers.get('1').consumers.size, 0);
});

test('лимит соседей оставляет ближайших', async () => {
  const peers = new Map();
  const positions = new Map();

  for (let index = 0; index < 5; index += 1) {
    const userId = String(index + 1);
    peers.set(userId, createPeer(userId, String(100 + index)));
    positions.set(String(100 + index), { x: index * 5, z: 0 });
  }

  const { engine } = createEngine({
    positions,
    peers,
    options: { maxNeighbors: 2 },
  });

  await engine.reconcile();
  await new Promise((resolve) => setImmediate(resolve));

  // Каждая пара ограничена: у каждого участника не больше двух связей.
  for (const peer of peers.values()) {
    assert.ok(peer.consumers.size <= 2);
  }
});

test('пространственная сетка соединяет игроков в соседних ячейках', async () => {
  const peers = new Map([
    ['1', createPeer('1', '101')],
    ['2', createPeer('2', '102')],
  ]);
  // Ячейка 30: точки по разные стороны границы ячеек, но рядом друг с другом.
  const positions = new Map([
    ['101', { x: 29, z: 29 }],
    ['102', { x: 31, z: 31 }],
  ]);

  const { engine } = createEngine({ positions, peers });
  await engine.reconcile();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(engine.getStatus().edges, 1);
});

test('pairKey и splitKey симметричны', () => {
  assert.equal(pairKey('2', '10'), pairKey('10', '2'));
  assert.deepEqual(splitKey(pairKey('2', '10')).sort(), ['10', '2']);
});
