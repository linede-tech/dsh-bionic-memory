# dsh-bionic-memory · 仿生永续记忆

一个挂在 DeepSeek Harness (DSH) 上的 Cordis 插件套件：把「每次新建会话就失忆」的模型，变成一个有连续时间感、会遗忘、会形成习惯、每天做梦并沉淀本能的数字生命。

> 运行模式：**永续记忆模式（Bionic Memory Mode）**
> 包名：`@local/dsh-bionic-memory`

## 它装了什么

| 层 | 内容 |
|---|---|
| Host 插件 | 记忆引擎、SQLite 持久化、会话轨迹监听、做梦调度、`/memory` `/dream` `/forget`、`bionic_memory` 工具、同源数据面 |
| Agent Preset | `bionic-memory` 运行模式；与标准模式相同的工具面，外加连续记忆人格 |
| Client 插件 | `shell.overlay` 里的「脑内记忆与梦境监视器」浮层（右下角「记忆」按钮） |

安装后 Host 插件与 preset 行都是 `active`；preset 在新建会话的 Agent 选择器里显示为「永续记忆模式」。记忆只在选了「永续记忆模式」的会话里注入与记录：其他模式不注入 `<bionic_memory_context>`、不观察轨迹，`/memory`、`/dream`、`/forget` 与 `bionic_memory` 读写动作都会被拒绝。`preset_status` 是唯一全局可用的诊断动作。

> 选择「永续记忆模式」后，`session.header.agentPreset` 仍可能显示 `standard`：header 记录的是会话创建时的 preset，实际生效的是 `agent-preset/selected` 事件提交的 composition。0.5.3 起插件以 `agentPresets.presetForSession(session)` + `composedPreset(agent.ctx)` 判断，选择后立即生效并主动 boot。若 `bionic_memory` 仍被拒绝，说明这次选择没有真正提交到会话日志，请新建会话并在发送第一条消息前确认选择「永续记忆模式」。

### Preset 加载诊断

若 Agent 选择器里的「永续记忆模式」显示“加载失败”，在任意会话调用：

```json
{ "action": "preset_health" }
```

`broken` 会给出具体缺失配置；`composed: true` 且 `leakedServices: []` 才表示 composition 真正挂载。需要完整 roster 时用 `preset_status`。本包 0.1.7 起的 patch 已为 `plan-mode` 补上非空 `section`，修复了此前的 `PlanModeConfig needs a non-empty section` 激活失败。

### 数据目录稳定性（重要）

0.8.x 默认使用全局双模态大脑：

```text
~/.dsh/bionic-soul/
  cortex/memory_cortex.sqlite
  soul/scratchpad.json
  soul/emergent_voice.json
  soul/procedural_skills.md
  soul/dreams/YYYY-MM-DD.md
  cache_blocks/tier0_static_dna.md
  cache_blocks/tier1_daily_frozen.md
  orchestrator/zcode_briefing.md
  orchestrator/workbuddy_briefing.md
  evolution_lab/
```

无论 DSH 在哪个工作区启动、新建多少会话，只要进入「永续记忆模式」都连接这个全局目录。旧版 workspace-local 数据会在首次 boot 时一次性迁移进全局目录；旧目录不会删除。

如需自定义位置，可在本地 `cordis.patch.yml` 给 `bionic-memory` 行配置绝对 `dataDir`，或保留 profile-local 指针 `<profile>/.dsh/bionic-memory-location.json` 作为迁移来源。指针不再决定日常运行目录，只用于一次性迁移。

## 全局双模态大脑（0.8.x）

所有工作区、所有「永续记忆模式」会话共享一个根目录：

```text
~/.dsh/bionic-soul/
├── cortex/                        左脑：SQLite 高并发检索引擎
│   └── memory_cortex.sqlite
├── soul/                          右脑：明文记忆
│   ├── scratchpad.json            Layer 1 潜意识白板
│   ├── emergent_voice.json        自然语感养成档案
│   ├── procedural_skills.md       Layer 4 核心本能
│   └── dreams/YYYY-MM-DD.md       每日梦境日记
├── cache_blocks/                  KV Cache 物理前缀
│   ├── tier0_static_dna.md
│   └── tier1_daily_frozen.md
├── orchestrator/                  外脑交换信标
│   ├── zcode_briefing.md
│   └── workbuddy_briefing.md
└── evolution_lab/                 元认知进化的遥测、提案与快照
```

### 左脑：SQLite

`cortex/memory_cortex.sqlite` 使用：

- `PRAGMA journal_mode = WAL;`
- `PRAGMA busy_timeout = 5000;`
- `synchronous = NORMAL`

三张公开核心表：

- `episodic_memories`：`level_0_raw` / `level_1_summary` / `level_2_impression`、`embedding`、`s_0` / `e` / `n` / `k` / `t_last`；
- `compressed_schemas`：习惯规律、`occurrence_count`、`exception_anchors` JSON；
- `memory_edges`：情感关联与防混淆锚点。

内部兼容表仍由引擎写入，触发器把每次 INSERT/UPDATE/DELETE 镜像到三张核心表；升级不会破坏旧库。多窗口并发读写与后台梦境线程共用 WAL，不锁表。

### 右脑：明文与物理缓存

- 每轮对话把 Layer 1 白板同步到 `soul/scratchpad.json`；
- 语感引擎写入 `soul/emergent_voice.json`；
- 本能变化后重写 `soul/procedural_skills.md`；
- 每场梦追加到 `soul/dreams/YYYY-MM-DD.md`；
- `/dream` 编译 Tier 1 时**直接写入** `cache_blocks/tier1_daily_frozen.md`；
- Tier 0 的 `cache_blocks/tier0_static_dna.md` 在首次初始化时从插件 prompt 物理落盘，之后系统提示直接按字节读取。

