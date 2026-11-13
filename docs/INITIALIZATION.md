# 全局记忆数据初始化说明

适用版本：`dsh-bionic-memory@0.8.x`

全局根目录：

```text
~/.dsh/bionic-soul/
```

Windows 当前机器上是：

```text
C:\Users\unity\.dsh\bionic-soul\
```

记忆只在「永续记忆模式」会话里读写；所有工作区、所有模式会话共享这一个全局目录。标准会话不会被初始化或注入记忆。

## 1. 什么时候初始化

初始化是自动的，不需要手动运行脚本：

1. **Host 插件加载时**：`ensureSoul()` 创建五个子目录、`agents.json`、`orchestrator/README.md`、`.gitignore`，执行 `git init` 和首次 commit，并从插件 `prompt-template.md` 物理落盘 `cache_blocks/tier0_static_dna.md`。
2. **第一次真正 boot 记忆引擎时**（进入永续记忆模式、或在模式会话里触发工具/监视器）：
   - 创建 `cortex/memory_cortex.sqlite`，建三张核心表与兼容触发器；
   - 创建 `soul/scratchpad.json`、`soul/emergent_voice.json`、`soul/procedural_skills.md`、`soul/dreams/`；
   - 若 `cache_blocks/tier1_daily_frozen.md` 不存在，先编译一个 seed；第一次 `/dream` 会覆盖为当日冻结区；
   - 刷新 `orchestrator/briefings/<id>.md`。
3. **之后每轮对话**：同步白板、语感、本能与外部 agent 简报。
4. **每次 `/dream`**：NREM/REM、语感反刍、梦境日记、Tier 1 物理文件、简报。

## 2. 全新安装

1. 安装 bundle（本地路径）：

```powershell
# 通过 DSH 的 plugin_manager install_bundle 安装本仓库
```

2. 重启 DSH，或让插件热重载。
3. 新建会话，在 Agent 选择器里选择「永续记忆模式」。
4. 进入模式后调用一次：

```json
{ "action": "preset_health" }
```

确认 `broken: null`、`composed: true`。

5. 在模式会话里正常聊第一轮，或调用 `/voice status` 触发引擎；然后检查：

```text
~/.dsh/bionic-soul/cortex/memory_cortex.sqlite
~/.dsh/bionic-soul/soul/scratchpad.json
~/.dsh/bionic-soul/cache_blocks/tier0_static_dna.md
~/.dsh/bionic-soul/cache_blocks/tier1_daily_frozen.md
~/.dsh/bionic-soul/orchestrator/agents.json
```

6. 执行 `/dream`，生成第一份当日冻结区、梦境日记和外部 agent 简报。

## 3. 旧 workspace-local 数据迁移

如果之前使用过 `default-workspace/.dsh/bionic-memory`，首次 boot 会一次性迁移：

- 读取 profile 指针 `<profile>/.dsh/bionic-memory-location.json`（或环境变量 `BIONIC_MEMORY_DATA_DIR`）作为**旧数据来源**；
- 用 SQLite `VACUUM INTO` 把旧 `memory.db` 复制为 `cortex/memory_cortex.sqlite`；
- 复制旧的 `user_linguistics.json` → `soul/emergent_voice.json`；
- 复制旧 `daily-frozen-memory.json` 的 block → `cache_blocks/tier1_daily_frozen.md`；
- 复制旧 `telemetry.json` / `meta-evolution.json` → `evolution_lab/`；
- 复制旧 `proposals` / `snapshots` / `context-archive`；
- 写入 `~/.dsh/bionic-soul/.migrated-from`，避免重复迁移。

**旧目录不会删除**，它保留为冷备份。迁移完成后，日常运行只使用全局目录。

当前机器已经完成过这一步：旧库的 28 条情景、2 条本能、1 场梦、8 条边已进入全局 `cortex`，旧目录仍在。

## 4. 数据目录覆盖

默认固定为 `~/.dsh/bionic-soul`。如果需要自定义：

- 在本地 `cordis.patch.yml` 给 `bionic-memory` 行配置绝对 `dataDir`；
- 不要把个人绝对路径提交到公开仓库。

profile 指针和 `BIONIC_MEMORY_DATA_DIR` 不再决定日常运行目录，只用于一次性旧数据迁移。

## 5. 重置与备份

不要直接删除全局目录。推荐：

```powershell
Rename-Item "C:\Users\unity\.dsh\bionic-soul" "bionic-soul.backup-$(Get-Date -Format yyyyMMdd-HHmmss)"
```

下次进入永续记忆模式时插件会重新创建空的全局目录。需要恢复时，把备份目录改回 `bionic-soul` 并重启。

## 6. 验证清单

- `preset_health`：composition 正常；
- `bionic_memory { "action": "status" }`：模式内可用；
- `/voice status`：熟稔度、传染词、句式指标；
- `/memory`：情景/习惯/本能/梦；
- 文件：`cortex`、`soul`、`cache_blocks`、`orchestrator`、`evolution_lab`；
- `git -C ~/.dsh/bionic-soul log --oneline`：至少有一条 `bootstrap bionic-soul`；
- SQLite：`episodic_memories` / `compressed_schemas` / `memory_edges` 三张表存在。

## 7. 外部 Agent 初始化

`orchestrator/agents.json` 默认为示例条目 `zcode` 与 `workbuddy`，但不固定。添加任意 agent：

```json
{
  "id": "my-agent",
  "name": "My Agent",
  "description": "它负责什么",
  "keywords": ["接口", "bug", "部署"],
  "briefing": "briefings/my-agent.md"
}
```

每次入库、每场梦后，引擎按每个 agent 的 `keywords` 重写其 `briefing`。外部 orchestrator 只应读取 `agents.json`，按 `id` 挂载对应简报，不应假设 ZCode/WorkBuddy 一定存在。

## 8. 已知边界

- 当前 profile/工作区没有 `dsh-agent-orchestrator` 源码；通用桥梁文件已就绪，但无法修改那个插件自身的写入逻辑。
- 标准会话不读写记忆；需要连续记忆时请使用「永续记忆模式」。
- Tier 1 只在启动 seed 或 `/dream` 时重编译；白天不会逐轮改写静态前缀。
