# desk-gateway

VPS 上的 stdio MCP 服务，由 desk 插件按会话启动（`bin/desk-gateway`，每个会话一个进程）。提供 9 个工具：Copy、Machines、Read、Write、Edit、Glob、Grep、Bash、BashJob（Machines、BashJob 延迟加载）。都带可选的 `machine` 参数，按 machine 把调用转发到对应机器的 desk-node（`POST /rpc`）。纯 ESM，无依赖，用 VPS 上的 Node 24（`~/opt/node24`）运行。

## 配置
- 注册：desk 插件（仓库根目录的 `.claude-plugin/plugin.json`）。会话的默认机器和目录见 `src/binding.mjs`：环境变量 → 最近的 `.desk.json` → machines.json 的 default。
- 权限：新部署不附带项目级 `.claude` 设置或 Hooks。`Machines restore` 不带 `confirm` 只预览，带 `confirm: true` 会执行，因此应先人工核对预览。
- 机器：`DESK_MACHINES`，否则 `~/.config/desk-fleet/machines.json`，否则 `~/fleet/machines.json`。每台机器：`url`、`tokenFile`、`os`、`defaultDir`、`note`；`local: true` 表示本机（vps），desk 工具对它返回 LOCAL_MACHINE。文件修改后下一次调用即生效，不用重启会话。
- 环境变量：`DESK_MACHINES`、`DESK_DEFAULT_MACHINE`（覆盖 machines.json 的 default）、`DESK_STATE_DIR`（默认 `~/.local/state/desk-fleet`）、`DESK_RETRY_WINDOW_MS`（默认 30000）。

## 行为
- 读状态 sid：Claude Code 给 stdio MCP 子进程传 `CLAUDE_CODE_SESSION_ID`，gateway 直接用它（实测与会话 id 一致）；没有时用进程启动时生成的 id。
- 每次调用传 `defaultDir`（machines.json），所以默认目录以 VPS 侧配置为准。
- 重试：连接被拒、tailscale serve 返回 502/503/504（主机在线、desk-node 在重启）时，用同一个 callId 重试（250 ms 起指数退避，最长 5 s 一次），超过重试窗口返回 MACHINE_OFFLINE（附最后在线时间，记录在 `last-seen.json`）。主机本身不应答（连接 5 秒未建立、EHOSTUNREACH 等，例如电脑睡眠或关机）时不重试，约 5 秒返回 MACHINE_OFFLINE。callId 只给有副作用的调用（Write、Edit、Bash、BashJob start/stop）；只读调用直接重放。
- 超时：Bash 为其 timeout + 60 s，BashJob 为 wait_ms + 60 s，其他 120 s；超时返回 NODE_TIMEOUT。Claude Code 对 stdio MCP 工具调用的默认超时足够长（实测 150 s 的 Bash 正常返回），无需设置 MCP_TOOL_TIMEOUT。
- 输出：desk-node 已按 30,000 字符截断；gateway 再设 100,000 字符兜底。图片以 MCP image 内容返回。
- 错误：一律是 `isError: true`，文本为 JSON `{code, message, next}`。
- 日志：`~/.local/state/desk-fleet/gateway.log`，每次调用一行（工具、机器、结果、耗时），不记参数。

- Machines 的 action：`list`（默认）；`checkpoint` / `checkpoints` / `restore`（转发到节点的 Checkpoint 工具，path 为仓库目录）；`upgrade`（从 `dist/` 上传 `desk-node-<version>.tar.gz`，version 默认取 `packages/node/package.json`，启动节点的升级器并等待结果，最多 180 s；回滚返回 UPGRADE_ROLLED_BACK）。没有为这些功能新增工具。

## 测试
`npm test`（`node --test test/*.test.mjs`）：用本地假 desk-node 测转发、callId 重试、MACHINE_OFFLINE、错误、图片、Machines、stdio 协议和工具定义大小。
