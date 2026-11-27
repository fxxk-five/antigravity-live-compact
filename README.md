# Antigravity Live Compact (`live-compact`)

面向 **Google Antigravity（App / CLI / IDE）** 的低水位上下文防爆仓插件（零额外模型开销、零第三方 npm 依赖）：

- **入站工具减重（In-Flight Spine Card）**：在冗长的终端命令输出与超大日志读取进入对话上下文前，于本地确定性压缩为高信息密度 **Spine Card**，同时以 Fail-Closed 方式落盘 SHA256 校验的 **Shadow 原文备份**，并内置本地 MCP Server 支持按需精准检索。
- **过程内存回收（Subagent Context GC）**：通过内置 `rules/AGENTS.md` 建立三条定量派发红线，把多文件调研、网页交互/长会话看图、多模块独立改造隔离进 `invoke_subagent` 独立上下文“用完即焚”。
- **阶段一键换窗（Baton Relay / `接力`）**：长会话里程碑收口时给出一行轻提醒，回复一句 **`接力`**（或 `relay`），内置零依赖脚本 `scripts/relay-session.mjs` 通过本地 `ConversationService/CreateConversation` 自动在同项目创建满血新会话并投递 `< 1 KB` 结构化交接单。
- **可选入口防拖入（`contrib/patch-powertools-drop.mjs`）**：针对同时安装 `agy-powertools` 的用户，提供显式手动运行的独立配套脚本，将拖入/粘贴到输入框的大文件/日志/目录自动转为轻量 `@file` 引用，并将自动检查点水位设为 `256K`。

