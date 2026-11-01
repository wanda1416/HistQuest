-- v16：游客身份（挑战链接免注册游玩）：同一游客同一挑战只保留进行中的一局
ALTER TABLE sessions ADD COLUMN guest_id TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_guest ON sessions(guest_id, status);
