# 运维手册

## 目录绑定（取代原来的工作区）

VPS 上任意目录都可以当工作区，不需要预先生成任何东西。

- `/desk:use <机器> [目录]`（终端里是 `desk use …`）在当前目录写 `.desk.json`：`{"machine": "pc-home", "dir": "D:\\git\\x"}`。gateway 每次调用前从会话目录往上找最近的 `.desk.json`，所以对子目录同样有效，改完立刻生效。
- 没有 `.desk.json` 时用 machines.json 的 `default` 机器和它的 `defaultDir`。
- 环境变量 `DESK_DEFAULT_MACHINE` / `DESK_DEFAULT_DIR` 仍然优先于 `.desk.json`（脚本、CI 用）。
- `.desk.json` 写错（不是 JSON、机器不存在、目录不是绝对路径）时，所有调用都报 BAD_CONFIG，不会退回默认机器。
- 会话按启动目录归属（`~/.claude/projects/<编码后的目录>/`），换目录就是换项目。

## 开关

- `/desk:off`：在当前目录的 `.claude/settings.local.json` 里加 `permissions.deny: ["mcp__plugin_desk_desk"]`（当前会话立刻生效）和 `enabledPlugins: {"desk@fleet": false}`（新会话不再加载插件，不占工具描述的 token）。
- `/desk:on`：删掉这两项。当前会话里工具没出现时，新开会话或用 `/mcp` 重连。
- 全局关闭：`claude plugin disable desk@fleet`。

## 升级

- desk-fleet：`kit/update.sh`。插件从本机 checkout 读取，拉取后新会话就是新版本。
- desk-node：`Machines action=upgrade`（gateway 上传 `dist/` 里的包，失败自动回滚）。构建：`deploy/node/build-release.sh`。
