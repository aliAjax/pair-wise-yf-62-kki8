'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AreaStatus, AssetStatus, ConflictRecord, EventLog, MergeStatus, Mission, MissionStatus, OutboxRecord, PositionReport, ProgressRecord, RescueAsset, SearchArea } from './types';
import { coverageForArea, isPositionExpired } from './coverage';

const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const uuid = () => crypto.randomUUID();

/** 初始位置轨迹：单位失联前仍在正常上报，覆盖率由新鲜位置点重算而来。 */
const initialPositionTrail: PositionReport[] = [
  { id: 'pos-init-1', assetId: 'ship-01', lat: 30.75, lng: 121.55, time: iso(now - 35_000), source: 'online', archived: false, synced: true },
  { id: 'pos-init-2', assetId: 'ship-01', lat: 30.80, lng: 121.60, time: iso(now - 3 * 60_000), source: 'online', archived: false, synced: true },
  { id: 'pos-init-3', assetId: 'ship-01', lat: 30.76, lng: 121.55, time: iso(now - 5 * 60_000), source: 'online', archived: false, synced: true },
  { id: 'pos-init-4', assetId: 'ship-01', lat: 30.84, lng: 121.56, time: iso(now - 6 * 60_000), source: 'online', archived: false, synced: true },
  { id: 'pos-init-5', assetId: 'ship-01', lat: 30.72, lng: 121.50, time: iso(now - 7 * 60_000), source: 'online', archived: false, synced: true },
  { id: 'pos-init-6', assetId: 'ship-01', lat: 30.68, lng: 121.46, time: iso(now - 9 * 60_000), source: 'online', archived: false, synced: true },
  { id: 'pos-init-7', assetId: 'ship-01', lat: 30.94, lng: 121.79, time: iso(now - 2 * 60_000), source: 'online', archived: false, synced: true },
  { id: 'pos-init-8', assetId: 'ship-01', lat: 30.90, lng: 121.74, time: iso(now - 6 * 60_000), source: 'online', archived: false, synced: true }
];

const areaSeeds: SearchArea[] = [
  { id: 'area-a', name: 'A区 · 最后目击点', bounds: [121.42, 30.65, 121.68, 30.88], status: 'active', coverage: 0 },
  { id: 'area-b', name: 'B区 · 北向漂流', bounds: [121.64, 30.82, 121.96, 31.06], status: 'planned', coverage: 0 }
];
const initialAreas: SearchArea[] = areaSeeds.map((area) => ({ ...area, coverage: coverageForArea(area, initialPositionTrail, now) }));

const initialAssets: RescueAsset[] = [
  { id: 'ship-01', name: '海巡071', type: 'ship', status: 'assigned', lat: 30.75, lng: 121.55, lastSeen: iso(now - 35_000) },
  { id: 'heli-02', name: '救助B-712', type: 'helicopter', status: 'ready', lat: 30.82, lng: 121.73, lastSeen: iso(now - 7 * 60_000) },
  { id: 'drone-03', name: '无人机D-9', type: 'drone', status: 'offline', lat: 30.69, lng: 121.61, lastSeen: iso(now - 18 * 60_000) }
];

const initialMissions: Mission[] = [
  { id: 'mission-1', title: 'A区扇形搜索', areaId: 'area-a', assetIds: ['ship-01', 'drone-03'], status: 'in_progress', priority: 'urgent', note: '优先核验橙色漂浮物', updatedAt: iso(now - 6 * 60_000) }
];

const initialEvents: EventLog[] = [
  { id: 'event-1', time: iso(now - 15 * 60_000), actor: '指挥员', message: 'A区任务下发，海巡071开始扇形搜索' },
  { id: 'event-2', time: iso(now - 6 * 60_000), actor: '无人机D-9', message: '链路中断，最后位置已标记为过期' }
];

