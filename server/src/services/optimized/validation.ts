import { promises as dns } from 'dns';
import { isIP } from 'net';
import { URL } from 'url';
import { PreferredTargetResult } from './types';

export const normalizeHostname = (value: unknown): string =>
  String(value || '').trim().replace(/^\*\./, '').replace(/\.+$/, '').toLowerCase();

const hostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function assertHostname(value: unknown, field = 'hostname'): string {
  const hostname = normalizeHostname(value);
  if (!hostnamePattern.test(hostname) || hostname.includes('..')) {
    throw Object.assign(new Error(`${field} 格式不正确`), { code: 'INVALID_HOSTNAME', status: 400 });
  }
  return hostname;
}
export function assertHealthPath(value: unknown): string {
  const path = String(value || '/').trim();
  if (!/^\/(?:[^?#]*)$/.test(path) || path.length > 512) {
    throw Object.assign(new Error('健康检查 Path 只能是 /xxx 形式，不能包含查询参数或片段'), { code: 'INVALID_HEALTH_PATH', status: 400 });
  }
  return path || '/';
}

export function assertServiceUrl(value: unknown): string {
  const raw = String(value || '').trim();
  let parsed: URL;
  try { parsed = new URL(raw); } catch {
    throw Object.assign(new Error('本地服务 URL 格式不正确'), { code: 'INVALID_SERVICE_URL', status: 400 });
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    throw Object.assign(new Error('本地服务 URL 仅支持带主机名的 HTTP/HTTPS 地址'), { code: 'INVALID_SERVICE_URL', status: 400 });
  }
  return raw;
}

export function assertPreferredTarget(value: unknown): string {
  const target = normalizeHostname(value);
  if (!hostnamePattern.test(target) || isIP(target)) {
    throw Object.assign(new Error('preferredTarget 必须是合法 hostname，不能直接使用 IP'), { code: 'INVALID_PREFERRED_TARGET', status: 400 });
  }
  return target;
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19)) ||
      a >= 224;
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') ||
      normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
      normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('ff');
  }
  return true;
}

function ipv4ToBigInt(address: string): bigint {
  return address.split('.').reduce((value, part) => (value << 8n) + BigInt(Number(part)), 0n);
}

function ipv6ToBigInt(address: string): bigint {
  const input = address.toLowerCase().split('%')[0];
  const [leftRaw, rightRaw = ''] = input.split('::');
  const left = leftRaw ? leftRaw.split(':').filter(Boolean) : [];
  const right = rightRaw ? rightRaw.split(':').filter(Boolean) : [];
  const parts = input.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  if (parts.length !== 8) return 0n;
  return parts.reduce((value, part) => (value << 16n) + BigInt(`0x${part || '0'}`), 0n);
}

export function cidrContains(cidr: string, address: string): boolean {
  const [network, prefixRaw] = cidr.split('/');
  const family = isIP(address);
  if (!family || isIP(network) !== family) return false;
  const bits = family === 4 ? 32 : 128;
  const prefix = Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return false;
  const value = family === 4 ? ipv4ToBigInt(address) : ipv6ToBigInt(address);
  const base = family === 4 ? ipv4ToBigInt(network) : ipv6ToBigInt(network);
  return (value >> BigInt(bits - prefix)) === (base >> BigInt(bits - prefix));
}

export async function resolveCnameChain(target: string, lookup = dns): Promise<{ chain: string[]; addresses: string[] }> {
  const chain = [assertPreferredTarget(target)];
  for (let depth = 0; depth < 12; depth += 1) {
    let cnames: string[] = [];
    try { cnames = await lookup.resolveCname(chain[chain.length - 1]); } catch (error: any) {
      if (!['ENODATA', 'ENOTFOUND'].includes(error?.code)) throw error;
    }
    if (!cnames.length) break;
    const next = normalizeHostname(cnames[0]);
    if (!next || chain.includes(next)) throw Object.assign(new Error('preferredTarget CNAME 链存在循环'), { code: 'INVALID_PREFERRED_TARGET', status: 400 });
    chain.push(next);
  }
  if (chain.length >= 12) throw Object.assign(new Error('preferredTarget CNAME 链过长'), { code: 'INVALID_PREFERRED_TARGET', status: 400 });
  const final = chain[chain.length - 1];
  const [v4, v6] = await Promise.all([
    lookup.resolve4(final).catch((error: any) => error?.code === 'ENODATA' ? [] : Promise.reject(error)),
    lookup.resolve6(final).catch((error: any) => ['ENODATA', 'ENOTFOUND'].includes(error?.code) ? [] : Promise.reject(error)),
  ]);
  const addresses = [...v4, ...v6];
  if (!addresses.length) throw Object.assign(new Error('preferredTarget 最终没有 A/AAAA 地址'), { code: 'INVALID_PREFERRED_TARGET', status: 400 });
  return { chain, addresses };
}

export async function loadCloudflareRanges(fetcher: typeof fetch = fetch): Promise<string[]> {
  const [v4, v6] = await Promise.all([
    fetcher('https://www.cloudflare.com/ips-v4').then(response => response.text()),
    fetcher('https://www.cloudflare.com/ips-v6').then(response => response.text()),
  ]);
  return `${v4}\n${v6}`.split(/\s+/).filter(Boolean);
}

export async function validatePreferredTarget(target: string): Promise<PreferredTargetResult> {
  const normalized = assertPreferredTarget(target);
  const resolved = await resolveCnameChain(normalized);
  if (resolved.addresses.some(isPrivateAddress)) {
    throw Object.assign(new Error('preferredTarget 解析到了私网、环回或保留地址'), { code: 'SSRF_BLOCKED', status: 400 });
  }
  const cloudflareRanges = await loadCloudflareRanges();
  const invalid = resolved.addresses.filter(address => !cloudflareRanges.some(range => cidrContains(range, address)));
  if (invalid.length) {
    throw Object.assign(new Error(`preferredTarget 最终地址不在 Cloudflare 官方 IP 段：${invalid.join(', ')}`), { code: 'PREFERRED_TARGET_NOT_CLOUDFLARE', status: 400 });
  }
  return { target: normalized, ...resolved, cloudflareRanges };
}
