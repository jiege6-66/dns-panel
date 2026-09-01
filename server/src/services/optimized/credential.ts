import { PrismaClient } from '@prisma/client';
import { CloudflareService } from '../cloudflare';
import { decrypt } from '../../utils/encryption';

export class OptimizedCredentialService {
  constructor(private readonly prisma: PrismaClient) {}

  async getCloudflareContext(userId: number, credentialId: number): Promise<{
    credential: any;
    cfService: CloudflareService;
    accountId: string;
  }> {
    if (!Number.isInteger(credentialId)) throw Object.assign(new Error('无效的 Cloudflare 凭证 ID'), { status: 400 });
    const credential = await this.prisma.dnsCredential.findFirst({
      where: { id: credentialId, userId, provider: 'cloudflare' },
    });
    if (!credential) throw Object.assign(new Error('Cloudflare 凭证不存在或无权访问'), { status: 404 });
    let secrets: any;
    try { secrets = JSON.parse(decrypt(credential.secrets)); } catch {
      throw Object.assign(new Error('Cloudflare 凭证解析失败'), { status: 400 });
    }
    if (!secrets?.apiToken) throw Object.assign(new Error('Cloudflare 凭证缺少 API Token'), { status: 400 });
    const cfService = new CloudflareService(String(secrets.apiToken));
    const accountId = String(credential.accountId || '').trim() || await cfService.getDefaultAccountId();
    if (!accountId) throw Object.assign(new Error('缺少 Cloudflare Account ID，请检查账户读取权限'), { status: 403 });
    return { credential, cfService, accountId };
  }
}
