export const OPTIMIZED_STEPS = [
  'DRAFT',
  'PREFLIGHT',
  'WAITING_CONFIRMATION',
  'PREPARING_TUNNEL',
  'TUNNEL_READY',
  'CONFIGURING_FALLBACK',
  'WAITING_FALLBACK',
  'FALLBACK_READY',
  'CREATING_CUSTOM_HOSTNAME',
  'CREATING_VALIDATION_RECORDS',
  'WAITING_SSL_ACTIVE',
  'SWITCHING_DNS',
  'WAITING_HOSTNAME_ACTIVE',
  'VERIFYING',
  'ACTIVE',
  'FAILED',
  'ROLLING_BACK',
  'ROLLED_BACK',
  'ROLLBACK_FAILED',
  'DELETING',
  'DELETED',
] as const;

export type OptimizedStep = typeof OPTIMIZED_STEPS[number];
export type OptimizedMode = 'DEFAULT' | 'PREFERRED';
export type OptimizedOperation = 'DEPLOY' | 'REDEPLOY' | 'SWITCH_PREFERRED' | 'SWITCH_DEFAULT' | 'ROLLBACK' | 'DELETE';

export type OptimizedErrorCode =
  | 'INVALID_HOSTNAME'
  | 'INVALID_SERVICE_URL'
  | 'INVALID_HEALTH_PATH'
  | 'INVALID_PREFERRED_TARGET'
  | 'SSRF_BLOCKED'
  | 'PREFERRED_TARGET_NOT_CLOUDFLARE'
  | 'DNS_CONFLICT'
  | 'INGRESS_CONFLICT'
  | 'SSL_ACTIVATION_TIMEOUT'
  | 'HOSTNAME_ACTIVATION_TIMEOUT'
  | 'HTTPS_HEALTH_CHECK_FAILED'
  | 'WORKFLOW_INTERRUPTED'
  | 'LOCKED'
  | 'PERMISSION_DENIED'
  | 'ROLLBACK_FAILED'
  | 'CLOUDFLARE_ERROR';

export interface OptimizedInput {
  name: string;
  dnsCredentialId: number;
  accountId?: string;
  zoneId: string;
  zoneName?: string;
  hostname: string;
  serviceUrl: string;
  tunnelId?: string;
  tunnelName?: string;
  mode?: OptimizedMode;
  preferredTarget?: string;
  intermediateEnabled?: boolean;
  intermediateHostname?: string;
  healthCheckPath?: string;
}

export interface PreferredTargetResult {
  target: string;
  chain: string[];
  addresses: string[];
  cloudflareRanges: string[];
}

export interface HealthCheckResult {
  ok: boolean;
  status?: number;
  url: string;
  host: string;
  error?: string;
  checkedAt: string;
}

export interface DeploymentSnapshot {
  version: 1;
  capturedAt: string;
  dns: Array<{ id?: string; type: string; name: string; content: string; ttl?: number; proxied?: boolean }>;
  tunnel?: { id?: string; accountId?: string; config?: unknown };
  fallbackOrigin?: { origin: string | null; status: string };
  customHostname?: { id?: string; existed: boolean; hostnameStatus?: string; sslStatus?: string };
  validationRecordIds: string[];
}

export function safeJson<T>(value: T): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item !== 'string') return item;
    if (/token|secret|private.?key|jwt|password|api.?key|authorization|cookie/i.test(_key)) return '[REDACTED]';
    if (/^(?:bearer\s+|eyj[a-z0-9_-]*\.)/i.test(item)) return '[REDACTED]';
    return item;
  });
}
