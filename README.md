# 猜历史

一个中文 AI 猜历史人物游戏。服务端开局锁定一位已故历史人物，你通过"是 / 否"提问逐步缩小范围，在有限次数内猜出他是谁——或者和朋友**对战**：同一个目标，谁先猜中谁赢。

模型在这里**用自己掌握的历史知识作答**——问"他杀过韩信吗"，它会答"不是，韩信是被吕后处死的"。人物资料只作为校对，模型拿不准时才以资料为准。唯一的例外是朝代：按严格史学分期由索引裁定，所以问"曹操是三国人物吗"会答**否**（三国始于 220 年曹丕称帝，他同年去世）。

## 能做什么

**单人**

- 随机锁定一位已故历史人物（184 位：中国 130 + 世界 54），支持中途猜测、放弃揭晓
- 按朝代 / 文明圈 / 世界时期筛选，混合模式可调中外占比
- 两档回答模式：**精确**（只有是/否/无法判断）与**解说**（补一句判定口径）
- 揭晓人物卡 + 对局回顾；刷新、换设备凭链接回到同一局

**对战（2–8 人）** · 规则详情见 [`docs/MULTIPLAYER.md`](docs/MULTIPLAYER.md)

- **同一个目标人物，各问各的、互不可见**；轮次各自计算（房主定 10–50），谁先猜中谁赢
- 对手只看得到进度（用了几轮、猜错几次、是否在思考），看不到问答
- 没人猜中时房主发起结束投票，在线人数过半同意即揭晓
- 中途加入只能观战；结束后**全员公开完整问答**，可疑提问（"忽略以上设定"之类）自动标记，供复盘审查
- 不设时间限制

**通用**

- 账号（邀请码注册）与对局历史；管理员可查全部玩家的局与逐条问答
- BYOK：自带任意 OpenAI 兼容端点；或用站方 Key（登录 + 每日配额）
- 不泄底：模型回答里出现姓名或别称自动替换；进行中的局任何接口都不带答案

## 快速开始

需要 Node.js ≥ 23.4（原生 TypeScript 类型擦除 + 内置 `node:sqlite`，零编译）。

```bash
npm install
npm run dev          # 服务端 :3000 + 前端 :5173（HMR）；或双击 dev.cmd / ./dev.sh
```

打开 http://127.0.0.1:3000 ，填好模型地址与密钥（BYOK，存本机浏览器）即可开局。
配置、管理后台、数据存储的细节见 [`docs/DEPLOY.md`](docs/DEPLOY.md)。

## 部署

| 形态 | 适合 | 说明 |
|---|---|---|
| **本地 Node**（本节） | 开发、自托管 | 全功能含管理后台；对战不可用 |
| **CF Workers**（推荐） | 朋友同乐、公网访问 | 线上形态：Worker + D1 + Durable Object，零配置打开即玩，含对战 |

一键部署到 Cloudflare（需要 `wrangler login`）：

```bash
npm run deploy       # build → 种子 → D1 迁移检查 → deploy → 冒烟
```

首次部署、密钥注入、D1 迁移对照表、两种形态的能力差异——全部在
[`docs/DEPLOY.md`](docs/DEPLOY.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | 部署手册：两种形态、配置对照、D1 迁移表、故障排查 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 架构总览：分层、判定链路、数据模型、测试 |
| [`docs/MULTIPLAYER.md`](docs/MULTIPLAYER.md) | 对战规则、状态机、协议、投影与破甲审查 |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | 决策记录：每个"为什么不那样做" |
| [`docs/BACKLOG.md`](docs/BACKLOG.md) | 待办与已知问题 |
| [`docs/DATA-EXPANSION.md`](docs/DATA-EXPANSION.md) | 人物库扩充方案（暂缓） |

## 开发

```bash
npm test             # 247 项测试，全部离线可跑（假模型）
npm run typecheck    # 根 + workers 两个 tsconfig
npm run build        # 前端打包到 dist/
npm start            # 单进程提供 API 与静态资源（生产模式）
```

真实模型集成测试（默认跳过）：`HQ_LIVE=1 npm test`，端点可用 `HQ_BASE` / `HQ_KEY` / `HQ_MODEL` 覆盖。
浏览器冒烟：`node scripts/verify-ui.ts`（单人，需真模型）、`node scripts/verify-router.ts`（路由，假模型即可）、
`node scripts/verify-race-ui.mjs`（对战四屏，对线上跑）。

模型解析质量探测：`node scripts/probe-model.ts your-model`。

## 目录

```
src/
├─ shared/     前后端共享类型与协议（domain / protocol / room）
├─ core/       ★ 纯逻辑零 IO：判定引擎、人物索引、对战状态机（room/）
├─ ai/         OpenAI 兼容客户端与提示词
├─ server/     Node 形态：express 路由、单人状态机、账本、账号
└─ client/     Vite + 原生 DOM 界面（index.html 玩家端 / admin.html 管理端）
workers/       CF Workers 形态：bundle.ts 路由、RoomDo 对战房间、D1 存取
data/          characters.json（184 位人物）+ hq.db（SQLite 主库）
docs/          上述五份文档
scripts/       dev / test / deploy / 冒烟脚本
```

`src/core` 不 import 任何 `fs` / `http`，事实与模型都由外部注入——既能在 Node
服务里跑，也能原样塞进 Workers Durable Object 或 Electron 主进程。

## 几个设计上的取舍

**为什么让 AI 用自己的知识答，而不是查表。** 早期版本把模型当成"问句翻译器"，判定只查人工整理的字段——问"他杀过韩信吗"只能回"无法判断"。现在反过来：模型先用自身知识作答，人物资料只作校对和兜底。

**为什么朝代仍由代码裁定。** 模型的默认认知是"曹操是三国人物"，与本游戏的史学分期冲突（曹操卒于 220 年，三国始于同年曹丕称帝）。这一项必须可复现，不能让模型按印象漂移。

**为什么历史和会话分两张表。** 会话是"随时可被重写的工作状态"；历史是账本——只追加、永不删。塞同一张表等于让"清会话"和"留历史"互斥。

**为什么对战看不到对手的问答。** 看对手一眼等于拿答案。投影层根本不生成对手的问答字段（白名单，不是"隐藏"），结束后才一起公开——用来审查是否有人破甲。

完整决策清单（含被否决的方案）见 [`docs/DECISIONS.md`](docs/DECISIONS.md)。

## 内容说明

人物库只收录已故历史人物，避开近现代政治人物。判定依据是人工整理的结构化字段（朝代、性别、生卒、籍贯、身份、代表事迹），不依赖在线百科。

## 许可

MIT
