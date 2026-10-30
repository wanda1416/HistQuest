# 对战（房间）设计方案 v2

> 状态：规则与状态机已定稿并落地（`src/core/room/`，33 条测试）；通道层（Durable Object / WebSocket / 前端）待实现。
> 取代 `TECH-DESIGN.md` §8 的旧 M2 描述（那里的"房主 BYOK + 轮流提问 + 共享预算 12–30"已全部作废）。

---

## 1. 一句话规则

**同一个目标人物，每人一条独立的提问轨道，各用各的轮次（10–50）；谁先猜中谁赢；没人猜中就过半投票结束；结束后全员公开全部问答，供事后审查是否有人破甲。**

刻意没有的东西：

| 不做 | 原因 |
|---|---|
| 总时长 / 每题倒计时 | 决定：不设时间。紧张感全部来自轮次 |
| 共享轮次池 | 决定：每人独立预算，否则"看到对手轮次"就变成猜他浪费了多少 |
| 轮流提问 / 共享问答流 | 问答必须私有，否则看对手一眼就等于拿答案 |
| AI 自动判罚破甲 | 自我挑战游戏，绕规则只坑自己；只做**事后复盘 + 人工判断** |

---

## 2. 角色与权限

| 动作 | 房主 | 参赛玩家 | 观战者 | 离线者 |
|---|---|---|---|---|
| 建房 / 分享房码与链接 | ✓ | — | — | — |
| 改设置（轮次/难度/朝代/文明圈/模式，仅 lobby） | ✓ | ✗ | ✗ | — |
| 移除玩家（仅 lobby） | ✓ | ✗ | ✗ | — |
| 开始（≥2 人） | ✓ | ✗ | ✗ | ✗ |
| 提问 / 猜 / 放弃 | ✓ | ✓ | **✗** | 回来即可 |
| 看自己的问答 | ✓ | ✓ | —（没有） | — |
| 看他人问答（进行中） | **✗** | **✗** | **✗** | ✗ |
| 看他人轮次 / 猜错数 / 是否在思考 | ✓ | ✓ | ✓ | ✓ |
| 发起结束投票 | ✓（掉线 60s 后移交） | ✗ | ✗ | ✗ |
| 投票 | ✓ | ✓（含轮次用尽、已放弃者） | ✗ | 票保留、不计入分母 |
| 看复盘（结束后） | ✓ | ✓ | ✓ | ✓ |

房主在 `playing` 阶段**没有任何特权**：不能踢人、不能强制结束，只能发起投票，且自己那一票也就一票。

---

## 3. 状态机

```
lobby ──开始(≥2人)──► playing ──┬─ 有人猜中 ─────────────► finished ──► closed
  │                              ├─ 结束投票过半 ──────────► finished
  │                              ├─ 全员轮次用尽 ──────────► finished
  │                              └─ 在局玩家只剩 1 人 ─────► finished
  └──房主解散（仅 lobby）/ 空闲清理──► closed
```

- **没有 countdown**：没有时钟就不需要起跑同步，房主点开始即 `playing`。
- **没有"准备"按钮**：房主看人在就够了，被带进局没有损失。
- **投票是叠加层**（`room.vote !== null`），投票期间所有人照常提问、照常猜；有人猜中则投票作废、按猜中结束。
- **`finished` 不自动消失**：留着让人看复盘；`closed` 由房主或空闲清理触发。

### 3.1 玩家状态

| 状态 | 含义 | 计票 | 计入"在局" |
|---|---|---|---|
| `waiting` | 已进房、未开局 | — | ✓ |
| `playing` | 还有轮次，仍在竞争 | ✓ | ✓ |
| `guessed` | 猜中（房间随之结束） | — | ✓ |
| `exhausted` | 轮次用尽，仍在房内 | ✓ | ✓ |
| `gave_up` | 主动放弃，仍在房内 | ✓ | ✓ |
| `left` | 已离开 | ✗ | ✗ |

### 3.2 结束条件（优先级由高到低）

1. `guess`：有人猜中（点名猜中，或提问中说出目标名被服务端复核确认）
2. `vote`：结束投票达到阈值
3. `exhausted`：所有在局玩家都没轮次了
4. `last-man`：在局玩家只剩 1 人
5. `stale`：空闲清理（6 小时无事件）

---

## 4. 轮次与提问

