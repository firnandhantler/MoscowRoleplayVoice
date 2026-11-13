import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Синхронизация общего протокола между сервером и клиентом.
 *
 * Канонический источник — server/shared/protocol.js.
 * Копия для Electron-клиента — app/shared/protocol.js.
 *
 * Запуск:
 *   npm run shared:sync   — скопировать протокол в app/shared;
 *   npm run shared:check  — проверить, что копии совпадают.
 *
 * Если папка app отсутствует (сервер развёрнут отдельно), проверка
 * пропускается, а синхронизация завершается понятной ошибкой.
 */

const SERVER_ROOT = fileURLToPath(new URL('..', import.meta.url));
const APP_ROOT = join(SERVER_ROOT, '..', 'app');
const SOURCE = join(SERVER_ROOT, 'shared', 'protocol.js');
const TARGET = join(APP_ROOT, 'shared', 'protocol.js');
const checkOnly = process.argv.includes('--check');

/**
 * @param {Buffer} buffer
 * @returns {string}
 */
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function main() {
  if (!existsSync(APP_ROOT)) {
    console.log('app отсутствует: синхронизация протокола пропущена.');
    return;
  }

  let target;

  try {
    target = await readFile(TARGET);
  } catch {
    if (checkOnly) {
      console.log('app/shared отсутствует: проверка синхронизации пропущена.');
      return;
    }

    await mkdir(dirname(TARGET), { recursive: true });
    await copyFile(SOURCE, TARGET);
    console.log('Протокол скопирован: server/shared/protocol.js → app/shared/protocol.js');
    return;
  }

  const source = await readFile(SOURCE);

  if (checkOnly) {
    if (sha256(source) !== sha256(target)) {
      console.error(
        'Копии протокола различаются. Выполните в папке server: npm run shared:sync',
      );
      process.exitCode = 1;
      return;
    }

    console.log('app/shared/protocol.js синхронизирован с server/shared/protocol.js.');
    return;
  }

  await copyFile(SOURCE, TARGET);
  console.log('Протокол скопирован: server/shared/protocol.js → app/shared/protocol.js');
}

main().catch((err) => {
  console.error('Не удалось синхронизировать общий протокол:', err.message);
  process.exitCode = 1;
});
