# Cloudflare Tunnel 优选一键部署 MVP 规划

## 总体方案

当前工作区为空；我已只读核对上游 `Frankieli123/dns-panel`，确认项目使用：

- Express + TypeScript
- Prisma + SQLite
- React 18 + MUI 6
- TanStack Query
- 现有 Cloudflare DNS、Tunnel、Public Hostname、Custom Hostname、Fallback Origin 服务

本功能实现为一个异步 `Optimized Deployment Workflow`，由面板负责预检查、配置、等待、切换、验证和回滚。

官方文档确认：

- Fallback Origin 回源时默认保留原始 `Host`。
- O2O 场景不支持 hostname pre-validation。
- Custom Hostname 的 hostname 状态与 SSL 状态必须分开判断。

因此采用以下已确认决策：

1. 同一 Zone 的 MVP 服务共用一个 Tunnel。
2. 保留同 Zone 架构；`hostname.status` 在切 DNS 前允许为 `pending`。
3. 切 DNS 前尽可能完成 SSL/DCV；切换后等待 `hostname.status` 与 `ssl.status` 均为 `active`。
4. `preferredTarget` 接受任意合法 hostname，不建立白名单、不验证第三方所有权。
5. Preflight 严格检查 CNAME 链、最终 A/AAAA、Cloudflare 官方 IP 段，并执行带正确 SNI/Host 的 HTTPS 预检。
6. 动态出现 DNS 冲突时进入“待确认”，由用户选择备份替换或取消。
7. 保留现有 SQLite + `prisma db push` 升级方式，不建立破坏既有实例的 migration 基线。
8. 开发前先用真实 Cloudflare 测试账号验证同 Zone 拓扑；若真实行为无法稳定完成，停止 MVP 并报告，不自动改成双 Zone 架构。

## 主要实现改动

### 数据模型

在 `server/prisma/schema.prisma` 增加：

- `CloudflareOptimizedZoneConfig`
  - `userId`
  - `dnsCredentialId`
  - `accountId`
  - `zoneId`
  - `zoneName`
  - `fallbackHostname`
  - `fallbackStatus`
  - `tunnelId`
  - `tunnelName`
  - 唯一约束：`userId + dnsCredentialId + zoneId`

- `OptimizedService`
  - 名称、访问 hostname、本地服务 URL
  - Cloudflare 凭证、账户、Zone
  - Tunnel ID/名称
  - 当前模式：`DEFAULT` / `PREFERRED`
  - `preferredTarget`
  - 中间 CNAME 开关及 hostname
  - Custom Hostname ID
  - 部署状态、当前步骤、健康状态
  - 最近错误、最近健康检查时间
  - `managedResourcesJson`
  - `lockToken`、`lockExpiresAt`
  - 唯一约束：`userId + dnsCredentialId + hostname`

- `OptimizedDeployment`
  - 服务 ID
  - 操作类型：`DEPLOY`、`REDEPLOY`、`SWITCH_PREFERRED`、`SWITCH_DEFAULT`、`ROLLBACK`、`DELETE`
  - 状态、当前步骤、心跳时间
  - 错误码、错误信息
  - `snapshotJson`
  - `resultJson`
  - `stepLogJson`
  - `pendingConfirmationJson`
  - 幂等键

Snapshot 必须记录 DNS、Tunnel ingress、Fallback Origin、Custom Hostname 的必要状态和资源 ID，禁止写入 API Token、Tunnel Token、JWT Secret、加密密钥。

数据库只做新增表/字段，保留现有 Docker 中的 `prisma db push`。README 增加升级前 SQLite 备份和升级后校验步骤。

### Cloudflare 服务层

先抽取现有 `routes/tunnels.ts` 中的 Public Hostname 逻辑，形成可复用服务，原有 Tunnel 页面继续调用该服务。

扩展现有 `CloudflareService`，不新建第二套 Cloudflare Client：

- Custom Hostname 列表、详情、创建、删除
- 支持 `ssl.method = txt`
- 读取 `ownership_verification`
- 读取 `ssl.validation_records`
- 读取 `ssl.dcv_delegation_records`
- 返回 Custom Hostname 与 SSL 的独立状态
- Fallback Origin 详情，包括 `origin`、`status`、`errors`
- 429、超时、403 的统一重试和错误映射

