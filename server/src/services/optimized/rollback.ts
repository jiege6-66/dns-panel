import { PrismaClient } from '@prisma/client';
import { unlink } from 'fs/promises';
import path from 'path';
import { CloudflareService } from '../cloudflare';
import { DeploymentSnapshot, safeJson } from './types';

export class OptimizedRollbackService {
  constructor(private readonly prisma: PrismaClient) {}

  async restore(
    service: any,
    cloudflare: CloudflareService,
    accountId: string,
    snapshot: DeploymentSnapshot,
  ): Promise<{ cleaned: string[]; failures: string[] }> {
    const cleaned: string[] = [];
    const failures: string[] = [];
    const records = await cloudflare.getDNSRecords(service.zoneId);

    for (const previous of snapshot.dns || []) {
      try {
        const current = records.find((item: any) => String(item.id) === String(previous.id)) ||
          records.find((item: any) => String(item.name).toLowerCase() === String(previous.name).toLowerCase() && String(item.type).toUpperCase() === String(previous.type).toUpperCase());
        const params = {
          type: previous.type,
          name: previous.name,
          content: previous.content,
          ttl: previous.ttl || 1,
          proxied: previous.proxied === true,
        };
        if (current?.id) await cloudflare.updateDNSRecord(service.zoneId, current.id, params);
        else await cloudflare.createDNSRecord(service.zoneId, params);
        cleaned.push(`dns:${previous.name}`);
      } catch (error: any) {
        failures.push(`dns:${previous.name}: ${error?.message || String(error)}`);
      }
    }

    if (snapshot.tunnel?.config && service.tunnelId) {
      try {
        await cloudflare.updateTunnelConfig(accountId, service.tunnelId, snapshot.tunnel.config);
        cleaned.push(`tunnel:${service.tunnelId}`);
      } catch (error: any) {
        failures.push(`tunnel:${service.tunnelId}: ${error?.message || String(error)}`);
      }
    }

    const managed = service.managedResourcesJson ? JSON.parse(service.managedResourcesJson) : {};
    for (const recordId of Array.isArray(managed.dnsRecordIds) ? managed.dnsRecordIds : []) {
      if (snapshot.dns.some(record => record.id === recordId)) continue;
      try {
        await cloudflare.deleteDNSRecord(service.zoneId, recordId);
        cleaned.push(`managed-dns:${recordId}`);
      } catch (error: any) {
        if (Number(error?.status || error?.statusCode) !== 404) failures.push(`managed-dns:${recordId}: ${error?.message || String(error)}`);
      }
    }
    for (const recordId of Array.isArray(managed.validationRecordIds) ? managed.validationRecordIds : []) {
      if (snapshot.validationRecordIds.includes(recordId)) continue;
      try {
        await cloudflare.deleteDNSRecord(service.zoneId, recordId);
        cleaned.push(`validation:${recordId}`);
      } catch (error: any) {
        failures.push(`validation:${recordId}: ${error?.message || String(error)}`);
      }
    }

    if (managed.customHostnameCreated && service.customHostnameId) {
      try {
        await cloudflare.deleteCustomHostname(service.zoneId, service.customHostnameId);
        cleaned.push(`custom-hostname:${service.customHostnameId}`);
      } catch (error: any) {
        failures.push(`custom-hostname:${service.customHostnameId}: ${error?.message || String(error)}`);
      }
    }

    try {
      if (snapshot.fallbackOrigin?.origin) await cloudflare.updateFallbackOrigin(service.zoneId, snapshot.fallbackOrigin.origin);
      else await cloudflare.deleteFallbackOrigin(service.zoneId);
      cleaned.push('fallback-origin');
    } catch (error: any) {
      failures.push(`fallback-origin: ${error?.message || String(error)}`);
    }

    if (managed.tunnelCreated && service.tunnelId) {
      try {
        const tokenDir = String(process.env.OPTIMIZED_TUNNEL_TOKEN_DIR || '').trim();
        if (tokenDir) await unlink(path.join(tokenDir, `${service.tunnelId}.token`)).catch(() => undefined);
        let deleted = false;
        let lastError: any;
        for (let attempt = 0; attempt < 12; attempt += 1) {
          try {
            await cloudflare.deleteTunnel(accountId, service.tunnelId);
            deleted = true;
            break;
          } catch (error: any) {
            lastError = error;
            if (!/active connections/i.test(String(error?.message || ''))) throw error;
            await new Promise(resolve => setTimeout(resolve, 5_000));
          }
        }
        if (!deleted) throw lastError || new Error('Tunnel Connector 未及时断开');
        cleaned.push(`tunnel-resource:${service.tunnelId}`);
      } catch (error: any) {
        failures.push(`tunnel-resource:${service.tunnelId}: ${error?.message || String(error)}`);
      }
    }

    await this.prisma.optimizedService.update({
      where: { id: service.id },
      data: {
        managedResourcesJson: safeJson({ cleaned, failures }),
        lockToken: null,
        lockExpiresAt: null,
      },
    });
    return { cleaned, failures };
  }
}
