# desk-fleet 项目背景

本项目把 VPS 上的 Claude Code 与多台 Windows 工程机连接起来。desk 以 Claude Code 插件的形式安装（`.claude-plugin/`）：插件启动 `packages/gateway`（stdio MCP，每个会话一个进程），gateway 经 tailnet 调用各工程机上的 `packages/node`（desk-node），提供文件、搜索、命令、传文件和机器状态工具。VPS 上任意目录都可以当工作区：目录用 `.desk.json` 绑定机器和文件夹（`/desk:use`），没有绑定就用 machines.json 的默认机器。桌面、浏览器和手机通过 VPS 上的 Orca 服务（`orca.service`，只在 tailnet 内）进入同一环境。

## 代码结构

- `.claude-plugin/plugin.json`、`marketplace.json`：插件清单；MCP 服务定义在 plugin.json 里。
- `commands/`：`/desk:status`、`/desk:use`、`/desk:off`、`/desk:on`、`/desk:handoff`、`/desk:help`。
- `handoff/handoff.py`：`handoff` 客户端和 hub 钩子（`/desk:handoff` 用它），单文件、只依赖 Python 3 和 Git；`bin/handoff` 是入口，测试在 `tests/test_handoff.py`。
- `skills/desk/SKILL.md`：使用规则。规则写在这里，不写进工具描述，工具描述每轮都要发送。
- `bin/`：`desk-node24`（找 Node 24）、`desk-gateway`、`desk`（开关和绑定）、`desk-copy`。
- `packages/gateway`：工具定义（`defs.mjs`）、绑定（`binding.mjs`）、机器清单、转发、取消、Copy、`desk` CLI。
- `packages/node`：Windows 节点服务、文件和命令工具、输出归档、检查点、文件传输。
- `deploy/node`：Windows 节点构建、安装与更新脚本。`deploy/vps/bin`：清理（`fleet-tidy`）、冒烟测试和远程浏览器脚本。
- `kit`：新部署、升级、诊断和加机器的脚本。

gateway 使用 Node 24。运行时的机器令牌、machines.json、用户登录状态、会话历史和 Orca 的配对数据不属于源码，不进 Git。仓库在 GitHub 上公开（wenzhuofu/fleet）：不要提交主机名、tailnet 地址、IP、个人路径或内部记录。

## 设计约束

- 工具描述要短：常驻工具（Copy、Read、Write、Edit、Glob、Grep、Bash）的定义大小有测试上限；Machines、BashJob 延迟加载。
- 绑定在每次调用前重新读取，`/desk:use` 立刻生效；绑定有问题时报 BAD_CONFIG，不退回默认机器。
- `/desk:off` 同时做两件事：在本目录 `.claude/settings.local.json` 里拒绝 `mcp__plugin_desk_desk`（当前会话立刻生效），并在本目录禁用插件（新会话不再发送工具描述）。

## 两条路控制工程机

- **A. desk 工具（默认）**：当前会话直接读写、搜索、跑命令，同步，有 denyPaths、令牌保护和自动检查点。
- **B. Orca 派活**：`orca orchestration worker-start --on <工程机> --agent codex`，由工程机上的 agent 完成一段任务后汇报。适合一次性的长任务或并行任务；desk 的保护不适用。同一目录不要同时被 A 和 B 修改。
- **任务接力用 `handoff`（`/desk:handoff`）**：任务在任意机器上的任意 agent 之间往返，参与者写作 `agent@machine`（machine 是文件所在的机器）。每跳是 hub（VPS 上的裸仓库）上的一个提交：文件快照加台账（state、task、log）。hub 钩子是所有权的权威。agent 只写交接说明，快照、校验、推送都由 `handoff` 完成。快照放在私有 Git 目录里，不碰项目的 `.git`。take 不覆盖未同步的修改。台账才是事实依据，agent 的会话续接只是优化。

## 开发约定

- 测试和构建放进独立的 `systemd-run --user --scope -p MemoryMax=...`，一次一个；Orca 和它里面的 Claude 会话共用一个内存上限。
- VPS 只做控制：构建、检查、分析放到工程机上做。