interface CommandState {
  areas: SearchArea[];
  assets: RescueAsset[];
  missions: Mission[];
  events: EventLog[];
  offline: boolean;
  lowBandwidth: boolean;
  /** 已入库的位置轨迹（在线直传 + 离线归并），过期点只留档。 */
  positionTrail: PositionReport[];
  /** 已入库的任务进展记录，冲突记录保留双方。 */
  progressTrail: ProgressRecord[];
  /** 离线本地批次：未归并的记录在归并失败后仍然保留。 */
  outbox: OutboxRecord[];
  /** 归并冲突：同一任务两边都推进过时保留的双方记录与差异。 */
  conflicts: ConflictRecord[];
  activeBatchId: string | null;
  mergeStatus: MergeStatus;
  mergeMessage: string;
  /** 模拟服务端临时拒绝：用于演示归并失败后保留批次、只重试未入库部分。 */
  simulateMergeFailure: boolean;
  setAreaStatus: (id: string, status: AreaStatus) => void;
  setAssetStatus: (id: string, status: AssetStatus) => void;
  dispatchMission: (input: { title: string; areaId: string; assetIds: string[]; priority: 'normal' | 'urgent'; note: string }) => void;
  /** 单位上报位置：在线直传入库，断链时照常记入本地批次。 */
  reportPosition: (assetId: string) => void;
  /** 推进任务：在线立即生效，断链时记入本地批次，回线后归并。 */
  advanceMission: (missionId: string, status: MissionStatus, note?: string) => void;
  /** 归并离线批次（手动）：只处理未入库记录。 */
  mergeOutbox: () => void;
  /** 重试归并：只重试未入库部分。 */
  retryOutbox: () => void;
  toggleOffline: () => void;
  toggleBandwidth: () => void;
  setSimulateMergeFailure: (value: boolean) => void;
}

