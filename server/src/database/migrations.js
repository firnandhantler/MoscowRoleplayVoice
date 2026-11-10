import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../database/migrations/', import.meta.url),
);

// Произвольный, но постоянный идентификатор блокировки PostgreSQL.
// Защищает от одновременного применения миграций несколькими процессами.
const MIGRATION_LOCK_ID = 72420101;

const CREATE_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

/**
 * Применяет SQL-миграции из каталога по порядку.
 *
 * Правила:
 * - имя файла определяет порядок применения;
 * - уже применённую миграцию нельзя изменять;
 * - каждая миграция выполняется в отдельной транзакции;
 * - управление транзакциями внутри SQL-файла запрещено.
 *
 * @param {{database: import('./pool.js').Database, logger: import('pino').Logger, migrationsDir?: string}} options
 * @returns {Promise<{appliedCount: number, total: number}>}
 */
export async function runMigrations({
  database,
  logger,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
}) {
  const log = logger.child({ module: 'migrations' });
  const client = await database.getPool().connect();
  let lockAcquired = false;

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    lockAcquired = true;

    await client.query(CREATE_MIGRATIONS_TABLE_SQL);

    const entries = await readdir(migrationsDir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
      .map((entry) => entry.name)
      .sort();

    const appliedResult = await client.query(
      'SELECT filename, checksum FROM schema_migrations',
    );
    const applied = new Map(
      appliedResult.rows.map((row) => [row.filename, row.checksum]),
    );

    let appliedCount = 0;

    for (const filename of files) {
      const sql = await readFile(join(migrationsDir, filename), 'utf8');

      const checksum = createHash('sha256').update(sql, 'utf8').digest('hex');
      const previousChecksum = applied.get(filename);

      if (previousChecksum !== undefined) {
        if (previousChecksum !== checksum) {
          throw new Error(
            `Миграция ${filename} уже применена, но её содержимое изменилось. ` +
              'Изменять применённые миграции запрещено. Создайте новую миграцию.',
          );
        }

        continue;
      }

      log.info({ filename }, 'Применяю миграцию');

      await client.query('BEGIN');

      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
          [filename, checksum],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }

      appliedCount += 1;
      log.info({ filename }, 'Миграция применена');
    }

    log.info(
      { appliedCount, total: files.length },
      'Применение миграций завершено',
    );

    return { appliedCount, total: files.length };
  } finally {
    let releaseWithError = false;

    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
      } catch (err) {
        releaseWithError = true;
        log.warn({ err }, 'Не удалось снять блокировку миграций');
      }
    }

    // Если блокировку снять не удалось, соединение нужно уничтожить,
    // иначе оно вернётся в пул с удерживаемой блокировкой.
    client.release(releaseWithError);
  }
}
