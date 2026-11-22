# desk-node

每台工程机上的执行服务。只监听 127.0.0.1，经 `tailscale serve` 发布到 tailnet；每个请求都要带 `Authorization: Bearer <token>`，否则返回 401。

## 协议

- `GET /health` → `{ok, machineId, version, os, hostname, uptimeSec, defaultDir, node, pid, tools}`
- `POST /rpc`，请求体 `{tool, args, callId?, sid?, defaultDir?}`
  - 成功：`{ok: true, text, data, image?}`（`image` = `{mimeType, data(base64)}`，仅 Read 图片）；失败：`{ok: false, error: {code, message, next?}}`（HTTP 200）
  - `callId`：同一个 callId 加相同输入，返回缓存结果（`cached: true`）；输入不同返回 `CONFLICT`；执行中途 desk-node 重启过，返回 `CALL_OUTCOME_UNKNOWN`。缓存保留 7 天。
  - `sid`：会话标识，ETag 读状态按 sid 隔离（默认 `default`）。gateway 传入 Claude 会话 id。
  - `defaultDir`：本次调用的默认目录（相对路径、输出显示、Bash 默认 cwd 都以它为准），由 gateway 从 machines.json 传入；不传时用 config.json 的值。

## 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| Read | file_path, offset?, limit? | cat -n 格式；记录 ETag（`sha256:` + 原始字节哈希）。png/jpg/gif/webp 按文件头识别后以 base64 返回；超过 3.75 MiB（base64 后 5 MB）或单边超过 8000 px 时只返回提示文字，不报错 |
| Write | file_path, content | 已有文件必须先 Read（READ_REQUIRED），读后被改过报 STALE_ETAG；保持原编码/BOM/EOL |
| Edit | file_path, old_string, new_string, replace_all? | 同上；EDIT_NO_MATCH / EDIT_AMBIGUOUS / EDIT_NOOP |
| Glob | pattern, path? | 按修改时间倒序，最多 100 条；跳过 .git、node_modules |
| Grep | pattern, path?, glob?, type?, output_mode?, -i?, -n?, -A/-B/-C?, multiline?, head_limit? | 调用发布目录里的 rg.exe |
| Bash | command, cwd?, timeout?, shell?, run_in_background? | shell：bash（默认，Git Bash）/ cmd / powershell；默认超时 120 s，上限 600 s |
| BashJob | action: start/status/output/stop/list, id?, command?, cwd?, shell?, wait_ms? | 后台任务；日志在 outputs\jobs，desk-node 重启后仍可查询、停止 |
| Checkpoint | action: create/list/restore, path?, ref?, confirm?, note? | Git 检查点（`checkpoint.mjs`）：临时 index，refs/desk/cp/<sid>/<n>，每会话 20 个；restore 不带 confirm 只返回预览；恢复前备份到 outputs\restore-backups。gateway 通过 Machines 的 action 调用 |
| Upgrade | action: start/status, package?, version?, id? | 经 WMI 启动独立的 `upgrade.mjs`（安装 → 切换 current → 重启 → 自切换起 40 s 内健康检查 → 失败回滚）；结果在 logs\upgrade-<id>.json |
| Fs | action: stat/read/tree, path, encoding?, maxDepth?, maxEntries?, exclude? | 只读（`readonly.mjs`），供 fleet-ui 机器面板使用：元数据、原始内容（utf8/base64，≤20 MiB）、目录树（默认深 10 层、≤10000 项） |
| Git | cwd, args | 只读 git（白名单子命令，拒绝写入、--output、--ext-diff），返回 {code, stdout, stderr}；无 callId、不触发自动检查点 |

另有 `PUT /upload/desk-node-<版本>.tar.gz`（请求头 `x-sha256`，上限 300 MiB），写入 `C:\desk-node\incoming`。

路径：接受 `D:\x`、`D:/x`、`/d/x` 和相对路径（相对默认目录）。默认目录内输出相对路径，其他输出 `D:/x`。`C:\desk-node\data`（配置、令牌、缓存）对文件工具不可见，返回 PATH_BLOCKED。

输出：先按 UTF-8 解码，非法 UTF-8 的行按 CP936 解码；去 ANSI 转义、折叠 `\r`、去控制字符；超过 30,000 字符时保留头 20%、尾 80%，完整输出归档到 `C:\desk-node\outputs`。
进程：前台命令放进 kill-on-close 的 Job Object。超时就终止整棵进程树；命令结束 1 秒后，仍在运行的残留进程也会被终止。

## 目录

```
C:\desk-node\data\config.json   {machineId, port, defaultDir, bash?, rg?}
C:\desk-node\data\token         仅当前用户可访问
C:\desk-node\outputs\           归档输出、任务日志
C:\desk-node\logs\desk-node.log 每次调用一行（工具名、callId、结果码、耗时；不含参数）
```

## 测试

```bash
node --test test/unit/*.test.mjs        # 任意平台
DESK_URL=http://<pc>.<tailnet>.ts.net:7801 DESK_TOKEN_FILE=~/.config/desk-fleet/tokens/pc-home.token \
DESK_RESTART_CMD='ssh pc-home "powershell -NoProfile -ExecutionPolicy Bypass -File C:/desk-node/dev/desk-node-0.1.0/deploy/dev-start.ps1 -Release C:/desk-node/dev/desk-node-0.1.0"' \
node --test --test-concurrency=1 test/e2e/*.test.mjs
```
