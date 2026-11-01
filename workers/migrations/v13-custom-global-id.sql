-- v13：自定义题库记录审核通过后复制出的全局条目 id（单人「我的题库」开局按此取谜底）
ALTER TABLE custom_targets ADD COLUMN global_id TEXT;