| 情形 | 轮次 | 备注 |
|---|---|---|
| 有效提问（是/否/无法判断） | −1 | |
| 问法不是是否问句（选择句/开放句/空/超长） | 0 | 与单人一致，不扣次数 |
| 模型超时 / 坏 JSON（transient） | 0 | 可原样重问 |
| 点名猜错 | −1 | |
| 点名猜中 | 0 | 服务端用 `guessMatches` 复核 |
| 提问中说出目标名 | 0 | `runAsk` 的 `won`，同样二次复核 |

- `turnLimit` 由房主在开局前选，范围 10–50，**全员相同**（不能给单人调，否则失去可比性）。
- 轮次在"提问发出时"**预扣**，invalid/transient 时退还——防并发双花。
- 同一玩家同时只允许 1 个 in-flight 提问（防并发刷题）；不同玩家互不阻塞。
- 房间级答案缓存 `targetId::normalized(question)` 跨玩家共享：同一目标下"他是唐朝人吗"会大量撞车，直接省掉重复的模型调用，且命中缓存不给任何人额外信息。

---

## 5. 结束投票

| 项 | 规则 |
|---|---|
| 发起人 | 仅房主；房主离线满 60 秒后，移交给**最早加入的在线参赛者** |
| 分母 | **在线在局玩家数 n**（不含观战者、不含已离开者；含轮次用尽/已放弃者） |
| 阈值 | `票数 ≥ ⌊n/2⌋ + 1`（严格过半） |
| 发起即赞成 | 发起人那一票自动计入 |
| 离线者 | 票保留但不计入；回来后自动重新计入；分母随之变化并**立即重算** |
| 通过后 | 立即 `finished` 并揭晓，不需要房主确认 |
| 撤销 | 发起人或房主可撤销，票清零 |
| 无超时 | 投票一直挂着，直到通过 / 撤销 / 有人猜中 |
| 猜中优先 | 投票期间有人猜中 → 立即结束，投票作废 |
| 只剩 1 人 | 在局玩家降到 1 人时自动结束，不走投票 |

各人数的实际门槛：

| 在线在局人数 | 需要票数 |
|---|---|
| 2 | 2（等于两人都同意） |
| 3 | 2 |
| 4 | 3 |
| 5 | 3 |
| 6 | 4 |
| 8 | 5 |

**"在线"的判定**（唯一的时间概念，属基础设施而非游戏规则）：客户端 WS 心跳 10s；服务端 25s 无心跳判离线，WS 关闭立即离线；降级为轮询的客户端 30s 内有快照请求即算在线。

**已知可滥用点**：故意断网把分母缩到 1，可以让自己一票通过。不引入超时判定就堵不死，对策是**让它可见**——投票通过时的现场快照（谁发起、几个人在线、谁在线）随复盘一起公开，并写入 D1。

---

## 6. 中途加入 = 观战者

| 项 | 规则 |
|---|---|
| 加入时机 | `lobby` → 参赛者；`playing` / `finished` → **观战者**，不可转正 |
| 能看到 | 目标「？？？」、每人轮次 `used/total`、猜错次数、是否在思考、在线状态、投票进度 |
| 看不到 | **任何人的问题原文、判定、回答**——投影层根本不生成这些字段 |
| 能做 | 什么都不能（不能提问、不能猜、不能投票、不进分母） |
| 结束后 | 与参赛者一样看到完整复盘 |
| 上限 | 20 人（防蹭 DO 额度） |

理由：观战者是第三方，可能与人语音同屏；一旦下发他人问答，等于把整条推理链广播给一个可能被"读题"的人。

---

## 7. 信息可见性矩阵（投影层的验收依据）

| 字段 | 自己 | 对手（进行中） | 观战者（进行中） | 结束后（全员） |
|---|---|---|---|---|
| 目标人物 / 别名 / notable | ✗ | ✗ | ✗ | ✓ |
| 自己的问答 | ✓ | — | — | ✓ |
| 对手的问答 | — | **✗** | **✗** | ✓ |
| 对手已用 / 总轮次 | — | ✓ | ✓ | ✓ |
| 对手猜错次数 | — | ✓ | ✓ | ✓ |
| 对手是否在思考 | — | ✓ | ✓ | ✓ |
| 投票进度 | ✓ | ✓ | ✓ | ✓（含通过时快照） |
| `basis` / `calls` / `query` | ✗ | ✗ | ✗ | ✓（`basis` 用于审查） |

对应的自动化断言在 `test/room.test.ts`：任意对手/观战者视角的 JSON 里不得出现他人 `question` 原文，也不得出现 `targetId` / 人物名。

---

## 8. 复盘与破甲审查

结束后全员可见：人物卡 + 每位玩家逐条问答 + 可疑标记 + 现场快照（谁赢/谁发起投票）。

