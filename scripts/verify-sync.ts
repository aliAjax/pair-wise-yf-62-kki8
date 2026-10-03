import assert from 'node:assert';
import { mergeBatch, alignWithCommand, recalcCoverage, POSITION_TTL_MS } from '../src/lib/sync';
import type { Mission, MissionStatus, OfflineRecord, RescueAsset, SearchArea, SyncBatch } from '../src/lib/types';

const nowMs = new Date('2026-10-03T10:00:00Z').getTime();
const iso = (offsetMin: number) => new Date(nowMs + offsetMin * 60_000).toISOString();

function baseArea(): SearchArea {
  return { id: 'area-a', name: 'A区', bounds: [0, 0, 1, 1], status: 'active', coverage: 60, coverageBase: 60, coverageLedger: [] };
}
function baseAsset(): RescueAsset {
  return { id: 'drone-1', name: '无人机', type: 'drone', status: 'offline', lat: 30, lng: 121, lastSeen: iso(-20) };
}
function baseMission(status: MissionStatus = 'in_progress'): Mission {
  return { id: 'm-1', title: '扇形搜索', areaId: 'area-a', assetIds: ['drone-1'], status, priority: 'urgent', note: '', updatedAt: iso(-30), timeline: [] };
}

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log('  ✓', name); };

// 1. 无冲突：本地离线推进直接生效，覆盖率即时重算
check('本地离线进展直接生效并即时重算覆盖率', () => {
  const records: OfflineRecord[] = [
    { id: 'r-pos', assetId: 'drone-1', kind: 'position', at: iso(-2), lat: 30.5, lng: 121.5 },
    { id: 'r-prog', assetId: 'drone-1', kind: 'progress', at: iso(-2), missionId: 'm-1', status: 'in_progress', note: '离线扫测', coverageDelta: 12 }
  ];
  const result = mergeBatch({
    assets: [baseAsset()], missions: [baseMission()], areas: [baseArea()], archives: [], conflicts: [],
    records, assetId: 'drone-1', windowStartedAt: iso(-19), remoteByMission: new Map(), nowMs
  });
  assert.strictEqual(result.missions[0].status, 'in_progress');
  assert.strictEqual(result.missions[0].timeline.length, 1);
  assert.strictEqual(result.missions[0].timeline[0].side, 'local');
  assert.strictEqual(result.areas[0].coverage, 72, '覆盖率应为 60+12=72');
  assert.strictEqual(result.assets[0].lat, 30.5);
  assert.deepStrictEqual(result.persistedRecordIds.sort(), ['r-pos', 'r-prog']);
});

// 2. 双侧推进：两份都留、先到生效、晚到 divergent 不覆盖
check('双侧推进：两份记录都保留，先到一方生效，晚到标 divergent', () => {
  const mission = baseMission();
  // 指挥台在断链窗口内 5 分钟前推进为 closed
  mission.timeline.push({ id: 'rmt-1', missionId: 'm-1', assetId: 'command', side: 'remote', status: 'closed', note: '指挥台关闭', at: iso(-5) });
  mission.status = 'closed';
  // 本地在 3 分钟前推进为 in_progress（晚到）
  const records: OfflineRecord[] = [
    { id: 'r-late', assetId: 'drone-1', kind: 'progress', at: iso(-3), missionId: 'm-1', status: 'in_progress', note: '单位端仍在搜', coverageDelta: 5 }
  ];
  const result = mergeBatch({
    assets: [baseAsset()], missions: [mission], areas: [baseArea()], archives: [], conflicts: [],
    records, assetId: 'drone-1', windowStartedAt: iso(-19), remoteByMission: new Map([['m-1', mission.timeline[0]]]), nowMs
  });
  assert.strictEqual(result.missions[0].status, 'closed', '先到的指挥台状态应保持');
  assert.strictEqual(result.missions[0].timeline.length, 2, '两条记录都应保留');
  const localEntry = result.missions[0].timeline.find((e) => e.side === 'local')!;
  assert.strictEqual(localEntry.divergent, true, '晚到的一方应标 divergent');
  assert.strictEqual(result.conflicts.length, 1);
  assert.strictEqual(result.conflicts[0].winner, 'remote');
});

// 2b. 本地先到时本地生效
check('本地先到时本地状态生效，指挥台记录标 divergent', () => {
  const mission = baseMission();
  mission.timeline.push({ id: 'rmt-2', missionId: 'm-1', assetId: 'command', side: 'remote', status: 'closed', note: '指挥台关闭', at: iso(-3) });
  const records: OfflineRecord[] = [
    { id: 'r-early', assetId: 'drone-1', kind: 'progress', at: iso(-8), missionId: 'm-1', status: 'in_progress', note: '单位先推进', coverageDelta: 4 }
  ];
  const result = mergeBatch({
    assets: [baseAsset()], missions: [mission], areas: [baseArea()], archives: [], conflicts: [],
    records, assetId: 'drone-1', windowStartedAt: iso(-19), remoteByMission: new Map([['m-1', mission.timeline[0]]]), nowMs
  });
  assert.strictEqual(result.missions[0].status, 'in_progress');
  assert.strictEqual(result.conflicts[0].winner, 'local');
});