> [!IMPORTANT]
> **适用范围声明**：本项目**仅针对 Google Antigravity（App / CLI / IDE）**，**并非 DSH 插件**。  
> 如果你使用的是 DSH，请直接安装原项目：[Tranquillitatis-Lab/dsh-live-compact](https://github.com/Tranquillitatis-Lab/dsh-live-compact)。

## 开源致谢与设计来源

本项目的核心设计思想（用尽可能低的上下文水位维持尽可能高的模型注意力）、Spine Card 骨架提取策略、失败诊断保留规则、防提示词注入声明以及 Fail-Closed 本地 Shadow 备份机制，均深度借鉴并改编自以下优秀的开源项目与分享：

- **原项目**：[Tranquillitatis-Lab/dsh-live-compact](https://github.com/Tranquillitatis-Lab/dsh-live-compact)（原作者 **Merkyor / Tranquillitatis-Lab**，MIT License）
- **设计详解视频**：[用尽可能更低的上下文水位，去保持尽可能高的模型注意力——DSH Live Compact 的设计初衷及实现方案详解](https://www.bilibili.com/video/BV1hBW86wEEj/)（B 站 UP 主 Merkyor）
- **相关参考项目**：
  - [MerkyorLynn/pi-live-compact](https://github.com/MerkyorLynn/pi-live-compact)
  - [Haoming9527/opencode-live-compact](https://github.com/Haoming9527/opencode-live-compact)

在原项目思想基础上，本项目结合 Google Antigravity 的官方插件扩展点（`SessionStart` / `PreToolUse` Hooks + 本地 Stdio MCP Server + Rules + Skills + `ConversationService`），完整重写并演进为面向 Antigravity 生命周期的四层防爆仓体系。

---

## 快速安装（支持多台电脑同步与一键更新）

### 环境要求

- 已安装 **Google Antigravity**（App / CLI / IDE 均可）
- **Node.js >= 22**（纯 Node.js 原生 ESM 实现，**零第三方 npm 依赖**，克隆即用，无需 `npm install`）

### 方式一：直接克隆到 Antigravity 全局插件目录（推荐，全平台通用）

这种方式在 Windows / macOS / Linux 上最稳定，且后续更新只需一行命令：

**Windows (PowerShell)：**

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.gemini\config\plugins" | Out-Null
git clone https://github.com/fxxk-five/antigravity-live-compact.git "$env:USERPROFILE\.gemini\config\plugins\live-compact"
```

**macOS / Linux (Bash / Zsh)：**

```bash
mkdir -p ~/.gemini/config/plugins
git clone https://github.com/fxxk-five/antigravity-live-compact.git ~/.gemini/config/plugins/live-compact
```

**后续在任意电脑上拉取更新（自动适配 `git clone` 与直接安装）：**

```powershell
# Windows (PowerShell)
node "$env:USERPROFILE\.gemini\config\plugins\live-compact\scripts\update-check.mjs" --apply
```

```bash
# macOS / Linux
node ~/.gemini/config/plugins/live-compact/scripts/update-check.mjs --apply
```

> [!TIP]
> **自动升级提示**：插件通过 `SessionStart` Hook 读取本地 4 小时缓存（过期时在后台非阻塞刷新 GitHub Releases / `main/plugin.json`，并在 Windows 下自动兼容系统代理与 `HTTP_PROXY`）。检测到新版本时，会在新对话开头直接向用户内联显示升级提示卡片（使用 `metadata.user_markdown` 且 `systemMessage=""`，**零启动阻塞、零模型 Token 消耗**）。设置 `AGY_LIVE_COMPACT_NO_UPDATE_CHECK=1` 可关闭提醒。

### 方式二：通过 `agy plugin install` 安装

```bash
git clone https://github.com/fxxk-five/antigravity-live-compact.git
agy plugin install ./antigravity-live-compact
```

> [!NOTE]
> 在 Windows 上如果 Antigravity App 正在运行，`agy plugin install` 在重命名临时目录时可能触发 `Access is denied`。遇到该情况请直接使用**方式一**克隆到 `%USERPROFILE%\.gemini\config\plugins\live-compact`，Antigravity 会自动发现并热加载。

### 方式三：仅在单个项目生效（工作区级安装）

如果你只想在某个特定仓库启用，可克隆到该项目的 `.agents/plugins/live-compact` 目录：

```bash
git clone https://github.com/fxxk-five/antigravity-live-compact.git ./.agents/plugins/live-compact
```

---

## 验证安装与日常管理

安装完成后，可执行以下命令验证插件结构与 28 项内置门禁测试：

```powershell
# Windows (PowerShell)
agy plugin list
agy plugin validate --strict "$env:USERPROFILE\.gemini\config\plugins\live-compact"
node "$env:USERPROFILE\.gemini\config\plugins\live-compact\scripts\self-test.mjs"
```

```bash
# macOS / Linux
agy plugin list
agy plugin validate --strict ~/.gemini/config/plugins/live-compact
node ~/.gemini/config/plugins/live-compact/scripts/self-test.mjs
```

预期输出：
- `agy plugin list` 显示 `live-compact` 已启用
- `agy plugin validate --strict` 通过（`skills 1, rules 1, hooks 1, mcpServers 1`）
- `self-test.mjs` 输出 `ALL 28 LIVE-COMPACT GATE TESTS PASSED!`

> [!TIP]
> 在 Antigravity App 新建一个对话并发送“查看当前 Live Compact 统计信息”，如果能正常调用 `shadow_stats` 返回会话统计，即说明 Hooks 与 MCP 均已完整生效（已打开的旧对话建议新开对话或刷新后使用）。

### 停用与卸载

- **命令行开关**：`agy plugin disable live-compact` / `agy plugin enable live-compact`（也可在 Antigravity App 的 **Customizations** 面板直接切换开关）
- **环境变量临时跳过**：设置 `AGY_LIVE_COMPACT_DISABLED=1`
- **卸载**：`agy plugin uninstall live-compact`，或直接删除 `~/.gemini/config/plugins/live-compact` 目录

---

## 四层低水位防爆仓架构（`v2.1.0`）

Antigravity 主会话轨迹是**只增不减**的，单纯压缩单次工具输出无法解决“拖入大文件直接塞爆”、“几十轮跨文件调研永久滞留”或“长会话中途跨家族切模导致 KV 缓存清零”。`v2.1.0` 将低水位策略升级为完整四层闭环：

| 层级 | 实现位置 | 核心机制 | 是否默认内置 |
| :--- | :--- | :--- | :--- |
| **1. 入口防爆** | `contrib/patch-powertools-drop.mjs` | 拦截拖入/粘贴到输入框的非图片文件、目录与 `>4MB` 大图，自动转为 `@file` 轻量引用，并配置 `256K` 自动检查点上限 | 可选独立脚本（需用户显式 `--apply`） |
| **2. 工具减重** | `hooks.json` + `scripts/plan.mjs` + `mcp-server.mjs` | 超长命令输出与大日志读取在入站前压缩为 Spine Card，原文 Fail-Closed 落盘 Shadow 并支持 `shadow_search` / `shadow_read` 按需召回 | 内置默认开启 |
| **3. 过程回收** | `rules/AGENTS.md` | 子代理 GC 三红线：`>=5` 文件调研派 `research`（仅回传 `<=1.5 KB`）、网页/长会话看图派 `browser`/子代理、`>=2` 独立子模块派 `self` 分治，外加窄窗精读与禁跨家族切模 | 内置默认开启 |
| **4. 阶段换窗** | `rules/AGENTS.md` + `scripts/relay-session.mjs` | 阶段收口轻提醒；用户回复 **`接力`**（或 `relay`）后自动提炼 `<=1 KB` 交接单，调用本地 `ConversationService/CreateConversation` 创建同项目满血新会话并返回直达链接 | 内置默认开启 |

### 工具入站压缩数据流

```mermaid
flowchart LR
    A["Tool Call: run_command / read_file"] --> B{"PreToolUse Hook"}
    B -->|"小输出(<=9.8KB&180行) / 窄范围读(<=250行且文档源码<=36KB) / 常规源码(<80KB) / JSON(<32KB)"| C["原样透传 (Verbatim)"]
    B -->|"超阈值大输出 / 无范围大日志"| D["本地写入 Shadow 原文 + SHA256 校验"]
    D -->|"备份失败 (Fail-Closed)"| C
    D -->|"备份成功且净节省 >=35% 且 >=1200 chars"| E["生成 Spine Card 进入上下文"]
    E --> F["需要细节时按 shadowId 调用 MCP: shadow_search / shadow_read"]
```

### 一键“接力”换窗用法（`接力` / `relay`）

当你在一个长会话中完成某个阶段目标、看到末尾轻提示（或任意时候觉得当前窗口已变重），直接回复：

- `接力`（沿当前未决事项继续推进）
- 或 `接力：下一步要做的具体目标`（英文也可回复 `relay` / `relay: <next goal>`）

Agent 会自动执行：
1. 提炼 `<= 1 KB` 结构化交接单（前序会话回溯链接、已完成改动与验收结果、关键文件路径+行号、下一步任务）；
2. 通过 `scripts/relay-session.mjs`（原生 `node:http` 直连本机回环地址，自动绕过 `HTTP_PROXY` 代理与 Windows PowerShell UTF-8 中文乱码问题）调用 `ConversationService/CreateConversation`，自动继承 `$ANTIGRAVITY_PROJECT_ID` 并使用 `pro` 模型投递首条指令；
3. 在当前窗口直接返回可点击链接 `[点击进入接力会话](conversation://<new-id>)`。

> [!NOTE]
> 如果终端沙箱拦截了本地语言服务端口（`EPERM` / HTTP 403），Agent 会申请脱离沙箱仅重跑该单条命令，审批通过即可完成开窗。

### 可选配套：`contrib/patch-powertools-drop.mjs`（搭配 `agy-powertools`）

如果你同时安装了社区插件 `agy-powertools`，并希望解决“把大日志、代码文件、PDF 或文件夹拖入/粘贴进 Antigravity 输入框直接触发 Media Upload 把会话塞死”的痛点，可手动运行仓库附带的独立脚本（**本插件绝不自动修改第三方插件**，且脚本会自动生成 `.orig.bak` 原文件备份并支持随时还原）：

```powershell
# Windows (PowerShell)：应用防拖入补丁并开启 256K 自动检查点上限（同时运行内置校验与 Bundle 语法编译测试）
node "$env:USERPROFILE\.gemini\config\plugins\live-compact\contrib\patch-powertools-drop.mjs" --apply

# 检查当前状态
node "$env:USERPROFILE\.gemini\config\plugins\live-compact\contrib\patch-powertools-drop.mjs" --check

# 一键还原 agy-powertools 原始文件
node "$env:USERPROFILE\.gemini\config\plugins\live-compact\contrib\patch-powertools-drop.mjs" --restore
```

```bash
# macOS / Linux
node ~/.gemini/config/plugins/live-compact/contrib/patch-powertools-drop.mjs --apply
```

效果说明：
- 拖入或 `Ctrl+V` 粘贴任意非图片本地文件（代码、`.jsonl`、`.log`、`.md`、PDF、Office、压缩包等）、本地文件夹或 `> 4 MB` 巨图 → 自动降级为原生 `@file` / `@directory` 引用（约 20 tokens），不把原文塞死输入框；
- `<= 4 MB` 正常截图与剪贴板截图保持原样内联上传；拖入时按住 `Alt` 键可临时绕过拦截；
- 若 `agy-powertools` 当前 `contextLimit` 为 `0`（无上限），自动设为 `256000` 作为自动检查点兜底线；
- 应用后重启 Antigravity App（或 `Reload Window`）即可生效。

---

### DSH Live Compact vs Antigravity Live Compact

| 维度 | DSH Live Compact (`dsh-live-compact`) | Antigravity Live Compact (`live-compact`) |
| --- | --- | --- |
| **宿主与扩展面** | Open Cordis `ctx.compaction` 服务（替换 `BasicCompactionEngine`） | Google Antigravity 官方插件体系（`hooks.json` + `mcp_config.json` + `rules/` + `skills/` + `ConversationService`） |
| **压缩时机** | 回合结束 `turn/end` 事后替换（保留最近 3 轮工具输出原样） | **入站在线压缩（In-Flight）**：通过 `PreToolUse` 在超长命令输出与大文件读取进入上下文前完成压缩 |
| **KV Prefix Cache** | 保留 checkpoint 之前前缀，改写切点之后尾部 | **零前缀改写**：Spine Card 一次性写入对话轨迹 + 子代理 GC 隔离，不破坏主会话历史 KV Prefix Cache |
| **Shadow 备份** | Fail-Closed 备份至 `~/.dsh/compaction-spine/shadow/<sid>/` | Fail-Closed 原子写入 + SHA256 校验，存至 `~/.gemini/antigravity/live-compact/shadow/<convId>/` |
| **失败诊断保护** | 预算内保留完整失败信息，不将失败命令误判为正常 | 失败命令放宽预算至 `failureBudget`（默认 `6400` 字符），精确过滤通过用例，优先保留真实失败与尾部汇总 |
| **按需召回** | `shadow-search.js` 辅助脚本 | 内置零依赖 Stdio MCP Server（`shadow_search` / `shadow_read` / `shadow_stats`） |
| **长会话换窗** | 宿主内置上下文压缩 | 内置“接力”（`relay-session.mjs`）一键创建同项目满血新会话并自动投递交接单 |

---

## 实测效果

### 1. 同 Agent A/B 基准测试（`gemini-4-neon-high`，8 轮 25 分多模块排障）

任务：6 模块结算引擎 + 5 个跨模块联动 Bug + 600 个自动化测试 + 685 KB 生产日志排查 + 15 分跨工件回忆考题。

| 指标 | Baseline（无插件） | Live Compact（启用插件） | 变化 |
| --- | --- | --- | --- |
| 综合得分（工程修复 + 跨工件考试） | **25 / 25** | **25 / 25** | 质量零折损 |
| 峰值上下文（Peak Context） | 507,852 tokens | **85,965 tokens** | **-83.1%** |
| 平均上下文（Mean Context） | 242,753 tokens | **52,284 tokens** | **-78.5%** |
| 累计 Prompt Tokens | 5,340,571 tokens | **1,202,530 tokens** | **-77.5%** |
| 非缓存输入（Uncached Input） | 555,168 tokens | **102,934 tokens** | **-81.5%** |
| KV Cache 命中率 | 89.6% | **91.4%** | **+1.8 pp**（0 次触发宿主强压缩） |
| 宿主盲截断次数 | 4 次 | **0 次** | 完全消除盲截断 |
| 工具调用次数 | 48 次 | **40 次** | **-16.7%** |
| 总耗时 | 583.57s | **527.43s** | **-9.6%** |

### 2. 中等任务基准（`gemini-3.8-flash-medium`）

- **7 轮日志洪峰 + 细节回忆**：得分 `10/10` vs `10/10`，峰值上下文 **-23.8%**，累计 Prompt **-35.5%**，非缓存输入 **-22.0%**
- **444 测试集排错修复**：得分 `6/6` vs `6/6`，峰值上下文 **-24.5%**，累计 Prompt **-26.0%**

### 3. Antigravity App 生产实战回归（四层套路全开 vs 旧基线）

在连续 2 小时真实生产使用（5 个 App 主会话 + 6 个子代理，含 1 个 80 分钟 / 54 轮规划的重度网络排障长会话）中的实测表现：

- **主会话最高峰值**：从旧基线 `356K - 485K` 压降至 **`187.4K`**（新会话均峰仅 **`70.5K`**），全程零爆仓、零跨家族切模；
- **分段精读率**：`read_file` 窄范围分段读取达 **`62 / 64`（`96.9%`）**（重度长会话 `26 / 26` 达 `100%`）；
- **子代理 GC 卸载**：6 个子代理累计替主会话挡掉 **`741.6 KB`** 原始日志与网页 DOM 上下文，重度长会话缓存命中率保持 **`89.5%`**；
- **Spine Card 兜底**：精准拦下 4 次巨型日志/清单读取（合计 **`1.10 MB` → `~11.4 KB`**，净省 **`~271K tokens`**，压缩率 `99.0%`，事后 `shadow_read` 返工率为 `0`）。

---

## 插件目录结构

```text
antigravity-live-compact/
├── plugin.json                         # Antigravity 插件清单
├── hooks.json                          # SessionStart & PreToolUse 钩子声明
├── mcp_config.json                     # 本地 Shadow MCP Server 配置
├── rules/AGENTS.md                     # Spine Card 召回 + 子代理 GC 三红线 + 一键接力与缓存卫生
├── skills/live-compact/SKILL.md        # 查看统计、阈值与接力说明的内置 Skill
├── assets/logo.svg                     # 插件图标
├── contrib/
│   └── patch-powertools-drop.mjs       # 可选独立脚本：为 agy-powertools 增加拖入/粘贴防爆与 256K 上限
└── scripts/
    ├── hook-dispatch.mjs               # 统一 Hook 分发器（含 SessionStart 更新提示与过期临时文件清理）
    ├── live-compact-exec.mjs           # 跨平台命令执行包装器（Windows UTF-8 .ps1 / Unix /bin/sh）
    ├── plan.mjs                        # Spine Card 确定性压缩规划器与信号提取器
    ├── shadow.mjs                      # Fail-Closed 原子落盘、SHA256 校验与索引检索
    ├── mcp-server.mjs                  # 零依赖 Stdio MCP Server (shadow_search/read/stats)
    ├── relay-session.mjs               # 零依赖“接力”换窗脚本（直连本地 ConversationService，绕代理防乱码）
    ├── update-check.mjs                # 后台非阻塞版本检查、SessionStart 升级提示与 --apply 一键升级
    └── self-test.mjs                   # 28 项端到端门禁自测
```

## 环境变量调优

所有阈值均有保守默认值，可通过环境变量按需覆盖：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AGY_LIVE_COMPACT_DISABLED` | 未设置 | 设为 `1` 可在不卸载插件的情况下临时禁用 Hook |
| `AGY_LIVE_COMPACT_CMD_MODE` | `smart` | `run_command` 包装策略：`smart`（默认）仅对测试/构建/lint/容器日志/`git grep`/`diff`/`show`/`rg`/`Select-String`/递归枚举/无界日志输出等高噪音命令启用包装，常规短命令零开销原样放行；`off` 仅保留 `read_file` 压缩；`all` 全量包装 |
| `AGY_LIVE_COMPACT_CMD_EXTRA_REGEX` | 未设置 | `smart` 模式下追加的自定义高噪音命令正则（忽略大小写），用于纳管项目特有脚本 |
| `AGY_LIVE_COMPACT_NO_UPDATE_CHECK` | 未设置 | 设为 `1` 可关闭 `SessionStart` 自动版本更新提示 |
| `AGY_LIVE_COMPACT_SMALL_CHARS` | `9800` | 命令输出字符数透传阈值（卡在宿主 ~10.3 KB 盲截断线之下，同时满足行数阈值时原样透传） |
| `AGY_LIVE_COMPACT_SMALL_LINES` | `180` | 命令输出行数透传阈值 |
| `AGY_LIVE_COMPACT_CARD_BUDGET` | `2800` | 常规输出 Spine Card 字符预算（需净压缩 >= 35% 且 >= 1200 字符才压缩） |
| `AGY_LIVE_COMPACT_FAILURE_BUDGET` | `6400` | 失败命令 Spine Card 字符预算，优先保留错误栈与尾部汇总 |
| `AGY_LIVE_COMPACT_LOG_MIN_BYTES` | `16384` | 无行号范围 `read_file` 读取日志/文本文件的最小压缩字节数（且行数 >= 240） |
| `AGY_LIVE_COMPACT_JSON_MIN_BYTES` | `32768` | 无行号范围 `read_file` 读取 JSON 文件的最小压缩字节数（且行数 >= 400） |
| `AGY_LIVE_COMPACT_CODE_MIN_BYTES` | `81920` | 无行号范围 `read_file` 读取超大源码文件的最小压缩字节数（且行数 >= 1500） |
| `AGY_LIVE_COMPACT_MAX_BOUNDED_LINES` | `250` | 指定 `StartLine`/`EndLine` 且范围不超过该值（且文档/源码切片 <= 36 KB，高密度日志 <= 14 KB）时直接原样透传 |
| `AGY_LIVE_COMPACT_WATERMARK_TOKENS` | `120000` | （可选，默认不启用 `PreInvocation` 同步 Hook，水位由 `shadow_stats` 按需直扫 `transcript_full.jsonl` 实时计算） |
| `AGY_LIVE_COMPACT_SHADOW_DIR` | `~/.gemini/antigravity/live-compact/shadow` | 自定义本地 Shadow 备份根目录 |

## License

[MIT License](./LICENSE)

本项目面向 Google Antigravity 重新实现，核心理念与压缩策略借鉴并改编自 [Tranquillitatis-Lab/dsh-live-compact](https://github.com/Tranquillitatis-Lab/dsh-live-compact)（MIT License, Copyright (c) 2026 Merkyor）。