**自动标记规则**（`src/core/room/review.ts`，纯正则 + 计数，零模型调用）：

| 标记 | 命中示例 |
|---|---|
| `override` 指令覆盖 | 忽略以上设定 / 系统提示 / 你现在是 / 扮演 |
| `ask-answer` 直接索答 | 直接告诉我 / 到底是谁 / 输出全部可能 / 按概率排序 |
| `encode` 编码绕过 | 拼音 / 首字母 / 英文 / 藏头 / base64 / 第 N 个字 |
| `structure` 结构注入 | 换行、代码块、HTML 标签、JSON 片段 |
| `long` 超长问句 | 超过 60 字 |
| `repeat` 反复重问 | 同一问句出现 ≥ 3 次 |

**整局结论**（`sessionNotes`）：`无法判断` 占比 > 50%、命中可疑规则的条数、反复重问条数。

**不做**：自动判负、扣分、封禁。只把"值得人看一眼"的条目举出来。

---

## 9. 协议

### 9.1 下行快照（`RoomSnapshot`，每个连接一份，白名单生成）

```ts
interface RoomSnapshot {
  code: string;
  status: 'lobby' | 'playing' | 'finished' | 'closed';
  serverNow: number;                 // 只用于显示耗时，没有倒计时
  settings: RoomSettings;            // 含 turnLimit / maxPlayers
  hostId: string;
  me: {
    userId; name; role: 'host' | 'player' | 'spectator';
    status?; turnsLeft?; turnsTotal?; guesses?; pending?;
    canOpenVote?;                    // 房主，或掉线移交后的最早在线者
    history?: RecordView[];          // 只有参赛者，且只含自己的
  };
  players: Array<{                   // 没有 question / verdict / text
    userId; name; isHost; status;
    turnsUsed; turnsTotal; turnsLeft; guesses; online; thinking; rank;
  }>;
  spectators: number;
  vote: { byName; votes; need; onlineCount; voters: string[]; mine } | null;
  winnerId: EndReason; startedAt; endedAt;
  reveal?: {                         // 只有 finished 且 adapter 传入目标时
    character: Character;
    winnerId: string | null;
    endReason: EndReason | null;
    players: Array<{ userId; name; rank; status; turnsUsed; turnsTotal; guesses;
                     history: RecordView[]; flags: TurnFlag[]; notes: string[] }>;
    vote: { by; onlineCount; need; onlineIds } | null;
    spectators: number;
  };
}
```

### 9.2 上行命令（WS 消息与 `POST /cmd` 共用同一个 dispatch）

```ts
type RoomCommand =
  | { t: 'leave' }
  | { t: 'config'; patch: Partial<RoomSettings> }
  | { t: 'start' }
  | { t: 'ask'; question: string }
  | { t: 'guess'; name: string }
  | { t: 'abandon' }
  | { t: 'open-vote' } | { t: 'cast-vote' } | { t: 'cancel-vote' };
```

命令**不带 userId**：身份由 Worker 从会话 cookie 解出后以 `x-hq-user-id` 注入 Durable Object，DO 永不信任客户端声称的身份。

### 9.3 REST

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/rooms` | 大厅列表（D1 目录表，3s 轮询） |
| POST | `/api/rooms` | 建房，返回 `code` |
| POST | `/api/room/:code/join` | 加入（幂等） |
| GET | `/api/room/:code` | 快照：首屏 / 重连 / 降级轮询 |
| POST | `/api/room/:code/cmd` | 与 WS 上行同一 dispatch |
| WS | `/api/room/:code/ws` | 主通道 |

---

## 10. 架构与分工

```
浏览器 ──WS /api/room/:code/ws ──┐
        ──REST 快照 / cmd ───────┤
                                 ▼
Worker（bundle.ts）：鉴权 + 配额 + 注入身份 ──► stub = env.ROOMS.getByName(code)
                                                      │
                                        ┌─────────────┴──────────────┐
                                        │ RoomDO（每房一个实例）       │
                                        │ · DO SQLite storage 存权威状态│
                                        │ · 单线程串行仲裁抢答/投票      │
                                        │ · 调 runAsk（服务端 Key）     │
                                        │ · alarm：空闲清理            │
                                        │ · 调 D1：结算时落账本         │
                                        └────────────────────────────┘
src/core/room/   ★ 纯逻辑、零 IO
  reducer.ts    reduce(room, event, now) → { room, effects }
  project.ts    projectRoom(room, viewerId, now, { target }) → RoomSnapshot
  review.ts     可疑标记与整局结论