// 3. 过期位置只留档，不回灌坐标；过期进展增量剔除，覆盖率重算
check('过期位置只留档不回灌；过期增量剔除并重算覆盖率', () => {
  const asset = baseAsset();
  const records: OfflineRecord[] = [
    { id: 'r-oldpos', assetId: 'drone-1', kind: 'position', at: iso(-15), lat: 99, lng: 99 },
    { id: 'r-newpos', assetId: 'drone-1', kind: 'position', at: iso(-1), lat: 30.7, lng: 121.7 },
    { id: 'r-oldprog', assetId: 'drone-1', kind: 'progress', at: iso(-15), missionId: 'm-1', status: 'in_progress', note: '过期进展', coverageDelta: 20 },
    { id: 'r-newprog', assetId: 'drone-1', kind: 'progress', at: iso(-1), missionId: 'm-1', status: 'in_progress', note: '新进展', coverageDelta: 8 }
  ];
  const result = mergeBatch({
    assets: [asset], missions: [baseMission()], areas: [baseArea()], archives: [], conflicts: [],
    records, assetId: 'drone-1', windowStartedAt: iso(-19), remoteByMission: new Map(), nowMs
  });
  assert.strictEqual(result.assets[0].lat, 30.7, '最新未过期位置回灌');
  assert.strictEqual(result.archives.length, 1, '过期位置进档案');
  assert.strictEqual(result.archives[0].lat, 99);
  assert.ok(result.expiredRecordIds.includes('r-oldpos') && result.expiredRecordIds.includes('r-oldprog'));
  const archivedGains = result.areas[0].coverageLedger.filter((g) => g.archived);
  assert.strictEqual(archivedGains.length, 1, '过期进展增量被归档');
  assert.strictEqual(result.areas[0].coverage, 68, '覆盖率=60+8=68，过期的 20 不计');
});

// 4. 部分失败后重试：已入库记录幂等去重，未入库记录继续入库
check('重试幂等：已入库记录不重复，未入库记录补入', () => {
  const mission = baseMission();
  const area = baseArea();
  const records: OfflineRecord[] = [
    { id: 'p1', assetId: 'drone-1', kind: 'progress', at: iso(-4), missionId: 'm-1', status: 'in_progress', note: '第一条', coverageDelta: 5 },
    { id: 'p2', assetId: 'drone-1', kind: 'progress', at: iso(-2), missionId: 'm-1', status: 'in_progress', note: '第二条', coverageDelta: 7 }
  ];
  // 第一次只传 p1
  const first = mergeBatch({
    assets: [baseAsset()], missions: [mission], areas: [area], archives: [], conflicts: [],
    records: [records[0]], assetId: 'drone-1', windowStartedAt: iso(-19), remoteByMission: new Map(), nowMs
  });
  assert.strictEqual(first.areas[0].coverage, 65);
  // 重试时两条都再传（模拟批次整体重放），p1 须按 recordId 去重
  const second = mergeBatch({
    assets: first.assets, missions: first.missions, areas: first.areas, archives: first.archives, conflicts: first.conflicts,
    records, assetId: 'drone-1', windowStartedAt: iso(-19), remoteByMission: new Map(), nowMs
  });
  assert.strictEqual(second.missions[0].timeline.length, 2, '时间线只有 2 条，p1 未重复');
  assert.strictEqual(second.areas[0].coverage, 72, '覆盖率=60+5+7=72，无重复增量');
});

// 5. 对齐：指挥台坐标过期时不覆盖本地合并结果
check('对齐指挥台：过期的指挥台坐标不覆盖本地', () => {
  const assets = [{ ...baseAsset(), lat: 30.7, lng: 121.7, lastSeen: iso(-1) }];
  const aligned = alignWithCommand(assets, 'drone-1', { lat: 1, lng: 1, lastSeen: iso(-30) }, nowMs);
  assert.strictEqual(aligned[0].lat, 30.7, '指挥台坐标过期，保留本地合并坐标');
  assert.strictEqual(aligned[0].status, 'ready', '状态仍对齐为在线');
  const aligned2 = alignWithCommand(assets, 'drone-1', { lat: 31, lng: 122, lastSeen: iso(0) }, nowMs);
  assert.strictEqual(aligned2[0].lat, 31, '指挥台坐标新鲜时覆盖');
});

// 6. recalcCoverage 钳制 0-100
check('覆盖率重算钳制在 0-100', () => {
  const area: SearchArea = { ...baseArea(), coverageBase: 95, coverageLedger: [
    { id: 'g1', missionId: 'm-1', assetId: 'drone-1', delta: 20, time: iso(-1) }
  ] };
  assert.strictEqual(recalcCoverage(area), 100);
});

console.log(`\n全部 ${passed} 项归并不变量验证通过`);