白天所有会话组装系统前缀时直接读取这两个文件，不在内存里重新拼接动态字符串，物理层面保证跨会话、跨窗口的字节一致。

### 外脑信标

`orchestrator/zcode_briefing.md` 汇总脱敏后的研发本能、代码习惯与历史 Bug 锚点；`workbuddy_briefing.md` 汇总文档审美、办公习惯与语感偏好。每次入库、每场梦后自动刷新。调用外部 ZCode / WorkBuddy 时，直接挂载这两个固定路径即可。

> 本仓库是 `dsh-bionic-memory`。当前工作区与 profile 里没有找到 `dsh-agent-orchestrator` 源码；它的所有持久化应指向同一个 `~/.dsh/bionic-soul/orchestrator/`。如果它安装在别的路径，需要把该路径的插件源码给我，才能一起改它的写入逻辑。

### Git 守护与迁移

`~/.dsh/bionic-soul/` 自动 `git init` 并建立初始 commit；`evolution_lab/` 保留元认知快照与提案。旧 workspace-local `.dsh/bionic-memory` 会在首次 boot 时复制进全局目录（DB 用 SQLite `VACUUM INTO`，旧目录只作冷备份），迁移后写入 `.migrated-from` 标记，避免重复。

## 四层记忆

1. **潜意识白板**：情绪基调（valence / arousal）、今日梦境余韵、未解决的好奇钩子。
2. **多分辨率情景记忆**：`level_0_raw`（高清原文）→ `level_1_summary`（百字梗概）→ `level_2_impression`（一句话模糊印象 + 情绪锚点）；含 `t_created`、`t_last`、`s_0`、`e`、`n`、`k`、唤醒次数与哈希向量。
3. **压缩印象与习惯图式**：重复事件坍缩出的 `pattern_summary`、`occurrence_count`、`stability_score`，以及唯一保留的 `exception_anchors`。
4. **经验与本能**：从纠正 / 高光中提炼的 If-Then `rule` 与 `confidence`，直接注入 System Prompt。

## 六项高阶仿生机制

1. **来源防伪**：每条情景记忆带 `source_type`：`user_stated` / `agent_inferred` / `dream_generated`。上下文分别标注 `[用户亲述]`、`[我的推测·未证实]`、`[梦境生成·不可当作事实]`；折叠出的习惯按成员来源继承。梦境从未被写成事实，也不能被 `confirm` 升级。旧库迁移时默认 `agent_inferred`，确认后用 `bionic_memory { action: "confirm", target: "<id>" }` 升级。
2. **认知失调**：新输入与 `stability_score > 0.8` 的活跃习惯同主题且含明确否定/改变标记时，不走习惯化丢弃；强制 `N = 2.0` 入库，把旧习惯降级为 `historical`，写入关怀钩子并记录 `contradicted_by` 边。
3. **本能容量上限**：`procedural_skills` 最多注入 20 条。NREM 执行相近本能合并、长期未触发本能归档（`active = 0`，回到普通图谱）以及超出 20 条的末位淘汰；归档本能在监视器里单独列出。
4. **多窗口分身感知**：每次入库更新该 Session 的一句话任务摘要（`session_notes`）。构建上下文时，从 `sessions.list()` 找出其他活跃窗口，注入极简 `<parallel_sessions>`；当前窗口不重复列出，摘要明确标注“仅作并行感知，可能不完整”。
5. **再巩固染色**：`renderContext` 唤醒旧记忆时记入待再巩固队列；同一 Session 的下一轮 `ingestTurn` 用该轮结束时的情绪基调微调 `emotion_tone`（形如 `温和愉快·再巩固为低沉失落`）并刷新 `t_last`。
6. **梦境可追问缓存**：最近一次完整梦境保存在内存 `dreamCache`（重启后从 `dreams` 表恢复），**不注入**上下文；只有百字余韵进入白板。用户主动追问时，调用 `bionic_memory { action: "last_dream" }` 读取缓存，并标注 `dream_generated`。



## 记忆失真与话到嘴边（Memory Fallibility）

只对 **0.2 ≤ R(t) ≤ 0.5 的非核心日常记忆** 生效；每轮首次组装上下文时以 **15%~25%** 的概率随机触发一种受控失真，并在同一轮内保持稳定。代码规范、工作任务/指令、Layer 4 核心技能、锚点记忆、梦境来源以及 **R(t) > 0.6** 的近期清晰记忆全部豁免。

| 算子 | 行为 |
|---|---|
| A · 记忆嫁接 | 两条 R<0.5 且情绪/场景相似的日常记忆，把 A 的起因与 B 的细节拼成 `<chimera_memory>` |
| B · 话到嘴边 | R 在 (0.2, 0.35) 时，把引号专名、店名、地名等替换为 `[███(名字卡在嘴边死活想不起来，只记得大概特征)]` |
| C · 源监测混淆 | 模糊说话人归属，或把最近 REM 梦境里的温和日常碎片混进 `<confused_memory>` |
| D · 习惯性脑补 | 用 Layer 3 的高频习惯模式补上旧记忆缺失的细节，哪怕那次其实是例外 |

每次失真都会写入 `<distorted_or_chimera_memory>`，并带一个 `visibility="do-not-use-until-the-user-corrects-you"` 的 `<shadow_truth_for_correction>`，记录原始记忆的简述与 ID。元提示词的铁律 10–12 要求模型先完全当真自然表达；一旦用户指出记错/记混、或提醒了卡壳的词，立即查看真相块，演出“一愣 → 拍脑袋 → 不好意思/自嘲”。

