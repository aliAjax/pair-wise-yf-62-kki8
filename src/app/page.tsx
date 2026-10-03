'use client';

import { useQuery } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, Grid, Group, List, Progress, SimpleGrid, Stack, Switch, Table, Text, Textarea, TextInput, Timeline, Title } from '@mantine/core';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { useEffect, useReducer, useState } from 'react';
import { useCommandStore } from '@/lib/store';
import { SearchMap } from '@/components/SearchMap';
import { coverageForArea, isPositionExpired } from '@/lib/coverage';

const missionSchema = z.object({
  title: z.string().min(3, '任务名称至少3个字'),
  areaId: z.string().min(1),
  assetIds: z.array(z.string()).min(1, '至少调派一个单位'),
  priority: z.enum(['normal', 'urgent']),
  note: z.string().max(160)
});

export default function CommandPage() {
  const state = useCommandStore();
  const [selectedAssets, setSelectedAssets] = useState<string[]>(['ship-01']);
  const [, rerender] = useReducer((tick: number) => tick + 1, 0);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<z.infer<typeof missionSchema>>({
    resolver: zodResolver(missionSchema),
    defaultValues: { title: '', areaId: state.areas[0]?.id, assetIds: selectedAssets, priority: 'urgent', note: '' }
  });
  const brief = useQuery({
    queryKey: ['sea-state'],
    queryFn: async () => ({ wind: '东北风 6级', visibility: '4.2海里', tide: '涨潮' }),
    refetchInterval: state.lowBandwidth ? false : 60_000
  });

  // 定时刷新：让过期位置判定与覆盖率随时间重算
  useEffect(() => {
    const timer = setInterval(rerender, 30_000);
    return () => clearInterval(timer);
  }, []);

  // 断链期间单位照常记录位置：每 15 秒为失联单位补一条本地位置记录
  useEffect(() => {
    if (!state.offline) return;
    const timer = setInterval(() => {
      state.assets.forEach((asset) => {
        if (asset.status === 'offline') state.reportPosition(asset.id);
      });
    }, 15_000);
    return () => clearInterval(timer);
  }, [state.offline, state.assets, state.reportPosition]);

  const submitMission = (values: z.infer<typeof missionSchema>) => {
    state.dispatchMission({ ...values, assetIds: selectedAssets });
    reset({ title: '', areaId: state.areas[0]?.id, assetIds: selectedAssets, priority: 'urgent', note: '' });
  };

  const pendingRecords = state.outbox.filter((record) => !record.synced);
  const failedRecords = pendingRecords.filter((record) => record.attempts > 0 && record.lastError);
  const archivedCount = state.positionTrail.filter((point) => isPositionExpired(point.time)).length;
  const coverageOf = (areaId: string) => {
    const area = state.areas.find((item) => item.id === areaId);
    return area ? coverageForArea(area, state.positionTrail) : 0;
  };
  const nextMissionStatus = (missionId: string, status: string) => state.advanceMission(missionId, status === 'in_progress' ? 'closed' : 'in_progress');

  return (
    <main className={state.lowBandwidth ? 'low-bandwidth' : ''}>
      <Stack p="xl" gap="lg" maw={1600} mx="auto">
        <Group justify="space-between" align="flex-end">
          <div><Badge color={state.offline ? 'red' : 'teal'}>{state.offline ? '离线缓存模式' : '联合指挥在线'}</Badge><Title order={1} className="section-title">海上搜救联合指挥</Title><Text c="dimmed">搜索区、力量与任务在同一时间线上协同</Text></div>
          <Group><Switch label="低带宽" checked={state.lowBandwidth} onChange={state.toggleBandwidth} /><Switch label="模拟离线" checked={state.offline} onChange={state.toggleOffline} /></Group>
        </Group>

        <SimpleGrid cols={{ base: 2, md: 5 }}>
          {[
            ['活动搜索区', state.areas.filter((item) => item.status === 'active').length],
            ['在线单位', state.assets.filter((item) => item.status !== 'offline').length],
            ['进行中任务', state.missions.filter((item) => item.status === 'in_progress').length],
            ['待归并记录', pendingRecords.length],
            ['过期留档位置', archivedCount]
          ].map(([label, value]) => <Card key={String(label)} withBorder><Text size="sm" c="dimmed">{label}</Text><Title order={2}>{value}</Title></Card>)}
        </SimpleGrid>

        <Grid gutter="lg">
          <Grid.Col span={{ base: 12, lg: 8 }}><Card withBorder><Group justify="space-between"><Title order={3}>搜救态势</Title><Text size="sm">风况：{brief.data?.wind ?? '读取中'} · 能见度：{brief.data?.visibility ?? '--'}</Text></Group><SearchMap areas={state.areas} assets={state.assets} trail={state.positionTrail} /></Card></Grid.Col>
          <Grid.Col span={{ base: 12, lg: 4 }}><Card withBorder h="100%"><Title order={3}>单位状态</Title><Stack mt="md">{state.assets.map((asset) => {
            const stale = isPositionExpired(asset.lastSeen);
            return <Card key={asset.id} withBorder padding="sm"><Group justify="space-between"><b>{asset.name}</b><Badge color={asset.status === 'offline' ? 'red' : asset.status === 'assigned' ? 'blue' : 'teal'}>{asset.status}</Badge></Group><Text size="xs" c={stale ? 'red' : 'dimmed'}>{stale ? '位置已过期 · ' : ''}{formatDistanceToNow(new Date(asset.lastSeen), { addSuffix: true, locale: zhCN })}</Text><Group mt="xs"><Button size="compact-xs" onClick={() => state.setAssetStatus(asset.id, asset.status === 'offline' ? 'ready' : 'offline')}>{asset.status === 'offline' ? '恢复在线' : '标记失联'}</Button><Button size="compact-xs" variant="outline" onClick={() => state.reportPosition(asset.id)}>{state.offline ? '记录位置(离线)' : '上报位置'}</Button></Group></Card>;
          })}</Stack></Card></Grid.Col>
        </Grid>

        <Grid gutter="lg">
          <Grid.Col span={{ base: 12, lg: 5 }}><Card withBorder><Title order={3}>派发新任务</Title><form onSubmit={handleSubmit(submitMission)}><Stack mt="md"><TextInput label="任务名称" {...register('title')} error={errors.title?.message} /><label>搜索区<select {...register('areaId')} style={{ width: '100%', padding: 8 }}>{state.areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</select></label><label>调派单位（可多选）<select multiple value={selectedAssets} onChange={(event) => setSelectedAssets(Array.from(event.currentTarget.selectedOptions, (option) => option.value))} style={{ width: '100%', minHeight: 86 }}>{state.assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label><label>优先级<select {...register('priority')} style={{ width: '100%', padding: 8 }}><option value="urgent">紧急</option><option value="normal">常规</option></select></label><Textarea label="任务说明" {...register('note')} /><Button type="submit" disabled={state.offline}>{state.offline ? '离线中 · 回线后可派单' : '派发任务'}</Button></Stack></form></Card></Grid.Col>
          <Grid.Col span={{ base: 12, lg: 7 }}><Card withBorder><Title order={3}>任务与搜索区</Title><table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr><th align="left">搜索区</th><th align="left">状态</th><th align="left">覆盖率（按新鲜位置重算）</th></tr></thead><tbody>{state.areas.map((area) => <tr key={area.id}><td style={{ padding: '8px 0' }}>{area.name}</td><td>{area.status}</td><td style={{ width: '42%' }}><Progress value={coverageOf(area.id)} /></td></tr>)}</tbody></table><List mt="lg" spacing="sm">{state.missions.map((mission) => {
            const missionConflicts = state.conflicts.filter((item) => item.missionId === mission.id);
            return <List.Item key={mission.id}><Group justify="space-between"><div><b>{mission.title}</b>{missionConflicts.length > 0 && <Badge size="xs" color="orange" ml="xs">差异 {missionConflicts.length}</Badge>}<Text size="xs" c="dimmed">{mission.areaId} · {mission.assetIds.join(' / ')}{state.offline ? ' · 离线记账中' : ''}</Text></div><Group><Badge>{mission.status}</Badge><Button size="compact-xs" onClick={() => nextMissionStatus(mission.id, mission.status)}>{mission.status === 'closed' ? '重开' : '推进'}</Button></Group></Group></List.Item>;
          })}</List></Card></Grid.Col>
        </Grid>

        <Card withBorder>
          <Group justify="space-between">
            <Title order={3}>离线批次与归并</Title>
            <Switch label="模拟归并失败" checked={state.simulateMergeFailure} onChange={(event) => state.setSimulateMergeFailure(event.currentTarget.checked)} />
          </Group>
          {state.offline && <Alert color="orange" mt="md">离线期间：单位位置与任务进展照常记入本地批次，回线后自动归并；过期位置只留档，覆盖率随即重算。</Alert>}
          {!state.offline && pendingRecords.length === 0 && !state.mergeMessage && <Text size="sm" c="dimmed" mt="md">链路在线，无待归并记录。</Text>}
          {pendingRecords.length > 0 && (
            <>
              <List mt="md" spacing="xs">
                {pendingRecords.map((record) => (
                  <List.Item key={record.id}>
                    <Group justify="space-between">
                      <div>
                        <Badge size="xs" color={record.kind === 'position' ? 'blue' : 'violet'}>{record.kind === 'position' ? '位置' : '进展'}</Badge>
                        <Text size="xs" component="span" ml="xs">
                          {record.kind === 'position'
                            ? `${record.payload.assetId} · ${record.payload.lat?.toFixed(3)}, ${record.payload.lng?.toFixed(3)}`
                            : `${record.payload.missionId} → ${record.payload.status}`}
                          {' · '}{formatDistanceToNow(new Date(record.createdAt), { addSuffix: true, locale: zhCN })}
                          {record.attempts > 0 ? ` · 已重试 ${record.attempts} 次` : ''}
                        </Text>
                      </div>
                      {record.lastError && <Text size="xs" c="red">{record.lastError}</Text>}
                    </Group>
                  </List.Item>
                ))}
              </List>
              <Group mt="md">
                <Button size="compact-sm" onClick={state.mergeOutbox} disabled={state.offline}>归并离线批次</Button>
                {failedRecords.length > 0 && <Button size="compact-sm" variant="outline" color="red" onClick={state.retryOutbox} disabled={state.offline}>只重试未入库部分（{failedRecords.length}）</Button>}
              </Group>
            </>
          )}
          {state.mergeMessage && <Alert color={state.mergeStatus === 'success' ? 'teal' : state.mergeStatus === 'partial' ? 'orange' : 'red'} mt="md">{state.mergeMessage}</Alert>}
          {state.conflicts.length > 0 && (
            <>
              <Text size="sm" fw={600} mt="md">归并差异（{state.conflicts.length} 条）：两边记录都留下，晚到的一方未盖掉先到的一方</Text>
              <List mt="xs" spacing="xs">
                {state.conflicts.map((item) => (
                  <List.Item key={item.id}>
                    <Text size="xs">
                      <b>{item.missionId}</b> · 字段 {item.field}：指挥台先到 <Badge size="xs" color="teal">{item.remoteValue}</Badge> {new Date(item.remoteTime).toLocaleTimeString()} ／ 离线晚到 <Badge size="xs" color="orange">{item.localValue}</Badge> {new Date(item.localTime).toLocaleTimeString()}
                    </Text>
                    <Text size="xs" c="dimmed">{item.diff}</Text>
                  </List.Item>
                ))}
              </List>
            </>
          )}
        </Card>

        <Card withBorder><Title order={3}>联合事件时间线</Title><Timeline mt="lg" active={1} bulletSize={18} lineWidth={2}>{state.events.slice(0, 10).map((event) => <Timeline.Item key={event.id} title={`${event.actor} · ${new Date(event.time).toLocaleTimeString()}`}><Text size="sm">{event.message}</Text></Timeline.Item>)}</Timeline></Card>
      </Stack>
    </main>
  );
}
