-- v11：谜底表字段精简（facts 合并）——与 src/server/db.ts 迁移 v8 同构
-- 类别化之后人物专用列对事件/物品全是占位值，world_era 与 polity 同语义。
--   facts ← gender/emperor/birthplace/birth_province/country（JSON）
--   world_era → 并入 polity（世界条目时期即身份），旧政权名移入 facts.regime
-- 注意：先删 idx_pick_era（引用 world_era 的索引会阻止 DROP COLUMN）。
-- 只对已上线的库执行一次：
--   npx wrangler d1 execute hq --remote --file=workers/migrations/v11-facts.sql

ALTER TABLE targets ADD COLUMN facts TEXT;

UPDATE targets SET facts = json_object(
  'gender', gender,
  'emperor', emperor,
  'birthplace', birthplace,
  'province', birth_province,
  'country', country
) WHERE facts IS NULL;

UPDATE targets SET polity = world_era,
  facts = json_set(facts, '$.regime', polity)
WHERE region != 'cn' AND world_era IS NOT NULL AND world_era != '';

DROP INDEX IF EXISTS idx_pick_era;

ALTER TABLE targets DROP COLUMN gender;
ALTER TABLE targets DROP COLUMN emperor;
ALTER TABLE targets DROP COLUMN birthplace;
ALTER TABLE targets DROP COLUMN birth_province;
ALTER TABLE targets DROP COLUMN country;
ALTER TABLE targets DROP COLUMN world_era;
