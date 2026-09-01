import test from 'node:test';
import assert from 'node:assert/strict';
import { TunnelPublicHostnameService } from './tunnelPublicHostname';

function mockCloudflare(config: any) {
  const updates: any[] = [];
  return {
    updates,
    async getTunnelConfig() { return { config: JSON.parse(JSON.stringify(config)) }; },
    async updateTunnelConfig(_accountId: string, _tunnelId: string, next: any) { updates.push(next); return next; },
  };
}

test('adds ingress before fallback and is idempotent', async () => {
  const mock = mockCloudflare({ ingress: [{ service: 'http_status:404' }] });
  const service = new TunnelPublicHostnameService(mock as any);
  const result = await service.ensureIngress({ accountId: 'a', tunnelId: 't', hostname: 'App.Example.com', service: 'http://127.0.0.1:8080' });
  assert.equal(result.action, 'created');
  assert.equal(mock.updates[0].ingress[0].hostname, 'app.example.com');
  assert.equal(mock.updates[0].ingress[1].service, 'http_status:404');

  const idempotentMock = mockCloudflare(mock.updates[0]);
  const idempotent = await new TunnelPublicHostnameService(idempotentMock as any).ensureIngress({ accountId: 'a', tunnelId: 't', hostname: 'app.example.com', service: 'http://127.0.0.1:8080' });
  assert.equal(idempotent.action, 'unchanged');
  assert.equal(idempotentMock.updates.length, 0);
});
test('reports an ingress conflict without overwriting it', async () => {
  const mock = mockCloudflare({ ingress: [{ hostname: 'app.example.com', service: 'http://old:80' }, { service: 'http_status:404' }] });
  await assert.rejects(
    () => new TunnelPublicHostnameService(mock as any).ensureIngress({ accountId: 'a', tunnelId: 't', hostname: 'app.example.com', service: 'http://new:80' }),
    (error: any) => error.code === 'INGRESS_CONFLICT',
  );
  assert.equal(mock.updates.length, 0);
});
