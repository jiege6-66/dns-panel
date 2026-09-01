import { randomUUID } from 'crypto';
import { chmod, mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { CloudflareService } from '../cloudflare';
import { OptimizedCredentialService } from './credential';
import { OptimizedHealthService } from './health';
import { validatePreferredTarget, assertHealthPath, assertHostname, assertServiceUrl, normalizeHostname } from './validation';
import { DeploymentSnapshot, OptimizedInput, OptimizedOperation, safeJson } from './types';
import { extractTunnelConfig, TunnelPublicHostnameService, ensureTunnelFallbackRule } from '../tunnelPublicHostname';
import { OptimizedRollbackService } from './rollback';

const prisma = new PrismaClient();
class ConfirmationRequiredError extends Error {
  readonly code = 'CONFIRMATION_REQUIRED';
  readonly status = 409;
  constructor(readonly kind: string, readonly details: any, message: string) { super(message); }
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}

function errorDetails(error: any): { code: string; message: string; status: number; details?: any } {
  const status = Number(error?.status || error?.statusCode || 400);
  const code = String(error?.code || (status === 403 ? 'PERMISSION_DENIED' : 'CLOUDFLARE_ERROR'));
  return { code, message: String(error?.message || error), status, details: error?.details };
}

export class OptimizedDeploymentService {
  private readonly credentials = new OptimizedCredentialService(prisma);
  private readonly rollback = new OptimizedRollbackService(prisma);
  private readonly health = new OptimizedHealthService();

  private async provisionConnectorToken(tunnelId: string, token: string): Promise<void> {
    const directory = String(process.env.OPTIMIZED_TUNNEL_TOKEN_DIR || '').trim();
    if (!directory || !token) return;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, `${tunnelId}.token`);
    await writeFile(target, `${token.trim()}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(target, 0o600);
  }

  async list(userId: number): Promise<any[]> {
    return prisma.optimizedService.findMany({ where: { userId }, orderBy: { updatedAt: 'desc' } });
  }

  async get(userId: number, id: number): Promise<any> {
    const item = await prisma.optimizedService.findFirst({ where: { id, userId } });
    if (!item) throw Object.assign(new Error('优选服务不存在或无权访问'), { status: 404 });
    return item;
  }

  normalizeInput(input: Partial<OptimizedInput>): OptimizedInput {
    const name = String(input.name || '').trim();
    if (!name) throw Object.assign(new Error('名称不能为空'), { status: 400 });
    const dnsCredentialId = Number(input.dnsCredentialId);
    if (!Number.isInteger(dnsCredentialId) || dnsCredentialId <= 0) throw Object.assign(new Error('请选择 Cloudflare 凭证'), { status: 400 });
    const zoneId = String(input.zoneId || '').trim();
    if (!zoneId) throw Object.assign(new Error('Zone 不能为空'), { status: 400 });
    const hostname = assertHostname(input.hostname);
    const serviceUrl = assertServiceUrl(input.serviceUrl);
    const mode = input.mode === 'PREFERRED' ? 'PREFERRED' : 'DEFAULT';
    const preferredTarget = input.preferredTarget ? String(input.preferredTarget) : undefined;
    if (mode === 'PREFERRED' && !preferredTarget) throw Object.assign(new Error('PREFERRED 模式必须填写 preferredTarget'), { status: 400 });
    if (preferredTarget) assertHostname(preferredTarget, 'preferredTarget');
    const intermediateEnabled = input.intermediateEnabled === true;
    const intermediateHostname = intermediateEnabled ? assertHostname(input.intermediateHostname, '中间 CNAME') : undefined;
    return {
      name,
      dnsCredentialId,
      accountId: input.accountId?.trim() || undefined,
      zoneId,
      zoneName: input.zoneName?.trim() || undefined,
      hostname,
      serviceUrl,
      tunnelId: input.tunnelId?.trim() || undefined,
      tunnelName: input.tunnelName?.trim() || undefined,
      mode,
      preferredTarget,
      intermediateEnabled,
      intermediateHostname,
      healthCheckPath: assertHealthPath(input.healthCheckPath || '/'),
    };
  }

  async create(userId: number, raw: Partial<OptimizedInput>): Promise<any> {
    const input = this.normalizeInput(raw);
    const context = await this.credentials.getCloudflareContext(userId, input.dnsCredentialId);
    const zone = await context.cfService.getDomainById(input.zoneId);
    if (!zone?.id || normalizeHostname(zone.name) !== normalizeHostname(input.zoneName || zone.name)) {
      throw Object.assign(new Error('Zone 不存在或凭证无权访问'), { status: 404 });
    }
    const existing = await prisma.optimizedService.findFirst({ where: { userId, dnsCredentialId: input.dnsCredentialId, hostname: input.hostname } });
    if (existing) throw Object.assign(new Error('该凭证下已存在相同访问域名的优选服务'), { status: 409 });
    return prisma.optimizedService.create({
      data: {
        userId,
        name: input.name,
        hostname: input.hostname,
        serviceUrl: input.serviceUrl,
        dnsCredentialId: input.dnsCredentialId,
        accountId: input.accountId || context.accountId,
        zoneId: input.zoneId,
        zoneName: normalizeHostname(input.zoneName || zone.name),
        tunnelId: input.tunnelId,
        tunnelName: input.tunnelName,
        mode: input.mode,
        preferredTarget: input.preferredTarget,
        intermediateEnabled: input.intermediateEnabled,
        intermediateHostname: input.intermediateHostname,
        healthCheckPath: input.healthCheckPath || '/',
      },
    });
  }

  async update(userId: number, id: number, raw: Partial<OptimizedInput>): Promise<any> {
    const existing = await this.get(userId, id);
    const input = this.normalizeInput({ ...existing, ...raw });
    return prisma.optimizedService.update({ where: { id: existing.id }, data: {
      name: input.name, hostname: input.hostname, serviceUrl: input.serviceUrl,
      dnsCredentialId: input.dnsCredentialId, accountId: input.accountId || existing.accountId,
      zoneId: input.zoneId, zoneName: input.zoneName || existing.zoneName,
      tunnelId: input.tunnelId, tunnelName: input.tunnelName, mode: input.mode,
      preferredTarget: input.preferredTarget, intermediateEnabled: input.intermediateEnabled,
      intermediateHostname: input.intermediateHostname, healthCheckPath: input.healthCheckPath,
    } });
  }

  async preflight(userId: number, raw: Partial<OptimizedInput>): Promise<any> {
    const input = this.normalizeInput(raw);
    const context = await this.credentials.getCloudflareContext(userId, input.dnsCredentialId);
    const checks: Array<{ name: string; ok: boolean; message: string; details?: any }> = [];
    let zone: any;
    try {
      zone = await context.cfService.getDomainById(input.zoneId);
      checks.push({ name: 'Zone', ok: !!zone?.id, message: zone?.id ? 'Zone 可访问' : 'Zone 不存在' });
    } catch (error: any) {
      checks.push({ name: 'Zone', ok: false, message: error?.message || String(error) });
    }
    const records = zone?.id ? await context.cfService.getDNSRecords(input.zoneId) : [];
    const hostnameRecords = records.filter((record: any) => normalizeHostname(record.name) === input.hostname);
    const dnsConflict = hostnameRecords.some((record: any) => String(record.type).toUpperCase() !== 'CNAME');
    checks.push({ name: 'DNS', ok: !dnsConflict, message: dnsConflict ? '业务 hostname 存在非 CNAME 冲突' : 'DNS 无不可自动处理的冲突', details: { records: hostnameRecords.map((r: any) => ({ id: r.id, type: r.type, content: r.content, proxied: r.proxied })) } });
    let tunnelConfig: any = null;
    if (input.tunnelId) {
      try {
        tunnelConfig = extractTunnelConfig(await context.cfService.getTunnelConfig(context.accountId, input.tunnelId));
        checks.push({ name: 'Tunnel', ok: !!tunnelConfig, message: tunnelConfig ? 'Tunnel 可访问' : 'Tunnel 配置无法解析' });
      } catch (error: any) {
        const status = Number(error?.status || error?.statusCode || 0);
        if (status === 404 || /configuration for tunnel not found/i.test(String(error?.message || ''))) {
          checks.push({ name: 'Tunnel', ok: true, message: 'Tunnel 尚无 ingress 配置，部署时初始化' });
        } else {
          checks.push({ name: 'Tunnel', ok: false, message: error?.message || String(error) });
        }
      }
    } else checks.push({ name: 'Tunnel', ok: true, message: '部署时创建同账户共享 Tunnel' });
    const fallback = await context.cfService.getFallbackOriginDetails(input.zoneId).catch((error: any) => ({ origin: null, status: 'ERROR', errors: [{ message: error?.message || String(error) }] }));
    checks.push({ name: 'Fallback Origin', ok: fallback.status !== 'ERROR', message: fallback.origin ? `已配置：${fallback.origin}` : '未配置，部署时初始化' });
    if (input.preferredTarget) {
      try {
        const preferred = await validatePreferredTarget(input.preferredTarget);
        checks.push({ name: 'preferredTarget', ok: true, message: 'CNAME 链和 Cloudflare IP 预检通过', details: preferred });
      } catch (error: any) { checks.push({ name: 'preferredTarget', ok: false, message: error?.message || String(error), details: { code: error?.code } }); }
    } else checks.push({ name: 'preferredTarget', ok: input.mode !== 'PREFERRED', message: input.mode === 'PREFERRED' ? 'PREFERRED 模式缺少目标' : 'DEFAULT 模式无需目标' });
    checks.push({ name: '权限声明', ok: true, message: '需要 Zone Read、DNS Read/Write、Account Cloudflare Tunnel Read/Write、SSL and Certificates Read/Write' });
    return { input, accountId: context.accountId, zone, checks, canDeploy: checks.every(check => check.ok), tunnelConfig, fallback };
  }

  private async acquireLock(userId: number, id: number): Promise<string> {
    const service = await this.get(userId, id);
    const token = randomUUID();
    const now = new Date();
    const lockExpiresAt = new Date(now.getTime() + 30 * 60_000);
    const conflicting = await prisma.optimizedService.findFirst({
      where: {
        userId,
        id: { not: id },
        dnsCredentialId: service.dnsCredentialId,
        OR: [{ hostname: service.hostname }, { zoneId: service.zoneId }],
        lockToken: { not: null },
        lockExpiresAt: { gt: now },
      },
      select: { id: true, hostname: true, zoneId: true },
    });
    if (conflicting) throw Object.assign(new Error('同 hostname 或 Zone 已有修改任务运行中'), { status: 409, code: 'LOCKED', details: conflicting });
    const result = await prisma.optimizedService.updateMany({ where: { id, userId, OR: [{ lockToken: null }, { lockExpiresAt: null }, { lockExpiresAt: { lt: now } }] }, data: { lockToken: token, lockExpiresAt } });
    if (result.count !== 1) throw Object.assign(new Error('该服务已有部署任务运行中'), { status: 409, code: 'LOCKED' });
    return token;
  }

  private async appendLog(jobId: number, entry: { step: string; message: string; details?: any }): Promise<void> {
    const job = await prisma.optimizedDeployment.findUnique({ where: { id: jobId }, select: { stepLogJson: true } });
    const logs = parseJson<any[]>(job?.stepLogJson, []);
    logs.push({ at: new Date().toISOString(), ...entry });
    await prisma.optimizedDeployment.update({ where: { id: jobId }, data: { currentStep: entry.step, heartbeatAt: new Date(), stepLogJson: safeJson(logs) } });
  }

  async enqueue(userId: number, serviceId: number, operation: OptimizedOperation, idempotencyKey?: string, metadata?: any): Promise<any> {
    const service = await this.get(userId, serviceId);
    const key = String(idempotencyKey || `${operation}:${service.id}:${service.updatedAt.toISOString()}`);
    const existing = await prisma.optimizedDeployment.findUnique({ where: { idempotencyKey: key } });
    if (existing) return existing;
    const lockToken = await this.acquireLock(userId, service.id);
    try {
      const job = await prisma.optimizedDeployment.create({ data: { userId, serviceId, operation, idempotencyKey: key, status: 'QUEUED', heartbeatAt: new Date(), currentStep: 'DRAFT', resultJson: metadata ? safeJson(metadata) : undefined } });
      void this.run(job.id, lockToken).catch(() => undefined);
      return job;
    } catch (error) {
      await prisma.optimizedService.update({ where: { id: service.id }, data: { lockToken: null, lockExpiresAt: null } }).catch(() => undefined);
      throw error;
    }
  }

  async status(userId: number, serviceId: number): Promise<any> {
    await this.get(userId, serviceId);
    const job = await prisma.optimizedDeployment.findFirst({ where: { userId, serviceId }, orderBy: { createdAt: 'desc' } });
    return { service: await this.get(userId, serviceId), deployment: job };
  }

  async deployments(userId: number, serviceId: number): Promise<any[]> {
    await this.get(userId, serviceId);
    return prisma.optimizedDeployment.findMany({ where: { userId, serviceId }, orderBy: { createdAt: 'desc' } });
  }

  async healthCheck(userId: number, serviceId: number): Promise<any> {
    const service = await this.get(userId, serviceId);
    const result = await this.health.checkSavedHostname(service.hostname, service.healthCheckPath);
    return prisma.optimizedService.update({ where: { id: service.id }, data: { healthStatus: result.ok ? 'HEALTHY' : 'UNHEALTHY', lastHealthCheckAt: new Date(result.checkedAt), lastError: result.error || null } }).then(() => result);
  }

  async continue(userId: number, deploymentId: number, decision: 'replace' | 'cancel' = 'replace'): Promise<any> {
    const job = await prisma.optimizedDeployment.findFirst({ where: { id: deploymentId, userId } });
    if (!job) throw Object.assign(new Error('部署任务不存在或无权访问'), { status: 404 });
    if (job.status !== 'WAITING_CONFIRMATION') throw Object.assign(new Error('该任务当前不需要确认'), { status: 409 });
    if (decision === 'cancel') {
      await prisma.optimizedService.update({ where: { id: job.serviceId }, data: { deploymentStatus: 'FAILED', currentStep: 'FAILED', lockToken: null, lockExpiresAt: null, lastError: '用户取消冲突处理' } });
      return prisma.optimizedDeployment.update({ where: { id: job.id }, data: { status: 'FAILED', currentStep: 'FAILED', errorCode: 'USER_CANCELLED', errorMessage: '用户取消冲突处理', pendingConfirmationJson: null } });
    }
    const pending = parseJson<any>(job.pendingConfirmationJson, {});
    const previous = parseJson<any>(job.resultJson, {});
    const confirmed = Array.from(new Set([...(previous.confirmed || []), pending.kind].filter(Boolean)));
    const lockToken = await this.acquireLock(userId, job.serviceId);
    const next = await prisma.optimizedDeployment.update({ where: { id: job.id }, data: { status: 'QUEUED', pendingConfirmationJson: null, resultJson: safeJson({ ...previous, confirmed }), heartbeatAt: new Date() } });
    void this.run(job.id, lockToken).catch(() => undefined);
    return next;
  }

  async processQueued(jobId: number): Promise<void> {
    const job = await prisma.optimizedDeployment.findUnique({ where: { id: jobId } });
    if (!job || job.status !== 'QUEUED') return;
    const lockToken = await this.acquireLock(job.userId, job.serviceId);
    await this.run(job.id, lockToken);
  }

  async recoverInterrupted(): Promise<number> {
    const running = await prisma.optimizedDeployment.findMany({ where: { status: 'RUNNING' }, select: { id: true, serviceId: true } });
    if (!running.length) return 0;
    await prisma.optimizedDeployment.updateMany({ where: { id: { in: running.map(item => item.id) } }, data: { status: 'FAILED', currentStep: 'FAILED', errorCode: 'WORKFLOW_INTERRUPTED', errorMessage: '服务重启中断了运行中的任务；资源已保留，可幂等重试', heartbeatAt: new Date() } });
    await prisma.optimizedService.updateMany({ where: { id: { in: running.map(item => item.serviceId) } }, data: { deploymentStatus: 'FAILED', currentStep: 'FAILED', lockToken: null, lockExpiresAt: null, lastError: 'WORKFLOW_INTERRUPTED' } });
    return running.length;
  }

  async provisionPendingConnectors(): Promise<number> {
    if (!String(process.env.OPTIMIZED_TUNNEL_TOKEN_DIR || '').trim()) return 0;
    const services = await prisma.optimizedService.findMany({
      where: { deploymentStatus: 'WAITING_CONFIRMATION', tunnelId: { not: null } },
    });
    let provisioned = 0;
    for (const service of services) {
      try {
        const context = await this.credentials.getCloudflareContext(service.userId, service.dnsCredentialId);
        const token = await context.cfService.getTunnelToken(context.accountId, service.tunnelId!);
        await this.provisionConnectorToken(service.tunnelId!, token);
        provisioned += 1;
        const tunnel = await context.cfService.getTunnel(context.accountId, service.tunnelId!);
        if (Array.isArray(tunnel?.connections) && tunnel.connections.length > 0) {
          const deployment = await prisma.optimizedDeployment.findFirst({
            where: { serviceId: service.id, userId: service.userId, status: 'WAITING_CONFIRMATION' },
            orderBy: { createdAt: 'desc' },
          });
          const pending = parseJson<any>(deployment?.pendingConfirmationJson, {});
          if (deployment && pending.kind === 'TUNNEL_CONNECTION_REQUIRED') {
            await this.continue(service.userId, deployment.id, 'replace');
          }
        }
      } catch {
        // Keep the task waiting. The next scheduler tick retries without
        // exposing the token or turning a transient API error into job failure.
      }
    }
    return provisioned;
  }

  private validationRecords(custom: any): Array<{ type: 'TXT' | 'CNAME'; name: string; content: string }> {
    const records: Array<{ type: 'TXT' | 'CNAME'; name: string; content: string }> = [];
    const ownership = custom?.ownership_verification;
    if (ownership?.name && ownership?.value) records.push({ type: String(ownership.type || 'TXT').toUpperCase() === 'CNAME' ? 'CNAME' : 'TXT', name: ownership.name, content: ownership.value });
    const delegation = Array.isArray(custom?.ssl?.dcv_delegation_records) ? custom.ssl.dcv_delegation_records : [];
    for (const item of delegation) {
      const name = item?.cname || item?.name;
      const content = item?.cname_target || item?.target;
      if (name && content) records.push({ type: 'CNAME', name, content });
    }
    if (!delegation.length) {
      for (const item of custom?.ssl?.validation_records || []) {
        if (item?.txt_name && item?.txt_value) records.push({ type: 'TXT', name: item.txt_name, content: item.txt_value });
      }
    }
    return [...new Map(records.map(item => [`${item.type}:${normalizeHostname(item.name)}:${String(item.content).replace(/\.$/, '')}`, item])).values()];
  }

  private async ensureDynamicValidation(
    cf: CloudflareService,
    service: any,
    custom: any,
    managed: any,
    snapshot: DeploymentSnapshot,
    confirmed: Set<string>,
  ): Promise<number> {
    let created = 0;
    for (const item of this.validationRecords(custom)) {
      const records = (await cf.getDNSRecords(service.zoneId)).filter((record: any) => normalizeHostname(record.name) === normalizeHostname(item.name));
      const same = records.find((record: any) => String(record.type).toUpperCase() === item.type && String(record.content).replace(/[".]$/g, '') === String(item.content).replace(/[".]$/g, ''));
      if (same) continue;
      const conflicts = item.type === 'CNAME' ? records : records.filter((record: any) => String(record.type).toUpperCase() === 'CNAME');
      if (conflicts.length) {
        if (!confirmed.has('VALIDATION_RECORD_CONFLICT')) {
          throw new ConfirmationRequiredError('VALIDATION_RECORD_CONFLICT', { requested: { type: item.type, name: item.name }, existing: conflicts.map((record: any) => ({ id: record.id, type: record.type, content: record.content })) }, `验证记录 ${item.name} 存在冲突`);
        }
        for (const conflict of conflicts) {
          if (!snapshot.dns.some(record => record.id === conflict.id)) snapshot.dns.push({ id: conflict.id, type: conflict.type, name: conflict.name, content: conflict.content, ttl: conflict.ttl, proxied: conflict.proxied });
          await cf.deleteDNSRecord(service.zoneId, conflict.id);
        }
      }
      const record = await cf.createDNSRecord(service.zoneId, { type: item.type, name: item.name, content: item.content, ttl: 60, proxied: false });
      managed.validationRecordIds = [...new Set([...(managed.validationRecordIds || []), record.id])];
      created += 1;
    }
    return created;
  }

  async rollbackDeployment(userId: number, deploymentId: number): Promise<any> {
    const job = await prisma.optimizedDeployment.findFirst({ where: { id: deploymentId, userId } });
    if (!job) throw Object.assign(new Error('部署任务不存在或无权访问'), { status: 404 });
    const service = await this.get(userId, job.serviceId);
    const context = await this.credentials.getCloudflareContext(userId, service.dnsCredentialId);
    const snapshot = parseJson<DeploymentSnapshot | null>(job.snapshotJson, null);
    if (!snapshot) throw Object.assign(new Error('该任务没有可用 Snapshot'), { status: 409 });
    await prisma.optimizedDeployment.update({ where: { id: job.id }, data: { status: 'ROLLING_BACK', currentStep: 'ROLLING_BACK', heartbeatAt: new Date() } });
    const result = await this.rollback.restore(service, context.cfService, context.accountId, snapshot);
    const status = result.failures.length ? 'ROLLBACK_FAILED' : 'ROLLED_BACK';
    return prisma.optimizedDeployment.update({ where: { id: job.id }, data: { status, currentStep: status, resultJson: safeJson(result), heartbeatAt: new Date(), errorCode: result.failures.length ? 'ROLLBACK_FAILED' : null, errorMessage: result.failures.length ? '部分资源回滚失败' : null } });
  }

  private async run(jobId: number, lockToken: string): Promise<void> {
    const job = await prisma.optimizedDeployment.findUnique({ where: { id: jobId } });
    if (!job) return;
    const service = await prisma.optimizedService.findUnique({ where: { id: job.serviceId } });
    if (!service) return;
    let snapshot: DeploymentSnapshot | undefined;
    try {
      await prisma.optimizedDeployment.update({ where: { id: jobId }, data: { status: 'RUNNING', heartbeatAt: new Date() } });
      await prisma.optimizedService.update({ where: { id: service.id }, data: { deploymentStatus: 'PREFLIGHT', currentStep: 'PREFLIGHT', lastError: null } });
      const input = this.normalizeInput(service as any);
      const jobResult = parseJson<any>(job.resultJson, {});
      const confirmed = new Set<string>(jobResult.confirmed || []);
      const context = await this.credentials.getCloudflareContext(service.userId, service.dnsCredentialId);
      if (job.operation === 'DELETE' && !service.tunnelId) {
        await prisma.optimizedService.update({ where: { id: service.id }, data: { deploymentStatus: 'DELETED', currentStep: 'DELETED', healthStatus: 'UNKNOWN', lockToken: null, lockExpiresAt: null } });
        await prisma.optimizedDeployment.update({ where: { id: jobId }, data: { status: 'SUCCEEDED', currentStep: 'DELETED', resultJson: safeJson({ deleteMode: jobResult.deleteMode || 'restore', cleaned: false }), heartbeatAt: new Date() } });
        return;
      }
      const records = await context.cfService.getDNSRecords(service.zoneId);
      const managedNames = [service.hostname, service.intermediateHostname].filter(Boolean).map(normalizeHostname);
      const businessRecords = records.filter((record: any) => managedNames.includes(normalizeHostname(record.name)));
      let tunnelConfig: any;
      if (service.tunnelId) {
        try { tunnelConfig = extractTunnelConfig(await context.cfService.getTunnelConfig(context.accountId, service.tunnelId)); }
        catch (error: any) { if (Number(error?.status || error?.statusCode) !== 404) throw error; }
      }
      const fallback = await context.cfService.getFallbackOriginDetails(service.zoneId);
      const custom = service.customHostnameId ? await context.cfService.getCustomHostname(service.zoneId, service.customHostnameId) : null;
      snapshot = { version: 1, capturedAt: new Date().toISOString(), dns: businessRecords.map((record: any) => ({ id: record.id, type: record.type, name: record.name, content: record.content, ttl: record.ttl, proxied: record.proxied })), tunnel: tunnelConfig ? { id: service.tunnelId || undefined, accountId: context.accountId, config: tunnelConfig } : undefined, fallbackOrigin: fallback, customHostname: { id: service.customHostnameId || undefined, existed: !!custom, hostnameStatus: custom?.status, sslStatus: custom?.ssl?.status }, validationRecordIds: [] };
      await prisma.optimizedDeployment.update({ where: { id: jobId }, data: { snapshotJson: safeJson(snapshot) } });
      await this.appendLog(jobId, { step: 'PREFLIGHT', message: '预检查通过，Snapshot 已保存' });

      const zoneConfig = await prisma.cloudflareOptimizedZoneConfig.findUnique({ where: { userId_dnsCredentialId_zoneId: { userId: service.userId, dnsCredentialId: service.dnsCredentialId, zoneId: service.zoneId } } });
      let tunnelId = service.tunnelId || zoneConfig?.tunnelId || undefined;
      let tunnelName = service.tunnelName;
      const managed = parseJson<any>(service.managedResourcesJson, {});
      if (!tunnelId) {
        await this.appendLog(jobId, { step: 'PREPARING_TUNNEL', message: '创建同 Zone 共享 Tunnel' });
        const tunnel = await context.cfService.createTunnel(context.accountId, `${service.zoneName}-optimized`);
        tunnelId = tunnel.id;
        tunnelName = tunnel.name;
        managed.tunnelCreated = true;
        await prisma.optimizedService.update({ where: { id: service.id }, data: { tunnelId, tunnelName, managedResourcesJson: safeJson(managed) } });
        // A newly-created remotely-managed Tunnel has no configuration until
        // the first PUT. Seed a valid ingress now so the continuation task can
        // read it even before a connector comes online.
        await context.cfService.updateTunnelConfig(context.accountId, tunnelId, {
          ingress: [
            { hostname: service.hostname, service: service.serviceUrl },
            { service: 'http_status:404' },
          ],
        });
        const token = await context.cfService.getTunnelToken(context.accountId, tunnelId).catch(() => '');
        await this.provisionConnectorToken(tunnelId, token);
        await prisma.optimizedDeployment.update({ where: { id: jobId }, data: { status: 'WAITING_CONFIRMATION', currentStep: 'WAITING_CONFIRMATION', pendingConfirmationJson: safeJson({ kind: 'TUNNEL_CONNECTION_REQUIRED', tunnelId, message: '请先启动新 Tunnel Connector，再继续部署' }) } });
        await prisma.optimizedService.update({ where: { id: service.id }, data: { deploymentStatus: 'WAITING_CONFIRMATION', currentStep: 'WAITING_CONFIRMATION', lastError: 'Connector 正在自动启动，连接成功后请重新检查' } });
        return;
      }
      const selectedTunnel = await context.cfService.getTunnel(context.accountId, tunnelId).catch(() => null);
      if (!selectedTunnel || !Array.isArray(selectedTunnel.connections) || selectedTunnel.connections.length === 0) {
        const token = await context.cfService.getTunnelToken(context.accountId, tunnelId).catch(() => '');
        await this.provisionConnectorToken(tunnelId, token);
        throw new ConfirmationRequiredError('TUNNEL_CONNECTION_REQUIRED', { tunnelId, message: 'Connector 正在自动启动；连接成功后点击“重新检查连接”继续' }, 'Tunnel 尚未连接');
      }
      const connectorToken = await context.cfService.getTunnelToken(context.accountId, tunnelId).catch(() => '');
      await this.provisionConnectorToken(tunnelId, connectorToken);
      if (zoneConfig?.tunnelId && zoneConfig.tunnelId !== tunnelId && !confirmed.has('ZONE_TUNNEL_CONFLICT')) {
        throw new ConfirmationRequiredError('ZONE_TUNNEL_CONFLICT', { existingTunnelId: zoneConfig.tunnelId, requestedTunnelId: tunnelId }, '同一 Zone 已绑定另一个共享 Tunnel');
      }
      await prisma.optimizedService.update({ where: { id: service.id }, data: { deploymentStatus: 'TUNNEL_READY', currentStep: 'TUNNEL_READY' } });
      const tunnelService = new TunnelPublicHostnameService(context.cfService);
      if (job.operation === 'DELETE') {
        const deleteMode = String(jobResult.deleteMode || 'restore');
        const currentRecords = await context.cfService.getDNSRecords(service.zoneId);
        const businessRecord = currentRecords.find((record: any) => normalizeHostname(record.name) === service.hostname && String(record.type).toUpperCase() === 'CNAME');
        if (deleteMode !== 'record') {
          const target = `${tunnelId}.cfargotunnel.com`;
          if (businessRecord?.id) await context.cfService.updateDNSRecord(service.zoneId, businessRecord.id, { type: 'CNAME', name: service.hostname, content: target, ttl: 1, proxied: true });
          else await context.cfService.createDNSRecord(service.zoneId, { type: 'CNAME', name: service.hostname, content: target, ttl: 1, proxied: true });
        }
        if (deleteMode === 'cleanup') {
          await tunnelService.removeIngress({ accountId: context.accountId, tunnelId, hostname: service.hostname }).catch(() => undefined);
          if (service.customHostnameId) await context.cfService.deleteCustomHostname(service.zoneId, service.customHostnameId).catch(() => undefined);
          for (const id of managed.validationRecordIds || []) await context.cfService.deleteDNSRecord(service.zoneId, id).catch(() => undefined);
          if (service.intermediateHostname) {
            for (const record of currentRecords.filter((item: any) => normalizeHostname(item.name) === service.intermediateHostname)) await context.cfService.deleteDNSRecord(service.zoneId, record.id).catch(() => undefined);
          }
          if (jobResult.cleanupZone === true) {
            const otherCount = await prisma.optimizedService.count({ where: { userId: service.userId, dnsCredentialId: service.dnsCredentialId, zoneId: service.zoneId, id: { not: service.id }, deploymentStatus: { not: 'DELETED' } } });
            if (otherCount === 0) {
              await context.cfService.deleteFallbackOrigin(service.zoneId).catch(() => undefined);
              const config = await prisma.cloudflareOptimizedZoneConfig.findUnique({ where: { userId_dnsCredentialId_zoneId: { userId: service.userId, dnsCredentialId: service.dnsCredentialId, zoneId: service.zoneId } } });
              if (config) await prisma.cloudflareOptimizedZoneConfig.delete({ where: { id: config.id } });
            }
          }
        }
        await prisma.optimizedService.update({ where: { id: service.id }, data: { deploymentStatus: 'DELETED', currentStep: 'DELETED', healthStatus: 'UNKNOWN', lockToken: null, lockExpiresAt: null } });
        await prisma.optimizedDeployment.update({ where: { id: jobId }, data: { status: 'SUCCEEDED', currentStep: 'DELETED', resultJson: safeJson({ deleteMode, cleaned: deleteMode === 'cleanup' }), heartbeatAt: new Date() } });
        return;
      }
      try {
        await tunnelService.ensureIngress({ accountId: context.accountId, tunnelId, hostname: service.hostname, service: service.serviceUrl });
      } catch (error: any) {
        if (error?.code === 'INGRESS_CONFLICT' && !confirmed.has('INGRESS_CONFLICT')) throw new ConfirmationRequiredError('INGRESS_CONFLICT', error.details || {}, error.message);
        if (error?.code === 'INGRESS_CONFLICT') {
          const raw = await context.cfService.getTunnelConfig(context.accountId, tunnelId);
          const config = extractTunnelConfig(raw);
          if (!config) throw error;
          config.ingress = ensureTunnelFallbackRule((config.ingress || []).filter((rule: any) => normalizeHostname(rule?.hostname) !== service.hostname));
          await context.cfService.updateTunnelConfig(context.accountId, tunnelId, config);
          await tunnelService.ensureIngress({ accountId: context.accountId, tunnelId, hostname: service.hostname, service: service.serviceUrl });
        } else throw error;
      }
      const beforeTunnelDns = businessRecords.find((record: any) => normalizeHostname(record.name) === service.hostname);
      const tunnelTarget = `${tunnelId}.cfargotunnel.com`;
      if (beforeTunnelDns && String(beforeTunnelDns.type).toUpperCase() !== 'CNAME') throw new ConfirmationRequiredError('DNS_CONFLICT', { records: businessRecords }, '业务 hostname 存在非 CNAME 记录');
      if (beforeTunnelDns && normalizeHostname(beforeTunnelDns.content) !== normalizeHostname(tunnelTarget) && !confirmed.has('DNS_CONFLICT')) {
        throw new ConfirmationRequiredError('DNS_CONFLICT', { records: businessRecords, requested: tunnelTarget }, '业务 hostname 已指向其他目标');
      }
      await context.cfService.upsertTunnelCnameRecord(service.zoneId, service.hostname, tunnelId);
      await this.appendLog(jobId, { step: 'TUNNEL_READY', message: 'Tunnel ingress 与业务 CNAME 已就绪' });

      const fallbackHostname = `fallback.${service.zoneName}`;
      if (!fallback.origin) {
        await context.cfService.upsertTunnelCnameRecord(service.zoneId, fallbackHostname, tunnelId);
        await context.cfService.updateFallbackOrigin(service.zoneId, fallbackHostname);
      } else if (normalizeHostname(fallback.origin) !== fallbackHostname && fallback.origin !== service.hostname) {
        if (!confirmed.has('FALLBACK_ORIGIN_CONFLICT')) throw new ConfirmationRequiredError('FALLBACK_ORIGIN_CONFLICT', { existing: fallback.origin, requested: fallbackHostname }, 'Zone 已存在不同 Fallback Origin');
        await context.cfService.updateFallbackOrigin(service.zoneId, fallbackHostname);
      }
      const fallbackDeadline = Date.now() + Number(process.env.OPTIMIZED_FALLBACK_TIMEOUT_MS || 300_000);
      let fallbackStatus = await context.cfService.getFallbackOriginDetails(service.zoneId);
      while (fallbackStatus.status !== 'active' && Date.now() < fallbackDeadline) {
        await new Promise(resolve => setTimeout(resolve, Number(process.env.OPTIMIZED_POLL_INTERVAL_MS || 10_000)));
        fallbackStatus = await context.cfService.getFallbackOriginDetails(service.zoneId);
      }
      if (fallbackStatus.status !== 'active') throw Object.assign(new Error('Fallback Origin 激活超时'), { code: 'FALLBACK_ACTIVATION_TIMEOUT', status: 504 });
      await prisma.cloudflareOptimizedZoneConfig.upsert({
        where: { userId_dnsCredentialId_zoneId: { userId: service.userId, dnsCredentialId: service.dnsCredentialId, zoneId: service.zoneId } },
        create: { userId: service.userId, dnsCredentialId: service.dnsCredentialId, accountId: context.accountId, zoneId: service.zoneId, zoneName: service.zoneName, fallbackHostname, fallbackStatus: 'ACTIVE', tunnelId, tunnelName },
        update: { accountId: context.accountId, zoneName: service.zoneName, fallbackHostname, fallbackStatus: 'ACTIVE', tunnelId, tunnelName },
      });
      await prisma.optimizedService.update({ where: { id: service.id }, data: { deploymentStatus: 'FALLBACK_READY', currentStep: 'FALLBACK_READY' } });

      let customHostnameId = service.customHostnameId;
      if (!customHostnameId) {
        const existingCustom = await context.cfService.getCustomHostnameByHostname(service.zoneId, service.hostname);
        const created = existingCustom || await context.cfService.createCustomHostnameWithTxt(service.zoneId, service.hostname, fallbackHostname);
        customHostnameId = created.id;
        managed.customHostnameCreated = !existingCustom;
        await prisma.optimizedService.update({ where: { id: service.id }, data: { customHostnameId, managedResourcesJson: safeJson(managed) } });
      }
      await prisma.optimizedService.update({ where: { id: service.id }, data: { deploymentStatus: 'WAITING_SSL_ACTIVE', currentStep: 'WAITING_SSL_ACTIVE', managedResourcesJson: safeJson(managed) } });
      const sslDeadline = Date.now() + Number(process.env.OPTIMIZED_SSL_TIMEOUT_MS || 600_000);
      let customStatus: any = null;
      let dynamicCreated = 0;
      while (Date.now() < sslDeadline) {
        customStatus = await context.cfService.getCustomHostname(service.zoneId, customHostnameId);
        dynamicCreated += await this.ensureDynamicValidation(context.cfService, service, customStatus, managed, snapshot, confirmed);
        await prisma.optimizedService.update({ where: { id: service.id }, data: { managedResourcesJson: safeJson(managed) } });
        if (customStatus?.ssl?.status === 'active') break;
        await new Promise(resolve => setTimeout(resolve, Number(process.env.OPTIMIZED_POLL_INTERVAL_MS || 10_000)));
      }
      await this.appendLog(jobId, { step: 'CREATING_VALIDATION_RECORDS', message: `动态验证记录已就绪（新建 ${dynamicCreated} 条）` });
      if (customStatus?.ssl?.status !== 'active') throw Object.assign(new Error('Custom Hostname SSL 激活超时'), { code: 'SSL_ACTIVATION_TIMEOUT', status: 504 });

      if (input.preferredTarget) await validatePreferredTarget(input.preferredTarget);
      const desiredMode = job.operation === 'SWITCH_DEFAULT' ? 'DEFAULT' : job.operation === 'SWITCH_PREFERRED' ? 'PREFERRED' : input.mode;
      if (desiredMode === 'PREFERRED' && !input.preferredTarget) throw Object.assign(new Error('切换优选缺少 preferredTarget'), { code: 'INVALID_PREFERRED_TARGET', status: 400 });
      if (desiredMode === 'PREFERRED' && input.preferredTarget) {
        const preferredHealth = await this.health.checkSavedHostname(service.hostname, service.healthCheckPath, input.preferredTarget);
        if (!preferredHealth.ok) throw Object.assign(new Error(`preferred target HTTPS 预检失败：${preferredHealth.error || preferredHealth.status}`), { code: 'HTTPS_HEALTH_CHECK_FAILED', status: 502 });
      }
      if (desiredMode === 'PREFERRED' && input.intermediateEnabled && input.intermediateHostname) {
        const intermediate = (await context.cfService.getDNSRecords(service.zoneId)).find((record: any) => normalizeHostname(record.name) === input.intermediateHostname);
        if (intermediate && String(intermediate.type).toUpperCase() !== 'CNAME') throw new ConfirmationRequiredError('DNS_CONFLICT', { record: intermediate }, '中间 hostname 存在非 CNAME 冲突');
        if (intermediate?.id) await context.cfService.updateDNSRecord(service.zoneId, intermediate.id, { type: 'CNAME', name: input.intermediateHostname, content: input.preferredTarget!, ttl: 60, proxied: false });
        else await context.cfService.createDNSRecord(service.zoneId, { type: 'CNAME', name: input.intermediateHostname, content: input.preferredTarget!, ttl: 60, proxied: false });
      }
      const target = desiredMode === 'PREFERRED' ? (input.intermediateEnabled ? input.intermediateHostname! : input.preferredTarget!) : `${tunnelId}.cfargotunnel.com`;
      await prisma.optimizedService.update({ where: { id: service.id }, data: { deploymentStatus: 'SWITCHING_DNS', currentStep: 'SWITCHING_DNS' } });
      const currentRecords = await context.cfService.getDNSRecords(service.zoneId);
      const current = currentRecords.find((record: any) => normalizeHostname(record.name) === service.hostname && String(record.type).toUpperCase() === 'CNAME');
      const proxied = desiredMode === 'DEFAULT';
      if (current) await context.cfService.updateDNSRecord(service.zoneId, current.id, { type: 'CNAME', name: service.hostname, content: target, ttl: proxied ? 1 : 60, proxied });
      else await context.cfService.createDNSRecord(service.zoneId, { type: 'CNAME', name: service.hostname, content: target, ttl: proxied ? 1 : 60, proxied });
      await prisma.optimizedService.update({ where: { id: service.id }, data: { deploymentStatus: 'VERIFYING', currentStep: 'VERIFYING', mode: desiredMode, preferredTarget: input.preferredTarget } });
      const hostnameDeadline = Date.now() + Number(process.env.OPTIMIZED_HOSTNAME_TIMEOUT_MS || 600_000);
      while (Date.now() < hostnameDeadline) {
        const latestCustom = await context.cfService.getCustomHostname(service.zoneId, customHostnameId);
        if (latestCustom?.status === 'active' && latestCustom?.ssl?.status === 'active') break;
        await new Promise(resolve => setTimeout(resolve, Number(process.env.OPTIMIZED_POLL_INTERVAL_MS || 10_000)));
      }
      const finalCustom = await context.cfService.getCustomHostname(service.zoneId, customHostnameId);
      if (finalCustom?.status !== 'active' || finalCustom?.ssl?.status !== 'active') {
        throw Object.assign(new Error('切换后 Custom Hostname 或 SSL 未达到 active'), { code: 'HOSTNAME_ACTIVATION_TIMEOUT', status: 504 });
      }
      const health = await this.health.checkSavedHostname(service.hostname, service.healthCheckPath);
      if (!health.ok) throw Object.assign(new Error(health.error || 'HTTPS 健康检查失败'), { code: 'HTTPS_HEALTH_CHECK_FAILED', status: 502 });
      await prisma.optimizedService.update({ where: { id: service.id }, data: { deploymentStatus: 'ACTIVE', currentStep: 'ACTIVE', healthStatus: 'HEALTHY', lastHealthCheckAt: new Date(health.checkedAt), lastError: null, lockToken: null, lockExpiresAt: null } });
      await prisma.optimizedDeployment.update({ where: { id: jobId }, data: { status: 'SUCCEEDED', currentStep: 'ACTIVE', resultJson: safeJson({ health, tunnelId, customHostnameId }), heartbeatAt: new Date() } });
    } catch (error: any) {
      if (error instanceof ConfirmationRequiredError) {
        await this.appendLog(jobId, { step: 'WAITING_CONFIRMATION', message: error.message, details: error.details }).catch(() => undefined);
        await prisma.optimizedDeployment.update({ where: { id: jobId }, data: { status: 'WAITING_CONFIRMATION', currentStep: 'WAITING_CONFIRMATION', pendingConfirmationJson: safeJson({ kind: error.kind, ...error.details }), heartbeatAt: new Date() } }).catch(() => undefined);
        await prisma.optimizedService.update({ where: { id: service.id }, data: { deploymentStatus: 'WAITING_CONFIRMATION', currentStep: 'WAITING_CONFIRMATION', lastError: error.message } }).catch(() => undefined);
        return;
      }
      const details = errorDetails(error);
      await prisma.optimizedDeployment.update({ where: { id: jobId }, data: { status: 'FAILED', currentStep: 'FAILED', errorCode: details.code, errorMessage: details.message, heartbeatAt: new Date(), snapshotJson: snapshot ? safeJson(snapshot) : undefined } }).catch(() => undefined);
      await prisma.optimizedService.update({ where: { id: service.id }, data: { deploymentStatus: 'ROLLING_BACK', currentStep: 'ROLLING_BACK', lastError: details.message } }).catch(() => undefined);
      if (snapshot) {
        try {
          const context = await this.credentials.getCloudflareContext(service.userId, service.dnsCredentialId);
          const result = await this.rollback.restore(service, context.cfService, context.accountId, snapshot);
          await prisma.optimizedDeployment.update({ where: { id: jobId }, data: { status: result.failures.length ? 'ROLLBACK_FAILED' : 'ROLLED_BACK', currentStep: result.failures.length ? 'ROLLBACK_FAILED' : 'ROLLED_BACK', resultJson: safeJson(result), errorCode: result.failures.length ? 'ROLLBACK_FAILED' : details.code } }).catch(() => undefined);
          await prisma.optimizedService.update({ where: { id: service.id }, data: { deploymentStatus: result.failures.length ? 'ROLLBACK_FAILED' : 'ROLLED_BACK', currentStep: result.failures.length ? 'ROLLBACK_FAILED' : 'ROLLED_BACK' } }).catch(() => undefined);
        } catch (rollbackError: any) {
          await prisma.optimizedDeployment.update({ where: { id: jobId }, data: { status: 'ROLLBACK_FAILED', currentStep: 'ROLLBACK_FAILED', errorCode: 'ROLLBACK_FAILED', errorMessage: rollbackError?.message || String(rollbackError) } }).catch(() => undefined);
          await prisma.optimizedService.update({ where: { id: service.id }, data: { deploymentStatus: 'ROLLBACK_FAILED', currentStep: 'ROLLBACK_FAILED' } }).catch(() => undefined);
        }
      } else {
        await prisma.optimizedService.update({ where: { id: service.id }, data: { deploymentStatus: 'FAILED', currentStep: 'FAILED', lockToken: null, lockExpiresAt: null } }).catch(() => undefined);
      }
    } finally {
      await prisma.optimizedService.updateMany({ where: { id: service.id, lockToken }, data: { lockToken: null, lockExpiresAt: null } }).catch(() => undefined);
    }
  }
}

export const optimizedDeploymentService = new OptimizedDeploymentService();