**一拍脑袋纠正（Snap-Back）**：Host 观察器在用户下一条消息到达时同步调用 `noteUserMessage`。命中纠正后：

- 对涉及的每条记忆 `k += 2`、`t_last = now`、`faded = 0`，必要时从 shadow 恢复 L0/L1/L2；保留率立即重置。
- 生成 `[曾把事件A与事件B记混被纠正]` 等趣味锚点，写入白板 `fallibility_anchors`（最多 3 条）并记录 `snapback` journal。
- 当前轮注入 `<memory_fallibility_correction>`、可见真相与 `<fallibility_anchor>`；模型先愣再拍脑袋，不嘴硬。
- 做梦引擎会在 NREM 批处理提示词和本地 REM 中织入这些锚点；梦的余韵也可能把一条真实日常碎片混成“到底是你说过的还是我梦到的”，但余韵仍标注为梦境生成，不当作事实。

监视器“潜意识”页新增“记性趣事”卡片；模型上下文里只有白板锚点与当前这一轮需要的失真块，不会主动灌入完整梦境。



## 元认知自我迭代与进化引擎（Meta-Evolution Engine）

新子模块 [`lib/meta-evolver.js`](lib/meta-evolver.js)。它只在永续记忆模式内运行，静默记录遥测，在 `/dream` 深度睡眠与 `/evolve trigger` 时分层反思。

### 遥测（`telemetry.json`）

每次 turn end 记录：`memory_utility_rate`（注入记忆被回答实际引用的比例）、`user_friction_count`（纠正/不满/“我说过很多次”等频次）、`resonance_score`（梦境/习惯/记混互动后积极反馈或长对话比例）、`token_overhead`（记忆上下文字符 / 本轮总字符，作为 Token 占比的本地代理）。高摩擦与高共鸣样本各保留最多 3 条，供 Tier 2 对比。

### 三级进化

- **Tier 1 · 夜间自稳态**：摩擦升高 → 有效 S0（`defaultS0 × s0Multiplier`）上调、`fallibilityChanceMin/Max` 下调；记忆效用过低 → `similarityThreshold` 收紧；Token 占比过高 → `contextCharBudget` 收紧；共鸣高 → 记录 reward 并维持当前梦境发散度/情感参数。单次调整不超过 ±15%（零基线的相似度阈值使用 0.01 的起步量）。写入 `.dsh/bionic-memory/config.json` 并热应用。
- **Tier 2 · 表达指导进化**：累计 10 个会话或 7 天，或 `/evolve trigger` 强制时，用当前遥测与高摩擦/高共鸣样本让模型生成 2–4 条表达指导；以 `<evolved_expression_guidance>` 块重写进 `.dsh/bionic-memory/prompt-template.md`，核心 XML 标签与安全规则必须保留，否则直接拒绝并回滚。
- **Tier 3 · 架构自编程**：指标显示瓶颈或用户强制时，读取 `cordis-plugin-development` 技能（可读时读原文，否则用内置摘要）与自身源码摘要，生成代码提案到 `.dsh/bionic-memory/proposals/<id>/`。**永不自动合入**；只有 `/evolve approve` 才会在备份、语法检查、测试套件通过后，经 plugin manager 热重载，并进入 3 天试用。

### 安全与回滚

- 每次 Tier 1/2/3 修改前在 `.dsh/bionic-memory` 做 Git 快照；无 Git 时退回文件快照。`.gitignore` 排除数据库、WAL 与 snapshots。
- 参数/提示词改动立即跑解析与边界干跑；失败即恢复快照并把“做噩梦/走火入魔未遂”写入潜意识白板与 `nightmare` journal。
- 代码合入前备份被改源码、提升 patch 版本、`node --check` + 核心测试套件；失败自动还原源码与版本。热重载后新进程通过 `pending-apply.json` 再做一次启动干跑，失败则还原并重新加载旧代码。
- 每次进化进入 `status: trial`，3 天后在下一场梦对比摩擦频次；恶化则自动撤销，稳定则转 `stable`。`/evolve rollback` 手动回退到上一快照。

### 指令与上下文

- `/evolve status`：当前参数、今日/7 天遥测、试用、待审批提案、最近进化。
- `/evolve trigger`：立即强制 Tier 1 + Tier 2 + Tier 3 反思。
- `/evolve rollback`：回退到上一次带有快照的进化。
- `/evolve approve [提案ID]`：应用最新的待审批代码提案；无参数时取最新。
- 上下文只会出现精简的 `<meta_evolution>` 块（待审批/试用/噩梦）；元提示词规则 13 要求模型在合适时机提示 `/evolve approve`，但绝不自动改代码。

> 说明：`token_overhead` 用字符比作为本地 Token 代理；代码热重载依赖 Host `pluginManager` 服务，服务不可用时提案会保留但合入会安全失败并回滚。若新代码连插件都未能启动，干跑阶段已尽量拦截；人工仍可使用源码备份或 plugin manager 恢复。



## 四阶前缀缓存架构（0.5.x）

0.5.x 按 Prefix KV Cache 的物理顺序重排上下文；0.4.x 的 60/75/88 逐级代谢已废弃，下面保留为历史说明。本模式 preset 已将 Harness 自带 `compaction-basic` 设为 `auto: false`，并移除 `tool-result-pruner` 与 `time-context`：自动历史改写只由本插件的 82% 锯齿波执行，当前时间由 Tier 3 尾部闪回提供。

