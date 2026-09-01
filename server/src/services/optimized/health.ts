import { request as httpsRequest } from 'https';
import { promises as dns } from 'dns';
import { assertHealthPath, assertHostname, isPrivateAddress } from './validation';
import { HealthCheckResult } from './types';

export class OptimizedHealthService {
  constructor(private readonly timeoutMs = Number(process.env.OPTIMIZED_HEALTH_TIMEOUT_MS || 15_000)) {}

  async checkSavedHostname(
    savedHostname: string,
    healthPath: string,
    connectHostname = savedHostname,
  ): Promise<HealthCheckResult> {
    const hostname = assertHostname(savedHostname);
    const target = assertHostname(connectHostname, '连接目标');
    const path = assertHealthPath(healthPath);
    const checkedAt = new Date().toISOString();

    const addresses = await dns.lookup(target, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) {
      return { ok: false, url: `https://${hostname}${path}`, host: hostname, error: '连接目标解析到私网、环回或保留地址', checkedAt };
    }

    try {
      const status = await new Promise<number>((resolve, reject) => {
        const request = httpsRequest({
          hostname: target,
          port: 443,
          method: 'GET',
          path,
          servername: hostname,
          rejectUnauthorized: true,
          timeout: this.timeoutMs,
          headers: { Host: hostname, 'User-Agent': 'dns-panel-optimized-health/1.0' },
        }, response => {
          response.resume();
          response.once('end', () => resolve(response.statusCode || 0));
        });
        request.once('timeout', () => request.destroy(new Error('HTTPS 健康检查超时')));
        request.once('error', reject);
        request.end();
      });
      const ok = (status >= 200 && status < 400) || status === 401 || status === 403;
      return {
        ok,
        status,
        url: `https://${hostname}${path}`,
        host: hostname,
        error: ok ? undefined : `不允许的 HTTP 状态 ${status}`,
        checkedAt,
      };
    } catch (error: any) {
      return {
        ok: false,
        url: `https://${hostname}${path}`,
        host: hostname,
        error: error?.message || String(error),
        checkedAt,
      };
    }
  }
}
