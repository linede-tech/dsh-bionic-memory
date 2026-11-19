# dsh-bionic-memory · 仿生永续记忆

挂在 DeepSeek Harness 上的 Cordis 插件：让模型在「永续记忆模式」里拥有连续时间感、会遗忘、会形成习惯、每天做梦、写日记，并能核对原话。

## 安装与启用

将本目录作为一个 bundle 安装，重启或热重载 DSH：

```text
plugin_manager install_bundle <本目录>
```

新建会话，在 Agent 选择器里选择 **「永续记忆模式」**。只有该模式会读写记忆；标准会话不注入上下文、不观察轨迹，工具与命令会被拒绝。

先调用一次诊断确认 composition 正常：

```json
{ "action": "preset_health" }
```

`composed: true` 且 `leakedServices: []` 即可用。

## 首次初始化（没有预设角色）

这个项目**不内置名字、性别、头像、关系或人格**。没有“小溯”这类默认角色，也没有预设的“她/他”身份。

第一次进入「永续记忆模式」并说话时，模型会通过 `<companion_setup>` 引导用户回答：

1. 你想给我起什么名字？
2. 你希望我怎么称呼你？
3. 你希望我们是什么关系、用什么方式相处？
4. （可选）要不要给我一张头像？

也可以直接说：

```text
初始化：你的名字叫「……」，叫我「……」，我们像……一样相处。
```

模型会调用 `initialize_companion` 写入 `config.json`。名字是必填项；用户暂时跳过时，它会保持中性称呼，不编造身份。

相关入口：

| 入口 | 用途 |
|---|---|
| `/init` | 查看初始化状态，或获取首次引导 |
| `initialize_companion` | 写入用户给出的名字、称呼、关系、语气与可选头像 |

初始化完成前：

- 显示已配置的头像（没有自定义时用中性占位图）；
- 不显示名字；
- 不使用任何预设角色；
- 系统只注入中性的 `<companion_setup>`。

初始化完成后才显示 `<companion_identity>` 和名字；头像从第一步起就可见。

## 全局记忆目录

所有工作区、所有模式会话共享：

```text
~/.dsh/bionic-soul/
├── cortex/memory_cortex.sqlite   左脑：SQLite（WAL）
├── soul/
│   ├── scratchpad.json           情绪 / 梦余韵 / 好奇心
│   ├── emergent_voice.json       语感与熟稔度
│   ├── procedural_skills.md      本能
│   ├── dreams/YYYY-MM-DD_#01.md  每场梦独立编号
│   ├── journal/                  300 字序言、活页、卷宗、冷封
│   ├── memory_catalog.md         一天一行家底目录
│   └── my_schedule.json          TA 自己的闹钟
├── cache_blocks/                 Tier 0 / Tier 1 物理前缀
├── orchestrator/                 外部 agent 注册表与简报
├── evolution_lab/                元认知遥测、提案、快照
├── assets/avatar.png             用户初始化后使用的头像
└── config.json                   名字、称呼、关系与头像配置
```

无需手动初始化目录：首次 boot 自动建目录、schema、中性占位头像和 Git 仓库。首次**角色**初始化由用户完成。

## 项目数据与本地数据是分开的

| 位置 | 内容 | 是否在项目仓库 |
|---|---|---|
| `dsh-bionic-memory/` | 代码、预设声明、默认资源、文档、测试 | 是 |
| `dsh-bionic-memory/samples/` | **虚构样例数据**，只供参考，不会被插件加载 | 是 |
| `~/.dsh/bionic-soul/` | 记忆库、日记、梦境、原话、config、头像 | 否 |
| `~/.dsh/sessions/` | 会话日志 | 否 |
| `dsh-bionic-memory/test/*` | 临时测试目录，运行后清理 | 否（临时） |

> `samples/` 全部是虚构样例；项目仓库不包含任何真实记忆、日记、头像或会话数据。

从 `1.3.1` 起，启动阶段对**已存在的本地数据只读**：

