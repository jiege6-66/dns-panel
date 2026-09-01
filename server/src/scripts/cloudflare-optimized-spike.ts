import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { isIP } from 'net';
import { promises as dns } from 'dns';
import { randomBytes } from 'crypto';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import path from 'path';
import dotenv from 'dotenv';

for (const candidate of [
  path.resolve(process.cwd(), '.env.local'),
  path.resolve(process.cwd(), '../.env.local'),
]) {
  dotenv.config({ path: candidate, override: false });
}

const API_BASE = 'https://api.cloudflare.com/client/v4';
const POLL_INTERVAL_MS = Number(process.env.CF_SPIKE_POLL_INTERVAL_MS || 10_000);
const FALLBACK_TIMEOUT_MS = Number(process.env.CF_SPIKE_FALLBACK_TIMEOUT_MS || 300_000);
const SSL_TIMEOUT_MS = Number(process.env.CF_SPIKE_SSL_TIMEOUT_MS || 600_000);
const HOSTNAME_TIMEOUT_MS = Number(process.env.CF_SPIKE_HOSTNAME_TIMEOUT_MS || 600_000);

type JsonMap = Record<string, any>;
type DnsRecord = { id: string; type: string; name: string; content: string };

class CloudflareApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errors: unknown[],
  ) {
    super(message);
  }
}

function requiredEnv(name: string): string {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeHostname(value: unknown): string {
  return String(value || '').trim().toLowerCase().replace(/\.+$/, '');
}

function normalizeDnsContent(value: unknown): string {
  return String(value || '').trim().replace(/^"|"$/g, '').toLowerCase().replace(/\.+$/, '');
}

async function cfRequest(
  token: string,
  route: string,
  init: RequestInit = {},
  options: { allow404?: boolean } = {},
): Promise<any> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${API_BASE}${route}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(init.headers || {}),
        },
      });
    } catch (error) {
      if (attempt === 5) throw error;
      await sleep(Math.min(2 ** attempt * 1_000, 15_000));
      continue;
    }

    const payload: JsonMap = await response.json().catch(() => ({}));
    if (response.ok && payload.success !== false) return payload.result ?? payload;
    if (response.status === 404 && options.allow404) return null;

    if ((response.status === 429 || response.status >= 500) && attempt < 5) {
      const retryAfter = Number(response.headers.get('retry-after') || 0) * 1_000;
      await sleep(retryAfter || Math.min(2 ** attempt * 1_000, 15_000));
      continue;
    }

    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    const message = errors[0]?.message || payload.message || response.statusText || 'Cloudflare API 请求失败';
    throw new CloudflareApiError(String(message), response.status, errors);
  }
  throw new Error('Cloudflare API 重试次数耗尽');
}

async function poll<T>(
  label: string,
  timeoutMs: number,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  describe: (value: T) => string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastDescription = '';
  while (Date.now() < deadline) {
    const value = await read();
    const description = describe(value);
    if (description !== lastDescription) {
      console.log(`[spike] ${label}: ${description}`);
      lastDescription = description;
    }
    if (done(value)) return value;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`${label} 超时（最后状态：${lastDescription || 'unknown'}）`);
}

