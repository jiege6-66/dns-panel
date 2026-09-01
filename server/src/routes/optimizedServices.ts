import { Router, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { generalLimiter, dnsLimiter } from '../middleware/rateLimit';
import { AuthRequest } from '../types';
import { successResponse, errorResponse } from '../utils/response';
import { optimizedDeploymentService } from '../services/optimized/deployment';

const router = Router();
router.use(authenticateToken);

function idOf(value: unknown): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('无效的服务 ID'), { status: 400 });
  return id;
}

function deploymentError(res: Response, error: any): Response {
  const status = Number(error?.status || error?.statusCode || 400);
  return res.status(status).json({
    success: false,
    message: error?.message || String(error),
    error: {
      code: error?.code || 'CLOUDFLARE_ERROR',
      step: error?.step,
      details: error?.details || {},
    },
  });
}

router.get('/', generalLimiter, async (req: AuthRequest, res) => {
  try { return successResponse(res, { services: await optimizedDeploymentService.list(req.user!.id) }, '获取优选服务成功'); }
  catch (error: any) { return deploymentError(res, error); }
});

router.post('/', dnsLimiter, async (req: AuthRequest, res) => {
  try { return successResponse(res, { service: await optimizedDeploymentService.create(req.user!.id, req.body || {}) }, '创建优选服务成功', 201); }
  catch (error: any) { return deploymentError(res, error); }
});

router.post('/preflight', generalLimiter, async (req: AuthRequest, res) => {
  try { return successResponse(res, await optimizedDeploymentService.preflight(req.user!.id, req.body || {}), '预检查完成'); }
  catch (error: any) { return deploymentError(res, error); }
});

router.get('/:id', generalLimiter, async (req: AuthRequest, res) => {
  try { return successResponse(res, { service: await optimizedDeploymentService.get(req.user!.id, idOf(req.params.id)) }, '获取优选服务成功'); }
  catch (error: any) { return deploymentError(res, error); }
});

router.patch('/:id', dnsLimiter, async (req: AuthRequest, res) => {
  try { return successResponse(res, { service: await optimizedDeploymentService.update(req.user!.id, idOf(req.params.id), req.body || {}) }, '更新优选服务成功'); }
  catch (error: any) { return deploymentError(res, error); }
});

router.delete('/:id', dnsLimiter, async (req: AuthRequest, res) => {
  try {
    const service = await optimizedDeploymentService.get(req.user!.id, idOf(req.params.id));
    const mode = String(req.body?.mode || req.query.mode || 'record');
    if (mode === 'cleanup' || mode === 'restore') {
      const job = await optimizedDeploymentService.enqueue(req.user!.id, service.id, 'DELETE', `DELETE:${service.id}:${Date.now()}`, { deleteMode: mode, cleanupZone: req.body?.cleanupZone === true });
      return successResponse(res, { jobId: job.id, status: job.status }, '删除任务已排队', 202);
    }
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();
    await prisma.optimizedDeployment.deleteMany({ where: { serviceId: service.id, userId: req.user!.id } });
    await prisma.optimizedService.delete({ where: { id: service.id } });
    await prisma.$disconnect();
    return successResponse(res, null, '已移除优选服务记录');
  } catch (error: any) { return deploymentError(res, error); }
});

router.post('/:id/deploy', dnsLimiter, async (req: AuthRequest, res) => {
  try { const job = await optimizedDeploymentService.enqueue(req.user!.id, idOf(req.params.id), 'DEPLOY', req.body?.idempotencyKey); return successResponse(res, { jobId: job.id, status: job.status }, '部署任务已排队', 202); }
  catch (error: any) { return deploymentError(res, error); }
});

router.post('/:id/redeploy', dnsLimiter, async (req: AuthRequest, res) => {
  try { const job = await optimizedDeploymentService.enqueue(req.user!.id, idOf(req.params.id), 'REDEPLOY', req.body?.idempotencyKey); return successResponse(res, { jobId: job.id, status: job.status }, '重新部署任务已排队', 202); }
  catch (error: any) { return deploymentError(res, error); }
});

router.get('/:id/status', generalLimiter, async (req: AuthRequest, res) => {
  try { return successResponse(res, await optimizedDeploymentService.status(req.user!.id, idOf(req.params.id)), '获取部署状态成功'); }
  catch (error: any) { return deploymentError(res, error); }
});

router.get('/:id/deployments', generalLimiter, async (req: AuthRequest, res) => {
  try { return successResponse(res, { deployments: await optimizedDeploymentService.deployments(req.user!.id, idOf(req.params.id)) }, '获取部署历史成功'); }
  catch (error: any) { return deploymentError(res, error); }
});

router.post('/:id/health-check', generalLimiter, async (req: AuthRequest, res) => {
  try { return successResponse(res, await optimizedDeploymentService.healthCheck(req.user!.id, idOf(req.params.id)), '健康检查完成'); }
  catch (error: any) { return deploymentError(res, error); }
});

router.post('/:id/switch/preferred', dnsLimiter, async (req: AuthRequest, res) => {
  try {
    if (req.body?.preferredTarget) await optimizedDeploymentService.update(req.user!.id, idOf(req.params.id), { preferredTarget: req.body.preferredTarget, mode: 'PREFERRED' });
    const job = await optimizedDeploymentService.enqueue(req.user!.id, idOf(req.params.id), 'SWITCH_PREFERRED', req.body?.idempotencyKey);
    return successResponse(res, { jobId: job.id, status: job.status }, '切换优选任务已排队', 202);
  } catch (error: any) { return deploymentError(res, error); }
});

router.post('/:id/switch/default', dnsLimiter, async (req: AuthRequest, res) => {
  try { const job = await optimizedDeploymentService.enqueue(req.user!.id, idOf(req.params.id), 'SWITCH_DEFAULT', req.body?.idempotencyKey); return successResponse(res, { jobId: job.id, status: job.status }, '恢复 Cloudflare 默认任务已排队', 202); }
  catch (error: any) { return deploymentError(res, error); }
});

export default router;
