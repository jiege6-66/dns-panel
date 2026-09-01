import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert, Box, Button, Card, CardActions, CardContent, Chip, CircularProgress, Dialog, DialogActions,
  DialogContent, DialogTitle, Divider, FormControl, FormControlLabel, InputLabel, MenuItem, Select,
  Stack, Switch, TextField, Typography,
} from '@mui/material';
import { Add as AddIcon, HealthAndSafety as HealthIcon, RocketLaunch as DeployIcon, Restore as RestoreIcon } from '@mui/icons-material';
import { useProvider } from '@/contexts/ProviderContext';
import { getDomains } from '@/services/domains';
import { getTunnels } from '@/services/tunnels';
import {
  createOptimizedService, deployOptimizedService, getOptimizedDeployments, getOptimizedServices,
  healthCheckOptimizedService, removeOptimizedService, switchOptimizedDefault, switchOptimizedPreferred,
  preflightOptimizedService, OptimizedInput, OptimizedService, continueOptimizedDeployment, rollbackOptimizedDeployment, updateOptimizedService,
} from '@/services/optimizedServices';
import { formatDateTime } from '@/utils/formatters';

const statusLabel: Record<string, string> = {
  DRAFT: '草稿', PREFLIGHT: '预检查', WAITING_CONFIRMATION: '待确认', PREPARING_TUNNEL: '准备 Tunnel',
  TUNNEL_READY: 'Tunnel 就绪', FALLBACK_READY: 'Fallback 就绪', WAITING_SSL_ACTIVE: '等待 SSL',
  SWITCHING_DNS: '切换 DNS', VERIFYING: '验证中', ACTIVE: '已激活', FAILED: '失败', ROLLED_BACK: '已回滚', ROLLBACK_FAILED: '回滚失败',
};

const emptyInput = (): OptimizedInput => ({ name: '', dnsCredentialId: 0, zoneId: '', hostname: '', serviceUrl: '', mode: 'DEFAULT', healthCheckPath: '/', intermediateEnabled: false });