export const useCommandStore = create<CommandState>()(
  persist(
    (set, get) => {
      /**
       * 归并离线批次：逐条处理未入库记录。
       * - 位置：新鲜点入库并推进单位位置，过期点只留档；
       * - 进展：与指挥台状态对齐，同一任务两边都推进过时保留双方、标出差异（晚到不盖先到）；
       * - 失败：保留本地批次，只标记未入库记录，供只重试这部分。
       */
      const mergeBatch = (mode: 'auto' | 'manual') => {
        const state = get();
        const pending = state.outbox.filter((record) => !record.synced);
        if (pending.length === 0) {
          set({ mergeStatus: 'idle', mergeMessage: '没有待归并的离线记录' });
          return;
        }

        const mergeNow = Date.now();
        let positions = 0;
        let progress = 0;
        let archived = 0;
        let conflicts = 0;
        let failed = 0;
        let simulated = false;

        const positionTrail = state.positionTrail.map((point) => ({ ...point }));
        const progressTrail = state.progressTrail.map((record) => ({ ...record }));
        const conflictsList = state.conflicts.map((item) => ({ ...item }));
        const assets = state.assets.map((asset) => ({ ...asset }));
        const missions = state.missions.map((mission) => ({ ...mission }));
        const outbox = state.outbox.map((record) => ({ ...record }));

        for (const record of pending) {
          const target = outbox.find((item) => item.id === record.id)!;
          target.attempts += 1;
          try {
            // 模拟服务端临时拒绝：每个批次第一条记录失败，用于演示失败后保留批次、只重试未入库部分
            if (state.simulateMergeFailure && !simulated) {
              simulated = true;
              throw new Error('模拟服务端拒绝：批次临时不可入库');
            }
            if (record.kind === 'position') {
              const { assetId, lat, lng } = record.payload;
              const asset = assets.find((item) => item.id === assetId);
              if (!asset) throw new Error('单位不存在，位置记录无法入库');
              const reportTime = new Date(record.createdAt).getTime();
              const isArchived = isPositionExpired(record.createdAt, mergeNow);
              positionTrail.push({
                id: record.id,
                assetId: assetId!,
                lat: lat!,
                lng: lng!,
                time: record.createdAt,
                source: 'offline',
                archived: isArchived,
                synced: true,
                batchId: record.batchId
              });
              if (isArchived) {
                archived += 1;
              } else if (reportTime > new Date(asset.lastSeen).getTime()) {
                // 只有新鲜位置才推进单位最后已知位置；先到先得，不回退
                asset.lat = lat!;
                asset.lng = lng!;
                asset.lastSeen = record.createdAt;
              }
              positions += 1;
            } else {
              const { missionId, status, note } = record.payload;
              const mission = missions.find((item) => item.id === missionId);
              if (!mission) throw new Error('任务不存在，进展记录无法入库');
              const offlineTime = new Date(record.createdAt).getTime();
              const remoteTime = new Date(mission.updatedAt).getTime();
              if (remoteTime > offlineTime && mission.status !== status) {
                // 同一任务两边都推进过：晚到的离线记录不覆盖指挥台状态，双方记录都留下并标出差异
                const conflict: ConflictRecord = {
                  id: `conflict-${record.id}`,
                  missionId: missionId!,
                  field: 'status',
                  localValue: status!,
                  localTime: record.createdAt,
                  remoteValue: mission.status,
                  remoteTime: mission.updatedAt,
                  diff: `${mission.status} → ${status}（晚到的离线记录未覆盖指挥台状态）`,
                  time: iso(mergeNow)
                };
                conflictsList.push(conflict);
                progressTrail.push({
                  id: record.id,
                  missionId: missionId!,
                  fromStatus: mission.status,
                  toStatus: status!,
                  note,
                  time: record.createdAt,
                  source: 'offline',
                  synced: true,
                  conflict: true,
                  conflictId: conflict.id,
                  batchId: record.batchId
                });
                conflicts += 1;
              } else {
                mission.status = status!;
                mission.updatedAt = record.createdAt;
                if (note) mission.note = note;
                progressTrail.push({
                  id: record.id,
                  missionId: missionId!,
                  fromStatus: mission.status,
                  toStatus: status!,
                  note,
                  time: record.createdAt,
                  source: 'offline',
                  synced: true,
                  conflict: false,
                  batchId: record.batchId
                });
                progress += 1;
              }
            }
            target.synced = true;
            target.lastError = undefined;
          } catch (error) {
            // 归并失败：保留本地批次，只标记未入库部分，重试时只处理这部分
            target.synced = false;
            target.lastError = (error as Error).message;
            failed += 1;
          }
        }

        // 过期位置只留档：重算归档标记，覆盖率随即重算
        const refreshedTrail = positionTrail.map((point) => ({
          ...point,
          archived: point.archived || isPositionExpired(point.time, mergeNow)
        }));
        const areas = state.areas.map((area) => ({
          ...area,
          coverage: coverageForArea(area, refreshedTrail, mergeNow)
        }));

        const allSynced = failed === 0;
        const stored = positions + progress + conflicts;
        const mergeStatus: MergeStatus = allSynced ? 'success' : stored > 0 ? 'partial' : 'failed';
        const mergeMessage = allSynced
          ? `归并完成：${positions} 条位置、${progress} 条进展入库${archived ? `，${archived} 条过期位置已留档` : ''}${conflicts ? `，${conflicts} 条冲突保留双方记录` : ''}`
          : `归并未完成：${failed} 条记录未入库，本地批次已保留，可只重试未入库部分`;

        const events: EventLog[] = [
          {
            id: uuid(),
            time: iso(mergeNow),
            actor: '指挥台',
            message: `离线批次归并${mode === 'auto' ? '（回线自动）' : ''}：${positions} 条位置、${progress} 条进展入库${archived ? `，${archived} 条过期位置留档` : ''}${conflicts ? `，${conflicts} 条冲突未覆盖指挥台状态` : ''}${failed ? `，${failed} 条失败待重试` : ''}`
          },
          ...(conflicts > 0
            ? [{ id: uuid(), time: iso(mergeNow), actor: '指挥台', message: `检测到 ${conflicts} 条任务进展冲突：离线记录与指挥台状态不一致，已保留双方记录并标出差异` }]
            : []),
          ...(failed > 0
            ? [{ id: uuid(), time: iso(mergeNow), actor: '指挥台', message: `${failed} 条离线记录归并失败，本地批次保留，仅重试未入库部分` }]
            : []),
          ...state.events
        ];

        set({ areas, assets, missions, positionTrail: refreshedTrail, progressTrail, conflicts: conflictsList, outbox, mergeStatus, mergeMessage, events });
      };

      return {
        areas: initialAreas,
        assets: initialAssets,
        missions: initialMissions,
        events: initialEvents,
        offline: false,
        lowBandwidth: false,
        positionTrail: initialPositionTrail,
        progressTrail: [],
        outbox: [],
        conflicts: [],
        activeBatchId: null,
        mergeStatus: 'idle',
        mergeMessage: '',
        simulateMergeFailure: false,
        setAreaStatus: (id, status) => set((state) => ({
          areas: state.areas.map((area) => area.id === id ? { ...area, status } : area),
          events: [{ id: uuid(), time: new Date().toISOString(), actor: '指挥员', message: `搜索区 ${id} 状态改为 ${status}` }, ...state.events]
        })),
        setAssetStatus: (id, status) => set((state) => ({
          assets: state.assets.map((asset) => asset.id === id ? { ...asset, status, lastSeen: new Date().toISOString() } : asset),
          events: [{ id: uuid(), time: new Date().toISOString(), actor: '值班员', message: `${id} 状态改为 ${status}，已生成恢复记录` }, ...state.events]
        })),
        dispatchMission: (input) => set((state) => {
          const mission: Mission = { id: uuid(), ...input, status: 'dispatched', updatedAt: new Date().toISOString() };
          return {
            missions: [mission, ...state.missions],
            assets: state.assets.map((asset) => input.assetIds.includes(asset.id) ? { ...asset, status: 'assigned' } : asset),
            events: [{ id: uuid(), time: new Date().toISOString(), actor: '指挥员', message: `任务“${input.title}”已派发` }, ...state.events]
          };
        }),
        reportPosition: (assetId) => set((state) => {
          const asset = state.assets.find((item) => item.id === assetId);
          if (!asset) return {};
          const lat = asset.lat + (Math.random() - 0.5) * 0.012;
          const lng = asset.lng + (Math.random() - 0.5) * 0.012;
          const recordTime = new Date().toISOString();
          if (state.offline) {
            // 断链照常记录位置：进本地批次，不进指挥台态势
            return {
              outbox: [...state.outbox, {
                id: uuid(),
                batchId: state.activeBatchId ?? uuid(),
                kind: 'position',
                payload: { assetId, lat, lng },
                createdAt: recordTime,
                synced: false,
                attempts: 0
              }]
            };
          }
          return {
            positionTrail: [...state.positionTrail, {
              id: uuid(),
              assetId,
              lat,
              lng,
              time: recordTime,
              source: 'online',
              archived: false,
              synced: true
            }],
            assets: state.assets.map((item) => item.id === assetId ? { ...item, lat, lng, lastSeen: recordTime } : item)
          };
        }),
        advanceMission: (missionId, status, note) => set((state) => {
          const mission = state.missions.find((item) => item.id === missionId);
          if (!mission) return {};
          const recordTime = new Date().toISOString();
          if (state.offline) {
            // 断链照常记录任务进展：进本地批次，回线后归并
            return {
              outbox: [...state.outbox, {
                id: uuid(),
                batchId: state.activeBatchId ?? uuid(),
                kind: 'progress',
                payload: { missionId, status, note },
                createdAt: recordTime,
                synced: false,
                attempts: 0
              }]
            };
          }
          return {
            missions: state.missions.map((item) => item.id === missionId ? { ...item, status, updatedAt: recordTime, note: note ?? item.note } : item),
            progressTrail: [...state.progressTrail, {
              id: uuid(),
              missionId,
              fromStatus: mission.status,
              toStatus: status,
              note,
              time: recordTime,
              source: 'online',
              synced: true,
              conflict: false
            }],
            events: [{ id: uuid(), time: recordTime, actor: '指挥员', message: `任务“${mission.title}”进展：${mission.status} → ${status}` }, ...state.events]
          };
        }),
        mergeOutbox: () => mergeBatch('manual'),
        retryOutbox: () => mergeBatch('manual'),
        toggleOffline: () => {
          const goingOffline = !get().offline;
          set((state) => ({
            offline: goingOffline,
            activeBatchId: goingOffline ? uuid() : null,
            events: [
              {
                id: uuid(),
                time: new Date().toISOString(),
                actor: '指挥台',
                message: goingOffline
                  ? '转入离线：单位位置与任务进展继续记入本地批次，回线后自动归并'
                  : '链路恢复：先归并离线批次，再对齐指挥台状态'
              },
              ...state.events
            ]
          }));
          if (!goingOffline) {
            // 回线后先把离线记录合并进来，再对齐指挥台状态
            mergeBatch('auto');
          }
        },
        toggleBandwidth: () => set((state) => ({ lowBandwidth: !state.lowBandwidth })),
        setSimulateMergeFailure: (value) => set({ simulateMergeFailure: value })
      };
    },
    { name: 'maritime-command-v2' }
  )
);
