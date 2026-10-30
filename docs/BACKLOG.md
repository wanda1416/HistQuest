# 待办与已知问题

> 最后更新：2026-10-31
> 用法：只记录现状与结论，不写实现细节。完成一项就把状态改成 ✅ 并注明提交。

---

## 一、已提出但暂不实现

### 多 LLM 支持（状态：需求已记录，暂不排期）

**目标**：允许配置多个模型（DeepSeek / OpenAI / 本地 vLLM），开局前选择使用哪一个。

**数据模型**

```ts
interface LlmProfile {
  id: string;        // 本地生成
  name: string;      // 显示名
  baseURL: string;
  apiKey: string;
  model: string;
  temperature?: number;
}

interface LlmSettings {
  profiles: LlmProfile[];
  activeId: string | null;
}
```

**已确定的约束**

1. **协议不动**：服务端每次请求仍只收一个 `AiConfig`，由前端按 `activeId` 铺平后传入。
2. **同步载荷升 v2**：`{ llm: { profiles, activeId }, prefs, questions }`；读到旧 v1 载荷（单个 `aiConfig`）时迁移成一条 profile。
3. **安全边界不变**：多把 apiKey 都在同一个加密 blob 里，仍然只上传密钥密文。
4. **不涉及密钥层**：管理密钥 / 数据密钥的分层与轮换不受影响。

**涉及文件**：`src/client/store.ts`（配置模型）、`src/client/views.ts`（模型列表 UI）、`src/client/sync.ts`（载荷版本）、`src/client/vault.ts`（payload 类型）。

### 对战（后续打磨，非欠账）

- 观战者聊天/弹幕（复盘页已有文字，实时讨论待评估）
- 房间邀请链接带房名与设置预览
- 对战胜负统计页（数据已在 `games.room_id` / `finish_rank` 里，只差聚合视图）

---

## 二、正确性问题（未修）

| # | 问题 | 位置 | 说明 |
|---|---|---|---|
| 1 | ✅ **猜名单字即胜**（已修复） | `core/judge.ts` `guessMatches` | 严格相等：只有完整姓名或别名才算中。提交 1d2fd86 前后 |
| 2 | **限流被算作有效提问** | `core/engine.ts` catch 分支 | 只把 `BAD_JSON` / `TIMEOUT` / `EMPTY` 标为 transient；`RATE`（429）与 `HTTP` 走兜底，提示"没听明白"且扣次数 |
| 3 | ✅ **会话过期记录只读不删** | `server/sessions-node.ts` `prune()` | 历史已分离到账本；`prune()` 仍未接定时任务，属清理优化 |
| 4 | **空朝代静默跨朝代抽人** | `core/index.ts` `pick()` | 西晋、五代为 0 人，选中后回退到全量池，玩家会拿到别的朝代的目标 |

---

## 三、技术债

| 项 | 现状 |
|---|---|
| **无 CI** | 计划中：GitHub Actions 单 job（typecheck ×2 + 247 测试全离线可跑），见本次整理方案 |
| **后台缺导入入口** | 服务端有 `importFrom`，UI 只提供导出 |
| **dev.sh 无执行位** | Git 记录 100644，macOS/Linux 需 `chmod +x` 后重提交 |
| **抛错类失败不入历史** | `core/engine.ts` 对 AUTH / UNSUPPORTED / NETWORK 直接 throw，这一问不进会话也不进账本；要统计"模型挂了几次"需另建失败事件表 |
| **Workers 端历史排序靠 started_at** | 管理员列表按开局时间倒序；"最近活动优先"需按 `updated_at` 排序 |
| **workers/tsconfig 用排除列表** | 已改为 `include **/*.ts` + 显式排除 Node 专属文件；给 `server/` 新增两端共用模块时**不用登记**，但新增 Node 专属文件要记得加进 exclude——排错方向是"漏排除"，编译错误会明确指出 |
| **admin 后台未迁移 Workers** | 人物编辑、用户管理只在本地 Node 形态可用（见 DEPLOY.md 能力差异表）；迁移属于大工程，先记录 |

---

## 四、已完成（2026-10-31 对战 + 整理批次）

- ✅ 对战全链路上线：状态机 34 测 + DO 集成 4 测 + API/WS/UI 三层线上冒烟
- ✅ `TECH-DESIGN.md` 重写为 [`ARCHITECTURE.md`](ARCHITECTURE.md)；决策抽出 [`DECISIONS.md`](DECISIONS.md)
- ✅ 部署文档统一 [`DEPLOY.md`](DEPLOY.md)；`npm run deploy` 一键脚本（含迁移检查与冒烟）
- ✅ `server/sessions.ts` 拆出 Node 实现（`sessions-node.ts`），workers 侧不再为类型引入 `node:*`
- ✅ `solo.ts` 改为运行时中立（持久化经 `makePersistence` 注入，id 用两端通用的 `crypto.randomUUID`）
- ✅ `wrangler.example.toml` 同步 ROOMS DO 绑定与 migrations 段
- ✅ 历史列表区分对战局（`roomId` / `finishRank` →「对战 · 第 N 名」）

---

## 五、明确暂缓（不算欠账）

- 世界政权不做硬裁定："他是罗马人吗"交给模型，结果不可复现（产品决定）
- 人物库批量扩充：方案见 [DATA-EXPANSION.md](DATA-EXPANSION.md)
- 大洋洲 0 人：库克船长按人物归属计入欧洲
