import api from './api';
import { ApiResponse } from '@/types';

export type OptimizedMode = 'DEFAULT' | 'PREFERRED';
export interface OptimizedService {
  id: number;
  userId: number;
  name: string;
  hostname: string;
  serviceUrl: string;
  dnsCredentialId: number;
  accountId: string;
  zoneId: string;
  zoneName: string;
  tunnelId?: string | null;
  tunnelName?: string | null;
  mode: OptimizedMode;
  preferredTarget?: string | null;
  intermediateEnabled: boolean;
  intermediateHostname?: string | null;
  customHostnameId?: string | null;
  deploymentStatus: string;
  currentStep?: string | null;
  healthStatus: string;
  healthCheckPath: string;
  lastError?: string | null;
  lastHealthCheckAt?: string | null;
  updatedAt: string;
}

export interface OptimizedDeployment {
  id: number;
  serviceId: number;
  operation: string;
  status: string;
  currentStep: string;
  heartbeatAt?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  snapshotJson?: string | null;
  resultJson?: string | null;
  stepLogJson?: string | null;
  pendingConfirmationJson?: string | null;
  createdAt: string;
}

export type OptimizedInput = {
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
};

export const getOptimizedServices = (): Promise<ApiResponse<{ services: OptimizedService[] }>> => api.get('/optimized-services');
export const getOptimizedService = (id: number): Promise<ApiResponse<{ service: OptimizedService }>> => api.get(`/optimized-services/${id}`);
export const createOptimizedService = (input: OptimizedInput): Promise<ApiResponse<{ service: OptimizedService }>> => api.post('/optimized-services', input);
export const updateOptimizedService = (id: number, input: Partial<OptimizedInput>): Promise<ApiResponse<{ service: OptimizedService }>> => api.patch(`/optimized-services/${id}`, input);
export const preflightOptimizedService = (input: OptimizedInput): Promise<ApiResponse<any>> => api.post('/optimized-services/preflight', input);
export const deployOptimizedService = (id: number, idempotencyKey?: string): Promise<ApiResponse<{ jobId: number; status: string }>> => api.post(`/optimized-services/${id}/deploy`, { idempotencyKey });
export const redeployOptimizedService = (id: number, idempotencyKey?: string): Promise<ApiResponse<{ jobId: number; status: string }>> => api.post(`/optimized-services/${id}/redeploy`, { idempotencyKey });
export const switchOptimizedPreferred = (id: number, preferredTarget?: string): Promise<ApiResponse<{ jobId: number; status: string }>> => api.post(`/optimized-services/${id}/switch/preferred`, { preferredTarget, idempotencyKey: `SWITCH_PREFERRED:${id}:${Date.now()}` });
export const switchOptimizedDefault = (id: number): Promise<ApiResponse<{ jobId: number; status: string }>> => api.post(`/optimized-services/${id}/switch/default`, { idempotencyKey: `SWITCH_DEFAULT:${id}:${Date.now()}` });
export const getOptimizedStatus = (id: number): Promise<ApiResponse<{ service: OptimizedService; deployment: OptimizedDeployment | null }>> => api.get(`/optimized-services/${id}/status`);
export const getOptimizedDeployments = (id: number): Promise<ApiResponse<{ deployments: OptimizedDeployment[] }>> => api.get(`/optimized-services/${id}/deployments`);
export const healthCheckOptimizedService = (id: number): Promise<ApiResponse<any>> => api.post(`/optimized-services/${id}/health-check`);
export const continueOptimizedDeployment = (id: number, decision: 'replace' | 'cancel' = 'replace'): Promise<ApiResponse<any>> => api.post(`/optimized-deployments/${id}/continue`, { decision });
export const rollbackOptimizedDeployment = (id: number): Promise<ApiResponse<any>> => api.post(`/optimized-deployments/${id}/rollback`);
export const removeOptimizedService = (id: number, mode: 'record' | 'restore' | 'cleanup' = 'record'): Promise<ApiResponse<any>> => api.delete(`/optimized-services/${id}`, { data: { mode } });
