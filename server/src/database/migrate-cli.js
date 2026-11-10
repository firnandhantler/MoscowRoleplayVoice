import { loadConfig } from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import { createDatabase } from './pool.js';
import { runMigrations } from './migrations.js';

let logger;
let database;

try {
  const config = loadConfig();
  logger = createLogger(config);
  database = createDatabase(config, logger);

  await database.connect();
  const result = await runMigrations({ database, logger });

  logger.info(result, 'Миграции успешно применены');
} catch (err) {
  if (logger) {
    logger.fatal({ err }, 'Не удалось выполнить миграции');
  } else {
    console.error(
      JSON.stringify({
        level: 'fatal',
        message: 'Не удалось запустить миграции.',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  process.exitCode = 1;
} finally {
  if (database) {
    try {
      await database.close();
    } catch (err) {
      if (logger) {
        logger.error({ err }, 'Не удалось закрыть пул PostgreSQL');
      }
    }
  }
}
