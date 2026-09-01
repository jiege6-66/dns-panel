import { Router, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { dnsLimiter } from '../middleware/rateLimit';
import { AuthRequest } from '../types';
import { successResponse } from '../utils/response';
import { optimizedDeploymentService } from '../services/optimized/deployment';

const router = Router();
router.use(authenticateToken);

const idOf = (value: unknown): number => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('无效的部署任务 ID'), { status: 400 });
  return id;
};

const sendError = (res: Response, error: any): Response => res.status(Number(error?.status || 400)).json({
  success: false,
  message: error?.message || String(error),
  error: { code: error?.code || 'CLOUDFLARE_ERROR', step: error?.step, details: error?.details || {} },
});

router.post('/:id/continue', dnsLimiter, async (req: AuthRequest, res) => {
  try {
    const decision = req.body?.decision === 'cancel' ? 'cancel' : 'replace';
    const deployment = await optimizedDeploymentService.continue(req.user!.id, idOf(req.params.id), decision);
    return successResponse(res, { deployment }, decision === 'cancel' ? '已取消部署' : '部署任务已继续', decision === 'cancel' ? 200 : 202);
  } catch (error: any) { return sendError(res, error); }
});

router.post('/:id/rollback', dnsLimiter, async (req: AuthRequest, res) => {
  try { return successResponse(res, { deployment: await optimizedDeploymentService.rollbackDeployment(req.user!.id, idOf(req.params.id)) }, '回滚完成'); }
  catch (error: any) { return sendError(res, error); }
});

export default router;
