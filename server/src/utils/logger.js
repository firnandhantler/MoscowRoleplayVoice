import pino from 'pino';

/**
 * Создаёт структурированный логгер.
 * Секреты маскируются, даже если случайно попадут в объект лога.
 *
 * @param {Readonly<object>} config
 * @returns {import('pino').Logger}
 */
export function createLogger(config) {
  const options = {
    level: config.logLevel,
    base: {
      service: config.serviceName,
      version: config.appVersion,
      env: config.nodeEnv,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: {
      paths: [
        'password',
        '*.password',
        '*.*.password',
        'secret',
        '*.secret',
        '*.*.secret',
        'token',
        '*.token',
        '*.*.token',
        'authorization',
        '*.authorization',
        'headers.authorization',
        'headers.cookie',
        'req.headers.authorization',
        'req.headers.cookie',
        'database.password',
        'config.database.password',
        'err.config.password',
        'err.request.headers.authorization',
      ],
      censor: '[REDACTED]',
    },
  };

  if (config.logPretty) {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname,service,version,env',
        },
      },
    });
  }

  return pino(options);
}
