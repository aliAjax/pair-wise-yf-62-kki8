import type {
  CoverageGain,
  Mission,
  MissionConflict,
  OfflineRecord,
  PositionArchive,
  ProgressEntry,
  RescueAsset,
  SearchArea,
  SyncSide
} from './types';

let seq = 0;
export const uid = (prefix: string): string => {
  seq = (seq + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
};

/** 位置有效期：超过该时长的位置在合并时判为过期，只留档 */
export const POSITION_TTL_MS = 10 * 60_000;

export const isExpired = (at: string, nowMs: number): boolean => nowMs - new Date(at).getTime() > POSITION_TTL_MS;

/** 覆盖率由台账中「已入库且未归档」的增量即时重算，基准之外不回退到冻结值 */
export function recalcCoverage(area: SearchArea): number {
  const gained = area.coverageLedger
    .filter((entry) => !entry.archived)
    .reduce((sum, entry) => sum + entry.delta, 0);
  return Math.max(0, Math.min(100, area.coverageBase + gained));
}

export interface MergeInput {
  assets: RescueAsset[];
  missions: Mission[];
  areas: SearchArea[];
  archives: PositionArchive[];
  conflicts: MissionConflict[];
  records: OfflineRecord[];
  assetId: string;
  /** 断链窗口起点：只有窗口内指挥台侧的推进才算「两边都推进过」 */
  windowStartedAt: string;
  /** 指挥台状态：以任务 id 索引窗口内已采纳的推进 */
  remoteByMission: Map<string, ProgressEntry>;
  nowMs: number;
}

export interface MergeResult {
  assets: RescueAsset[];
  missions: Mission[];
  areas: SearchArea[];
  archives: PositionArchive[];
  conflicts: MissionConflict[];
  persistedRecordIds: string[];
  expiredRecordIds: string[];
  events: { actor: string; message: string }[];
}

/**
 * 把一个本地批次的记录合并进指挥台状态。
 * 关键约束：
 *  - 先到的一方状态生效，晚到的一方只留痕（divergent），绝不覆盖；
 *  - 同一任务两侧都推进过时两份记录都保留并生成差异；
 *  - 过期位置只进档案，不回灌坐标，覆盖率立即重算。
 */
export function mergeBatch(input: MergeInput): MergeResult {
  const { assets, missions, areas, archives, conflicts, records, assetId, windowStartedAt, remoteByMission, nowMs } = input;
  const persistedRecordIds: string[] = [];
  const expiredRecordIds: string[] = [];

  let nextAssets = assets.map((a) => ({ ...a }));
  let nextMissions = missions.map((m) => ({ ...m, timeline: [...m.timeline] }));
  let nextAreas = areas.map((a) => ({ ...a, coverageLedger: [...a.coverageLedger] }));
  let nextArchives = [...archives];
  let nextConflicts = [...conflicts];

  const asset = nextAssets.find((a) => a.id === assetId);

  // 位置按时间排序：只把「最新且未过期」的坐标回灌到当前位置
  const positions = records
    .filter((r) => r.kind === 'position' && typeof r.lat === 'number' && typeof r.lng === 'number')
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  for (const record of positions) {
    const expired = isExpired(record.at!, nowMs);
    if (expired) {
      expiredRecordIds.push(record.id);
      // 留档即终态：该记录已入库（进入档案），不会再被重试
      persistedRecordIds.push(record.id);
      const alreadyArchived = nextArchives.some((entry) => entry.at === record.at && entry.lat === record.lat && entry.lng === record.lng && entry.assetId === assetId);
      if (!alreadyArchived) {
        nextArchives.push({
          id: uid('archive'),
          assetId,
          lat: record.lat!,
          lng: record.lng!,
          at: record.at!,
          archivedAt: new Date(nowMs).toISOString(),
          reason: 'expired'
        });
      }
      continue;
    }
    if (asset) {
      asset.lat = record.lat!;
      asset.lng = record.lng!;
      asset.lastSeen = record.at!;
      asset.positionStale = false;
    }
    persistedRecordIds.push(record.id);
  }

  // 任务进展：每条都进入双向时间线；冲突时先到生效
  const progressRecords = records
    .filter((r) => r.kind === 'progress' && r.missionId)
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const events: { actor: string; message: string }[] = [];

  for (const record of progressRecords) {
    const mission = nextMissions.find((m) => m.id === record.missionId);
    if (isExpired(record.at!, nowMs)) expiredRecordIds.push(record.id);
    if (!mission) {
      // 指挥台已无此任务：记录仍留痕但无法入库状态，等重试也无意义——存档为已持久化的孤儿
      persistedRecordIds.push(record.id);
      continue;
    }

    const localEntry: ProgressEntry = {
      id: uid('progress'),
      missionId: mission.id,
      assetId,
      side: 'local',
      status: record.status ?? mission.status,
      note: record.note ?? '',
      at: record.at!,
      mergedAt: new Date(nowMs).toISOString(),
      recordId: record.id
    };

    const remoteAll = remoteByMission.get(mission.id);
    // 只把断链窗口内（晚于本批次起点）的指挥台推进算作双侧并发
    const remote = remoteAll && new Date(remoteAll.at).getTime() >= new Date(windowStartedAt).getTime() ? remoteAll : undefined;
    // 同一条记录可能在重试时再次到达，按 recordId 去重
    const already = mission.timeline.some((entry) => entry.recordId === record.id);
    if (already) {
      persistedRecordIds.push(record.id);
      continue;
    }

    mission.timeline.push(localEntry);

    // 覆盖率增量：先入台账，若位置过期则稍后随档案一起归档；此处直接按记录的入库时间有效性判断
    if (record.coverageDelta && record.coverageDelta !== 0) {
      const area = nextAreas.find((item) => item.id === mission.areaId);
      if (area) {
        const gain: CoverageGain = {
          id: uid('gain'),
          missionId: mission.id,
          assetId,
          delta: record.coverageDelta,
          time: record.at!,
          recordId: record.id
        };
        area.coverageLedger.push(gain);
      }
    }

    if (!remote) {
      // 指挥台在断链窗口内没有推进：本地记录直接生效
      mission.status = localEntry.status;
      mission.note = localEntry.note || mission.note;
      mission.updatedAt = localEntry.at;
    } else {
      // 两侧都推进过：比较实际发生时间，先到生效，晚到标差异
      const localFirst = new Date(localEntry.at).getTime() <= new Date(remote.at).getTime();
      const winner: SyncSide = localFirst ? 'local' : 'remote';
      localEntry.divergent = winner !== 'local';
      const remoteEntry = nextMissions
        .find((m) => m.id === mission.id)!
        .timeline.find((entry) => entry.id === remote.id);
      if (remoteEntry) remoteEntry.divergent = winner !== 'remote';

      const winning = winner === 'local' ? localEntry : remote;
      mission.status = winning.status;
      mission.note = winning.note || mission.note;
      mission.updatedAt = winning.at;

      const windowStart = remote.at < localEntry.at ? remote.at : localEntry.at;
      const known = nextConflicts.some((c) => c.missionId === mission.id && (c.local.recordId === record.id || c.local.at === localEntry.at));
      if (!known) {
        nextConflicts.push({
          id: uid('conflict'),
          missionId: mission.id,
          assetId,
          windowStart,
          local: localEntry,
          remote,
          winner,
          detectedAt: new Date(nowMs).toISOString()
        });
      }
      events.push({
        actor: '归并服务',
        message: `任务“${mission.title}”两侧记录均已保留：${winner === 'local' ? '本单位先到已采纳，指挥台晚到仅留痕' : '指挥台先到已采纳，本单位晚到仅留痕'}（状态差异 ${localEntry.status} / ${remote.status}）`
      });
    }

    persistedRecordIds.push(record.id);
  }

  if (expiredRecordIds.length > 0) {
    events.push({ actor: '归并服务', message: `${assetId} 有 ${expiredRecordIds.length} 条过期记录，位置仅留档，相关覆盖率增量已剔除并重算` });
  }

  // 过期位置对应的覆盖率增量随即归档并重算覆盖率
  if (expiredRecordIds.length > 0) {
    nextAreas = nextAreas.map((area) => {
      const ledger = area.coverageLedger.map((gain) =>
        expiredRecordIds.includes(gain.recordId ?? '') ? { ...gain, archived: true } : gain
      );
      return { ...area, coverageLedger: ledger, coverage: recalcCoverage({ ...area, coverageLedger: ledger }) };
    });
  }

  // 所有受影响区域都重算一次（含新增量）
  const touchedAreaIds = new Set(progressRecords.map((r) => nextMissions.find((m) => m.id === r.missionId)?.areaId).filter(Boolean) as string[]);
  nextAreas = nextAreas.map((area) => touchedAreaIds.has(area.id) ? { ...area, coverage: recalcCoverage(area) } : area);

  return {
    assets: nextAssets,
    missions: nextMissions,
    areas: nextAreas,
    archives: nextArchives,
    conflicts: nextConflicts,
    persistedRecordIds,
    expiredRecordIds,
    events
  };
}

/** 回线后「对齐指挥台状态」：以指挥台为准校正单位状态，但任务差异由上面的合并结果保留 */
export function alignWithCommand(
  assets: RescueAsset[],
  assetId: string,
  command: { status?: RescueAsset['status']; lat?: number; lng?: number; lastSeen?: string },
  nowMs: number
): RescueAsset[] {
  return assets.map((asset) => {
    if (asset.id !== assetId) return asset;
    const commandStale = command.lastSeen ? isExpired(command.lastSeen, nowMs) : false;
    return {
      ...asset,
      status: command.status ?? (asset.status === 'offline' ? 'ready' : asset.status),
      // 指挥台坐标过期时不覆盖本地（本地已在合并阶段更新）
      lat: command.lat !== undefined && !commandStale ? command.lat : asset.lat,
      lng: command.lng !== undefined && !commandStale ? command.lng : asset.lng,
      lastSeen: command.lastSeen && !commandStale ? command.lastSeen : asset.lastSeen,
      positionStale: commandStale
    };
  });
}
