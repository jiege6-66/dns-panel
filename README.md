# 🌐 DNS Panel

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker)](https://hub.docker.com/r/a3180623/dns-panel)

> 现代化的多 DNS 服务商统一管理面板：多用户、多凭证隔离，统一管理域名与 DNS 解析记录，支持通用证书中心、Cloudflare Tunnels 管理，并提供操作日志审计。

---

## 📑 目录

- [功能概览](#-功能概览)
- [Cloudflare Tunnels](#-cloudflare-tunnels)
- [Cloudflare 优选服务](#-cloudflare-优选服务)
- [支持的服务商](#-支持的服务商)
- [技术栈](#-技术栈)
- [相关文档](#-相关文档)
- [快速部署](#-快速部署docker-compose)
- [Docker Hub 镜像](#-docker-hub-镜像部署)
- [首次使用](#-首次使用)
- [本地开发](#-本地开发)
- [环境变量](#️-环境变量)
- [常见问题](#-常见问题)
- [版本更新](#-版本更新)

---

## 📋 版本更新

| 版本 | 日期 | 更新内容 |
|------|------|----------|
| v1.7.0 | 2026-03-31 | 🔐 新增证书中心（ACME/订单/自动续期/部署矩阵/通知）+ 域名到期手动设置 |
| v1.6.0 | 2026-03-24 | ✨ 新增 ESA 自动 DNS 配置、全提供商权威 DNS 识别、非权威域名显示开关 |
| v1.5.0 | 2026-03-02 | 🆕 新增 Cloudflare Tunnels 管理：隧道创建/删除、详情面板、cloudflared 安装指引、三类路由管理（Public Hostnames / CIDR / 主机名路由） |
| v1.4.1 | 2026-02-18 | ✨ 抽屉支持 DNS 服务商拖拽排序 + 前端体验优化 |
| v1.4.0 | 2026-02-18 | ✨ 新增阿里云 ESA 站点管理与免费证书 |
| v1.3.0 | 2026-01-30 | ✨ 多服务商添加/删除域名功能 |
| v1.2.0 | 2026-01-30 | ✨ 新增 Cloudflare 添加域名功能 |
| v1.1.0 | 2026-01-29 | ✨ 新增火山引擎、京东云、DNSLA 支持 |
| v1.0.0 | 2026-01-15 | 🎉 首次发布 |

<details>
<summary><b>查看完整更新日志</b></summary>

### v1.7.0 (2026-03-31)
- 🔐 **新增通用证书中心（Certificate Center）**
  - 证书订单：草稿/申请、DNS-01 自动写入/清理、状态机 + 重试、打包下载（ZIP）
  - ACME 账户：Let's Encrypt / ZeroSSL / Google / Custom（支持 EAB）
  - 自动续期：后台调度器轮询续期、失败重试、续期后自动触发部署
  - 部署矩阵：部署目标/部署任务（支持 Webhook / Dokploy / 1Panel / Nginx Proxy Manager 等），可手动执行部署
  - 厂商证书：腾讯云/阿里云/UCloud SSL 订单统一管理（含 DNS 验证与下载）
  - CNAME 代理：证书 CNAME Alias 管理与校验
  - 通知：证书/部署/厂商渠道通知策略 + 多通道配置（邮件/Webhook/Telegram/钉钉/飞书/企微等）
- ✨ **域名到期时间支持手动设置**：自动查询失败时可编辑补充；自动成功时也可覆盖并支持清除恢复自动

### v1.6.0 (2026-03-24)
- ✨ **增强阿里云 ESA 自动 DNS**
  - ESA 站点创建后，如为 CNAME 接入且项目内命中可托管 `_esaauth.<domain>` 的权威域名，可直接自动创建验证 TXT
  - ESA 业务记录创建后，如项目内命中可托管该记录名的权威域名，可直接自动创建业务 CNAME
  - 当命中多个可用主域名时，弹窗要求用户确认目标账户 / 域名后再继续
  - TXT 自动创建完成后会自动触发 ESA `VerifySite`
- ✨ **新增权威 DNS 识别框架**
  - 域名列表与详情统一输出 `authorityStatus / authorityReason / authorityMeta`
  - 自动识别 `authoritative / pending / non_authoritative / unknown`
  - 已接入 Cloudflare、阿里云、DNSPod、华为云、PowerDNS、火山引擎、京东云、Spaceship、NameSilo 等提供商的权威识别
  - 对百度云、西部数码、DNSLA 等元数据不足的提供商保持保守判定，避免误判为可自动接入
- ✨ **新增非权威域名显示开关**
  - 设置页新增「显示非权威域名」开关，默认关闭
  - 仅控制域名列表是否显示 `non_authoritative`
  - `pending / unknown` 仍然显示，便于排查待接入或待识别域名
- 🔒 **自动流程更严格**
  - 自动 DNS / ESA 自动接入仅使用 `authoritative` 域名
  - `unknown / pending / non_authoritative` 不参与自动接入，统一回退手动配置
- 🐛 **修复自动 DNS 重复记录识别**
  - 统一将不同服务商返回的相对主机名 / FQDN 规范化后再判断
  - 已存在同名同类型记录时优先更新，避免误判为重复创建

### v1.5.0 (2026-03-02)
- 🆕 **新增 Cloudflare Tunnels 管理**
  - 隧道列表：创建 / 删除 Tunnel，查看连接状态，支持搜索过滤
  - 删除 Tunnel 时可选同时清理指向该 Tunnel 的 DNS CNAME 记录
- ✨ **隧道详情面板**（展开即可查看）
  - Active Replicas 表格：Replica ID / Origin IP / Edge Locations / Version / Architecture / Uptime
  - Routes 概览：从 Tunnel Config 解析 ingress 公开路由列表
  - Status / Uptime 统计卡片
- ✨ **未连接安装指引**（Tunnel 状态为 inactive/down 时自动展示）
  - 支持 5 个平台切换：Windows / macOS / Debian / Red Hat / Docker
  - 自动生成安装命令和 `cloudflared tunnel run --token <TOKEN>` 连接命令
  - Token 默认遮罩显示，复制时保留完整值
- ✨ **路由管理弹窗（三类 Tab）**
  - 已发布应用程序路由（Public Hostnames）：增删改 ingress 规则，自动同步 DNS CNAME，失败时自动回滚 Tunnel 配置
  - CIDR 路由：创建 / 查询 / 删除私网 CIDR 路由（IPv4/IPv6），含前端格式校验
  - 主机名路由：创建 / 查询 / 删除私网主机名路由，含通配符支持
- 🔧 **后端 Tunnel API**
  - 新增 12+ 个 REST 端点：Tunnel CRUD、Config、Token、Public Hostnames、CIDR 路由、主机名路由
  - 私网路由聚合查询使用 `Promise.allSettled`，部分失败仍可返回
  - 删除路由前增加归属校验，防止跨 Tunnel 误删

### v1.4.1 (2026-02-18)
- ✨ 左侧抽屉：DNS 服务商支持拖拽排序（长按拖动，顺序自动保存）
- 💄 前端体验优化
  - 「DNS 账户管理」新增/编辑对话框样式统一，移动端不再全屏
  - 优化表单自动填充干扰（别名/Token 更不易被误识别为账号密码）
  - 优化抽屉交互：移除移动端点击蓝色遮罩、退出登录菜单居中、修复腾讯云重复显示

### v1.4.0 (2026-02-18)
- ✨ 新增阿里云 ESA（边缘安全加速）站点管理
  - 账号级「DNS 域名」与「ESA 站点管理」一键切换
  - 支持多 Region 拉取站点/实例（cn-hangzhou / ap-southeast-1）
  - 新增站点创建：接入方式（CNAME/NS）、覆盖范围、套餐实例（含配额展示）
- ✨ 新增 ESA DNS 记录管理
  - 记录增删改查、CNAME 配置指引与状态检测
  - HTTPS 证书状态展示 + 一键申请/续签免费证书（Let's Encrypt；基础版/更高支持 DigiCert）
  - 提供托管 DCV / DCV 验证信息复制，支持外部 DNS 场景
- 🐛 修复若干前端交互问题（站点下拉白屏、编辑凭证回填 label 重叠等）
- 🔧 新增后端 ESA API 路由与签名适配（增强错误信息、兼容 POST/GET）

### v1.3.0 (2026-01-30)
- ✨ 新增多服务商添加/删除域名功能
  - 支持：Cloudflare、阿里云、腾讯云（DNSPod）、华为云、百度云、火山引擎、京东云、DNSLA、PowerDNS
- 🔧 统一域名管理接口，支持批量添加、自动去重

### v1.2.0 (2026-01-30)
- ✨ 新增 Cloudflare 添加域名功能（批量添加、自动去重）
- ✨ 添加结果展示 NS 服务器信息，支持一键复制
- 🔒 删除域名增加二次确认（需输入域名）
- 💄 优化添加域名对话框 UI

### v1.1.0 (2026-01-29)
- ✨ 新增火山引擎 DNS 支持
- ✨ 新增京东云 DNS 支持
- ✨ 新增 DNSLA 支持
- 🐛 修复 Cloudflare 自定义主机名显示问题

### v1.0.0 (2026-01-15)
- 🎉 首次发布
- 支持 Cloudflare、阿里云、DNSPod、华为云、百度云、西部数码、NameSilo、PowerDNS、Spaceship

</details>

---

## ✨ 功能概览

| 功能 | 说明 |
|------|------|
| 🌐 多服务商支持 | 统一管理多个 DNS 服务商的域名和解析记录 |
| ⚡ ESA 自动 DNS | 自动创建 ESA 验证 TXT / 业务 CNAME；多候选时支持人工确认目标主域名 |
| 🧭 权威 DNS 识别 | 统一识别域名是否为当前托管方权威 DNS，区分 authoritative / pending / non_authoritative / unknown |
| 🧾 解析记录管理 | 增删改查；支持权重/线路/启停/备注等 |
| 🔐 通用证书中心 | ACME 账户管理、证书订单管理、DNS-01 自动验证、自动续期、Webhook / Dokploy / 1Panel / NPM 等部署目标、证书下载 |
| ☁️ Cloudflare 增强 | 自定义主机名、证书状态、Fallback Origin |
| 🚇 Cloudflare Tunnels | 隧道管理、路由配置（公网主机名 / CIDR / 主机名路由） |
| ⚡ Cloudflare 优选服务 | 同 Zone Tunnel + Custom Hostname 一键部署、切换、健康检查与回滚 |
| 🛡️ 阿里云 ESA | 边缘安全加速站点管理、DNS 记录、免费证书申请/续签 |
| 🔑 多用户隔离 | JWT 登录、账户与凭证隔离 |
| 🔒 安全存储 | DNS 凭证加密存储（AES-256） |
| 💾 数据持久化 | SQLite 数据库，挂载 Volume 即可备份迁移 |

### 🚇 Cloudflare Tunnels

通过面板即可完成 Cloudflare Tunnel 的全生命周期管理，无需手动操作 `cloudflared` 配置文件。

| 能力 | 说明 |
|------|------|
| 隧道管理 | 创建 / 删除 Tunnel，查看连接状态与副本（Replica）信息 |
| 详情面板 | 展开查看 Active Replicas、Routes、Uptime 等运行指标 |
| 安装指引 | 未连接 Tunnel 自动展示 cloudflared 安装 / 启动命令（Windows / macOS / Debian / Red Hat / Docker） |
| Token 安全 | Token 默认遮罩显示，复制时保留完整值 |
| 已发布应用程序路由 | 管理 Public Hostnames（ingress），自动同步创建 / 更新 DNS CNAME 记录，失败时自动回滚 |
| CIDR 路由 | 创建 / 查询 / 删除私网 CIDR 路由，支持归属校验防止跨 Tunnel 误删 |
| 主机名路由 | 创建 / 查询 / 删除私网主机名路由 |
| DNS 清理 | 删除 Tunnel 时可选同时清理指向该 Tunnel 的 DNS CNAME 记录 |

> ⚠️ Tunnels 功能需要 Cloudflare API Token 具备 **Account: Cloudflare Tunnel（编辑）** 和 **Zone: DNS（编辑）** 权限。

### ⚡ Cloudflare 优选服务

“优选服务”使用异步工作流配置同 Zone 的 Tunnel、Fallback Origin、Custom Hostname、动态 DCV 记录和 DNS-only preferred target。部署请求立即返回任务 ID，页面会持续展示当前步骤、hostname/SSL 独立状态、HTTPS 健康状态和详细日志。

主要安全约束：

- preferred target 必须经过完整 CNAME 链、最终 A/AAAA、私网/保留地址和 Cloudflare 官方 IP 段检查。
- HTTPS 预检始终使用业务 hostname 作为 SNI 与 Host，不允许由请求指定任意健康检查 host。
- DNS、Ingress、Fallback Origin 或动态 DCV 冲突不会静默覆盖，任务进入“待确认”。
- Snapshot 和步骤日志禁止保存 API Token、Tunnel Token、JWT、Cookie、私钥或加密密钥。
- 回滚只清理本次工作流创建的资源；Zone 级 Fallback Origin 仅在最后一个服务且用户明确要求时清理。

Cloudflare Token 需要：Zone Read、DNS Read/Write、Account Cloudflare Tunnel Read/Write、SSL and Certificates Read/Write。Cloudflare for SaaS、Fallback Origin 和证书能力仍受账户套餐限制。

#### SQLite 升级

本项目继续使用 `prisma db push`，升级前必须先停止写入并备份 SQLite：

```bash
cd server
cp prisma/database.db "prisma/database.db.backup-$(date +%Y%m%d-%H%M%S)"
npx prisma db push
```

升级后检查新增表且既有数据量未变化：

```bash
sqlite3 prisma/database.db ".tables"
sqlite3 prisma/database.db "PRAGMA integrity_check;"
sqlite3 prisma/database.db "SELECT count(*) FROM users; SELECT count(*) FROM dns_credentials;"
```

应看到 `cloudflare_optimized_zone_configs`、`optimized_services` 和 `optimized_deployments`；`PRAGMA integrity_check` 应返回 `ok`。Docker 部署启动时仍会自动运行 `prisma db push`，但不能替代升级前备份。

---

## 🏢 支持的服务商

| 国内服务商 | 国际服务商 |
|-----------|-----------|
| 阿里云 | Cloudflare |
| DNSPod（腾讯云） | NameSilo |
| UCloud | PowerDNS |
| 华为云 | Spaceship |
| 百度云 | |
| 西部数码 | |
| 火山引擎 | |
| 京东云 | |
| DNSLA | |

---

## 🧱 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React + TypeScript + Vite + MUI + TanStack Query |
| 后端 | Node.js 18 + Express + TypeScript + Prisma |
| 数据库 | SQLite（默认） |

---

## 📚 相关文档

- `快速启动指南.md`：面向新用户的快速部署与使用说明
- `CERTIFICATE_PLAN.md`：证书中心整体规划
- `GEMINI_CERTIFICATE_PLAN_REVIEW.md`：证书规划评估记录（Gemini）

---

## 🚀 快速部署（Docker Compose）

> 推荐方式：前后端一体，只需暴露一个端口。

### Docker 开发调试（无需重复构建）

频繁调试时使用独立的 `docker-compose.dev.yml`。它不会使用生产镜像，也不会覆盖宿主机的 `node_modules` 或 `server/database.db`；源码通过 bind mount 挂载，后端 `tsx watch` 和前端 Vite 会自动热更新：

```bash
docker compose -f docker-compose.dev.yml up
```

修改 TypeScript、React 或样式文件不需要重新构建。开发 Compose 还包含自动运行的 `cloudflared` sidecar：后端创建/复用 Tunnel 后将 Token 写入 Docker 私有卷，sidecar 自动连接；Token 不进入 SQLite、日志或 Git。只有修改 `package.json`、锁文件、Docker 基础镜像或 Compose 服务定义时，才需要重新创建对应容器（通常执行 `docker compose -f docker-compose.dev.yml up --force-recreate` 即可；不需要 `docker compose build`）。

停止开发环境：

```bash
docker compose -f docker-compose.dev.yml down
```

开发数据库位于 Docker 命名卷 `optimized_dev_data`，如需完全清空再显式执行 `docker compose -f docker-compose.dev.yml down -v`。

## 🏷️ 发版（Tag 自动发布）

项目已提供 GitHub Actions 工作流：当推送 `v*` Tag（例如 `v1.7.0`）时，会自动：

- 构建并推送 Docker 镜像：`a3180623/dns-panel:<tag>`、`a3180623/dns-panel:<version>`、`a3180623/dns-panel:latest`
- 创建 GitHub Release（自动生成 Release Notes）

使用方法：

```bash
# 1) 先提交本次改动（包括 README 的版本更新）
git add -A
git commit -m "chore(release): v1.7.0"

# 2) 打 Tag 并推送（触发 Release on Tag 工作流）
git tag -a v1.7.0 -m "v1.7.0"
git push origin main  # 仓库如使用 master 分支请改为 master
git push origin v1.7.0
```

发布前请在 GitHub 仓库 Secrets 中配置：

- `DOCKER_USERNAME`
- `DOCKER_PASSWORD`

### 前置条件

- Linux 服务器（Ubuntu / Debian 等）
- 已安装 Git、Docker 与 Docker Compose v2
- 开放端口 `3000`（或通过反代访问）

### 1️⃣ 克隆仓库

```bash
git clone https://github.com/Frankieli123/dns-panel.git
cd dns-panel
```

### 2️⃣ 配置环境变量

在仓库根目录创建 `.env` 文件：

```env
# 必填：生产环境必须设置强随机值
JWT_SECRET=your-random-jwt-secret-min-32-chars-here
ENCRYPTION_KEY=your-32-character-encryption-key!!

# 可选：跨域访问时设置
# CORS_ORIGIN=https://panel.example.com
```

**生成安全密钥：**

```bash
openssl rand -base64 48  # JWT_SECRET（建议 32+ 字符）
openssl rand -hex 16     # ENCRYPTION_KEY（必须 32 字符）
```

### 3️⃣ 启动服务

```bash
# 首次启动（从源码构建）
docker compose up -d --build

# 查看状态
docker compose ps

# 查看日志
docker compose logs -f
```

### 4️⃣ 访问面板

| 地址 | 说明 |
|------|------|
| `http://<IP>:3000` | Web 界面 |
| `http://<IP>:3000/health` | 健康检查 |

### 5️⃣ 更新版本

```bash
git pull
docker compose down
docker compose up -d --build
```

### 6️⃣ 数据备份

数据库文件位于 `./data/database.db`：

```bash
cp ./data/database.db ./data/database.db.backup
```

### 7️⃣ 生产建议

**反向代理（推荐）：**

1. 修改端口映射为 `127.0.0.1:3000:3000`
2. 使用 Nginx/Caddy 终止 TLS，对外开放 80/443

---

## 📦 Docker Hub 镜像部署

不想从源码构建？直接使用预构建镜像：

```bash
docker run -d \
  --name dns-panel \
  -p 3000:3000 \
  -e NODE_ENV=production \
  -e JWT_SECRET=your-secret-here \
  -e ENCRYPTION_KEY=your-32-character-encryption-key!! \
  -e DATABASE_URL=file:/app/data/database.db \
  -v $(pwd)/data:/app/data \
  --restart unless-stopped \
  a3180623/dns-panel:latest
```

> 镜像由 GitHub Actions 自动构建，包含 `latest` 与 `sha` 标签。

---

## 👤 首次使用

1. **注册账号** - 打开 `http://<IP>:3000`，注册管理员账号
2. **添加凭证** - 进入「设置」→「DNS 账户/凭证」，添加服务商 API 凭证
3. **开始管理 DNS** - 回到仪表盘，选择服务商与账户，管理域名和记录
4. **申请证书** - 进入左侧「证书中心」，创建 ACME 账户并发起证书申请
5. **自动续期 / 推送** - 在证书订单开启自动续期，在「部署目标 / 部署任务」中配置 Webhook、Dokploy、1Panel、Nginx Proxy Manager 等推送

> ⚠️ Cloudflare 自定义主机名功能需要 Token 具备 `区域.SSL 和证书（编辑）` 权限；Tunnels 功能需要 `Account: Cloudflare Tunnel（编辑）` + `Zone: DNS（编辑）` 权限。
>
> ⚠️ 通用证书中心默认使用 `DNS-01`；新建证书默认开启自动续期。开发/联调建议保持 `ACME_ENV=staging`。
>
> ⚠️ 如需升级旧版 NPM 实验目标类型，可执行：`cd server && npm run cert:deploy:migrate:npm-type`

---

## 🛠️ 本地开发

**前置要求：** Node.js 18+

### 端口说明

| 服务 | 端口 | 说明 |
|------|------|------|
| 前端 | 5173 | Vite 开发服务器 |
| 后端 | 4001 | Express API（可在 `server/.env` 修改） |

> 修改后端端口后，需同步更新 `client/vite.config.ts` 的 proxy target

### 启动命令

**后端：**

```bash
cd server
npm install
npx prisma generate
npx prisma migrate dev
npm run dev
```

**前端（新终端）：**

```bash
cd client
npm install
npm run dev
```

---

## ⚙️ 环境变量

### 必填（生产环境）

| 变量 | 说明 |
|------|------|
| `JWT_SECRET` | JWT 签名密钥（建议 32+ 字符） |
| `ENCRYPTION_KEY` | 加密密钥（**必须 32 字符**） |

### 可选

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CORS_ORIGIN` | - | 允许的前端来源 |
| `JWT_EXPIRES_IN` | `7d` | JWT 过期时间 |
| `LOG_RETENTION_DAYS` | `90` | 日志保留天数 |
| `DATABASE_URL` | - | SQLite 连接串 |
| `ACME_ENV` | `production`（当 `NODE_ENV=production` 且未显式设置 ACME_ENV 时），否则 `staging` | ACME 环境：`staging` / `production` |
| `CERTIFICATE_SCHEDULER_INTERVAL_MS` | `15000` | 证书订单调度器轮询间隔 |
| `CERTIFICATE_RENEWAL_SCHEDULER_INTERVAL_MS` | `21600000` | 自动续期调度器轮询间隔（默认 6 小时） |
| `ACME_PROPAGATION_DELAY_MS` | `30000` | 自动写入 TXT 后的首次传播等待时间 |
| `VENDOR_CERTIFICATE_SCHEDULER_INTERVAL_MS` | `30000` | 厂商证书订单调度器轮询间隔 |
| `CERTIFICATE_DEPLOY_SCHEDULER_INTERVAL_MS` | `30000` | 证书部署调度器轮询间隔 |
| `SMTP_HOST` | - | SMTP 主机（未在设置中配置 SMTP 时必填） |
| `SMTP_PORT` | `587` | SMTP 端口 |
| `SMTP_SECURE` | `false` | 是否使用 SMTPS（465） |
| `SMTP_USER` | - | SMTP 用户名（可选） |
| `SMTP_PASS` | - | SMTP 密码（可选） |
| `SMTP_FROM` | - | 发件人（如 `DNS Panel <no-reply@example.com>`） |

> 邮件通知：也可以在「设置」里配置 SMTP；未配置时会使用环境变量 `SMTP_*`。

---

## ❓ 常见问题

<details>
<summary><b>容器启动后无法访问？</b></summary>

```bash
docker compose ps          # 检查容器状态
docker compose logs -f     # 查看日志
curl http://localhost:3000/health  # 测试健康检查
```

</details>

<details>
<summary><b>忘记或修改了 ENCRYPTION_KEY？</b></summary>

更改 `ENCRYPTION_KEY` 后，历史加密的 DNS 凭证将**无法解密**。只能保持原值，或让用户重新录入凭证。

</details>

---

## 🗂️ 项目结构

```text
.
├── client/                           # 前端（React + Vite）
│   └── src/
│       ├── pages/Certificates.tsx    #   证书中心页
│       ├── components/Certificates/  #   证书中心组件
│       ├── services/certificates.ts  #   证书 API 调用
│       ├── pages/Tunnels.tsx         #   Tunnels 列表页
│       ├── components/Tunnels/       #   Tunnels 组件
│       │   ├── TunnelDetailsPanel.tsx #     详情面板（副本/路由/安装指引）
│       │   └── TunnelPublicHostnamesDialog.tsx  # 路由管理弹窗（三类路由）
│       └── services/tunnels.ts       #   Tunnels API 调用
├── server/                           # 后端（Express + Prisma）
│   └── src/
│       ├── routes/certificates.ts    #   证书订单 API
│       ├── routes/certificateCredentials.ts # ACME 账户 API
│       ├── routes/certificateDeploy.ts #   证书部署（目标/任务）API
│       ├── routes/vendorCertificates.ts #   厂商证书订单 API
│       ├── routes/certificateAliases.ts #   CNAME Alias API
│       ├── services/cert/            #   ACME / DNS-01 / 订单服务
│       ├── jobs/certificateOrderScheduler.ts # 证书调度器
│       ├── jobs/certificateRenewalScheduler.ts # 自动续期调度器
│       ├── jobs/vendorCertificateScheduler.ts # 厂商证书调度器
│       ├── jobs/certificateDeployScheduler.ts # 部署调度器
│       ├── routes/tunnels.ts         #   Tunnels REST API（~1000 行）
│       └── services/cloudflare.ts    #   Cloudflare API 封装
├── docker-compose.yml                # Docker Compose 配置
├── Dockerfile                        # 多阶段构建（前后端一体）
├── .env.example                      # 环境变量示例
├── 快速启动指南.md                   # 快速部署指南
├── CERTIFICATE_PLAN.md               # 证书中心规划
└── GEMINI_CERTIFICATE_PLAN_REVIEW.md # Gemini 规划评估
```

---

## 📄 许可证

[MIT License](LICENSE)
