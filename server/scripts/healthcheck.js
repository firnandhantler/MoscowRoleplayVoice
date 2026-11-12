/**
 * Docker healthcheck: проверяет GET /health.
 * Маршрут /health является readiness-проверкой и учитывает доступность PostgreSQL.
 * Не требует зависимостей и использует встроенный fetch Node.js.
 */
const host = process.env.HEALTHCHECK_HOST ?? '127.0.0.1';
const port = Number(process.env.SERVER_PORT ?? 3000);

try {
  const response = await fetch(`http://${host}:${port}/health`, {
    signal: AbortSignal.timeout(4000),
    headers: {
      Accept: 'application/json',
    },
  });

  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