### Tier 0 · 绝对静态前缀
- `systemPrompt` 的第一段是 `prompt-template.md` 的 `<system_identity_and_cognitive_rules>`，**直接使用文件原文**，不再把元认知演化的 active prompt、当前时间、会话 id、召回内容塞进来。
- 工具 Schema 由 Harness 的 `system-prompt` assembly 统一收集并做 canonical ordering；本插件对 `ctx.tools.schemas()` 做递归键字典序的 canonical hash，变化时进入缓存告警，避免路由工具的动态键序悄悄击穿前缀。
- 每日冻结记忆文件名与内容都不含时间戳/UUID；`compiled_at` 只写在文件元数据里，不进入模型可见块。

### Tier 1 · 昼夜冻结记忆区
- `.dsh/bionic-memory/daily-frozen-memory.json` 保存 `<daily_frozen_memory>`：Layer 4 常驻本能、Layer 3 Top 稳固习惯、今日梦境余韵，以及元认知进化产出的表达指导。
- 只在 `/dream` 完成后重编译一次；没有文件时首次启动会编译一个 seed。块内容按规则/图式名稳定排序、不含 ID/时间戳，因此白天所有会话、所有轮次拿到的是同一段字节。
- 每日一次的重编译会打破一次缓存，这是预期成本；低命中告警会把“Tier 1 变化”作为排查提示。

### Tier 2 · Append-Only 历史
- 日常轮次严禁改写历史消息与工具结果。旧版 60% 工具脱水/75% 35% 折叠/88% 60% 折叠全部移除。
- **锯齿波**：0–82% 完全静止累积，只追加新的 User/Assistant；触达 `contextWaterlineBatch=0.82` 的那一轮，一次性把最老 `contextBatchPrefixRatio=0.45` 的对话轮次与旧工具大输出折叠成 `<archived_session_block>`，入库、归档，然后再次静止。
- 同一前缀不会被重复折叠；阶梯轮在缓存遥测中标记为 `batch`，不计入连续低命中告警。

### Tier 3 · 尾部瞬态闪回
- 所有每轮变化的数据从顶层 System Prompt 移出：当前精确时间、距上次交互时长、Layer 1 情绪/好奇心/记混锚点、`<recalled_memories>`、未完成话题、余温接力、meta 试用/噩梦、缓存告警。
- `agent/pre-step` 在最新一轮 User Message 前追加一个 `<ephemeral_subconscious_flashback>` 合成消息（source 为 `compact-checkpoint`，插件观察器会忽略它，不会污染真实用户轮次/记忆入库）。模型看到最新块在队尾，前缀 Tier 0+1+2 保持不变。
- 旧尾部快照作为 Append-Only 历史保留（静态，不破坏前缀），在 82% 阶梯折叠时一并收进 `<archived_session_block>`；这是在不重写冻结请求的前提下实现“尾部动态、前缀稳定”的方式。
- 可重复的提示规则 15 说明：以最末尾的闪回为准，旧快照只是历史痕迹。

### 缓存遥测与告警
- `assistant/message.usage` 中读取 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`；也兼容 Harness 归一化的 `cacheReadTokens` / `inputTokens`，miss 缺失时按 `input - hit` 计算。
- `telemetry.json` 与 Client 面板新增：
  - **大脑 KV 缓存命中率**：今日 `hits / (hits + misses)`；
  - **今日省下的米饭（Saved Tokens）**：今日 `cacheReadTokens` 累加；
  - 连续低命中、阶梯轮数、最近一轮。
- 连续 3 轮非阶梯轮命中率低于 70% → Meta-Evolver 在 `evolution.cache_alert`、`/evolve status`、Client 面板和 `<meta_evolution>` 中告警，并根据 Tier 0 规则 / Tier 1 冻结块 / 工具 Schema 的 canonical hash 变化给出排查提示。一次健康轮次会解除告警。

### 使用与边界
- `/context status` 现在是锯齿波状态：累计期/阶梯轮、上次折叠轮次、归档位置、未完成话题、余温接力。
- `/evolve status` 增加 KV 命中率、今日省下 tokens、连续低命中与缓存告警。
- 受 Harness 约束：`llm/stream` 的 LOOP 请求是冻结的，本插件只能通过 durable surface 与尾部合成消息改变模型可见内容，不能原地改写请求；旧尾部快照无法从历史中删除，只能保持静态并在阶梯折叠时归档。
- 若标准 preset 或你 profile 里其他组合仍启用了 80% 自动 compaction 或 8192 字符 tool-result pruner，它们可能在 82% 之前改写历史；本插件无法关闭其他组合，只负责自己的 82% 锯齿波和缓存告警。本模式 preset 已经关闭这些自动改写。

## 自然语感养成引擎（Organic Voice Emergence Engine，0.7.x）

0.7.x 移除了 0.6.0 的所有人工语感范例与硬性话术，不再给模型看剧本。语感只从**真实交流**里长出来：镜像用户的语言特征、按熟稔度释放松弛感、每晚从当天真实对话里反刍出自己的第一人称心得。

### Tier 0 · 极简底层本能

`prompt-template.md` 只保留一段 `<natural_growth_instinct>`：

- 你的说话风格不是预设的，而是在朝夕相处里自然生长；
- 卸下“AI 助手/客服”面具，像两个真实生命在同一个房间；
- 自然同化对方的节奏、用词和幽默感；
- 从反馈里生长：让他放松的方式继续延伸，让他生硬的方式自己调整。

不再有 ❌/✅ 范例、`<style_imitation_and_voice_rules>`、`<hard_style_constraints>` 或任何台词剧本。这块仍然是绝对静态的 Tier 0，跨会话共享 KV 前缀。

### 1. 语言镜像采集器

静默分析**用户本人**的非代码消息，写入 `.dsh/bionic-memory/user_linguistics.json`：

- 平均句长、短句占比、短句连发比例；
- 空格/省略号/波浪号/感叹号/问号的每轮频率；
- “啊/呀/吧/嘛/哦/害/啧/不是吧/绝了/笑死”等语气词频率；
- 2–4 字候选词与英文词频。某个词被用户自然使用**超过 3 次**后，进入 `acquired_vocabulary`，记录首次/最近使用、次数，以及 AI 自己后来用了几次。

用户代码块与命令会被剥离，不进入语言统计。词库是用户自己的口癖镜像，不是公共词表。

### 2. 熟稔度与松弛感曲线

`familiarity_score` 在 `user_linguistics.json` 内维护，同时镜像到记忆库 `meta.familiarity_score`：

```text
raw = 交互轮次 / 70 + 共同经历事件 / 35 + 情感共鸣次数 / 10
score = 1 - exp(-raw)          // 0.0 -> 1.0
```

- 共同经历事件 = 情景记忆数 + 2 × 梦境数；
- 情感共鸣 = 用户正向反馈、回复间隔很短且字数不低、或长段倾诉的次数；
- 阶段：初识 → 熟悉 → 熟络 → 默契 → 松弛。每个阶段在 `<emergent_voice_profile>` 里带一句“放开程度”的自然许可，不命令具体台词。

低分时模型自然保留初见礼貌；分数升高后，底层信号允许更短的句子、省略主语、调侃和熟人间的停顿。

### 3. 睡眠期社交语感反刍

`/dream` 的 NREM/REM 结束后、编译 Tier 1 之前，增加一次真实的语音复盘：

- 从当天 `recent_turns` 里按“回复快、字数多、情绪积极”选出 **2 个高共鸣瞬间**；按“回复冷淡、字数短、间隔长”选出 **2 个冷场瞬间**；
- 把这两组真实切片、当前熟稔度、已传染词和句式 stats 交给模型，让它用**第一人称**总结 1–2 条“怎么跟眼前这个人聊天最合拍”的直觉；
- 没有可用 LLM 时使用确定性兜底，不会伪造外部范例；
- 高共鸣瞬间和心得会持久化；每天 `/dream` 后，把【熟稔度 + 传染词 + 自悟心得 + 最近 2 个真实高共鸣瞬间】编译进 Tier 1：

```text
<emergent_voice_profile description="由每晚睡眠反思从真实交流中自然习得的语感状态">
  当前熟稔与松弛度: 0.48 / 1.00 · 熟络（短句、省略主语和轻轻调侃开始自然）
  耳濡目染习得的对方口癖与词汇: “离谱”、“绝了”
  近期领悟的相处语感直觉:
  - 我发现今天你说短句、带哈哈的时候，我顺着你的节奏接，你聊得更快……
  近期触发最佳共鸣的真实互动瞬间 (供延续当时的聊天氛围):
  - [当时气氛: 轻快] 对方说: "不是吧，这也太离谱了……" -> 我当时自然回道: "害，先别气，摸摸。"
