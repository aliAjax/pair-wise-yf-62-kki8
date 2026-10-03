'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, Grid, Group, List, Progress, Select, SimpleGrid, Stack, Switch, Table, Text, Textarea, TextInput, Title } from '@mantine/core';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { useState } from 'react';
import { useCommandStore } from '@/lib/store';
import { SearchMap } from '@/components/SearchMap';
import { POSITION_TTL_MS } from '@/lib/sync';
import type { MissionStatus, SyncSide } from '@/lib/types';

const missionSchema = z.object({
  title: z.string().min(3, '任务名称至少3个字'),
  areaId: z.string().min(1),
  assetIds: z.array(z.string()).min(1, '至少调派一个单位'),
  priority: z.enum(['normal', 'urgent']),
  note: z.string().max(160)
});

const sideLabel = (side: SyncSide) => side === 'local' ? '单位端（离线）' : '指挥台';
const statusColor = (status: MissionStatus) => status === 'closed' ? 'gray' : status === 'in_progress' ? 'blue' : 'teal';

export default function CommandPage() {
  const state = useCommandStore();
  const [selectedAssets, setSelectedAssets] = useState<string[]>(['ship-01']);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<z.infer<typeof missionSchema>>({
    resolver: zodResolver(missionSchema),
    defaultValues: { title: '', areaId: state.areas[0]?.id, assetIds: selectedAssets, priority: 'urgent', note: '' }
  });
  const brief = useQuery({
    queryKey: ['sea-state'],
    queryFn: async () => ({ wind: '东北风 6级', visibility: '4.2海里', tide: '涨潮' }),
    refetchInterval: state.lowBandwidth ? false : 60_000
  });

  const submitMission = (values: z.infer<typeof missionSchema>) => {
    state.dispatchMission({ ...values, assetIds: selectedAssets });
    reset({ title: '', areaId: state.areas[0]?.id, assetIds: selectedAssets, priority: 'urgent', note: '' });
  };

  const openBatchOf = (assetId: string) => state.batches.find((batch) => batch.assetId === assetId && batch.status === 'open');
  const failedBatchOf = (assetId: string) => state.batches.find((batch) => batch.assetId === assetId && batch.status === 'failed');

  return (
    <main className={state.lowBandwidth ? 'low-bandwidth' : ''}>
      <Stack p="xl" gap="lg" maw={1600} mx="auto">
        <Group justify="space-between" align="flex-end">
          <div>
            <Badge color={state.offline ? 'red' : 'teal'}>{state.offline ? '离线缓存模式' : '联合指挥在线'}</Badge>
            <Title order={1} className="section-title">海上搜救联合指挥</Title>
            <Text c="dimmed">断链照常记录位置与进展 · 回线先归并再对齐 · 双侧推进双份留痕</Text>
          </div>
          <Group>
            <Switch label="模拟归并中途失败" checked={state.simulateSyncFailure} onChange={state.toggleSimulateSyncFailure} />
            <Switch label="低带宽" checked={state.lowBandwidth} onChange={state.toggleBandwidth} />
            <Switch label="模拟离线" checked={state.offline} onChange={state.toggleOffline} />
          </Group>
        </Group>

        <SimpleGrid cols={{ base: 1, md: 5 }}>
          {[
            ['活动搜索区', state.areas.filter((item) => item.status === 'active').length],
            ['在线单位', state.assets.filter((item) => item.status !== 'offline').length],
            ['失联单位（本地批次开启中）', state.assets.filter((item) => item.status === 'offline').length],
            ['待重试批次', state.batches.filter((item) => item.status === 'failed').length],
            ['过期位置（已留档）', state.archives.length]
          ].map(([label, value]) => (
            <Card key={String(label)} withBorder><Text size="sm" c="dimmed">{label}</Text><Title order={2}>{value}</Title></Card>
          ))}
        </SimpleGrid>

        <Grid gutter="lg">
          <Grid.Col span={{ base: 12, lg: 8 }}>
            <Card withBorder>
              <Group justify="space-between">
                <Title order={3}>搜救态势</Title>
                <Text size="sm">风况：{brief.data?.wind ?? '读取中'} · 能见度：{brief.data?.visibility ?? '--'}</Text>
              </Group>
              <SearchMap areas={state.areas} assets={state.assets} archives={state.archives} />
              <Text size="xs" c="dimmed" mt="xs">
                红色标记为失联单位；其坐标为失联前位置。过期位置（{POSITION_TTL_MS / 60_000} 分钟有效期）回线后不回灌地图，仅进入下方档案。
              </Text>
            </Card>
          </Grid.Col>

          <Grid.Col span={{ base: 12, lg: 4 }}>
            <Card withBorder h="100%">
              <Title order={3}>单位状态与断链记录</Title>
              <Stack mt="md">
                {state.assets.map((asset) => {
                  const stale = asset.positionStale ?? (Date.now() - new Date(asset.lastSeen).getTime() > POSITION_TTL_MS);
                  const batch = openBatchOf(asset.id) ?? failedBatchOf(asset.id);
                  const pending = batch?.records.filter((record) => !record.persisted).length ?? 0;
                  return (
                    <Card key={asset.id} withBorder padding="sm">
                      <Group justify="space-between">
                        <b>{asset.name}</b>
                        <Badge color={asset.status === 'offline' ? 'red' : asset.status === 'assigned' ? 'blue' : 'teal'}>
                          {asset.status === 'offline' ? `失联${pending > 0 ? ` · 待归并${pending}` : ''}` : asset.status}
                        </Badge>
                      </Group>
                      <Text size="xs" c={stale ? 'red' : 'dimmed'}>
                        {stale ? '位置已过期 · 仅档案可见 · ' : ''}
                        {formatDistanceToNow(new Date(asset.lastSeen), { addSuffix: true, locale: zhCN })}
                      </Text>

                      {asset.status === 'offline' && (
                        <Stack gap={4} mt="xs">
                          <Text size="xs" c="dimmed">断链期间照记（存入本地批次，不上指挥台坐标）：</Text>
                          <Group gap="xs">
                            <Button size="compact-xs" variant="light" onClick={() => state.logOfflinePosition(
                              asset.id,
                              +(asset.lat + (Math.random() * 0.08 - 0.04)).toFixed(4),
                              +(asset.lng + (Math.random() * 0.08 - 0.04)).toFixed(4),
                              { label: '最新位置' }
                            )}>记一条新位置</Button>
                            <Button size="compact-xs" variant="light" color="orange" onClick={() => state.logOfflinePosition(
                              asset.id,
                              +(asset.lat + (Math.random() * 0.1 - 0.05)).toFixed(4),
                              +(asset.lng + (Math.random() * 0.1 - 0.05)).toFixed(4),
                              { at: new Date(Date.now() - 12 * 60_000).toISOString(), label: '过期位置' }
                            )}>记一条过期位置</Button>
                          </Group>
                          {state.missions.filter((mission) => mission.assetIds.includes(asset.id)).map((mission) => (
                            <Group key={mission.id} gap="xs">
                              <Button size="compact-xs" variant="light" color="teal" onClick={() => state.logOfflineProgress(
                                asset.id, mission.id, { status: 'in_progress', note: `${asset.name}离线推进：扩大扇形扫测`, coverageDelta: 9 }
                              )}>推进“{mission.title.slice(0, 8)}” +9%</Button>
                              <Button size="compact-xs" variant="light" color="grape" onClick={() => state.logOfflineProgress(
                                asset.id, mission.id, { status: 'closed', note: `${asset.name}离线判断：分区已搜完`, coverageDelta: 0, at: new Date(Date.now() - 12 * 60_000).toISOString() }
                              )}>过期推进（剔除增量）</Button>
                            </Group>
                          ))}
                        </Stack>
                      )}

                      <Group mt="xs" gap="xs">
                        {asset.status === 'offline'
                          ? <Button size="compact-xs" onClick={() => state.reconnectAsset(asset.id)}>回线：先归并再对齐</Button>
                          : <Button size="compact-xs" variant="light" color="red" onClick={() => state.setAssetStatus(asset.id, 'offline')}>标记失联（开本地批次）</Button>}
                      </Group>
                    </Card>
                  );
                })}
              </Stack>
            </Card>
          </Grid.Col>
        </Grid>

        <Grid gutter="lg">
          <Grid.Col span={{ base: 12, lg: 5 }}>
            <Card withBorder>
              <Title order={3}>派发新任务</Title>
              <form onSubmit={handleSubmit(submitMission)}>
                <Stack mt="md">
                  <TextInput label="任务名称" {...register('title')} error={errors.title?.message} />
                  <label>搜索区
                    <select {...register('areaId')} style={{ width: '100%', padding: 8 }}>
                      {state.areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}
                    </select>
                  </label>
                  <label>调派单位（可多选）
                    <select multiple value={selectedAssets} onChange={(event) => setSelectedAssets(Array.from(event.currentTarget.selectedOptions, (option) => option.value))} style={{ width: '100%', minHeight: 86 }}>
                      {state.assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
                    </select>
                  </label>
                  <label>优先级
                    <select {...register('priority')} style={{ width: '100%', padding: 8 }}>
                      <option value="urgent">紧急</option>
                      <option value="normal">常规</option>
                    </select>
                  </label>
                  <Textarea label="任务说明" {...register('note')} />
                  <Button type="submit">派发任务</Button>
                </Stack>
              </form>
            </Card>

            {state.conflicts.length > 0 && (
              <Card withBorder mt="lg" color="yellow">
                <Title order={3}>双侧推进差异（两份记录均保留）</Title>
                <Stack mt="md">
                  {state.conflicts.map((conflict) => {
                    const mission = state.missions.find((item) => item.id === conflict.missionId);
                    const EntryView = ({ entry, isWinner }: { entry: typeof conflict.local; isWinner: boolean }) => (
                      <Card withBorder padding="xs" style={{ borderColor: isWinner ? '#0f766e' : '#f59e0b', borderWidth: 2 }}>
                        <Group justify="space-between">
                          <Text size="sm" fw={isWinner ? 700 : 400} c={isWinner ? 'teal' : 'dimmed'}>
                            {sideLabel(entry.side)}{isWinner ? ' · 先到·已采纳' : ' · 晚到·仅留痕不覆盖'}
                          </Text>
                          <Badge size="sm" color={statusColor(entry.status)}>{entry.status}</Badge>
                        </Group>
                        <Text size="xs" c="dimmed">{new Date(entry.at).toLocaleString('zh-CN')} · {entry.note || '无备注'}</Text>
                      </Card>
                    );
                    return (
                      <Card key={conflict.id} withBorder padding="sm" bg={conflict.resolved ? 'gray.0' : 'yellow.0'}>
                        <Group justify="space-between">
                          <Text fw={600}>任务“{mission?.title ?? conflict.missionId}”</Text>
                          {conflict.resolved
                            ? <Badge color="gray">已核验</Badge>
                            : <Button size="compact-xs" variant="light" onClick={() => state.resolveConflict(conflict.id)}>核验差异</Button>}
                        </Group>
                        <EntryView entry={conflict.local} isWinner={conflict.winner === 'local'} />
                        <EntryView entry={conflict.remote} isWinner={conflict.winner === 'remote'} />
                      </Card>
                    );
                  })}
                </Stack>
              </Card>
            )}
          </Grid.Col>

          <Grid.Col span={{ base: 12, lg: 7 }}>
            <Card withBorder>
              <Title order={3}>任务与搜索区</Title>
              <Table mt="md">
                <Table.Thead><Table.Tr><Table.Th>搜索区</Table.Th><Table.Th>状态</Table.Th><Table.Th>覆盖率（台账即时重算）</Table.Th></Table.Tr></Table.Thead>
                <Table.Tbody>
                  {state.areas.map((area) => (
                    <Table.Tr key={area.id}>
                      <Table.Td>{area.name}</Table.Td>
                      <Table.Td>{area.status}</Table.Td>
                      <Table.Td style={{ width: '42%' }}>
                        <Group gap="xs" wrap="nowrap"><Progress style={{ flex: 1 }} value={area.coverage} /><Text size="xs" fw={600}>{area.coverage}%</Text></Group>
                        <Text size="10" c="dimmed">基准 {area.coverageBase}% · 有效增量 {area.coverageLedger.filter((g) => !g.archived).reduce((s, g) => s + g.delta, 0)}% · 已归档 {area.coverageLedger.filter((g) => g.archived).length} 笔</Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>

              <List mt="lg" spacing="sm">
                {state.missions.map((mission) => (
                  <List.Item key={mission.id}>
                    <Stack gap={4}>
                      <Group justify="space-between">
                        <div>
                          <b>{mission.title}</b>
                          <Text size="xs" c="dimmed">{mission.areaId} · {mission.assetIds.join(' / ')}</Text>
                        </div>
                        <Group>
                          <Badge color={statusColor(mission.status)}>{mission.status}</Badge>
                          <Button size="compact-xs" onClick={() => state.advanceMission(mission.id)}>
                            {mission.status === 'closed' ? '指挥台重开' : '指挥台推进（远程）'}
                          </Button>
                        </Group>
                      </Group>
                      {mission.timeline.length > 0 && (
                        <Stack gap={2} ml="md">
                          {[...mission.timeline].sort((a, b) => +new Date(b.at) - +new Date(a.at)).map((entry) => (
                            <Group key={entry.id} gap="xs" wrap="nowrap">
                              <Badge size="xs" color={entry.side === 'local' ? 'teal' : 'blue'} variant={entry.divergent ? 'outline' : 'filled'}>
                                {sideLabel(entry.side)}{entry.divergent ? '·晚到留痕' : ''}
                              </Badge>
                              <Text size="xs" c="dimmed">{new Date(entry.at).toLocaleTimeString('zh-CN')} → {entry.status}{entry.note ? `：${entry.note}` : ''}</Text>
                            </Group>
                          ))}
                        </Stack>
                      )}
                    </Stack>
                  </List.Item>
                ))}
              </List>
            </Card>

            <Card withBorder mt="lg">
              <Title order={3}>本地批次与归并</Title>
              {state.batches.length === 0 ? <Text size="sm" c="dimmed" mt="sm">尚无断链批次。把单位标记失联后，记录会累积到本地批次。</Text> : (
                <Table mt="sm">
                  <Table.Thead><Table.Tr><Table.Th>单位</Table.Th><Table.Th>批次时间</Table.Th><Table.Th>记录</Table.Th><Table.Th>状态</Table.Th><Table.Th></Table.Th></Table.Tr></Table.Thead>
                  <Table.Tbody>
                    {state.batches.map((batch) => {
                      const done = batch.records.filter((r) => r.persisted).length;
                      return (
                        <Table.Tr key={batch.id}>
                          <Table.Td>{batch.assetId}</Table.Td>
                          <Table.Td><Text size="xs">{new Date(batch.startedAt).toLocaleTimeString('zh-CN')}{batch.endedAt ? ` → ${new Date(batch.endedAt).toLocaleTimeString('zh-CN')}` : ''}</Text></Table.Td>
                          <Table.Td>
                            <Text size="xs">{done}/{batch.records.length} 已入库
                              {batch.records.some((r) => r.expired) ? ` · ${batch.records.filter((r) => r.expired).length} 条过期留档` : ''}
                            </Text>
                            <Text size="10" c="dimmed">{batch.records.map((r) => r.kind === 'position' ? '位置' : '进展').join('、')}</Text>
                          </Table.Td>
                          <Table.Td>
                            <Badge size="sm" color={batch.status === 'synced' ? 'teal' : batch.status === 'failed' ? 'red' : 'yellow'}>
                              {batch.status === 'synced' ? '已归并' : batch.status === 'failed' ? `失败 · ${batch.records.length - done} 条未入库` : '记录中'}
                            </Badge>
                            {batch.lastError && <Text size="10" c="red">{batch.lastError}</Text>}
                          </Table.Td>
                          <Table.Td>
                            {batch.status === 'failed' && (
                              <Button size="compact-xs" color="orange" onClick={() => state.retryBatch(batch.id)}>
                                只重试未入库的 {batch.records.length - done} 条
                              </Button>
                            )}
                          </Table.Td>
                        </Table.Tr>
                      );
                    })}
                  </Table.Tbody>
                </Table>
              )}
            </Card>

            {state.archives.length > 0 && (
              <Card withBorder mt="lg">
                <Title order={3}>过期位置档案（不参与当前态势与覆盖率）</Title>
                <Table mt="sm">
                  <Table.Thead><Table.Tr><Table.Th>单位</Table.Th><Table.Th>坐标</Table.Th><Table.Th>位置时间</Table.Th><Table.Th>归档原因</Table.Th></Table.Tr></Table.Thead>
                  <Table.Tbody>
                    {state.archives.map((entry) => (
                      <Table.Tr key={entry.id}>
                        <Table.Td>{entry.assetId}</Table.Td>
                        <Table.Td>{entry.lat.toFixed(3)}, {entry.lng.toFixed(3)}</Table.Td>
                        <Table.Td>{new Date(entry.at).toLocaleString('zh-CN')}</Table.Td>
                        <Table.Td><Badge size="xs" color="orange">{entry.reason === 'expired' ? '超期留档' : '被新位置取代'}</Badge></Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Card>
            )}
          </Grid.Col>
        </Grid>

        <Card withBorder>
          <Title order={3}>联合事件时间线</Title>
          <List mt="lg" spacing="xs" type="ordered">
            {state.events.slice(0, 14).map((event) => (
              <List.Item key={event.id}>
                <Text size="sm" fw={600} span>{event.actor} · {new Date(event.time).toLocaleTimeString('zh-CN')}：</Text>
                <Text size="sm" span>{event.message}</Text>
              </List.Item>
            ))}
          </List>
        </Card>
      </Stack>
    </main>
  );
}
