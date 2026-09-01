# Cloudflare 同 Zone 优选拓扑 Spike

验证日期：2026-09-01

## 结论

测试账户上的同 Zone O2O 拓扑验证通过，可以继续按 `PLAN.md` 实现 MVP，无需改为双 Zone 架构。

已验证：

- 创建独立 Tunnel，并通过远程 ingress 连接本地 HTTP Origin。
- Fallback Origin 指向 Tunnel 的橙云 CNAME 后进入 `active`。
- 同 Zone Custom Hostname 可以使用 `ssl.method = txt` 创建。
- Custom Hostname 的 hostname 与 SSL 状态独立变化。
- hostname 可以先进入 `active`，SSL 随后从 `initializing`、`pending_validation` 进入 `active`。
- preferred target 的 CNAME 链最终解析到 Cloudflare 官方 IP 段。
- 使用业务 hostname 作为 SNI 和 Host、preferred target 作为连接目标的 HTTPS 预检返回 200。
- 业务 CNAME 切为 preferred target 且设为 DNS only 后，hostname 与 SSL 均保持 `active`。
- 最终请求经 preferred target、Fallback Origin、Tunnel 到达本地 Origin，并保留原始业务 Host。

## 动态 DCV 记录行为

Cloudflare 首先返回 Ownership TXT；Ownership 生效后，又返回 SSL validation TXT 和 Delegated DCV CNAME。

实测中 SSL TXT 与 Delegated DCV CNAME 使用同一个 `_acme-challenge` 名称。DNS 不允许 CNAME 与 TXT 在同名节点共存，因此实现必须：

1. 始终处理 Ownership TXT。
2. Cloudflare 返回 Delegated DCV CNAME 时优先创建 CNAME。
3. 只有未返回 Delegated DCV CNAME 时才创建 SSL validation TXT。
4. SSL 轮询期间持续重新读取并幂等补建晚到的验证记录。
5. 若同名节点已有不兼容记录，则进入 `WAITING_CONFIRMATION`，不得覆盖。

## 重复验证

凭据和测试目标只放在仓库忽略的 `.env.local` 中：

```dotenv
CLOUDFLARE_API_TOKEN=
CF_SPIKE_ACCOUNT_ID=
CF_SPIKE_ZONE_ID=
CF_SPIKE_ZONE_NAME=
CF_SPIKE_PREFERRED_TARGET=
CF_SPIKE_ALLOW_MUTATION=true
```

运行：

```bash
cd server
npm run spike:optimized
```

脚本使用唯一临时 hostname，并在成功或失败后恢复原 Fallback Origin、删除本次创建的 Custom Hostname、DNS 记录、Tunnel 和本地 Cloudflared 容器。禁止在生产 Zone 运行。