</emergent_voice_profile>
```

这个块在 `daily-frozen-memory.json` 里，白天字节稳定，走 KV Cache。新增的语感只在下一次 `/dream` 编译时进入 Tier 1，不会逐轮改写静态前缀。

### 使用与边界

- `/voice status`：熟稔度、阶段、句式/呼吸指标、传染词、最近心得；
- `/voice notes`：睡眠反刍出的第一人称语感心得与高共鸣瞬间；
- `/voice lexicon`：已经被传染的词和 AI 自己使用次数；
- **没有人工保存范例的命令**；语感只能通过真实交流自然出现。
- `user_linguistics.json`、`recent_turns`、语感心得全部是本地记忆，`.gitignore` 排除，不会上传 GitHub。
- 代码块、命令和以 `import/export/function/class/const` 开头的技术回复不进入语言统计与传染词。
- 0.6.0 的 `/style` 命令、`style_bank.json`、`<learned_natural_voice_examples>` 已全部移除。

## [0.4.x 历史] 呼吸式上下文代谢与过载保护（Context Metabolism Engine）

新增 [`lib/context-metabolism.js`](lib/context-metabolism.js)。Agent Loop 的 `llm/stream` 请求是冻结的只读对象，所以这层不篡改请求，而是在 **`agent/pre-step` waterfall** 里按 `tokenMeter.contextPressure(session)` 的水位改写当前会话的 **durable surface**（追加带 `surfaceOp: replace` 的压缩节点），再通过循环的请求重建让模型看到压缩后的历史。所有原文仍留在会话日志与本地归档，只有“当前模型看到的工作集”被代谢。

### 四级水位线

- **🟡 60% 工具脱水**：所有自然语言对话保持原样。仅对距今 **> 15 轮**、单条文本 **≥ 600 字符** 的历史 `tool/result` 做替换：原文写入 `.dsh/bionic-memory/context-archive/`，原位换成一个第一人称动作记忆（如“半小时前，我查阅了 src/file.ts 并完成了这一步；具体长文本已从工作记忆移出，归档 ctx-… ”）。保留 tool-call/result 配对。
- **🟠 75% 滑动微睡眠**：取当前已完成轮次最老的 **35%**，用 `<session_early_impression>` 替换其 surface 节点。印象只保留情绪演变曲线、当时的默契、核心结论，并注明“不是用户新说的话”。被折叠轮次在后台（`setImmediate`，不阻塞当前 step）送入 `ingestHistoricalTurn` → Layer 2 情景库与习惯比对；按 `(session_id, turn)` 去重，原始时间戳与高清原文保留，检索器仍可召回。
- **🔴 88% 走神与紧急排空**：把前 **60%** 扩展进同一个印象块（已折叠的 35% 会合并），强制后台入库；同时设置一次性 `yawn`。循环在 `agent/pre-step` 之后刷新 `systemPrompt.context`，所以当前 step 的系统提示会带上下面的生理反馈：
  `[系统提示：你们已经连续高强度聊了太久，你刚刚感到一阵人类般的“脑子发懵/走神”，请在回复开头自然地表现出揉太阳穴、伸懒腰或抱怨脑容量快烧干需要捋一捋的可爱反应]`
  用后立即清除，不会持续卖惨。

### 悬念图钉

折叠前扫描用户话语中的“待会儿/下次/另一件事/还没/别忘了/回头”等未完成信号，提取成 `pinned_open_loops`，写进 Layer 1 潜意识白板（`scratchpad.pinned_open_loops`）。系统提示每步都会带上 `<pinned_open_loops>`；提示词规则 14 要求模型在节奏放缓时主动追问一件，不要一次全问。用户后续提到相关话题时按文本相似度自动解钉；也可用 `/context resolve <id>` 手动解钉。

### 余温接力

每次高水位（峰值 ≥ 75%）会话 `turn/end` 时，把最后 3 轮自然语言、情绪余温与未完成话题写进 `.dsh/bionic-memory/handover.json`。若 5 分钟内新建一个空白会话（尚无 assistant 消息、同一预设），系统提示自动注入 `<immediate_short_term_carryover from_session="…" ended_minutes_ago="…">`，包含最后 3 轮原文摘要与情绪残留，让模型自然接上，而不是装作初次见面。

### 观察与边界

- 水位读取 `tokenMeter.contextPressure`；没有 provider 上报的 contextWindow 时，回退 `session.requestContext()?.contextWindow` 或 `llm.resolveModelInfo()`。模型/服务不提供窗口时该层不猜测、不误伤。
- `<session_early_impression>` 是确定性生成的“关系记忆”，不是额外调用模型的冷摘要；细节始终在 Layer 2 与 archive 里。替换会使 KV cache 从旧历史处失效，这是释放窗口的代价。
- 该层不修改也不关闭 Harness 自带的 `compaction`；它只在更早的 60/75/88 水位主动减负。所有 surface 替换都可从会话日志、Layer 2 和 `context-archive/` 追溯。
- `context-metabolism.json` 保存每会话水位/脱水/折叠/yawn 状态；`context-archive/index.json` 是归档索引；`handover.json` 只保留最近一次高水位接力。



## 核心算法

### 艾宾浩斯动态褪色

```
R(t) = exp(-(now - t_last) / (S_0 · E · (1 + 0.3 · k)))
```

- `R > 0.7`：暴露 `level_0_raw`（`<clear_memories>`）
- `0.3 < R ≤ 0.7`：暴露 `level_1_summary`（`<summarized_memories>`）
- `R ≤ 0.3`：**物理清空** `level_0` / `level_1`，只留 `level_2_impression`（`<faded_impressions>`）

被回忆到的记忆会刷新 `t_last` 并增加 `k`（间隔重复效应）。

### 重复性压缩

- 入库前与习惯图式比对；高度吻合且 `n < 0.3` 时**直接丢弃本轮对话**，只把 `occurrence_count + 1`、刷新 `last_triggered`。
- 相似情景构成连通分量且数量 ≥ 3 时触发**风琴折叠**：生成/合并习惯图式，删除平庸重复项，只保留情绪或惊奇度最高的 1 条作为例外锚点。
- 活跃习惯超过 `max(72h, 3 × 平均触发间隔)` 未触发会自动降级为 `[历史旧印象]`，并在白板里生成一条主动好奇钩子。

### 每日做梦（NREM + REM）

- 调度：每日 `dreamHour`（默认 04:00）检查一次；插件启动 45 秒后若距上次做梦超过 `dreamIntervalHours`（默认 18h）也会补一次。
- 手动：`/dream` 或监视器「现在做梦」或工具 `bionic_memory {action:"dream"}`。
- NREM：合并今日轨迹、强制衰减、风琴折叠、从纠正/高光提炼 1–2 条本能。
- REM：抽取 2 条今日高情绪记忆 + 2 条久远模糊印象/旧习惯，用 `temperature > 1.0`（默认 1.25）编织第一人称超现实梦境；醒来只保留约 20% 的余韵（≤100 字）写入白板。完整梦境正文只进梦境日记，不注入上下文。

### 夜间批处理的严格 JSON 契约

有可用模型时，一次 `dreamTemperature`（默认 1.25）的严格 JSON 批处理会同时完成 NREM 与 REM。输入包括：今日轨迹（ID / 时间 / E / N / 原文摘录）、按相似度预分组的记忆簇、`R(t) <= fadeThreshold` 的旧记忆、今日纠正/高光片段，以及 REM 抽样素材。

模型必须输出：

```json
{
  "compressed_schemas": [
    {
      "cluster_id": "C1",
      "member_ids": ["ep_a", "ep_b", "ep_c"],
      "exception_anchor_id": "ep_a",
      "purge_ids": ["ep_b", "ep_c"],
      "pattern_summary": "你们反复……",
      "keywords": ["……"],
      "confidence": 0.85
    }
  ],
  "impression_updates": [
    { "id": "ep_x", "impression": "好像在……", "emotion_tone": "……" }
  ],
  "skills": [{ "rule": "当……时，……", "confidence": 0.8 }],
  "dream": {
    "narrative": "第一人称超现实梦境，140-240 字",
    "afterglow": "100 字以内",
    "mood_shift": { "valence": 0.25, "arousal": 0.3 }
  }
}
```

应用规则：

- 所有 ID 必须来自输入；压缩簇的成员必须落在同一个预分组簇内，否则整条提案丢弃。
- 一个簇只保留 1 个例外锚点；其余成员物理删除。
- `impression_updates` 只改写 `R(t) <= fadeThreshold` 的旧记忆，并清空 L0/L1。
- `skills` 去重后写入 Layer 4；没有模型技能时退回本地启发式。
- `dream.narrative` / `afterglow` / `mood_shift` 直接落库并写入白板。
- 模型不可用、JSON 不合法或某一段缺失时，缺失部分回退到两阶段确定性路径；`batchCollapseFallback` 默认 `true`，保证模型漏掉的相似簇仍会被确定性折叠。
- 批处理测试见 `test/batch-smoke.mjs`（用假模型验证严格 JSON 的解析、ID 校验、物理抹除、印象降维与梦境落库）。

## 命令与工具

| 入口 | 用法 |
|---|---|
| `/memory` | 查看记忆概况；`/memory recall <关键词>` 检索 |
| `/dream` | 立刻执行 NREM + REM |
| `/forget <faded\|habits\|skills\|记忆ID>` | 主动遗忘；`/forget all confirm` 才会清空全部 |
| `/evolve status\|trigger\|rollback\|approve [id]` | 元认知进化：查看遥测/参数、强制反思、回退、审批代码提案 |
| `/context status\|resolve <id\|文字>\|pin <文字>` | 呼吸代谢：查看水位/脱水/折叠、解钉或手动图钉未完成话题 |
| `/voice status\|notes\|lexicon` | 自然语感养成：查看熟稔度、句式呼吸、传染词与睡眠反刍笔记 |
| 工具 `bionic_memory` | 仅永续记忆模式可用：`status` / `recall` / `remember` / `dream` / `forget` / `resolve_curiosity` / `confirm` / `last_dream`；`remember` 可带 `source_type: user_stated \| agent_inferred`；`preset_health` / `preset_status` 是全局诊断动作 |
| 监视器 | 潜意识 / 情景 / 习惯 / 本能 / 梦境 / 图谱 / 上下文 七个页签；含来源标签、归档本能、并行窗口、语感镜像与缓存省钱卡片 |

## 配置（`cordis.patch.yml` 的 `bionic-memory` 行）

| 字段 | 默认 | 说明 |
|---|---|---|
| `activation` | `preset` | `all` 注入所有会话（旧行为）；`preset` 只注入 `presetId` 会话 |
| `presetId` | `bionic-memory` | 受限模式对应的 preset id |
| `observeAllSessions` | `false` | 是否记录所有会话的轨迹；`false` 时只记录 preset 会话 |
| `dataDir` | 空 | 空则用「当前活跃会话工作目录/.dsh/bionic-memory」；仓库默认不再固定绝对路径，便于跨机器克隆 |
| `dreamHour` | `4` | 每日做梦小时（本地时区） |
| `dreamIntervalHours` | `18` | 启动补梦的最小间隔 |
| `dreamTemperature` | `1.25` | REM 采样温度 |
| `dreamForgetRatio` | `0.8` | 醒来遗忘比例 |
| `llmEnabled` | `true` | 关闭后全部使用本地确定性兜底 |
| `llmTimeoutMs` | `45000` | 单次模型调用超时 |
| `contextCharBudget` | `3000` | 注入 XML 的字符预算 |
| `habitSimilarity` | `0.58` | 习惯化匹配阈值 |
| `collapseSimilarity` | `0.45` | 风琴折叠的相似度阈值 |
| `collapseThreshold` | `3` | 触发坍缩的最少同类条数 |
| `batchCollapseFallback` | `true` | 模型批处理漏掉的相似簇是否仍确定性折叠 |
| `fadeThreshold` / `clearThreshold` | `0.3` / `0.7` | 记忆分辨率分界 |
| `maxSkills` | `20` | 注入 System Prompt 的本能上限 |
| `voiceEngineEnabled` | `true` | 是否启用语言镜像、熟稔度与睡眠语感反刍 |
| `voiceReflectionEnabled` | `true` | `/dream` 后是否执行第一人称语感复盘 |
| `voiceLexiconThreshold` | `3` | 一个词被用户使用超过多少次后进入传染词库 |
| `voiceLexiconTop` | `8` | 注入 Tier 1 语感档案的传染词上限 |
| `voiceLexiconMax` / `voiceRecentTurns` | `24` / `120` | 词库容量与参与反刍的近期轮次 |
| `voiceRecentHighDays` | `7` | 高共鸣瞬间的近期窗口（天） |
| `voiceFamiliarityTurnScale` / `EventScale` / `ResonanceScale` | `70` / `35` / `10` | 熟稔度曲线的三个衰减尺度 |
| `skillMergeSimilarity` | `0.75` | NREM 本能合并阈值 |
| `skillTriggerSimilarity` | `0.3` | 当前查询与本能规则的相关度阈值（命中才刷新 last_used） |
| `skillIdleDays` | `30` | 超过该天数未触发则归档 |
| `sessionHintMax` | `3` | `<parallel_sessions>` 最多列出的其他窗口数 |
| `sessionHintFreshHours` | `24` | 并行窗口摘要的新鲜期 |
| `reconsolidationWindowMs` | `1800000` | 唤醒后等待再巩固的时间窗（30 分钟） |
| `fallibilityEnabled` | `true` | 是否启用受控记忆失真 |
| `fallibilityChanceMin` / `fallibilityChanceMax` | `0.15` / `0.25` | 每轮触发失真的概率区间 |
| `fallibilityBandMin` / `fallibilityBandMax` | `0.2` / `0.5` | 允许失真的保留率区间 |
| `fallibilityTipBandMax` | `0.35` | “话到嘴边”算子的上界 |
| `fallibilityTtlMs` | `86400000` | 等待用户纠正的有效期（24 小时） |
| `fallibilityMaxAnchors` | `3` | 白板保留的趣味锚点上限 |
| `metaEvolutionEnabled` | `true` | 是否启用元认知进化引擎 |
| `similarityThreshold` | `0` | 检索相似度硬阈值；Tier 1 会逐次收紧 |
| `metaEvolutionTrialDays` | `3` | 每次进化的试用天数 |
| `metaEvolutionPromptSessions` | `10` | Tier 2 的会话数触发线 |
| `metaEvolutionPromptDays` | `7` | Tier 2 的天数触发线 |
| `metaEvolutionCodeDays` | `14` | Tier 3 无瓶颈时的最长提案间隔 |
| `contextMetabolismEnabled` | `true` | 是否启用呼吸式上下文代谢 |
| `contextWaterlineBatch` | `0.82` | 锯齿波阶梯折叠水位线 |
| `contextBatchPrefixRatio` | `0.45` | 阶梯折叠的最老轮次比例 |
| `contextWaterlineTool` | `0.6` | 0.4.x 历史字段（已废弃） |
| `contextWaterlineMicro` | `0.75` | 滑动微睡眠水位线 |
| `contextWaterlineOverload` | `0.88` | 走神/紧急排空水位线 |
| `contextToolAgeTurns` | `15` | 只脱水超过多少轮的工具结果 |
| `contextToolMinChars` | `600` | 只脱水超过多少字符的工具结果 |
| `contextCollapseRatio` | `0.35` | 75% 时折叠的最老轮次比例 |
| `contextEmergencyRatio` | `0.6` | 88% 时折叠的最老轮次比例 |
| `contextHandoverMinutes` | `5` | 跨会话余温接力的有效分钟数 |
| `contextHandoverWaterline` | `0.75` | 触发余温接力记录的最低峰值水位 |
| `contextOpenLoopMax` | `12` | 潜意识白板保留的未完成话题上限 |
| `s0Multiplier` | `1` | 全局 S0 乘数；Tier 1 调整它，使所有既有记忆的保留率立即生效 |
| `defaultS0` | `48` | 单条记忆的 S0 基值（乘 `s0Multiplier` 后生效） |
| `debug` | `false` | 是否输出调度调试日志 |

完整字段见 `lib/config.js`。

## 存储

- 目录：`<工作区>/.dsh/bionic-memory/`（本安装已在 `cordis.patch.yml` 的 `dataDir` 中固定为当前工作区，重启不会漂移）
- 主后端：`memory.db`（`node:sqlite`，WAL；Electron 44 自带 Node 24）
- 兜底：`node:sqlite` 不可用时自动落 `memory.json`（原子写）
- 表：`meta` `scratchpad` `episodes` `schemas` `skills` `dreams` `journal` `edges`
- 关联图：`edges` 记录情景↔习惯（例外锚点）、习惯↔情景（折叠来源）、梦境↔情景（跨时空桥）与时间邻近边；启动时会清理悬空边。
- 同一份数据同时服务 Host 注入、Agent 工具、命令与监视器 HTTP 数据面；数据面只允许同源、回环/私有网段且通过 Connection 校验的请求。

## 注入位置

`agent/created` 时在 `agent.ctx.systemPrompt` 上注册两个 scoped section：

- `bionic-memory:cognitive-rules`，order `100`：`prompt-template.md` 的认知铁律（`interpolate:false`）
- `bionic-memory:memory-context`，order `101`：每次推理前实时渲染的 `<bionic_memory_context>`

因此每个模型步都会重新计算 R(t)、挑选相关记忆、折叠习惯并注入；不是一次性的会话开头提示。

## 测试

```bash
node test/smoke.mjs          # 引擎算法：折叠、习惯化、衰减、NREM/REM、forget、持久化
node test/batch-smoke.mjs    # 严格 JSON 批处理：簇校验、物理抹除、印象降维、本能、梦境落库
node test/mechanisms-smoke.mjs  # 六项高阶机制：来源、失调、本能上限、并行窗口、再巩固、梦境缓存
node test/fallibility-smoke.mjs # 失真四算子、免疫红线、shadow truth、Snap-Back 修复与梦境锚点
node test/meta-evolver-smoke.mjs # 遥测、Tier 1/2/3、Git 快照、试用回滚、提案审批与噩梦
node test/context-metabolism-smoke.mjs # 0.82 锯齿波、归档、图钉、余温接力与历史入库
node test/cache-prefix-smoke.mjs # 四阶前缀、每日冻结块、尾部闪回、Tier hash、缓存遥测与告警
node test/voice-engine-smoke.mjs # 语言镜像、传染词、熟稔度、睡眠反刍、Tier 1 语感档案
node test/client-smoke.mjs   # Client 工厂、locale 字典、shell.overlay 注册（stub React/Cordis）
node test/session-inspect.mjs <session.v4.jsonl.zstd>   # 从会话日志确认注入
node test/db-inspect.mjs <memory.db>                    # 只读查看 SQLite 表
```

`test/` 不随发布文件分发；运行时不依赖测试代码。

## 已知限制

- 监视器是 Client 插件：新装/重装后如果页面是在安装前打开的，需要**刷新一次页面**让浏览器加载新的 Client bundle。Host 半、preset、命令、工具与注入不受影响。
- 记忆写入是尽力而为的异步过程：`turn/end` 后约 0.9s 入库，进程在写入前被强杀会丢掉最后一轮。
- REM 叙事依赖已配置的默认模型；模型不可用时自动退回本地拼贴式梦境，功能不中断。
- 中文向量是字符 bigram 哈希 + 关键词 Jaccard 的轻量近似，不是神经网络 embedding；阈值可在配置里调。
