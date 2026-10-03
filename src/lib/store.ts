'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  AreaStatus,
  AssetStatus,
  EventLog,
  Mission,
  MissionStatus,
  MissionConflict,
  OfflineRecord,
  PositionArchive,
  RescueAsset,
  SearchArea,
  SyncBatch
} from './types';
import { alignWithCommand, isExpired, mergeBatch, recalcCoverage, uid } from './sync';

const now = Date.now();
const iso = (offsetMs = 0) => new Date(now + offsetMs).toISOString();

const initialAreas: SearchArea[] = [
  { id: 'area-a', name: 'A区 · 最后目击点', bounds: [121.42, 30.65, 121.68, 30.88], status: 'active', coverageBase: 68, coverage: 68, coverageLedger: [] },
  { id: 'area-b', name: 'B区 · 北向漂流', bounds: [121.64, 30.82, 121.96, 31.06], status: 'planned', coverageBase: 32, coverage: 32, coverageLedger: [] }
];
const initialAssets: RescueAsset[] = [
  { id: 'ship-01', name: '海巡071', type: 'ship', status: 'assigned', lat: 30.75, lng: 121.55, lastSeen: iso(-35_000) },
  { id: 'heli-02', name: '救助B-712', type: 'helicopter', status: 'ready', lat: 30.82, lng: 121.73, lastSeen: iso(-7 * 60_000) },
  { id: 'drone-03', name: '无人机D-9', type: 'drone', status: 'offline', lat: 30.69, lng: 121.61, lastSeen: iso(-18 * 60_000), positionStale: true }
];
const initialMissions: Mission[] = [
  {
    id: 'mission-1',
    title: 'A区扇形搜索',
    areaId: 'area-a',
    assetIds: ['ship-01', 'drone-03'],
    status: 'in_progress',
    priority: 'urgent',
    note: '优先核验橙色漂浮物',
    updatedAt: iso(-6 * 60_000),
    timeline: []
  }
];
const initialEvents: EventLog[] = [
  { id: uid('event'), time: iso(-15 * 60_000), actor: '指挥员', message: 'A区任务下发，海巡071开始扇形搜索' },
  { id: uid('event'), time: iso(-6 * 60_000), actor: '无人机D-9', message: '链路中断，断链期间位置与进展转存本地批次，不再靠人工补录' }
];

interface CommandState {
  areas: SearchArea[];
  assets: RescueAsset[];
  missions: Mission[];
  events: EventLog[];
  batches: SyncBatch[];
  archives: PositionArchive[];
  conflicts: MissionConflict[];
  offline: boolean;
  lowBandwidth: boolean;
  /** 演练开关：模拟下一次归并在传输中途失败（仅部分记录入库） */
  simulateSyncFailure: boolean;

  setAreaStatus: (id: string, status: AreaStatus) => void;
  setAssetStatus: (id: string, status: AssetStatus) => void;
  /** 指挥台侧推进任务（断链窗口内若单位也推进，回线时会形成双侧差异） */
  advanceMission: (id: string, patch?: { status?: MissionStatus; note?: string }) => void;
  dispatchMission: (input: { title: string; areaId: string; assetIds: string[]; priority: 'normal' | 'urgent'; note: string }) => void;

  /** 断链期间照常记录：本地位置（可模拟过期位置） */
  logOfflinePosition: (assetId: string, lat: number, lng: number, options?: { at?: string; label?: string }) => void;
  /** 断链期间照常记录：本地任务进展与覆盖率增量（可模拟过期时间戳） */
  logOfflineProgress: (
    assetId: string,
    missionId: string,
    input: { status: MissionStatus; note: string; coverageDelta?: number; at?: string }
  ) => void;
  /** 回线：先合并本地批次，再对齐指挥台状态 */
  reconnectAsset: (assetId: string) => void;
  /** 归并失败后：保留本地批次，只重试未入库的记录 */
  retryBatch: (batchId: string) => void;
  resolveConflict: (conflictId: string) => void;

  toggleOffline: () => void;
  toggleBandwidth: () => void;
  toggleSimulateSyncFailure: () => void;
}