- 已有 `config.json` 不会被迁移或重写；
- 已有 Tier 0 不会被项目升级覆盖；
- 旧配置只在内存里按“未初始化”解释，文件保持原样；
- 只有缺失的新文件（例如首次安装的 `config.json`、中性占位头像）才会创建；
- 写入只发生在用户明确操作时：`initialize_companion`、`/avatar`、`/dream`，以及正常对话产生的增量记忆。

> 历史说明：`1.3.0` 安装时曾自动迁移过旧的 `config.json` 与 Tier 0；`1.3.1` 已移除这类启动写入。已发生的迁移不会自动回滚，需要恢复请明确确认。

开发或测试时请让 `dataDir` 指向临时目录，不要指向 `~/.dsh/bionic-soul`；仓库里的 `test/` 只使用临时目录。`samples/` 是虚构样例，插件不会扫描或加载它。

## 核心机制

- **左脑 SQLite**：`episodic_memories`（事实）、`agent_hypotheses`（推测池）、`compressed_schemas`、`memory_edges`；`verbatim_vault` 用 FTS5 永久保存原话。
- **四层记忆**：潜意识白板 → 情景记忆 → 压缩习惯 → If-Then 本能；按艾宾浩斯曲线从 raw → summary → impression 衰减。
- **事实与推测隔离**：默认召回只查 `user_stated`；AI 旧推测进 `agent_hypotheses`，只能按需查看。
- **严格 JSON 批处理**：NREM 折叠、降维、本能提炼、REM 梦境；解析失败自动走确定性兜底。
- **每日做梦**：`/dream` 可随时触发；同日多场梦写 `_#01`、`_#02`，不覆盖。
- **生命日记**：只有高情绪唤醒、关系/认知里程碑或主动执笔才写；Tier 1 只放 300 字序言，其余按需翻阅。
- **家底目录**：每天一行；漏梦的过去日会查原话冷库，补成 `[已聊/未眠补录]` 或 `[已聊/已眠补录]`，真空白才写 `[空白]`。
- **原话冷库**：衰减只从向量池移除 raw，原文永久留在 `verbatim_vault`；可按关键词 + 日期 + 前后轮数翻旧账。
- **再巩固**：被动召回不续命；只有本轮输出显式提到或工具调阅才强化，每轮最多 2 条、单条 24 小时内最多 1 次。
- **语感养成**：语言镜像、传染词、熟稔度、睡眠期第一人称复盘；不注入例句。
- **自主脉搏**：TA 可给自己定 `silent_task` / `proactive_message` / `go_to_sleep` 闹钟；插件每 5 分钟检查，到点拉起自主回合。
- **专属形象**：初始化完成后，聊天里才显示用户设定的头像与名字；心情切换光效；头像可随时替换。
- **Tier 前缀缓存**：Tier 0 静态行为规则与 Tier 1 每日冻结区物理落盘，全天走 KV Cache。
- **元认知**：遥测、自调参、提示词进化、代码提案、Git 快照与回滚。
- **上下文代谢**：水位线、工具脱水、阶梯折叠、余温接力、未完成话题。
- **外部 agent 桥**：`orchestrator/agents.json` 注册任意 agent；ZCode / WorkBuddy 只是示例，不是固定项。

## 命令与工具

| 入口 | 用途 |
|---|---|
| `/memory` | 记忆概况；`/memory recall <关键词>` 检索 |
| `/dream` | 立刻 NREM + REM |
| `/forget <faded\|habits\|skills\|id>` | 遗忘；`/forget all confirm` 才清空全部 |
| `/init` | 查看身份初始化状态，或获取首次引导 |
| `/avatar [路径\|URL\|data:...]` | 查看或替换头像（初始化后显示） |
| `/voice status` | 熟稔度、语感与传染词 |
| `/evolve ...` | 元认知进化状态、触发、回滚、审批 |
| `/context ...` | 上下文水位、解钉、手动图钉 |
| `bionic_memory` | 记忆状态/检索/手动记忆/做梦/遗忘/确认/梦境缓存 |
| `write_journal_entry` | 只记真正不想忘的瞬间，不写流水账 |
| `read_my_journal` | 按需翻阅日记与卷宗 |
| `dig_up_exact_words` | 从 `verbatim_vault` 精准翻旧账 |
| `check_my_hypotheses` | 查看自己过去的推测，不当事实 |
| `set_my_own_schedule` | 给自己定闹钟 |
| `initialize_companion` | 首次初始化 / 修改名字、称呼、关系、语气与头像 |
| `set_my_avatar` | 用户明确要求时更换头像/名字 |

