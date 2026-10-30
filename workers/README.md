# CF Workers 部署（纯 BS 一体化）

架构见 `docs/TECH-DESIGN.md` §3.1。服务器持有 LLM Key，朋友零配置打开即玩。

## 首次部署

```bash
# 1. 构建（顺序重要：先 build 再起 dev/deploy，assets 清单按启动时目录生成）
npm run build
node scripts/make-seed.mjs        # 人物库种子 → workers/seed.ts

# 2. 登录
npx wrangler login

# 3. 建 D1
cd workers
npx wrangler d1 create hq         # 记下 database_id 填入 wrangler.toml
npx wrangler d1 execute hq --remote --file=schema.sql

# 4. 配密钥与域名
npx wrangler secret put AI_API_KEY        # DeepSeek 等平台的 key
#    编辑 wrangler.toml：AI_BASE_URL / AI_MODEL / routes（你的域名）
#    AI_BASE_URL = "https://api.deepseek.com/v1"
#    AI_MODEL    = "deepseek-chat"

# 5. 发布
npx wrangler deploy
```

首次请求会自动把 184 位人物种子导入 D1（`d1.seeded` 日志）。

## 本地开发

```bash
npm run build && node scripts/make-seed.mjs
cd workers
npx wrangler d1 execute hq --local --file=schema.sql
npx wrangler dev --port 8787 --local     # 读 .dev.vars 里的本地模型配置
```

已知 Windows 坑：wrangler dev 的 assets 监视器可能报 EPERM，
**改前端后必须重启 dev**（先 `npm run build` 再启动），否则新 hash 文件名不在清单里，JS 会被 SPA 回退成 HTML。

## 更新人物库

人物数据以 D1 为准。改了 `data/characters.json` 后重新导入：

```bash
node scripts/make-seed.mjs
# seed 只在空库时生效；更新需先清空或写迁移
npx wrangler d1 execute hq --remote --command "DELETE FROM character_aliases; DELETE FROM characters;"
npx wrangler deploy   # 首个请求会重新播种
```

## 密钥边界

- `AI_API_KEY` 只存 wrangler secret，只在 Worker→LLM 一段使用
- 不出现在日志、响应、前端（与验收 9 一致）
- 管理后台（admin）未迁移到 Workers；人物编辑继续用本地 Node 模式