const addEvent = (events: EventLog[], actor: string, message: string): EventLog[] =>
  [{ id: uid('event'), time: new Date().toISOString(), actor, message }, ...events];

/** 取每个任务指挥台侧（远程）最新的一条推进，作为归并时的对照 */
const buildRemoteByMission = (missions: Mission[]): Map<string, Mission['timeline'][number]> => {
  const map = new Map<string, Mission['timeline'][number]>();
  for (const mission of missions) {
    for (const entry of mission.timeline) {
      if (entry.side === 'remote') map.set(mission.id, entry);
    }
  }
  return map;
};

export const useCommandStore = create<CommandState>()(
  persist(
    (set, get) => {
      /** 归并一个批次中的指定记录（失败重试时只传未入库的部分） */
      const ingest = (
        state: CommandState,
        batch: SyncBatch,
        records: OfflineRecord[]
      ): { ok: boolean; error?: string; statePatch?: Partial<CommandState> } => {
        const nowMs = Date.now();
        const result = mergeBatch({
          assets: state.assets,
          missions: state.missions,
          areas: state.areas,
          archives: state.archives,
          conflicts: state.conflicts,
          records,
          assetId: batch.assetId,
          windowStartedAt: batch.startedAt,
          remoteByMission: buildRemoteByMission(state.missions),
          nowMs
        });

        // 模拟传输中途失败：只确认前半段记录入库，其余保留待重试（重试单条时不再制造失败）
        const failThisSync = state.simulateSyncFailure && batch.status === 'open' && records.length > 1;
        let confirmedIds = new Set(result.persistedRecordIds);
        if (failThisSync && records.length > 1) {
          const cutoff = Math.max(1, Math.floor(records.length / 2));
          confirmedIds = new Set(records.slice(0, cutoff).flatMap((r) => result.persistedRecordIds.includes(r.id) ? [r.id] : []));
        }

        const updatedRecords = batch.records.map((record) => {
          if (!confirmedIds.has(record.id)) return record;
          return {
            ...record,
            persisted: true,
            expired: result.expiredRecordIds.includes(record.id) ? true : record.expired
          };
        });

        const allDone = updatedRecords.every((record) => record.persisted);
        const updatedBatch: SyncBatch = {
          ...batch,
          records: updatedRecords,
          status: allDone ? 'synced' : 'failed',
          endedAt: allDone ? new Date(nowMs).toISOString() : batch.endedAt,
          lastError: allDone ? undefined : '归并传输在第 ' + (updatedRecords.filter((r) => r.persisted).length + 1) + ' 条中断，未入库记录保留在本地批次'
        };

        let events = state.events;
        result.events.forEach((event) => { events = addEvent(events, event.actor, event.message); });
        events = addEvent(events, '归并服务',
          allDone
            ? `${batch.assetId} 本地批次 ${updatedRecords.length} 条记录全部入库`
            : `${batch.assetId} 批次部分入库：${confirmedIds.size}/${records.length}，未入库部分待重试`
        );

        const alignedAssets = allDone
          ? alignWithCommand(result.assets, batch.assetId, { status: 'ready', lastSeen: new Date(nowMs).toISOString() }, nowMs)
          : result.assets;

        return {
          ok: allDone,
          statePatch: {
            assets: alignedAssets,
            missions: result.missions,
            areas: result.areas,
            archives: result.archives,
            conflicts: result.conflicts,
            events,
            // 失败演练开关只作用一次：全量入库后自动复位
            simulateSyncFailure: allDone ? false : state.simulateSyncFailure,
            batches: state.batches.map((item) => item.id === batch.id ? updatedBatch : item)
          }
        };
      };

      return {
        areas: initialAreas,
        assets: initialAssets,
        missions: initialMissions,
        events: initialEvents,
        batches: [],
        archives: [],
        conflicts: [],
        offline: false,
        lowBandwidth: false,
        simulateSyncFailure: false,

        setAreaStatus: (id, status) => set((state) => ({
          areas: state.areas.map((area) => area.id === id ? { ...area, status } : area),
          events: addEvent(state.events, '指挥员', `搜索区 ${id} 状态改为 ${status}`)
        })),

        setAssetStatus: (id, status) => set((state) => {
          if (status === 'offline') {
            // 开一个本地批次：断链期间位置与进展照记，不再冻结
            const existing = state.batches.find((batch) => batch.assetId === id && batch.status === 'open');
            const batch: SyncBatch = existing ?? {
              id: uid('batch'),
              assetId: id,
              startedAt: new Date().toISOString(),
              endedAt: null,
              records: [],
              status: 'open'
            };
            return {
              assets: state.assets.map((asset) => asset.id === id ? { ...asset, status, positionStale: asset.positionStale ?? false } : asset),
              batches: existing ? state.batches : [batch, ...state.batches],
              events: addEvent(state.events, '值班员', `${id} 转入失联，本地批次已开启：位置与任务进展继续记录，等待回线归并`)
            };
          }
          // 手动恢复等价于走回线流程（先合并再对齐）
          const openBatch = state.batches.find((batch) => batch.assetId === id && (batch.status === 'open' || batch.status === 'failed'));
          if (openBatch && openBatch.records.some((record) => !record.persisted)) {
            const outcome = ingest(state, openBatch, openBatch.records.filter((record) => !record.persisted));
            return { ...outcome.statePatch } as Partial<CommandState>;
          }
          return {
            assets: state.assets.map((asset) => asset.id === id
              ? { ...asset, status, lastSeen: new Date().toISOString(), positionStale: false }
              : asset),
            events: addEvent(state.events, '值班员', `${id} 状态改为 ${status}`)
          };
        }),

        advanceMission: (id, patch) => set((state) => ({
          missions: state.missions.map((mission) => {
            if (mission.id !== id) return mission;
            const status = patch?.status ?? (mission.status === 'in_progress' ? 'closed' : 'in_progress');
            return {
              ...mission,
              status,
              note: patch?.note ?? mission.note,
              updatedAt: new Date().toISOString(),
              timeline: [...mission.timeline, {
                id: uid('progress'),
                missionId: id,
                assetId: 'command',
                side: 'remote' as const,
                status,
                note: patch?.note ?? '指挥台推进',
                at: new Date().toISOString()
              }]
            };
          }),
          events: addEvent(state.events, '指挥员', `任务 ${id} 由指挥台推进${patch?.note ? `：${patch.note}` : ''}`)
        })),

        dispatchMission: (input) => set((state) => {
          const mission: Mission = {
            id: uid('mission'),
            ...input,
            status: 'dispatched',
            updatedAt: new Date().toISOString(),
            timeline: []
          };
          return {
            missions: [mission, ...state.missions],
            assets: state.assets.map((asset) => input.assetIds.includes(asset.id) ? { ...asset, status: 'assigned' } : asset),
            events: addEvent(state.events, '指挥员', `任务“${input.title}”已派发`)
          };
        }),

        logOfflinePosition: (assetId, lat, lng, options) => set((state) => {
          const batch = state.batches.find((item) => item.assetId === assetId && item.status === 'open');
          if (!batch) return {};
          const at = options?.at ?? new Date().toISOString();
          const record: OfflineRecord = { id: uid('record'), assetId, kind: 'position', at, lat, lng };
          const updated = { ...batch, records: [...batch.records, record] };
          const stale = isExpired(at, Date.now());
          return {
            batches: state.batches.map((item) => item.id === batch.id ? updated : item),
            // 过期位置不上指挥台坐标，只入本地批次；未过期也保持失联前坐标，等回线统一回灌
            assets: stale
              ? state.assets
              : state.assets.map((asset) => asset.id === assetId ? { ...asset, positionStale: false } : asset),
            events: addEvent(state.events, assetId, `断链本地记录位置 (${lat.toFixed(3)}, ${lng.toFixed(3)})${options?.label ? ` · ${options.label}` : ''}${stale ? '（已超有效期，回线后只留档）' : ''}`)
          };
        }),

        logOfflineProgress: (assetId, missionId, input) => set((state) => {
          const batch = state.batches.find((item) => item.assetId === assetId && item.status === 'open');
          if (!batch) return {};
          const at = input.at ?? new Date().toISOString();
          const record: OfflineRecord = {
            id: uid('record'),
            assetId,
            kind: 'progress',
            at,
            missionId,
            status: input.status,
            note: input.note,
            coverageDelta: input.coverageDelta
          };
          const updated = { ...batch, records: [...batch.records, record] };
          return {
            batches: state.batches.map((item) => item.id === batch.id ? updated : item),
            events: addEvent(state.events, assetId, `断链本地推进任务“${missionTitle(missionId, state)}”→ ${input.status}，覆盖率增量 ${input.coverageDelta ?? 0}%${isExpired(at, Date.now()) ? '（记录已过期，增量回线后剔除）' : ''}`)
          };
        }),

        reconnectAsset: (assetId) => {
          const state = get();
          const batch = state.batches.find((item) => item.assetId === assetId && item.status !== 'synced');
          if (!batch || batch.records.every((record) => record.persisted)) {
            set((s) => ({
              assets: s.assets.map((a) => a.id === assetId ? { ...a, status: 'ready', lastSeen: new Date().toISOString(), positionStale: false } : a),
              events: addEvent(s.events, '值班员', `${assetId} 恢复在线（无待归并记录）`)
            }));
            return;
          }
          const pending = batch.records.filter((record) => !record.persisted);
          const outcome = ingest(state, batch, pending);
          set({ ...outcome.statePatch } as Partial<CommandState>);
        },

        retryBatch: (batchId) => set((state) => {
          const batch = state.batches.find((item) => item.id === batchId);
          if (!batch || batch.status !== 'failed') return {};
          const pending = batch.records.filter((record) => !record.persisted);
          if (pending.length === 0) {
            const nowMs = Date.now();
            const synced: SyncBatch = { ...batch, status: 'synced', endedAt: new Date(nowMs).toISOString(), lastError: undefined };
            const assets = alignWithCommand(
              state.assets,
              batch.assetId,
              { status: 'ready', lastSeen: new Date(nowMs).toISOString() },
              nowMs
            );
            return {
              assets,
              batches: state.batches.map((item) => item.id === batchId ? synced : item),
              events: addEvent(state.events, '归并服务', `${batch.assetId} 批次重试成功：全部记录入库，单位状态已对齐指挥台`)
            };
          }
          const retry: SyncBatch = { ...batch, status: 'open', lastError: undefined };
          const prepared = { ...state, batches: state.batches.map((item) => item.id === batchId ? retry : item) };
          const outcome = ingest(prepared, retry, pending);
          return { ...outcome.statePatch } as Partial<CommandState>;
        }),

        resolveConflict: (conflictId) => set((state) => ({
          conflicts: state.conflicts.map((conflict) => conflict.id === conflictId ? { ...conflict, resolved: true } : conflict),
          events: addEvent(state.events, '指挥员', `差异 ${conflictId} 已人工核验：先到记录维持生效，晚到记录留痕备查`)
        })),

        toggleOffline: () => set((state) => ({ offline: !state.offline })),
        toggleBandwidth: () => set((state) => ({ lowBandwidth: !state.lowBandwidth })),
        toggleSimulateSyncFailure: () => set((state) => ({ simulateSyncFailure: !state.simulateSyncFailure }))
      };
    },
    {
      name: 'maritime-command-v2',
      version: 2,
      migrate: (persisted: unknown) => {
        const s = persisted as Partial<CommandState> | undefined;
        if (!s) return s;
        return {
          ...s,
          areas: (s.areas ?? []).map((area) => ({
            ...area,
            coverageBase: area.coverageBase ?? area.coverage ?? 0,
            coverageLedger: area.coverageLedger ?? [],
            coverage: recalcCoverage({ ...area, coverageBase: area.coverageBase ?? area.coverage ?? 0, coverageLedger: area.coverageLedger ?? [] })
          })),
          missions: (s.missions ?? []).map((mission) => ({ ...mission, timeline: mission.timeline ?? [] })),
          batches: s.batches ?? [],
          archives: s.archives ?? [],
          conflicts: s.conflicts ?? []
        };
      }
    }
  )
);

function missionTitle(missionId: string, state: CommandState): string {
  return state.missions.find((mission) => mission.id === missionId)?.title ?? missionId;
}
