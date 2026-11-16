-- 0003_update_verification_comments.sql
-- Обновляет комментарии к таблице users после перехода с Bloxlink
-- на верификацию ER:LC Россия. Схема не меняется.
-- Миграция выполняется раннером в отдельной транзакции, BEGIN/COMMIT здесь не нужны.

COMMENT ON TABLE users IS 'Пользователи: Discord-аккаунт и подтверждённая через ER:LC Россия связка с Roblox.';
COMMENT ON COLUMN users.roblox_id IS 'Roblox User ID, подтверждён через ER:LC Россия, уникален; NULL — связка не подтверждена.';
