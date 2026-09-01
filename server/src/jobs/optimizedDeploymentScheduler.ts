import { PrismaClient } from '@prisma/client';
import { optimizedDeploymentService } from '../services/optimized/deployment';

const prisma = new PrismaClient();
let timer: NodeJS.Timeout | undefined;
let running = false;

export function startOptimizedDeploymentScheduler(intervalMs = Number(process.env.OPTIMIZED_DEPLOYMENT_SCHEDULER_INTERVAL_MS || 15_000)): void {
  if (timer) return;
  void optimizedDeploymentService.recoverInterrupted().catch(() => undefined);
  void optimizedDeploymentService.provisionPendingConnectors().catch(() => undefined);
  const process = async () => {
    if (running) return;
    running = true;
    try {
      await optimizedDeploymentService.provisionPendingConnectors().catch(() => 0);
      const jobs = await prisma.optimizedDeployment.findMany({ where: { status: 'QUEUED' }, orderBy: { createdAt: 'asc' }, take: 10 });
      for (const job of jobs) await optimizedDeploymentService.processQueued(job.id).catch(() => undefined);
    } finally { running = false; }
  };
  timer = setInterval(() => void process(), Math.max(5_000, intervalMs));
  void process();
}

export function stopOptimizedDeploymentScheduler(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
