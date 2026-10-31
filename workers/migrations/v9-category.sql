-- v9：谜底类别（character / event / item）
-- 三类共用 characters 表；人物专用列对事件/物品填占位值，语义由 category 决定。
-- 老数据默认 'character'，零回填。
-- 只对已上线的库执行一次（ALTER TABLE ADD COLUMN 不可重复执行）。
--   npx wrangler d1 execute hq --remote --file=workers/migrations/v9-category.sql

ALTER TABLE characters ADD COLUMN category TEXT NOT NULL DEFAULT 'character';
ALTER TABLE sessions ADD COLUMN category TEXT NOT NULL DEFAULT 'character';
ALTER TABLE games ADD COLUMN category TEXT NOT NULL DEFAULT 'character';
