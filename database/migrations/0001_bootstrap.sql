-- 0001_bootstrap.sql
-- Базовая служебная таблица фундамента.
-- Это ещё не бизнес-схема проекта: игровые сущности будут добавлены
-- отдельными миграциями на следующих этапах.

CREATE TABLE IF NOT EXISTS service_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE service_metadata IS
  'Служебные метаданные MoscowRoleplay Voice. Не содержит игровых данных.';

INSERT INTO service_metadata (key, value)
VALUES ('foundation_stage', '1')
ON CONFLICT (key) DO NOTHING;
