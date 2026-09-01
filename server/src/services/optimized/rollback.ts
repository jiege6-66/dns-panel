import { PrismaClient } from '@prisma/client';
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

    if (managed.tunnelCreated && service.tunnelId) {
      try {
        await cloudflare.deleteTunnel(accountId, service.tunnelId);
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