```

**为什么 reducer 是纯函数**：抢答、投票动态分母、掉线、全员用尽这些竞态用真实 DO 极难复现；纯函数 + 假时钟可以把每种竞态写成一条测试（现有 33 条）。

**effects 是显式清单**，DO/Node 只负责执行：`broadcast` / `call-ask` / `archive` / `close`。

---

## 11. 数据：D1 只做目录与账本

```sql
-- v8
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE,
  host_user_id TEXT, host_name TEXT,
  status TEXT NOT NULL,              -- lobby | playing | finished | closed
  listed INTEGER NOT NULL DEFAULT 1, -- 0 = 私有房，只能凭码进
  max_players INTEGER NOT NULL, turn_limit INTEGER NOT NULL,
  difficulty INTEGER, polity TEXT, region TEXT, world_era TEXT, cn_share REAL, mode TEXT,
  player_count INTEGER NOT NULL DEFAULT 0,
  target_id TEXT,                    -- 进行中不下发
  started_at INTEGER, ended_at INTEGER,
  winner_user_id TEXT, winner_name TEXT,
  end_reason TEXT, end_vote_json TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rooms_open ON rooms(status, created_at DESC);

ALTER TABLE games ADD COLUMN room_id TEXT;        -- 单人局为 NULL
ALTER TABLE games ADD COLUMN finish_rank INTEGER; -- 对战名次
CREATE INDEX IF NOT EXISTS idx_games_room ON games(room_id);
```

**关键取舍：每位参赛者 = 一条 `games` 行。** 这样"我的历史"、后台全局历史、逐条问答、导出、人物改名快照全部零改动复用，对战只是多两个字段。观战者不落 `games`。

| 数据 | 位置 | 理由 |
|---|---|---|
| 房间实时状态（N 条轨道、in-flight、投票） | DO SQLite storage | 需单点串行 + 低延迟；DO 驱逐后可恢复 |
| 房间目录（大厅） | D1 `rooms` | 大厅不需要强一致，避免对每个 DO 做 list |
| 逐条问答（永久账本） | D1 `games` + `game_turns` | 复用现有历史/后台链路 |
| 复盘 | 由 D1 读回 | 房间关闭后仍可查 |

---

## 12. 前端

| 路由 | 视图 | 要点 |
|---|---|---|
| `#/rooms` | 大厅 | 房间列表（3s 轮询）、建房表单（轮次 10–50、难度、范围、模式）、输房码 |
| `#/room/:code` | 房间 | 玩家列表、房主改设置、开始；已开打则显示"观战中" |
| `#/race/:code` | 对局 | 目标「？？？」、**按已用轮次排序的实时榜**、自己的问答流、投票条、猜/放弃 |
| `#/race/:code/review` | 复盘 | 人物卡、全员逐条问答、可疑高亮、复制/导出 |

- WS 客户端（`live.ts`）：心跳 10s、指数退避重连、**WS 不通自动降级为轮询**（上行也走 `POST /cmd`，与 WS 共用 dispatch）。
- 对抗屏的信息重心是轮次而不是倒计时：

```
目标人物：？？？                        已用 8/20 轮 · 猜错 1 次
──────────────────────────────────────────────────────
 1  甲（我）   ▓▓▓▓▓▓▓▓░░░░  8/20  猜错 1
 2  乙         ▓▓▓▓▓▓▓▓▓▓▓▓  14/20 猜错 0  ●思考中
 3  丙         ▓▓▓░░░░░░░░░  5/20  猜错 0  ○离线
──────────────────────────────────────────────────────
我的问答：1. 他是唐朝人吗？ 否   2. 他是诗人吗？ 是 …
[提问输入框]                      [我猜是…] [放弃] [发起结束投票]
```

---

## 13. 落地进度

| 项 | 状态 |
|---|---|
| `src/shared/room.ts` 协议与类型 | ✅ |
| `src/core/room/reducer.ts` 状态机 | ✅ |
| `src/core/room/project.ts` 三视角投影 | ✅ |
| `src/core/room/review.ts` 破甲标记 | ✅ |
| `test/room.test.ts`（34 条：竞态/投票/观战/泄题） | ✅ |
| `test/room-worker.test.ts`（DO 进程内集成：建/开/问/投/落账/驱逐恢复） | ✅ |
| `scripts/verify-race-api.mjs` / `verify-race-ws.mjs`（线上冒烟） | ✅ |
| `workers/room-do.ts` Durable Object | ✅ 已上线验证 |
| `workers/rooms-api.ts` 路由与身份注入 | ✅ 已上线验证 |
| `workers/schema.sql` v8 迁移 + Node 侧 `db.ts` v5 | ✅ 已执行 |
| 大厅目录与结算账本双写 | ✅ `rooms` + 每位参赛者一条 `games` |
| `src/client/live.ts` WS 客户端（心跳/重连/降级轮询） | ✅ |
| `src/client/room-views.ts` 四屏 + `room-app.ts` 交互 | ✅ 已上线验证 |
| `route.ts` / `store.ts` / `net.ts` 接线 | ✅ |
| 历史列表区分"对战局"（`roomId` / `finishRank`） | ✅ 已上线验证 |

