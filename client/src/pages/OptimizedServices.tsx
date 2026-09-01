import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert, Box, Button, Card, CardActions, CardContent, Chip, CircularProgress, Dialog, DialogActions,
  DialogContent, DialogTitle, Divider, FormControl, FormControlLabel, InputLabel, MenuItem, Select,
  Stack, Switch, TextField, Typography,
} from '@mui/material';
import { Add as AddIcon, HealthAndSafety as HealthIcon, RocketLaunch as DeployIcon, Restore as RestoreIcon } from '@mui/icons-material';
import { useProvider } from '@/contexts/ProviderContext';
import { getDomains } from '@/services/domains';
import {
  createOptimizedService, deployOptimizedService, getOptimizedDeployments, getOptimizedServices,
  healthCheckOptimizedService, removeOptimizedService, switchOptimizedDefault, switchOptimizedPreferred,
  preflightOptimizedService, OptimizedInput, OptimizedService, continueOptimizedDeployment, rollbackOptimizedDeployment,
} from '@/services/optimizedServices';
import { formatDateTime } from '@/utils/formatters';

const statusLabel: Record<string, string> = {
  DRAFT: '草稿', PREFLIGHT: '预检查', WAITING_CONFIRMATION: '待确认', PREPARING_TUNNEL: '准备 Tunnel',
  TUNNEL_READY: 'Tunnel 就绪', FALLBACK_READY: 'Fallback 就绪', WAITING_SSL_ACTIVE: '等待 SSL',
  SWITCHING_DNS: '切换 DNS', VERIFYING: '验证中', ACTIVE: '已激活', FAILED: '失败', ROLLED_BACK: '已回滚', ROLLBACK_FAILED: '回滚失败',
};

function CreateOptimizedServiceDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (input: OptimizedInput) => void }) {
  const { credentials } = useProvider();
  const [input, setInput] = useState<OptimizedInput>({ name: '', dnsCredentialId: 0, zoneId: '', hostname: '', serviceUrl: '', mode: 'DEFAULT', healthCheckPath: '/', intermediateEnabled: false });
  const cfCredentials = credentials.filter(item => item.provider === 'cloudflare');
  const zonesQuery = useQuery({ queryKey: ['optimized-zones', input.dnsCredentialId], queryFn: () => getDomains(input.dnsCredentialId), enabled: input.dnsCredentialId > 0 });
  const zones = zonesQuery.data?.data?.domains || [];
  const [preflight, setPreflight] = useState<any>(null);
  const [submitting, setSubmitting] = useState(false);
  const set = (key: keyof OptimizedInput, value: unknown) => setInput(prev => ({ ...prev, [key]: value }));
  const submit = async () => {
    setSubmitting(true);
    try {
      const result = await preflightOptimizedService(input);
      setPreflight(result.data);
      if (!result.data?.canDeploy) return;
      onCreated(input);
      onClose();
    } finally { setSubmitting(false); }
  };
  return <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
    <DialogTitle>创建优选服务</DialogTitle>
    <DialogContent>
      <Stack spacing={2} sx={{ pt: 1 }}>
        <TextField label="名称" value={input.name} onChange={e => set('name', e.target.value)} required />
        <FormControl fullWidth><InputLabel>Cloudflare 凭证</InputLabel><Select value={input.dnsCredentialId || ''} label="Cloudflare 凭证" onChange={e => set('dnsCredentialId', Number(e.target.value))}>{cfCredentials.map(item => <MenuItem key={item.id} value={item.id}>{item.name}</MenuItem>)}</Select></FormControl>
        <FormControl fullWidth><InputLabel>Zone</InputLabel><Select value={input.zoneId || ''} label="Zone" onChange={e => { const zone = zones.find(item => item.id === e.target.value); set('zoneId', e.target.value); set('zoneName', zone?.name); }}>{zones.map(item => <MenuItem key={item.id} value={item.id}>{item.name}</MenuItem>)}</Select></FormControl>
        <TextField label="访问域名" placeholder="app.example.com" value={input.hostname} onChange={e => set('hostname', e.target.value)} required />
        <TextField label="本地服务 URL" placeholder="http://127.0.0.1:8080" value={input.serviceUrl} onChange={e => set('serviceUrl', e.target.value)} required />
        <FormControl fullWidth><InputLabel>模式</InputLabel><Select value={input.mode} label="模式" onChange={e => set('mode', e.target.value)}><MenuItem value="DEFAULT">Cloudflare 默认</MenuItem><MenuItem value="PREFERRED">preferredTarget</MenuItem></Select></FormControl>
        {input.mode === 'PREFERRED' && <TextField label="preferredTarget" placeholder="cdn.example.net" value={input.preferredTarget || ''} onChange={e => set('preferredTarget', e.target.value)} required />}
        <FormControlLabel control={<Switch checked={!!input.intermediateEnabled} onChange={e => set('intermediateEnabled', e.target.checked)} />} label="使用中间 CNAME" />
        {input.intermediateEnabled && <TextField label="中间 CNAME hostname" value={input.intermediateHostname || ''} onChange={e => set('intermediateHostname', e.target.value)} required />}
        <TextField label="健康检查 Path" value={input.healthCheckPath || '/'} onChange={e => set('healthCheckPath', e.target.value)} />
        {preflight && <Alert severity={preflight.canDeploy ? 'success' : 'warning'}>{preflight.canDeploy ? '预检查通过，可以创建服务' : '预检查未通过，请修复以下项目'}<Stack sx={{ mt: 1 }}>{(preflight.checks || []).map((check: any) => <Typography variant="body2" key={check.name}>{check.ok ? '✓' : '✕'} {check.name}: {check.message}</Typography>)}</Stack></Alert>}
      </Stack>
    </DialogContent>
    <DialogActions><Button onClick={onClose}>取消</Button><Button variant="contained" onClick={submit} disabled={submitting}>{submitting ? <CircularProgress size={20} /> : '预检查并创建'}</Button></DialogActions>
  </Dialog>;
}

