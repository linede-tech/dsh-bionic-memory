# 全局记忆与身份初始化说明

适用版本：`dsh-bionic-memory@1.3.x`

全局根目录：

```text
~/.dsh/bionic-soul/
```

Windows 当前机器上是：

```text
C:\Users\unity\.dsh\bionic-soul\
```

记忆只在「永续记忆模式」会话里读写；所有工作区、所有模式会话共享这一个全局目录。标准会话不会被初始化或注入记忆。

项目不内置预设角色：没有默认名字、性别、关系、人格或“小溯”。身份由用户首次初始化写入 `config.json`；初始化前系统只注入中性的 `<companion_setup>`，不显示头像与名字。

## 1. 什么时候初始化

初始化是自动的，不需要手动运行脚本：

1. **Host 插件加载时**：`ensureSoul()` 创建五个子目录、`agents.json`、`orchestrator/README.md`、`.gitignore`，执行 `git init` 和首次 commit，并从插件 `prompt-template.md` 物理落盘 `cache_blocks/tier0_static_dna.md`。
2. **首次进入模式时**：写入 `assets/avatar.png` 的中性占位图与 `config.json`；此时 `initialized: false`、`name: ""`，没有任何预设角色。
3. **用户完成身份初始化后**：`config.json` 写入 `initialized: true` 及用户给出的 `name` / `user_name` / `relationship` / `tone`；聊天里才开始显示名字与头像。
4. **第一次真正 boot 记忆引擎时**（进入永续记忆模式、或在模式会话里触发工具/监视器）：
   - 创建 `cortex/memory_cortex.sqlite`，建三张核心表与兼容触发器；
   - 创建 `soul/scratchpad.json`、`soul/emergent_voice.json`、`soul/procedural_skills.md`、`soul/dreams/`；
   - 若 `cache_blocks/tier1_daily_frozen.md` 不存在，先编译一个 seed；第一次 `/dream` 会覆盖为当日冻结区；
   - 刷新 `orchestrator/briefings/<id>.md`。
5. **之后每轮对话**：同步白板、语感、本能与外部 agent 简报。
6. **每次 `/dream`**：NREM/REM、语感反刍、梦境日记、Tier 1 物理文件、简报。

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

5. 完成首次身份初始化，任选一种：

```text
初始化：你的名字叫「……」，叫我「……」，我们像……一样相处。
```

或：

```text
/init
```

也可以调用 `initialize_companion`：

```json
{
  "name": "你给 TA 的名字",
  "user_name": "TA 怎么称呼你",
  "relationship": "你们的关系/相处方式",
  "tone": "可选的语气偏好",
  "avatar": "可选的图片路径/URL/data URI"
}
```

名字必填；其余可留空。初始化前没有默认名字、头像或关系。

6. 在模式会话里正常聊第一轮，或调用 `/voice status` 触发引擎；然后检查：

```text
~/.dsh/bionic-soul/cortex/memory_cortex.sqlite
~/.dsh/bionic-soul/soul/scratchpad.json
~/.dsh/bionic-soul/cache_blocks/tier0_static_dna.md
~/.dsh/bionic-soul/cache_blocks/tier1_daily_frozen.md
~/.dsh/bionic-soul/orchestrator/agents.json
```

7. 执行 `/dream`，生成第一份当日冻结区、梦境日记和外部 agent 简报。

## 3. 身份配置

`~/.dsh/bionic-soul/config.json`：

```json
{
  "initialized": true,
  "name": "用户给的名字",
  "user_name": "用户希望被称呼的方式",
  "relationship": "用户选择的关系",
  "tone": "用户选择的语气",
  "avatar": "assets/avatar.png",
  "moods": {}
}
```

- `initialized` 为 false 时，客户端不显示头像与名字，System Prompt 只注入 `<companion_setup>`；
- 初始化后注入 `<companion_identity>`；
- 旧的未初始化“小溯”配置只会按未初始化读取，文件不会被启动过程改写；
- 想改身份时直接说“把你名字改成…”“以后叫我…”，或再次调用 `initialize_companion`。

## 4. 旧 workspace-local 数据

`1.3.1` 起**移除了启动时的自动迁移**。项目升级不会读取、复制或改写旧 workspace-local 数据；当前全局目录是唯一运行数据源。

当前机器已经完成过历史迁移：全局 `cortex` 中有 40 条情景、3 条本能、2 场梦、11 条边；旧 workspace-local 目录、旧 profile 目录、profile 指针和 `.migrated-from` 均已删除。

如果以后确实需要导入旧数据，请先备份全局目录，再手动复制或编写显式迁移脚本，不要让正常启动自动执行。

## 5. 数据目录覆盖

默认固定为 `~/.dsh/bionic-soul`。如果需要自定义：

- 在本地 `cordis.patch.yml` 给 `bionic-memory` 行配置绝对 `dataDir`；
- 不要把个人绝对路径提交到公开仓库。

profile 指针和 `BIONIC_MEMORY_DATA_DIR` 不再决定日常运行目录，只用于一次性旧数据迁移。当前机器已经删除旧指针，日常直接使用全局目录。

## 6. 重置与备份

不要直接删除全局目录。推荐：

```powershell
Rename-Item "C:\Users\unity\.dsh\bionic-soul" "bionic-soul.backup-$(Get-Date -Format yyyyMMdd-HHmmss)"
```

下次进入永续记忆模式时插件会重新创建空的全局目录。需要恢复时，把备份目录改回 `bionic-soul` 并重启。

## 7. 验证清单

- `preset_health`：composition 正常；
- `config.json`：`initialized`、`name` 已由用户完成，或明确保持未初始化；
- 未初始化时：聊天界面不显示头像/名字，System Prompt 只有 `<companion_setup>`；
- `bionic_memory { "action": "status" }`：模式内可用；
- `/voice status`：熟稔度、传染词、句式指标；
- `/memory`：情景/习惯/本能/梦；
- 文件：`cortex`、`soul`、`cache_blocks`、`orchestrator`、`evolution_lab`；
- `git -C ~/.dsh/bionic-soul log --oneline`：至少有一条 `bootstrap bionic-soul`；
- SQLite：`episodic_memories` / `compressed_schemas` / `memory_edges` 三张表存在。

## 8. 外部 Agent 初始化

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

## 9. 已知边界

- 当前 profile/工作区没有 `dsh-agent-orchestrator` 源码；通用桥梁文件已就绪，但无法修改那个插件自身的写入逻辑。
- 标准会话不读写记忆；需要连续记忆时请使用「永续记忆模式」。
- Tier 1 只在启动 seed 或 `/dream` 时重编译；白天不会逐轮改写静态前缀。

