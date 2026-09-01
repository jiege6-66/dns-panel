import { CloudflareService } from './cloudflare';

const normalizeHostname = (value: unknown): string => String(value || '').trim().replace(/\.+$/, '').toLowerCase();
const isFallbackRule = (rule: any): boolean => !String(rule?.hostname || '').trim() && !String(rule?.path || '').trim();

export function extractTunnelConfig(raw: any): any | null {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.config && typeof value.config === 'object' && !Array.isArray(value.config)) return value.config;
  return ('ingress' in value || 'originRequest' in value || 'warp-routing' in value) ? value : null;
}
export function ensureTunnelFallbackRule(ingress: any[]): any[] {
  const rules = Array.isArray(ingress) ? ingress.filter(Boolean) : [];
  if (!rules.length) return [{ service: 'http_status:404' }];
  if (isFallbackRule(rules[rules.length - 1])) return rules;
  return [...rules, { service: 'http_status:404' }];
}

export class TunnelPublicHostnameService {
  constructor(private readonly cloudflare: CloudflareService) {}

  async ensureIngress(input: {
    accountId: string;
    tunnelId: string;
    hostname: string;
    service: string;
    path?: string;
  }): Promise<{ config: any; previousConfig: any; action: 'created' | 'updated' | 'unchanged' }> {
    let raw: any;
    try {
      raw = await this.cloudflare.getTunnelConfig(input.accountId, input.tunnelId);
    } catch (error: any) {
      if (Number(error?.status || error?.statusCode) !== 404) throw error;
      raw = { config: { ingress: [{ service: 'http_status:404' }] } };
    }
    const config = extractTunnelConfig(raw);
    if (!config) throw Object.assign(new Error('Tunnel 配置解析失败'), { status: 502, code: 'CLOUDFLARE_ERROR' });
    const previousConfig = JSON.parse(JSON.stringify(config));
    const ingress = Array.isArray(config.ingress) ? [...config.ingress] : [];
    const hostname = normalizeHostname(input.hostname);
    const path = String(input.path || '').trim();
    const index = ingress.findIndex((rule: any) => normalizeHostname(rule?.hostname) === hostname && String(rule?.path || '').trim() === path);
    const next = { hostname, service: input.service, ...(path ? { path } : {}) };
    let action: 'created' | 'updated' | 'unchanged' = 'created';
    if (index >= 0) {
      const current = ingress[index];
      if (String(current?.service || '') === input.service) return { config, previousConfig, action: 'unchanged' };
      if (current?.service && current.service !== input.service) {
        throw Object.assign(new Error(`Tunnel ingress 冲突：${hostname} 已指向 ${current.service}`), {
          status: 409,
          code: 'INGRESS_CONFLICT',
          details: { hostname, currentService: current.service, requestedService: input.service },
        });
      }
      ingress[index] = { ...current, ...next };
      action = 'updated';
    } else {
      const fallbackIndex = ingress.findIndex(isFallbackRule);
      ingress.splice(fallbackIndex >= 0 ? fallbackIndex : ingress.length, 0, next);
    }
    config.ingress = ensureTunnelFallbackRule(ingress);
    await this.cloudflare.updateTunnelConfig(input.accountId, input.tunnelId, config);
    return { config, previousConfig, action };
  }

  async removeIngress(input: { accountId: string; tunnelId: string; hostname: string; path?: string }): Promise<{ config: any; removed: boolean }> {
    let raw: any;
    try {
      raw = await this.cloudflare.getTunnelConfig(input.accountId, input.tunnelId);
    } catch (error: any) {
      if (Number(error?.status || error?.statusCode) !== 404) throw error;
      return { config: { ingress: [{ service: 'http_status:404' }] }, removed: false };
    }
    const config = extractTunnelConfig(raw);
    if (!config) throw Object.assign(new Error('Tunnel 配置解析失败'), { status: 502 });
    const hostname = normalizeHostname(input.hostname);
    const path = String(input.path || '').trim();
    const ingress = Array.isArray(config.ingress) ? config.ingress : [];
    const next = ingress.filter((rule: any) => !(normalizeHostname(rule?.hostname) === hostname && String(rule?.path || '').trim() === path));
    if (next.length === ingress.length) return { config, removed: false };
    config.ingress = ensureTunnelFallbackRule(next);
    await this.cloudflare.updateTunnelConfig(input.accountId, input.tunnelId, config);
    return { config, removed: true };
  }
}
