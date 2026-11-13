import * as mediasoup from 'mediasoup';
import { AppError } from '../utils/errors.js';

/**
 * Единственный аудиокодек проекта — Opus.
 * Видео и микширование не используются, поэтому список кодеков минимален:
 * это снижает нагрузку на CPU VPS с одним vCPU.
 */
export const MEDIA_CODECS = Object.freeze([
  Object.freeze({
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    parameters: Object.freeze({
      useinbandfec: 1,
      minptime: 10,
    }),
  }),
]);

const TRANSPORT_OPTIONS = Object.freeze({
  enableUdp: true,
  enableTcp: true,
  preferUdp: true,
  initialAvailableOutgoingBitrate: 64_000,
});

/**
 * Управляет жизненным циклом mediasoup Worker и Router.
 *
 * Один Worker на один vCPU (MEDIASOUP_WORKER_COUNT в конфигурации).
 * Router создаётся один на процесс: все пользователи обслуживаются общим SFU.
 */
export class MediaSoupManager {
  /**
   * @param {{config: Readonly<object>, logger: import('pino').Logger}} options
   */
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger.child({ module: 'mediasoup' });
    this.worker = null;
    this.router = null;
    this.closed = false;
    this.startedAt = null;
  }

  /**
   * Создаёт Worker и Router. Повторный вызов безопасен.
   *
   * @returns {Promise<void>}
   */
  async start() {
    if (this.router !== null) {
      return;
    }

    if (this.closed) {
      throw new AppError('Медиасервер уже остановлен.', {
        code: 'mediasoup_closed',
        statusCode: 503,
      });
    }

    const worker = await mediasoup.createWorker({
      logLevel: this.config.nodeEnv === 'production' ? 'warn' : 'error',
      rtcMinPort: this.config.mediasoup.rtcMinPort,
      rtcMaxPort: this.config.mediasoup.rtcMaxPort,
    });

    worker.on('died', (error) => {
      this.logger.error(
        { err: error },
        'mediasoup Worker завершился. Голос недоступен до перезапуска сервера',
      );
      this.worker = null;
      this.router = null;
    });

    const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });

    this.worker = worker;
    this.router = router;
    this.startedAt = Date.now();

    this.logger.info(
      {
        pid: worker.pid,
        rtcMinPort: this.config.mediasoup.rtcMinPort,
        rtcMaxPort: this.config.mediasoup.rtcMaxPort,
        announcedIp: this.config.mediasoup.announcedIp,
      },
      'mediasoup Worker и Router созданы',
    );
  }

  /** @returns {boolean} */
  isReady() {
    return this.router !== null;
  }

  /**
   * @returns {object|null} RTP capabilities Router.
   */
  getRtpCapabilities() {
    return this.router === null ? null : this.router.rtpCapabilities;
  }

  /** @returns {import('mediasoup').types.Router|null} */
  getRouter() {
    return this.router;
  }

  /**
   * Создаёт WebRTC-транспорт для пользователя.
   *
   * @param {{direction: 'send'|'recv'}} params
   * @returns {Promise<import('mediasoup').types.WebRtcTransport>}
   */
  async createWebRtcTransport({ direction }) {
    if (this.router === null) {
      throw new AppError('Голосовой сервер временно недоступен.', {
        code: 'voice_unavailable',
        statusCode: 503,
        expose: true,
      });
    }

    const announced = this.config.mediasoup.announcedIp;
    const listenInfos = [
      {
        protocol: 'udp',
        ip: this.config.mediasoup.listenIp,
        ...(announced ? { announcedAddress: announced } : {}),
      },
      {
        protocol: 'tcp',
        ip: this.config.mediasoup.listenIp,
        ...(announced ? { announcedAddress: announced } : {}),
      },
    ];

    const transport = await this.router.createWebRtcTransport({
      listenInfos,
      ...TRANSPORT_OPTIONS,
      appData: { direction },
    });

    transport.on('dtlsstatechange', (state) => {
      if (state === 'closed') {
        transport.close();
      }
    });

    transport.on('@close', () => {
      this.logger.debug({ transportId: transport.id }, 'WebRTC-транспорт закрыт');
    });

    return transport;
  }

  /**
   * Проверяет, может ли получатель потребить поток производителя.
   *
   * @param {{producerId: string, rtpCapabilities: object}} params
   * @returns {boolean}
   */
  canConsume({ producerId, rtpCapabilities }) {
    if (this.router === null) {
      return false;
    }

    return this.router.canConsume({ producerId, rtpCapabilities });
  }

  /** Состояние для health-check. */
  getStatus() {
    return {
      ready: this.isReady(),
      workerPid: this.worker?.pid ?? null,
      startedAt: this.startedAt === null ? null : new Date(this.startedAt).toISOString(),
    };
  }

  /**
   * Корректно закрывает Router и Worker.
   *
   * @returns {Promise<void>}
   */
  async close() {
    if (this.closed) {
      return;
    }

    this.closed = true;

    if (this.router !== null) {
      this.router.close();
      this.router = null;
    }

    if (this.worker !== null) {
      const worker = this.worker;
      this.worker = null;

      try {
        await worker.close();
      } catch (err) {
        this.logger.warn({ err }, 'Не удалось корректно закрыть mediasoup Worker');
      }
    }

    this.logger.info('mediasoup остановлен');
  }
}
