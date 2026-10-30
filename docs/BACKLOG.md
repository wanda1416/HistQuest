# 待办与已知问题

> 最后更新：2026-10-30
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
3. **安全边界不变**：多把 apiKey 都在同一个加密 blob 里，仍然只上传密文。
4. **不涉及密钥层**：管理密钥 / 数据密钥的分层与轮换不受影响。

**后续扩展位**：若要按任务分工（解析用便宜模型、判定用强模型），在 `LlmSettings` 上加 `roles: { parse: id, judge: id }`，存储层不用再改。

**涉及文件**：`src/client/store.ts`（配置模型）、`src/client/views.ts`（模型列表 UI）、`src/client/sync.ts`（载荷版本）、`src/client/vault.ts`（payload 类型）。

---

## 二、正确性问题（未修）

| # | 问题 | 位置 | 说明 |
|---|---|---|---|
| 1 | ✅ **猜名单字即胜**（已修复，待提交） | `core/judge.ts` `guessMatches` | 改为严格相等：只有完整姓名或别名才算中，单字与子串一律不算。实测「子」「李」「白」命中 0 人，「孔子」「孔夫子」「李白」「诗仙」各命中 1 人 |
| 2 | **限流被算作有效提问** | `core/engine.ts` catch 分支 | 只把 `BAD_JSON` / `TIMEOUT` / `EMPTY` 标为 transient；`RATE`（429）与 `HTTP` 走兜底，提示"没听明白"且扣次数 |
| 3 | ✅ **会话过期记录只读不删**（历史已分离，见下条） | `server/sessions.ts` `prune()` | 对局历史已迁到 `games` / `game_turns` 账本，会话表只剩 24h 工作状态；`prune()` 仍未接定时任务，属清理优化 |
| 4 | **空朝代静默跨朝代抽人** | `core/index.ts` `pick()` | 西晋、五代为 0 人，选中后回退到全量池，玩家会拿到别的朝代的目标 |

---

## 三、技术债

| 项 | 现状 |
|---|---|
| **TECH-DESIGN 严重过时** | 标 v1.5，内容仍描述 `Parser → Judge`（`parser.ts` 已删除）、120 位人物、旧的测试文件清单；实际是「模型知识作答 + 索引裁定朝代/世纪」、184 人 |
| **无 CI** | 没有 GitHub Actions；typecheck 与测试全靠手动 |
| **UI 冒烟未入库** | `.tmp/verify-*.mjs` 为一次性脚本，未进 `scripts/` |
| **后台缺导入入口** | 服务端有 `importFrom`，UI 只提供导出 |
| **dev.sh 无执行位** | Git 记录 100644，macOS/Linux 需 `chmod +x` 后重提交 |
| **旧 JSON 会话未迁移** | 24h TTL 自然过期，可忽略；SQLite 库在迁移 v3 时已自动把在途会话连同问答搬进账本 |
| **Workers 端历史排序靠 started_at** | 管理员列表按开局时间倒序；若要"最近活动优先"需记录 `updated_at` 排序 |

---

## 四、明确暂缓（不算欠账）

- 世界政权不做硬裁定："他是罗马人吗"交给模型，结果不可复现（产品决定）
- 人物库批量扩充：方案见 [DATA-EXPANSION.md](DATA-EXPANSION.md)
- 大洋洲 0 人：库克船长按人物归属计入欧洲
