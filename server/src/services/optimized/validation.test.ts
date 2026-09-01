import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertHealthPath, assertHostname, assertPreferredTarget, assertServiceUrl,
  cidrContains, isPrivateAddress, resolveCnameChain,
} from './validation';

test('validates hostname, health path and local service URL inputs', () => {
  assert.equal(assertHostname('App.Example.COM.'), 'app.example.com');
  assert.equal(assertHealthPath('/health/live'), '/health/live');
  assert.equal(assertServiceUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.throws(() => assertHostname('bad_host.example.com'), /格式不正确/);
  assert.throws(() => assertHealthPath('https://example.com/'), /只能是/);
  assert.throws(() => assertHealthPath('/health?token=x'), /不能包含/);
  assert.throws(() => assertServiceUrl('file:///etc/passwd'), /HTTP\/HTTPS/);
  assert.throws(() => assertPreferredTarget('127.0.0.1'), /合法 hostname/);
});
test('blocks private, loopback, link-local and reserved addresses', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.2.3', '192.168.1.2', '169.254.1.1', '::1', 'fd00::1', 'fe80::1']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress('104.16.1.1'), false);
  assert.equal(isPrivateAddress('2606:4700::1111'), false);
});

test('matches Cloudflare IPv4 and IPv6 CIDR ranges', () => {
  assert.equal(cidrContains('104.16.0.0/13', '104.17.8.9'), true);
  assert.equal(cidrContains('104.16.0.0/13', '8.8.8.8'), false);
  assert.equal(cidrContains('2606:4700::/32', '2606:4700::1111'), true);
  assert.equal(cidrContains('2606:4700::/32', '2001:4860:4860::8888'), false);
});

test('resolves bounded CNAME chains and rejects loops', async () => {
  const lookup: any = {
    async resolveCname(name: string) {
      if (name === 'cdn.example.com') return ['edge.example.net'];
      if (name === 'edge.example.net') return [];
      return [];
    },
    async resolve4(name: string) { return name === 'edge.example.net' ? ['104.17.1.1'] : []; },
    async resolve6() { return []; },
  };
  assert.deepEqual(await resolveCnameChain('cdn.example.com', lookup), {
    chain: ['cdn.example.com', 'edge.example.net'], addresses: ['104.17.1.1'],
  });
  const loop: any = {
    async resolveCname(name: string) { return [name === 'a.example.com' ? 'b.example.com' : 'a.example.com']; },
    async resolve4() { return []; }, async resolve6() { return []; },
  };
  await assert.rejects(() => resolveCnameChain('a.example.com', loop), /存在循环/);
});