function OptimizedServiceCard({ service, onRefresh }: { service: OptimizedService; onRefresh: () => void }) {
  const [alert, setAlert] = useState<string>('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const deployments = useQuery({ queryKey: ['optimized-deployments', service.id], queryFn: () => getOptimizedDeployments(service.id), enabled: service.deploymentStatus !== 'DRAFT' });
  const action = async (fn: () => Promise<unknown>) => { try { await fn(); onRefresh(); } catch (error) { setAlert(String(error)); } };
  const latest = deployments.data?.data?.deployments?.[0];
  return <Card sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
    <CardContent sx={{ flexGrow: 1 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}><Box><Typography variant="h6">{service.name}</Typography><Typography variant="body2" color="text.secondary">{service.hostname}</Typography></Box><Chip size="small" label={statusLabel[service.deploymentStatus] || service.deploymentStatus} color={service.deploymentStatus === 'ACTIVE' ? 'success' : service.deploymentStatus.includes('FAILED') || service.deploymentStatus === 'FAILED' ? 'error' : 'default'} /></Stack>
      <Divider sx={{ my: 2 }} />
      <Stack spacing={0.75} sx={{ fontSize: 14 }}><Typography variant="body2"><b>DNS：</b>{service.mode === 'PREFERRED' ? 'DNS only → preferredTarget' : '橙云 Tunnel CNAME'}</Typography><Typography variant="body2"><b>Tunnel：</b>{service.tunnelName || service.tunnelId || '部署时创建'}</Typography><Typography variant="body2"><b>Custom Hostname：</b>{service.customHostnameId || '未创建'}</Typography><Typography variant="body2"><b>SSL：</b>{service.currentStep === 'WAITING_SSL_ACTIVE' ? '等待 active' : service.deploymentStatus === 'ACTIVE' ? 'active' : '—'}</Typography><Typography variant="body2"><b>HTTPS：</b>{service.healthStatus === 'HEALTHY' ? '健康' : service.healthStatus === 'UNHEALTHY' ? '失败' : '未检查'}</Typography><Typography variant="body2"><b>更新时间：</b>{formatDateTime(service.updatedAt)}</Typography></Stack>
      {service.lastError && <Alert severity="error" sx={{ mt: 2 }}>{service.lastError}</Alert>}
      {latest?.status === 'WAITING_CONFIRMATION' && <Alert severity="warning" sx={{ mt: 2 }}>任务需要人工确认：{latest.pendingConfirmationJson ? JSON.stringify(JSON.parse(latest.pendingConfirmationJson)) : '存在动态配置冲突'}<Stack direction="row" spacing={1} sx={{ mt: 1 }}><Button size="small" variant="contained" onClick={() => action(() => continueOptimizedDeployment(latest.id, 'replace'))}>备份并替换</Button><Button size="small" onClick={() => action(() => continueOptimizedDeployment(latest.id, 'cancel'))}>取消</Button></Stack></Alert>}
      {alert && <Alert severity="error" sx={{ mt: 2 }} onClose={() => setAlert('')}>{alert}</Alert>}
    </CardContent>
    <CardActions sx={{ flexWrap: 'wrap', gap: 0.5 }}><Button size="small" startIcon={<DeployIcon />} onClick={() => action(() => deployOptimizedService(service.id))} disabled={service.deploymentStatus === 'WAITING_SSL_ACTIVE'}>部署</Button><Button size="small" startIcon={<HealthIcon />} onClick={() => action(() => healthCheckOptimizedService(service.id))}>健康检查</Button><Button size="small" onClick={() => action(() => switchOptimizedPreferred(service.id))}>切换优选</Button><Button size="small" onClick={() => action(() => switchOptimizedDefault(service.id))}>恢复默认</Button>{latest && <Button size="small" color="warning" startIcon={<RestoreIcon />} onClick={() => action(() => rollbackOptimizedDeployment(latest.id))}>回滚</Button>}<Button size="small" color="error" onClick={() => setConfirmOpen(true)}>移除</Button></CardActions>
    <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}><DialogTitle>移除优选服务？</DialogTitle><DialogContent>默认只移除面板记录，不会删除 Cloudflare 资源。</DialogContent><DialogActions><Button onClick={() => setConfirmOpen(false)}>取消</Button><Button color="error" onClick={() => action(() => removeOptimizedService(service.id, 'record'))}>移除记录</Button></DialogActions></Dialog>
  </Card>;
}

export default function OptimizedServices() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const query = useQuery({ queryKey: ['optimized-services'], queryFn: getOptimizedServices, refetchInterval: 10_000 });
  const create = useMutation({ mutationFn: createOptimizedService, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['optimized-services'] }) });
  const services = query.data?.data?.services || [];
  const error = query.error ? String(query.error) : create.error ? String(create.error) : '';
  return <Box sx={{ maxWidth: 1600, mx: 'auto' }}><Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ sm: 'center' }} spacing={2} sx={{ mb: 3 }}><Box><Typography variant="h4" fontWeight={800}>优选服务</Typography><Typography color="text.secondary">同 Zone Cloudflare Tunnel + Custom Hostname 异步部署</Typography></Box><Button variant="contained" startIcon={<AddIcon />} onClick={() => setCreateOpen(true)}>新建服务</Button></Stack>{error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}{query.isLoading ? <CircularProgress /> : services.length ? <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)', xl: 'repeat(3, 1fr)' }, gap: 2 }}>{services.map(service => <OptimizedServiceCard key={service.id} service={service} onRefresh={() => queryClient.invalidateQueries({ queryKey: ['optimized-services'] })} />)}</Box> : <Card><CardContent><Typography color="text.secondary">还没有优选服务。请先配置 Cloudflare 凭证。</Typography></CardContent></Card>}<CreateOptimizedServiceDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={input => create.mutate(input)} /></Box>;
}