function CreateOptimizedServiceDialog({ open, onClose, onSaved, initial }: { open: boolean; onClose: () => void; onSaved: (input: OptimizedInput) => void; initial?: OptimizedService | null }) {
  const { credentials } = useProvider();
  const [input, setInput] = useState<OptimizedInput>(emptyInput);
  const cfCredentials = credentials.filter(item => item.provider === 'cloudflare');
  const zonesQuery = useQuery({ queryKey: ['optimized-zones', input.dnsCredentialId], queryFn: () => getDomains(input.dnsCredentialId), enabled: input.dnsCredentialId > 0 });
  const zones = zonesQuery.data?.data?.domains || [];
  const tunnelsQuery = useQuery({ queryKey: ['optimized-tunnels', input.dnsCredentialId], queryFn: () => getTunnels(input.dnsCredentialId), enabled: input.dnsCredentialId > 0 });
  const tunnels = tunnelsQuery.data?.data?.tunnels || [];
  const [preflight, setPreflight] = useState<any>(null);
  const [submitting, setSubmitting] = useState(false);
  const set = (key: keyof OptimizedInput, value: unknown) => setInput(prev => ({ ...prev, [key]: value }));
  useEffect(() => {
    if (!open) return;
    setPreflight(null);
    setInput(initial ? {
      name: initial.name, dnsCredentialId: initial.dnsCredentialId, accountId: initial.accountId,
      zoneId: initial.zoneId, zoneName: initial.zoneName, hostname: initial.hostname,
      serviceUrl: initial.serviceUrl, tunnelId: initial.tunnelId || undefined,
      tunnelName: initial.tunnelName || undefined, mode: initial.mode,
      preferredTarget: initial.preferredTarget || undefined, intermediateEnabled: initial.intermediateEnabled,
      intermediateHostname: initial.intermediateHostname || undefined, healthCheckPath: initial.healthCheckPath,
    } : emptyInput());
  }, [open, initial]);
  const submit = async () => {
    setSubmitting(true);
    try {
      const result = await preflightOptimizedService(input);
      setPreflight(result.data);
      if (!result.data?.canDeploy) return;
      onSaved(input);
      onClose();
    } finally { setSubmitting(false); }
  };
  return <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
    <DialogTitle>{initial ? '编辑优选服务' : '创建优选服务'}</DialogTitle>
    <DialogContent>
      <Stack spacing={2} sx={{ pt: 1 }}>
        <TextField label="名称" value={input.name} onChange={e => set('name', e.target.value)} required />
        <FormControl fullWidth><InputLabel>Cloudflare 凭证</InputLabel><Select value={input.dnsCredentialId || ''} label="Cloudflare 凭证" onChange={e => set('dnsCredentialId', Number(e.target.value))}>{cfCredentials.map(item => <MenuItem key={item.id} value={item.id}>{item.name}</MenuItem>)}</Select></FormControl>
        <FormControl fullWidth><InputLabel>Zone</InputLabel><Select value={input.zoneId || ''} label="Zone" onChange={e => { const zone = zones.find(item => item.id === e.target.value); set('zoneId', e.target.value); set('zoneName', zone?.name); }}>{zones.map(item => <MenuItem key={item.id} value={item.id}>{item.name}</MenuItem>)}</Select></FormControl>
        <TextField label="访问域名" placeholder="app.example.com" value={input.hostname} onChange={e => set('hostname', e.target.value)} required />
        <TextField label="本地服务 URL" placeholder="http://127.0.0.1:8080" value={input.serviceUrl} onChange={e => set('serviceUrl', e.target.value)} required />
        <FormControl fullWidth><InputLabel>已有 Tunnel</InputLabel><Select value={input.tunnelId || ''} label="已有 Tunnel" onChange={e => { const tunnel = tunnels.find(item => item.id === e.target.value); set('tunnelId', e.target.value || undefined); set('tunnelName', tunnel?.name); }}><MenuItem value=""><em>自动创建（创建后需先连接 Connector）</em></MenuItem>{tunnels.map(item => <MenuItem key={item.id} value={item.id}>{item.name || item.id}（{item.status || 'unknown'}）</MenuItem>)}</Select></FormControl>
        <FormControl fullWidth><InputLabel>模式</InputLabel><Select value={input.mode} label="模式" onChange={e => set('mode', e.target.value)}><MenuItem value="DEFAULT">Cloudflare 默认</MenuItem><MenuItem value="PREFERRED">preferredTarget</MenuItem></Select></FormControl>
        {input.mode === 'PREFERRED' && <TextField label="preferredTarget" placeholder="cdn.example.net" value={input.preferredTarget || ''} onChange={e => set('preferredTarget', e.target.value)} required />}
        <FormControlLabel control={<Switch checked={!!input.intermediateEnabled} onChange={e => set('intermediateEnabled', e.target.checked)} />} label="使用中间 CNAME" />
        {input.intermediateEnabled && <TextField label="中间 CNAME hostname" value={input.intermediateHostname || ''} onChange={e => set('intermediateHostname', e.target.value)} required />}
        <TextField label="健康检查 Path" value={input.healthCheckPath || '/'} onChange={e => set('healthCheckPath', e.target.value)} />
        {preflight && <Alert severity={preflight.canDeploy ? 'success' : 'warning'}>{preflight.canDeploy ? '预检查通过，可以创建服务' : '预检查未通过，请修复以下项目'}<Stack sx={{ mt: 1 }}>{(preflight.checks || []).map((check: any) => <Typography variant="body2" key={check.name}>{check.ok ? '✓' : '✕'} {check.name}: {check.message}</Typography>)}</Stack></Alert>}
      </Stack>
    </DialogContent>
    <DialogActions><Button onClick={onClose}>取消</Button><Button variant="contained" onClick={submit} disabled={submitting}>{submitting ? <CircularProgress size={20} /> : initial ? '预检查并保存' : '预检查并创建'}</Button></DialogActions>
  </Dialog>;
}