界面右下角「记忆」按钮打开监视器：潜意识 / 情景 / 习惯 / 本能 / 梦境 / 图谱 / 上下文。

## 配置

主要配置在本地 `cordis.patch.yml` 的 `bionic-memory` 行：

| 字段 | 默认 | 说明 |
|---|---|---|
| `activation` | `preset` | `preset` 仅模式会话；`all` 全会话 |
| `presetId` | `bionic-memory` | 模式 preset id |
| `dataDir` | 空 | 默认全局 `~/.dsh/bionic-soul` |
| `dreamHour` | `4` | 每日做梦小时 |
| `llmEnabled` | `true` | 关闭后用本地兜底 |
| `contextCharBudget` | `3000` | 上下文 XML 字符预算 |
| `fadeThreshold` / `clearThreshold` | `0.3` / `0.7` | 记忆分辨率分界 |
| `voiceEngineEnabled` | `true` | 语感养成 |
| `metaEvolutionEnabled` | `true` | 元认知进化 |
| `contextMetabolismEnabled` | `true` | 上下文代谢 |
| `heartbeatEnabled` | `true` | 自主心跳 |
| `heartbeatTickMs` | `300000` | 5 分钟检查一次 |

完整字段见 `lib/config.js`。

`config.json` 同时保存用户亲自设定的身份：

```json
{
  "initialized": false,
  "name": "",
  "user_name": "",
  "relationship": "",
  "tone": "",
  "avatar": "assets/avatar.png",
  "moods": {
    "happy": "assets/avatar_happy.png",
    "sleepy": "assets/avatar_sleepy.png",
    "curious": "assets/avatar_curious.png"
  }
}
```

初始化后 `initialized` 变为 `true`，并填入用户给出的 `name` / `user_name` / `relationship` / `tone`。没有初始化的旧配置只会被按“未初始化”读取，不会被改写；旧默认名“小溯”不会恢复。

`avatar` 支持本地路径、URL、Base64。可选心情图不存在时只切换头像外圈光效。

## 测试

```bash
node test/smoke.mjs
node test/batch-smoke.mjs
node test/mechanisms-smoke.mjs
node test/fallibility-smoke.mjs
node test/meta-evolver-smoke.mjs
node test/context-metabolism-smoke.mjs
node test/cache-prefix-smoke.mjs
node test/voice-engine-smoke.mjs
node test/bridge-smoke.mjs
node test/journal-smoke.mjs
node test/vault-catalog-smoke.mjs
node test/visual-smoke.mjs
node test/client-smoke.mjs
```

测试只使用临时目录，结束后自动清理。

## 已知边界

- 初始化前只显示头像、不显示名字；这是有意的，避免把默认角色当成用户设定。
- 旧版本配置里未初始化的“小溯”只会按未初始化读取，文件不会被启动过程改写。
- Client 插件更新后需要刷新页面；Host 注入、工具、命令不受影响。
- 记忆写入在 `turn/end` 后约 0.9 秒异步入库；进程强杀可能丢最后一轮。
- 中文检索是字符 bigram + 关键词的轻量近似，不是神经网络 embedding。
- 主动消息的内部唤醒载体仍存在 session log 中，但 Web 对话 UI 会隐藏；模型输入必须非空。
- 当前 profile 里没有 `dsh-agent-orchestrator` 源码；`~/.dsh/bionic-soul/orchestrator/` 下的注册表与简报是双方约定好的接入点。

## 版本

当前 `1.3.3`。详细变更见 Git 历史与 `docs/INITIALIZATION.md`。