DNS 操作继续复用现有 `DnsService`；Zone 权威判断继续复用 `zoneAuthority`。

新增服务：

- `OptimizedDeploymentService`
- `OptimizedHealthService`
- `OptimizedRollbackService`
- `OptimizedCredentialService`
- `OptimizedDeploymentScheduler`

### 工作流状态机

服务状态至少包括：

```text
DRAFT
PREFLIGHT
WAITING_CONFIRMATION
PREPARING_TUNNEL
TUNNEL_READY
CONFIGURING_FALLBACK
WAITING_FALLBACK
FALLBACK_READY
CREATING_CUSTOM_HOSTNAME
CREATING_VALIDATION_RECORDS
WAITING_SSL_ACTIVE
SWITCHING_DNS
WAITING_HOSTNAME_ACTIVE
VERIFYING
ACTIVE
FAILED
ROLLING_BACK
ROLLED_BACK
ROLLBACK_FAILED
DELETING
DELETED
```

部署顺序：

1. 校验 hostname、Zone 归属、service URL、preferred target、健康检查路径。
2. 检查账户、Zone、权威状态、Tunnel、DNS、Custom Hostname、Fallback Origin。
3. 检查同 Zone 是否已有 Tunnel 约束。
4. 保存 Snapshot。
5. 确保共享 Fallback Origin hostname 的 Tunnel ingress 和橙云 CNAME。
6. 确保业务 hostname 的 Tunnel ingress，暂时保持业务 DNS 指向 Tunnel。
7. 初始化或复用 Zone 级 Fallback Origin，并轮询其状态。
8. 创建或复用 Custom Hostname，使用 TXT 证书验证方式。
9. 根据 Cloudflare 返回值创建 Ownership TXT、SSL validation TXT、Delegated DCV CNAME；绝不硬编码记录名称或目标。
10. 动态发现冲突时进入 `WAITING_CONFIRMATION`，暂停等待用户决定。
11. 轮询 `ssl.status`；O2O 场景不要求此时 `hostname.status` 已为 active。
12. 对 preferred target 执行 CNAME 链、Cloudflare IP、SNI/Host HTTPS 预检。
13. 保存业务 DNS Snapshot 后切换：
    - 直接模式：业务 hostname → preferred target，DNS only
    - 中间模式：intermediate hostname → preferred target，业务 hostname → intermediate hostname，均 DNS only
14. 切换后轮询 hostname/SSL 状态。
15. 执行最终 HTTPS 健康检查。
16. 成功进入 `ACTIVE`；失败先恢复原业务 DNS，再执行资源清理。

健康检查只允许请求已保存的业务 hostname，path 只能是 `/xxx` 形式。默认允许 2xx、3xx、401、403；5xx、TLS 错误、连接错误和超时视为失败。

### 并发、恢复和回滚

- 使用 SQLite 可用的原子锁字段，禁止同一服务、hostname、Zone 同时运行多个修改任务。
- Scheduler 定期处理 `QUEUED` 任务。
- 服务重启后将超时的 `RUNNING` 任务标记为 `FAILED / WORKFLOW_INTERRUPTED`，保留资源，允许幂等重试。
- 只删除当前 Workflow 新建且此前不存在的资源。
- 共享 TXT、DCV、Fallback Origin、Tunnel ingress 必须检查其他服务引用。
- DNS 已切换后发生失败，优先恢复原 DNS，再处理 Custom Hostname、验证记录和 ingress。
- 回滚失败时进入 `ROLLBACK_FAILED`，返回待人工处理资源清单。
- “恢复 Cloudflare 默认”只切换业务 DNS，不默认删除 SaaS 配置。
- 删除支持：
  - 仅移除面板记录
  - 恢复默认后删除
  - 恢复默认并清理本服务资源
- Zone 级 Fallback Origin 只有在该 Zone 最后一个服务被删除且用户明确确认时才允许清理。

## API 与前端

### API

新增：