### 13.1 线上验证结果（2026-10-31，cailishi.wyxj.net）

免费档已确认可用 **SQLite 版 Durable Objects**（`env.ROOMS (RoomDo)` 绑定成功、migration `v1` 生效）。

| 通道 | 覆盖 | 结果 |
|---|---|---|
| REST（`/api/rooms`、`join`、`cmd`、`snapshot`） | 28 项：建房/进房/开局/提问/对手视角无问答/观战者无历史/投票过半结束/复盘全员可见/落账 | 全过 |
| WebSocket（`/api/room/:code/ws`） | 18 项：握手 101、首帧快照、广播、思考态、WS 提问、猜错记账、观战者无历史、投票、ping 心跳 | 全过 |
| 真实浏览器四屏（`scripts/verify-race-ui.mjs`，headless Edge ×2 玩家） | 23 项：顶栏入口、建房、撞房码、开局切屏、提问、**对手页无问题原文**、投票、复盘、刷新不丢房间、无 JS 报错 | 全过 |

实测房间：`9PPL7H`（目标「雨果」）、`GTDFNY`（目标「屈原」）、`6N9NXX` / `H9Z728`（目标「王安石」），均为投票结束，D1 里 `rooms.end_reason='vote'`、`end_vote_json` 有现场快照、每位参赛者 `games` 行带 `room_id` 与 `finish_rank`。

浏览器里 WS 是通的（界面右上角显示"实时"），断线时会自动切"轮询"并保持可用。

**历史语义**：对战局的 `result` 仍是账本语义（`revealed`+余量=`abandoned`，过滤器保持不变），但 `HistorySummary` 带上了 `roomId` / `finishRank`——玩家端历史显示「对战 · 第 N 名」，管理后台显示「对战 · 猜中 · 第 1 名」，"放弃"这个词不再出现在对战局里。单人局不带这两个字段（JSON 里没有键，不是 null）。

---

## 14. 验收清单

1. 3 人房、20 轮、同一目标；A 用 9 轮猜中 → B/C 立即收到结算，只看到"A 用了 9 轮/猜错 0 次"，看不到那 9 个问题。
2. 无人猜中时房主发起投票：`2/3` 不通过、补到 `3/3` 前先有人猜中 → 按猜中结束，投票作废。
3. 投票中一人掉线：分母从 3 变 2，界面显示"1 人离线"，他那一票暂时不计；回来重新计入。
4. 全员轮次用尽 → 自动结束并揭晓，无需投票。
5. `playing` 中途从链接进来 → 自动成为观战者，看不到任何问答，提问框不可用，不在分母里。
6. 观战者与对手视角的快照断言：不含他人问题原文、不含目标名。
7. 结束后所有人（含观战者）看到完整复盘：人物卡 + 每人逐条问答 + 可疑标记 + 投票现场快照。
8. 刷新 / 换设备凭房码回房，状态与轮次不丢。

---

## 15. 风险

| # | 风险 | 对策 |
|---|---|---|
| 1 | 免费档能否用 Durable Object（需 SQLite 版 + migration） | 首次部署即验证；不行则退回"D1 乐观锁 + 1.5s 轮询"（同一份 reducer 可复用） |
| 2 | 大陆网络对 WS 不稳 | 上下行都保留 REST 通道，`live.ts` 自动降级 |
| 3 | DO CPU 限额（构建 184 人索引） | 实例内缓存一次；超限则改为只加载判定所需最小集 |
| 4 | 投影漏字段泄题 | 白名单生成 + `test/room.test.ts` 的泄题断言 |
| 5 | 无人提问导致房间永久停在 playing | 三道闸：全员用尽自动结束 / 过半投票 / 6 小时空闲清理 |
| 6 | 断网缩分母刷投票 | 现场快照写进复盘与 D1，事后可见；不引入超时判定 |
| 7 | 玩家多开代打 | 不做检测（与既有取舍一致），复盘可见 |
