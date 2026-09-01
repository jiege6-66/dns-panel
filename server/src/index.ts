import express from 'express';
import cors from 'cors';
import path from 'path';
import { config, validateConfig } from './config';
import { requestLogger } from './middleware/logger';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';

// 导入路由
import authRoutes from './routes/auth';
import hostnameRoutes from './routes/hostnames';
import logRoutes from './routes/logs';
// 新增：多提供商路由
import dnsCredentialRoutes from './routes/dnsCredentials';
import dnsRecordRoutes from './routes/dnsRecords';
import aliyunEsaRoutes from './routes/aliyunEsa';
import domainExpiryRoutes from './routes/domainExpiry';
import tunnelRoutes from './routes/tunnels';
import { startDomainExpiryScheduler } from './jobs/domainExpiryScheduler';
import certificateCredentialRoutes from './routes/certificateCredentials';
import certificateRoutes from './routes/certificates';
import certificateDeployRoutes from './routes/certificateDeploy';
import vendorCertificateRoutes from './routes/vendorCertificates';
import certificateAliasesRoutes from './routes/certificateAliases';
import { startCertificateOrderScheduler } from './jobs/certificateOrderScheduler';
import { startCertificateRenewalScheduler } from './jobs/certificateRenewalScheduler';
import { startVendorCertificateScheduler } from './jobs/vendorCertificateScheduler';
import { startCertificateDeployScheduler } from './jobs/certificateDeployScheduler';
import optimizedServicesRoutes from './routes/optimizedServices';
import optimizedDeploymentsRoutes from './routes/optimizedDeployments';
import { startOptimizedDeploymentScheduler } from './jobs/optimizedDeploymentScheduler';

// 验证配置
validateConfig();

const app = express();

// 中间件
app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger);

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API 路由
app.use('/api/auth', authRoutes);
app.use('/api/dns-credentials', dnsCredentialRoutes); // 新版多提供商凭证
app.use('/api/dns-records', dnsRecordRoutes);        // 新版多提供商 DNS 路由
app.use('/api/aliyun-esa', aliyunEsaRoutes);         // 阿里云 ESA 站点管理
app.use('/api/hostnames', hostnameRoutes);
app.use('/api/tunnels', tunnelRoutes);
app.use('/api/logs', logRoutes);
app.use('/api/domain-expiry', domainExpiryRoutes);
app.use('/api/certificate-credentials', certificateCredentialRoutes);
app.use('/api/certificates', certificateRoutes);
app.use('/api/certificate-deploy', certificateDeployRoutes);
app.use('/api/vendor-certificates', vendorCertificateRoutes);
app.use('/api/certificate-aliases', certificateAliasesRoutes);
app.use('/api/optimized-services', optimizedServicesRoutes);
app.use('/api/optimized-deployments', optimizedDeploymentsRoutes);

// 静态文件服务 (生产环境)
// 在 Docker 中，前端构建产物将被复制到 /app/public
// 服务器代码在 /app/dist，所以 __dirname 是 /app/dist
// path.join(__dirname, '../public') 将指向 /app/public
if (process.env.NODE_ENV === 'production') {
  const staticDir = path.join(__dirname, '../public');
  app.use(express.static(staticDir));
  
  // SPA 回退处理：非 API 请求返回 index.html
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) {
      return next();
    }
    res.sendFile(path.join(staticDir, 'index.html'));
  });
}

// 错误处理
app.use(notFoundHandler);
app.use(errorHandler);

// 启动服务器
app.listen(config.port, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║   Cloudflare DNS Manager API Server                  ║
║                                                       ║
║   环境: ${config.nodeEnv.padEnd(43)}║
║   端口: ${config.port.toString().padEnd(43)}║
║   CORS: ${config.corsOrigin.padEnd(43)}║
║                                                       ║
║   服务器已启动: http://localhost:${config.port.toString().padEnd(18)}║
╚═══════════════════════════════════════════════════════╝
  `);

  startDomainExpiryScheduler();
  startCertificateOrderScheduler();
  startCertificateRenewalScheduler();
  startVendorCertificateScheduler();
  startCertificateDeployScheduler();
  startOptimizedDeploymentScheduler();
});

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('收到 SIGTERM 信号，正在关闭服务器...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n收到 SIGINT 信号，正在关闭服务器...');
  process.exit(0);
});