function OptimizedServiceCard({ service, onRefresh, onEdit }: { service: OptimizedService; onRefresh: () => void; onEdit: () => void }) {
  const navigate = useNavigate();
  const [alert, setAlert] = useState<string>('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const deployments = useQuery({ queryKey: ['optimized-deployments', service.id], queryFn: () => getOptimizedDeployments(service.id), enabled: service.deploymentStatus !== 'DRAFT', refetchInterval: 3_000 });
  const action = async (fn: () => Promise<unknown>) => { try { await fn(); onRefresh(); } catch (error) { setAlert(String(error)); } };
  const deploymentList = deployments.data?.data?.deployments || [];
  const latest = deploymentList[0];
  const pendingConfirmation = deploymentList.find(item => item.status === 'WAITING_CONFIRMATION');
  const canOperate = service.deploymentStatus === 'ACTIVE';
  let pendingDetails: any = {};
  try { pendingDetails = pendingConfirmation?.pendingConfirmationJson ? JSON.parse(pendingConfirmation.pendingConfirmationJson) : {}; } catch { pendingDetails = {}; }
  const connectorRequired = pendingDetails.kind === 'TUNNEL_CONNECTION_REQUIRED';
  return <Card sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
    <CardContent sx={{ flexGrow: 1 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}><Box><Typography variant="h6">{service.name}</Typography><Typography variant="body2" color="text.secondary">{service.hostname}</Typography></Box><Chip size="small" label={statusLabel[service.deploymentStatus] || service.deploymentStatus} color={service.deploymentStatus === 'ACTIVE' ? 'success' : service.deploymentStatus.includes('FAILED') || service.deploymentStatus === 'FAILED' ? 'error' : 'default'} /></Stack>
      <Divider sx={{ my: 2 }} />
      <Stack spacing={0.75} sx={{ fontSize: 14 }}><Typography variant="body2"><b>DNS：</b>{service.mode === 'PREFERRED' ? 'DNS only → preferredTarget' : '橙云 Tunnel CNAME'}</Typography><Typography variant="body2"><b>Tunnel：</b>{service.tunnelName || service.tunnelId || '部署时创建'}</Typography><Typography variant="body2"><b>Custom Hostname：</b>{service.customHostnameId || '未创建'}</Typography><Typography variant="body2"><b>SSL：</b>{service.currentStep === 'WAITING_SSL_ACTIVE' ? '等待 active' : service.deploymentStatus === 'ACTIVE' ? 'active' : '—'}</Typography><Typography variant="body2"><b>HTTPS：</b>{service.healthStatus === 'HEALTHY' ? '健康' : service.healthStatus === 'UNHEALTHY' ? '失败' : '未检查'}</Typography><Typography variant="body2"><b>更新时间：</b>{formatDateTime(service.updatedAt)}</Typography></Stack>
      {service.lastError && <Alert severity="error" sx={{ mt: 2 }}>{service.lastError}</Alert>}
      {pendingConfirmation?.status === 'WAITING_CONFIRMATION' && <Alert severity="warning" sx={{ mt: 2 }}>{connectorRequired ? <><Typography variant="body2" fontWeight={700}>Connector 正在自动连接</Typography><Typography variant="body2" sx={{ mt: 0.5 }}>Docker sidecar 会自动启动 cloudflared，连接成功后任务自动继续，无需复制 Token。</Typography></> : <><Typography variant="body2" fontWeight={700}>任务需要人工确认</Typography><Typography variant="body2" sx={{ mt: 0.5 }}>{pendingDetails.message || '存在 DNS、Ingress 或验证记录冲突'}</Typography></>}<Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap' }}>{connectorRequired && <Button size="small" variant="outlined" onClick={() => navigate(`/tunnels?credentialId=${service.dnsCredentialId}`)}>查看 Tunnel</Button>}<Button size="small" variant="contained" onClick={() => action(() => continueOptimizedDeployment(pendingConfirmation.id, 'replace'))}>{connectorRequired ? '立即重新检查' : '备份并替换'}</Button>{!connectorRequired && <Button size="small" onClick={() => action(() => continueOptimizedDeployment(pendingConfirmation.id, 'cancel'))}>取消</Button>}</Stack></Alert>}
      {alert && <Alert severity="error" sx={{ mt: 2 }} onClose={() => setAlert('')}>{alert}</Alert>}
    </CardContent>
    <CardActions sx={{ flexWrap: 'wrap', gap: 0.5 }}><Button size="small" onClick={onEdit}>编辑</Button><Button size="small" startIcon={<DeployIcon />} onClick={() => action(() => deployOptimizedService(service.id))} disabled={['PREFLIGHT', 'PREPARING_TUNNEL', 'TUNNEL_READY', 'WAITING_FALLBACK', 'WAITING_SSL_ACTIVE', 'SWITCHING_DNS', 'VERIFYING', 'WAITING_CONFIRMATION', 'ROLLING_BACK'].includes(service.deploymentStatus)}>部署</Button><Button size="small" startIcon={<HealthIcon />} onClick={() => action(() => healthCheckOptimizedService(service.id))} disabled={!canOperate}>健康检查</Button><Button size="small" onClick={() => action(() => switchOptimizedPreferred(service.id))} disabled={!canOperate}>切换优选</Button><Button size="small" onClick={() => action(() => switchOptimizedDefault(service.id))} disabled={!canOperate}>恢复默认</Button>{latest && <Button size="small" color="warning" startIcon={<RestoreIcon />} onClick={() => action(() => rollbackOptimizedDeployment(latest.id))}>回滚</Button>}<Button size="small" color="error" onClick={() => setConfirmOpen(true)}>移除</Button></CardActions>
    <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}><DialogTitle>移除优选服务？</DialogTitle><DialogContent>默认只移除面板记录，不会删除 Cloudflare 资源。</DialogContent><DialogActions><Button onClick={() => setConfirmOpen(false)}>取消</Button><Button color="error" onClick={() => action(() => removeOptimizedService(service.id, 'record'))}>移除记录</Button></DialogActions></Dialog>
  </Card>;
}

export default function OptimizedServices() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<OptimizedService | null>(null);
  const query = useQuery({ queryKey: ['optimized-services'], queryFn: getOptimizedServices, refetchInterval: 3_000 });
  const create = useMutation({ mutationFn: createOptimizedService, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['optimized-services'] }) });
  const update = useMutation({ mutationFn: ({ id, input }: { id: number; input: OptimizedInput }) => updateOptimizedService(id, input), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['optimized-services'] }) });
  const services = query.data?.data?.services || [];
  const error = query.error ? String(query.error) : create.error ? String(create.error) : update.error ? String(update.error) : '';
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: ['optimized-services'] }); void queryClient.invalidateQueries({ queryKey: ['optimized-deployments'] }); };
  return <Box sx={{ maxWidth: 1600, mx: 'auto' }}><Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ sm: 'center' }} spacing={2} sx={{ mb: 3 }}><Box><Typography variant="h4" fontWeight={800}>优选服务</Typography><Typography color="text.secondary">同 Zone Cloudflare Tunnel + Custom Hostname 异步部署</Typography></Box><Button variant="contained" startIcon={<AddIcon />} onClick={() => setCreateOpen(true)}>新建服务</Button></Stack>{error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}{query.isLoading ? <CircularProgress /> : services.length ? <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)', xl: 'repeat(3, 1fr)' }, gap: 2 }}>{services.map(service => <OptimizedServiceCard key={service.id} service={service} onRefresh={refresh} onEdit={() => setEditing(service)} />)}</Box> : <Card><CardContent><Typography color="text.secondary">还没有优选服务。请先配置 Cloudflare 凭证。</Typography></CardContent></Card>}<CreateOptimizedServiceDialog open={createOpen || !!editing} initial={editing} onClose={() => { setCreateOpen(false); setEditing(null); }} onSaved={input => editing ? update.mutate({ id: editing.id, input }) : create.mutate(input)} /></Box>;
}