function startOrigin(marker: string): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ marker, host: req.headers.host, path: req.url }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('无法获取临时 Origin 监听端口'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

function startCloudflared(containerName: string, tunnelToken: string): ChildProcess {
  const child = spawn('docker', [
    'run', '--rm', '--network', 'host', '--name', containerName,
    'cloudflare/cloudflared:latest',
    'tunnel', '--no-autoupdate', 'run', '--token', tunnelToken,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.resume();
  child.stderr?.resume();
  return child;
}

function stopCloudflared(containerName: string): void {
  spawnSync('docker', ['stop', '--time', '5', containerName], { stdio: 'ignore' });
}

async function waitForTunnelConnection(token: string, accountId: string, tunnelId: string): Promise<any> {
  return poll(
    'Tunnel 连接',
    180_000,
    () => cfRequest(token, `/accounts/${accountId}/cfd_tunnel/${tunnelId}`),
    value => Array.isArray(value?.connections) && value.connections.length > 0,
    value => `${value?.status || 'unknown'} / connections=${value?.connections?.length || 0}`,
  );
}

function collectValidationRecords(customHostname: JsonMap): Array<{ type: 'TXT' | 'CNAME'; name: string; content: string }> {
  const output: Array<{ type: 'TXT' | 'CNAME'; name: string; content: string }> = [];
  const ownership = customHostname?.ownership_verification;
  if (ownership?.name && ownership?.value) {
    output.push({
      type: String(ownership.type || 'TXT').toUpperCase() === 'CNAME' ? 'CNAME' : 'TXT',
      name: ownership.name,
      content: ownership.value,
    });
  }

  const delegationRecords = customHostname?.ssl?.dcv_delegation_records || [];
  for (const record of delegationRecords) {
    const name = record?.cname || record?.name;
    const content = record?.cname_target || record?.target;
    if (name && content) output.push({ type: 'CNAME', name, content });
  }

  // Cloudflare can return short-lived TXT validation values and a persistent
  // DCV delegation CNAME for the same _acme-challenge name. DNS forbids a
  // CNAME from coexisting with TXT, so delegation is the preferred path when
  // Cloudflare offers it; TXT is the fallback when it does not.
  if (delegationRecords.length === 0) {
    for (const record of customHostname?.ssl?.validation_records || []) {
      if (record?.txt_name && record?.txt_value) {
        output.push({ type: 'TXT', name: record.txt_name, content: record.txt_value });
      }
    }
  }

  const unique = new Map<string, { type: 'TXT' | 'CNAME'; name: string; content: string }>();
  for (const record of output) {
    unique.set(`${record.type}:${normalizeHostname(record.name)}:${normalizeDnsContent(record.content)}`, record);
  }
  return [...unique.values()];
}

async function ensureValidationRecord(
  token: string,
  zoneId: string,
  record: { type: 'TXT' | 'CNAME'; name: string; content: string },
): Promise<{ record: DnsRecord; created: boolean }> {
  const query = new URLSearchParams({ name: record.name, per_page: '100' });
  const existing = await cfRequest(token, `/zones/${zoneId}/dns_records?${query.toString()}`);
  const matches = Array.isArray(existing) ? existing : [];
  const same = matches.find(item => normalizeDnsContent(item.content) === normalizeDnsContent(record.content));
  if (same) return { record: same, created: false };
  const cnameConflict = matches.some(item => String(item.type).toUpperCase() === 'CNAME');
  if (record.type === 'CNAME' ? matches.length > 0 : cnameConflict) {
    throw new Error(`验证记录冲突：${record.type} ${record.name}`);
  }
  const created = await cfRequest(token, `/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify({ ...record, ttl: 60 }),
  });
  return { record: created, created: true };
}

async function waitForSslAndEnsureDynamicRecords(
  token: string,
  zoneId: string,
  customHostnameId: string,
  createdRecordIds: string[],
): Promise<any> {
  const deadline = Date.now() + SSL_TIMEOUT_MS;
  let lastDescription = '';
  while (Date.now() < deadline) {
    const customHostname = await cfRequest(token, `/zones/${zoneId}/custom_hostnames/${customHostnameId}`);
    const records = collectValidationRecords(customHostname);
    let createdNow = 0;
    for (const record of records) {
      const ensured = await ensureValidationRecord(token, zoneId, record);
      if (ensured.created && !createdRecordIds.includes(ensured.record.id)) {
        createdRecordIds.push(ensured.record.id);
        createdNow += 1;
      }
    }
    const description = `hostname=${customHostname?.status || 'unknown'} ssl=${customHostname?.ssl?.status || 'unknown'} records=${records.length}`;
    if (description !== lastDescription || createdNow > 0) {
      console.log(`[spike] SSL/DCV: ${description}${createdNow ? ` created=${createdNow}` : ''}`);
      lastDescription = description;
    }
    if (customHostname?.ssl?.status === 'active') return customHostname;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`SSL 激活（切换前）超时（最后状态：${lastDescription || 'unknown'}）`);
}

function ipv4ToBigInt(address: string): bigint {
  return address.split('.').reduce((value, part) => (value << 8n) + BigInt(Number(part)), 0n);
}

function ipv6ToBigInt(address: string): bigint {
  let input = address.toLowerCase().split('%')[0];
  const ipv4Match = input.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Match) {
    const ipv4 = ipv4ToBigInt(ipv4Match[1]);
    input = `${input.slice(0, ipv4Match.index)}${((ipv4 >> 16n) & 0xffffn).toString(16)}:${(ipv4 & 0xffffn).toString(16)}`;
  }
  const [leftRaw, rightRaw = ''] = input.split('::');
  const left = leftRaw ? leftRaw.split(':').filter(Boolean) : [];
  const right = rightRaw ? rightRaw.split(':').filter(Boolean) : [];
  const fill = Array(Math.max(0, 8 - left.length - right.length)).fill('0');
  const parts = input.includes('::') ? [...left, ...fill, ...right] : left;
  if (parts.length !== 8) throw new Error(`无效 IPv6 地址：${address}`);
  return parts.reduce((value, part) => (value << 16n) + BigInt(`0x${part || '0'}`), 0n);
}

function cidrContains(cidr: string, address: string): boolean {
  const [network, prefixRaw] = cidr.trim().split('/');
  const family = isIP(address);
  if (!family || isIP(network) !== family) return false;
  const bits = family === 4 ? 32 : 128;
  const prefix = Number(prefixRaw);
  const value = family === 4 ? ipv4ToBigInt(address) : ipv6ToBigInt(address);
  const base = family === 4 ? ipv4ToBigInt(network) : ipv6ToBigInt(network);
  const shift = BigInt(bits - prefix);
  return (value >> shift) === (base >> shift);
}

async function resolvePreferredTarget(target: string): Promise<{ chain: string[]; addresses: string[] }> {
  const chain = [normalizeHostname(target)];
  for (let depth = 0; depth < 12; depth += 1) {
    let cnames: string[];
    try {
      cnames = await dns.resolveCname(chain[chain.length - 1]);
    } catch (error: any) {
      if (['ENODATA', 'ENOTFOUND'].includes(error?.code)) break;
      throw error;
    }
    if (!cnames.length) break;
    const next = normalizeHostname(cnames[0]);
    if (!next || chain.includes(next)) throw new Error('preferred target CNAME 链存在循环');
    chain.push(next);
  }
  if (chain.length >= 12) throw new Error('preferred target CNAME 链过长');
  const final = chain[chain.length - 1];
  const [v4, v6] = await Promise.all([
    dns.resolve4(final).catch((error: any) => error?.code === 'ENODATA' ? [] : Promise.reject(error)),
    dns.resolve6(final).catch((error: any) => ['ENODATA', 'ENOTFOUND'].includes(error?.code) ? [] : Promise.reject(error)),
  ]);
  const addresses = [...v4, ...v6];
  if (!addresses.length) throw new Error('preferred target 最终没有 A/AAAA 地址');
  return { chain, addresses };
}

async function assertCloudflareAddresses(addresses: string[]): Promise<void> {
  const [v4Text, v6Text] = await Promise.all([
    fetch('https://www.cloudflare.com/ips-v4').then(response => response.text()),
    fetch('https://www.cloudflare.com/ips-v6').then(response => response.text()),
  ]);
  const ranges = `${v4Text}\n${v6Text}`.split(/\s+/).filter(value => value.includes('/'));
  const invalid = addresses.filter(address => !ranges.some(cidr => cidrContains(cidr, address)));
  if (invalid.length) throw new Error(`preferred target 包含非 Cloudflare 官方 IP：${invalid.join(', ')}`);
}

function httpsProbe(connectHostname: string, businessHostname: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      hostname: connectHostname,
      port: 443,
      path: '/',
      method: 'GET',
      servername: businessHostname,
      rejectUnauthorized: true,
      headers: {
        Host: businessHostname,
        'User-Agent': 'dns-panel-optimized-spike/1.0',
      },
      timeout: 15_000,
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', chunk => {
        if (size >= 64 * 1024) return;
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        chunks.push(buffer);
      });
      response.on('end', () => resolve({
        status: response.statusCode || 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('timeout', () => request.destroy(new Error('HTTPS 请求超时')));
    request.on('error', reject);
    request.end();
  });
}

async function pollHttps(
  label: string,
  connectHostname: string,
  businessHostname: string,
  marker: string,
  timeoutMs: number,
): Promise<void> {
  await poll(
    label,
    timeoutMs,
    async () => {
      try {
        return await httpsProbe(connectHostname, businessHostname);
      } catch (error: any) {
        return { status: 0, body: '', error: error?.message || String(error) };
      }
    },
    result => {
      if (![200, 201, 202, 204, 301, 302, 307, 308, 401, 403].includes(result.status)) return false;
      try {
        const body = JSON.parse(result.body);
        return body.marker === marker && normalizeHostname(body.host) === normalizeHostname(businessHostname);
      } catch {
        return false;
      }
    },
    result => result.status
      ? `HTTP ${result.status}`
      : `error=${'error' in result ? result.error : 'unknown'}`,
  );
}

async function main(): Promise<void> {
  const token = requiredEnv('CLOUDFLARE_API_TOKEN');
  const accountId = requiredEnv('CF_SPIKE_ACCOUNT_ID');
  const zoneId = requiredEnv('CF_SPIKE_ZONE_ID');
  const zoneName = normalizeHostname(requiredEnv('CF_SPIKE_ZONE_NAME'));
  const preferredTarget = normalizeHostname(requiredEnv('CF_SPIKE_PREFERRED_TARGET'));
  if (process.env.CF_SPIKE_ALLOW_MUTATION !== 'true') {
    throw new Error('CF_SPIKE_ALLOW_MUTATION 必须显式设为 true');
  }

  const runId = `${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
  const businessHostname = `codex-opt-${runId}.${zoneName}`;
  const fallbackHostname = `codex-fallback-${runId}.${zoneName}`;
  const tunnelName = `codex-opt-spike-${runId}`;
  const containerName = `cf-opt-spike-${runId}`;
  const marker = `dns-panel-spike-${runId}`;

  let originServer: Server | undefined;
  let cloudflared: ChildProcess | undefined;
  let tunnelId = '';
  let customHostnameId = '';
  let businessRecordId = '';
  let fallbackRecordId = '';
  let previousFallback: JsonMap | null = null;
  const createdValidationRecordIds: string[] = [];
  let succeeded = false;

  console.log(`[spike] run=${runId}`);
  console.log(`[spike] business=${businessHostname}`);
  console.log(`[spike] fallback=${fallbackHostname}`);

  try {
    const zone = await cfRequest(token, `/zones/${zoneId}`);
    if (normalizeHostname(zone?.name) !== zoneName || zone?.account?.id !== accountId || zone?.status !== 'active') {
      throw new Error('测试 Zone 与配置不匹配或未激活');
    }
    previousFallback = await cfRequest(
      token,
      `/zones/${zoneId}/custom_hostnames/fallback_origin`,
      {},
      { allow404: true },
    );

    const resolved = await resolvePreferredTarget(preferredTarget);
    await assertCloudflareAddresses(resolved.addresses);
    console.log(`[spike] preferred CNAME chain=${resolved.chain.join(' -> ')}`);
    console.log(`[spike] preferred addresses are within Cloudflare ranges (${resolved.addresses.length})`);

    const origin = await startOrigin(marker);
    originServer = origin.server;
    console.log(`[spike] temporary origin listening on 127.0.0.1:${origin.port}`);

    const tunnelSecret = randomBytes(32).toString('base64');
    const tunnel = await cfRequest(token, `/accounts/${accountId}/cfd_tunnel`, {
      method: 'POST',
      body: JSON.stringify({ name: tunnelName, tunnel_secret: tunnelSecret }),
    });
    tunnelId = tunnel.id;
    console.log(`[spike] Tunnel created id=${tunnelId}`);

    await cfRequest(token, `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
      method: 'PUT',
      body: JSON.stringify({
        config: {
          ingress: [
            { hostname: fallbackHostname, service: `http://127.0.0.1:${origin.port}` },
            { hostname: businessHostname, service: `http://127.0.0.1:${origin.port}` },
            { service: 'http_status:404' },
          ],
        },
      }),
    });

    const tunnelToken = await cfRequest(token, `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`);
    if (typeof tunnelToken !== 'string' || !tunnelToken) throw new Error('未取得 Tunnel Token');
    cloudflared = startCloudflared(containerName, tunnelToken);
    await waitForTunnelConnection(token, accountId, tunnelId);

    const tunnelTarget = `${tunnelId}.cfargotunnel.com`;
    const fallbackRecord = await cfRequest(token, `/zones/${zoneId}/dns_records`, {
      method: 'POST',
      body: JSON.stringify({ type: 'CNAME', name: fallbackHostname, content: tunnelTarget, proxied: true, ttl: 1 }),
    });
    fallbackRecordId = fallbackRecord.id;
    const businessRecord = await cfRequest(token, `/zones/${zoneId}/dns_records`, {
      method: 'POST',
      body: JSON.stringify({ type: 'CNAME', name: businessHostname, content: tunnelTarget, proxied: true, ttl: 1 }),
    });
    businessRecordId = businessRecord.id;
    console.log('[spike] Tunnel ingress and proxied CNAME records ready');

    await cfRequest(token, `/zones/${zoneId}/custom_hostnames/fallback_origin`, {
      method: 'PUT',
      body: JSON.stringify({ origin: fallbackHostname }),
    });
    await poll(
      'Fallback Origin',
      FALLBACK_TIMEOUT_MS,
      () => cfRequest(token, `/zones/${zoneId}/custom_hostnames/fallback_origin`),
      value => value?.status === 'active',
      value => `${value?.status || 'unknown'} (${value?.origin || 'no origin'})`,
    );

    const custom = await cfRequest(token, `/zones/${zoneId}/custom_hostnames`, {
      method: 'POST',
      body: JSON.stringify({ hostname: businessHostname, ssl: { method: 'txt', type: 'dv' } }),
    });
    customHostnameId = custom.id;
    console.log(`[spike] Custom Hostname created id=${customHostnameId}`);

    await waitForSslAndEnsureDynamicRecords(
      token,
      zoneId,
      customHostnameId,
      createdValidationRecordIds,
    );
    console.log(`[spike] dynamic Ownership/SSL/DCV records ensured (${createdValidationRecordIds.length} created)`);

    await pollHttps(
      'preferred target SNI/Host HTTPS 预检',
      preferredTarget,
      businessHostname,
      marker,
      180_000,
    );

    await cfRequest(token, `/zones/${zoneId}/dns_records/${businessRecordId}`, {
      method: 'PUT',
      body: JSON.stringify({
        type: 'CNAME',
        name: businessHostname,
        content: preferredTarget,
        proxied: false,
        ttl: 60,
      }),
    });
    console.log('[spike] business DNS switched to preferred target (DNS only)');

    await poll(
      'Hostname/SSL 激活（切换后）',
      HOSTNAME_TIMEOUT_MS,
      () => cfRequest(token, `/zones/${zoneId}/custom_hostnames/${customHostnameId}`),
      value => value?.status === 'active' && value?.ssl?.status === 'active',
      value => `hostname=${value?.status || 'unknown'} ssl=${value?.ssl?.status || 'unknown'}`,
    );

    await pollHttps('最终 HTTPS / Fallback → Tunnel / Host', businessHostname, businessHostname, marker, 180_000);
    succeeded = true;
    console.log('[spike] PASS: same-zone O2O topology, SSL, DNS switch and original Host routing verified');
  } finally {
    console.log('[spike] cleaning temporary resources');
    if (customHostnameId) {
      await cfRequest(token, `/zones/${zoneId}/custom_hostnames/${customHostnameId}`, { method: 'DELETE' }, { allow404: true }).catch(() => undefined);
    }
    for (const recordId of createdValidationRecordIds.reverse()) {
      await cfRequest(token, `/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' }, { allow404: true }).catch(() => undefined);
    }
    if (previousFallback?.origin) {
      await cfRequest(token, `/zones/${zoneId}/custom_hostnames/fallback_origin`, {
        method: 'PUT',
        body: JSON.stringify({ origin: previousFallback.origin }),
      }).catch(() => undefined);
    } else {
      await cfRequest(token, `/zones/${zoneId}/custom_hostnames/fallback_origin`, { method: 'DELETE' }, { allow404: true }).catch(() => undefined);
    }
    for (const recordId of [businessRecordId, fallbackRecordId]) {
      if (recordId) {
        for (let attempt = 0; attempt < 5; attempt += 1) {
          try {
            await cfRequest(token, `/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' }, { allow404: true });
            break;
          } catch {
            if (attempt === 4) break;
            await sleep(2_000);
          }
        }
      }
    }
    if (cloudflared) stopCloudflared(containerName);
    if (tunnelId) {
      await cfRequest(token, `/accounts/${accountId}/cfd_tunnel/${tunnelId}`, { method: 'DELETE' }, { allow404: true }).catch(() => undefined);
    }
    await new Promise<void>(resolve => originServer ? originServer.close(() => resolve()) : resolve());
    console.log('[spike] cleanup complete');
  }

  if (!succeeded) throw new Error('Spike 未通过');
}

main().catch(error => {
  const status = error instanceof CloudflareApiError ? ` (HTTP ${error.status})` : '';
  console.error(`[spike] FAIL${status}: ${error?.message || String(error)}`);
  process.exitCode = 1;
});
