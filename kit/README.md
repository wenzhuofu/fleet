# 新 VPS 部署

本仓库保留运行所需代码和 desk 插件。旧账号认证、会话历史、项目级 `.claude` 设置、Hooks 和 Orca 配对数据不会迁入。

成员从零部署请按英文指南 [SETUP.md](SETUP.md) 操作。

1. 管理员准备 Ubuntu、SSH、Tailscale，并为普通用户启用 linger；加工程机时还需要把该用户设为 Tailscale operator。
2. 将干净的 `desk-fleet` Git 仓库放到 `~/fleet/desk-fleet`。
3. 在 `desk-fleet` 中运行 `kit/bootstrap-vps.sh`。脚本安装或检查 Node 24、官方 Claude CLI 稳定通道，从本 checkout 安装 desk 插件（任意目录都能用 desk 工具），安装 Orca 并以 `orca.service`（`orca-ide serve`，只接受 tailnet 和本机）运行，再装上每日清理 `fleet-tidy.timer`。
4. 在终端运行 `claude`，由使用者完成新账号登录；在任意目录用 `/desk:status` 检查，用 `/desk:use <机器> [目录]` 绑定。然后用 `orca-ide pair --address <tailnet IP>`（手机加 `--mobile`）配对桌面版、浏览器或手机。
5. 运行 `kit/fleet-doctor.sh --no-claude` 检查服务和机器链路；登录后再运行完整体检。

`machines.json` 只保存节点地址和令牌文件路径。实际节点令牌放在 `~/.config/desk-fleet/tokens/`，权限为 0600，不纳入 Git。

## Upgrade

```sh
cd ~/fleet/desk-fleet
kit/update.sh
```

The updater fast-forwards `desk-fleet` (the worktree must be clean), refreshes the desk plugin's marketplace entry and the `fleet-tidy` units. New Claude sessions use the new plugin at once. When `ORCA_VERSION` in `kit/fleet.conf` names a version that is not installed, it downloads that Orca package, checks it against `ORCA_DEB_SHA256`, installs it next to the current one and switches `~/opt/orca`; it does not restart `orca.service`, because that ends every Claude session running inside it. Restart it yourself when nothing is running.