```text
GET    /api/optimized-services
POST   /api/optimized-services
POST   /api/optimized-services/preflight
GET    /api/optimized-services/:id
PATCH  /api/optimized-services/:id
DELETE /api/optimized-services/:id

POST   /api/optimized-services/:id/deploy
POST   /api/optimized-services/:id/redeploy
GET    /api/optimized-services/:id/status
GET    /api/optimized-services/:id/deployments
POST   /api/optimized-services/:id/health-check
POST   /api/optimized-services/:id/switch/preferred
POST   /api/optimized-services/:id/switch/default

POST   /api/optimized-deployments/:id/continue
POST   /api/optimized-deployments/:id/rollback
```

`POST /deploy` 返回 `202` 和 `jobId`，不保持 HTTP 请求数分钟。

错误响应统一包含：

```json
{
  "success": false,
  "message": "可读错误信息",
  "error": {
    "code": "SSL_ACTIVATION_TIMEOUT",
    "step": "WAITING_SSL_ACTIVE",
    "details": {}
  }
}
```

权限提示覆盖：

```text
Zone Read
DNS Read/Write
Account Cloudflare Tunnel Read/Write
SSL and Certificates Read/Write
```

Cloudflare 没有可靠的无副作用“写权限试探”接口，因此 Preflight 读取权限并声明写权限需求；实际 403 必须映射为具体缺失权限，而不是展示原始 Axios/Cloudflare 错误。

### 前端

新增路由：

```text
/optimized-services
```

左侧增加“优选服务”入口，不依赖当前 DNS 提供商页面状态；服务自身保存所用 Cloudflare 凭证。

新增页面和组件：

- `OptimizedServicesPage`
- `OptimizedServiceCard`
- `CreateOptimizedServiceDialog`
- `OptimizedServiceWizard`
- `PreflightResult`
- `DeploymentProgressDialog`
- `DeploymentTimeline`
- `HealthStatusPanel`
- `SwitchModeDialog`
- `RollbackDialog`

Wizard 字段：

```text
名称
Cloudflare 凭证
Zone
访问域名
已有 Tunnel
本地服务 URL
模式
preferredTarget
中间 CNAME
健康检查 Path
```

页面展示：

```text
DNS
Tunnel
Fallback Origin
Custom Hostname
SSL
HTTPS
当前模式
部署历史
详细步骤日志
```

使用现有 MUI Theme、Dialog、Snackbar、Loading、Empty/Error State，并提供移动端卡片布局。

## 测试与交付验收

### 真实 Cloudflare Spike

使用测试账户验证：

1. 同 Zone Custom Hostname 创建。
2. Ownership/SSL/DCV 记录自动创建。
3. O2O 下 hostname pending、SSL 状态变化。
4. preferred target DNS-only CNAME。
5. 带正确 SNI/Host 的 `curl --resolve`/HTTPS 请求。
6. Fallback Origin → Tunnel → 原始 Host 路由。

Spike 失败时停止 MVP，不自行引入双 Zone 架构。

### 自动化测试

使用现有 `tsx` 配合 Node Test，注入 Mock Cloudflare Provider，覆盖：

- 全新部署
- 幂等重复部署
- DNS 冲突
- ingress 冲突
- Fallback Origin 已存在或不一致
- Custom Hostname 已存在
- 动态 Ownership/DCV 冲突暂停
- SSL/Hostname 超时
- DNS 切换失败恢复
- HTTPS 健康检查失败恢复
- 回滚失败
- 同服务并发锁
- 应用重启后任务恢复/中断
- 429、403、404、409、5xx、网络超时
- preferred target CNAME 链、私网地址、非 Cloudflare IP 拒绝
- SSRF 路径防护
- 日志和 Snapshot 脱敏

### 构建验收

```bash
cd server && npm test
cd server && npm run build
cd client && npm run build
cd client && npm run lint
docker compose build
docker compose up -d
```

同时使用已有 SQLite 数据库执行一次 `prisma db push` 升级验证，确认原有 DNS、Tunnel、Custom Hostname、证书和多用户隔离数据不受影响。

## 明确限制

- preferred target 的长期可用性、第三方运营者可信度不由面板保证。
- Cloudflare for SaaS、SSL、Fallback Origin 能力受账户套餐和 Token 权限影响。
- 第一版不实现全球测速、自动选线、Redis、消息队列、Prometheus、自动故障回退和后台定时健康调度。
- 若目标 hostname 虽解析到 Cloudflare IP，但实际不是可用的 SaaS CNAME target，Preflight 或 Spike 必须失败并阻止切换。
