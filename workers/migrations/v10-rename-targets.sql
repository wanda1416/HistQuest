-- v10：谜底库表改名 characters → targets（谜底现有 人物/事件/物品 三类）。
-- 前置：v9-category.sql 已执行（本迁移只做 RENAME，不带类别列）。
-- ALTER 不可重复执行：只对还没改名的库跑一次。
--
--   npx wrangler d1 execute hq --remote --file=workers/migrations/v10-rename-targets.sql

ALTER TABLE characters RENAME TO targets;
ALTER TABLE character_aliases RENAME TO target_aliases;
ALTER TABLE target_aliases RENAME COLUMN character_id TO target_id;