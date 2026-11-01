-- v14：出题（挑战链接）：share_code 非空 = 已生成挑战；global_id 指向全局库里 retired 的副本
ALTER TABLE custom_targets ADD COLUMN share_code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_share ON custom_targets(share_code);
