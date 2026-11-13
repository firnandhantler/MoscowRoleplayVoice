-- 0002_accounts_sessions.sql
-- Пользователи и серверные сессии второго этапа.
-- Миграция выполняется раннером в отдельной транзакции, BEGIN/COMMIT здесь не нужны.

-- Пользователи: связка Discord ↔ Roblox.
-- roblox_id может быть NULL до подтверждения связки через Bloxlink.
CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  discord_id TEXT NOT NULL,
  discord_username TEXT NOT NULL,
  discord_global_name TEXT,
  roblox_id TEXT,
  roblox_username TEXT,
  roblox_linked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_discord_id_unique UNIQUE (discord_id),
  CONSTRAINT users_roblox_id_unique UNIQUE (roblox_id),
  CONSTRAINT users_discord_id_format CHECK (discord_id ~ '^[0-9]{17,20}$'),
  CONSTRAINT users_roblox_id_format CHECK (roblox_id IS NULL OR roblox_id ~ '^[1-9][0-9]{0,19}$'),
  CONSTRAINT users_roblox_link_consistency CHECK (
    (roblox_id IS NULL AND roblox_username IS NULL AND roblox_linked_at IS NULL)
    OR (roblox_id IS NOT NULL AND roblox_username IS NOT NULL AND roblox_linked_at IS NOT NULL)
  )
);

COMMENT ON TABLE users IS 'Пользователи: Discord-аккаунт и подтверждённая через Bloxlink связка с Roblox.';
COMMENT ON COLUMN users.discord_id IS 'Discord snowflake ID, получен сервером из Discord API, уникален.';
COMMENT ON COLUMN users.roblox_id IS 'Roblox User ID, подтверждён через Bloxlink, уникален; NULL — связка не подтверждена.';
COMMENT ON COLUMN users.last_login_at IS 'Время последнего успешного входа через Discord.';

-- Серверные сессии.
-- В cookie клиента хранится случайный токен, в базе — только его SHA-256-хеш.
CREATE TABLE user_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT false,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT user_sessions_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT user_sessions_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT user_sessions_expiry_order CHECK (expires_at <= absolute_expires_at),
  CONSTRAINT user_sessions_revoked_consistency CHECK (revoked = (revoked_at IS NOT NULL))
);

COMMENT ON TABLE user_sessions IS 'Серверные сессии. Недействительна, если revoked = true или истёк expires_at/absolute_expires_at.';
COMMENT ON COLUMN user_sessions.token_hash IS 'SHA-256-хеш токена сессии (hex). Сам токен в базе не хранится.';
COMMENT ON COLUMN user_sessions.expires_at IS 'Скользящий срок жизни, продлевается при использовании.';
COMMENT ON COLUMN user_sessions.absolute_expires_at IS 'Абсолютный предел жизни сессии, не продлевается.';

CREATE INDEX idx_user_sessions_user_active ON user_sessions (user_id) WHERE revoked = false;
CREATE INDEX idx_user_sessions_expires_at ON user_sessions (expires_at);
