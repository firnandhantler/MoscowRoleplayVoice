import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOTS = [
  fileURLToPath(new URL('../src/', import.meta.url)),
  fileURLToPath(new URL('../test/', import.meta.url)),
  fileURLToPath(new URL('../scripts/', import.meta.url)),
  fileURLToPath(new URL('../shared/', import.meta.url)),
];

const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build']);

/**
 * Рекурсивно собирает JavaScript-файлы.
 *
 * @param {string} directory
 * @returns {Promise<string[]>}
 */
async function collectJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        files.push(...(await collectJavaScriptFiles(fullPath)));
      }

      continue;
    }

    if (entry.isFile() && extname(entry.name) === '.js') {
      files.push(fullPath);
    }
  }

  return files;
}

const files = (
  await Promise.all(ROOTS.map((root) => collectJavaScriptFiles(root)))
).flat();

let failed = 0;

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    failed += 1;
    console.error(`Синтаксическая ошибка: ${file}`);
    console.error(result.stderr.trim());
  }
}

if (failed > 0) {
  console.error(`Проверка синтаксиса не пройдена: ${failed} файл(ов).`);
  process.exitCode = 1;
} else {
  console.log(`Синтаксис проверен: ${files.length} файл(ов).`);
}
