export type AreaStatus = 'planned' | 'active' | 'closed';
export type AssetStatus = 'ready' | 'assigned' | 'offline' | 'returning';
export type MissionStatus = 'draft' | 'dispatched' | 'in_progress' | 'closed';

/** 记录由哪一侧产生：本地单位端 或 指挥台（远程） */
export type SyncSide = 'local' | 'remote';

export interface SearchArea {
  id: string;
  name: string;
  bounds: [number, number, number, number];
  status: AreaStatus;
  /** 当前覆盖率（由 coverageBase 与台账即时重算得出） */
  coverage: number;
  /** 初始基准覆盖率，失联不会冻结它，恢复后从台账增量重算 */
  coverageBase: number;
  /** 覆盖率增量台账：覆盖率由这些已入库、未归档的增量即时重算得出 */
  coverageLedger: CoverageGain[];
}

/** 一次已入库的搜索进展所带来的覆盖率增量 */
export interface CoverageGain {
  id: string;
  missionId: string;
  assetId: string;
  /** 增量百分点 */
  delta: number;
  time: string;
  /** 关联的离线记录 id（指挥台直接推进时可为空） */
  recordId?: string;
  /** 关联位置被判定过期时，增量留档但不再计入覆盖率 */
  archived?: boolean;
}

export interface RescueAsset {
  id: string;
  name: string;
  type: 'ship' | 'helicopter' | 'drone' | 'shore';
  status: AssetStatus;
  lat: number;
  lng: number;
  lastSeen: string;
  /** 当前位置是否已过期（过期位置不回灌到地图坐标，只在档案中可见） */
  positionStale?: boolean;
}

export interface Mission {
  id: string;
  title: string;
  areaId: string;
  assetIds: string[];
  status: MissionStatus;
  priority: 'normal' | 'urgent';
  note: string;
  updatedAt: string;
  /** 双向时间线：本单位端与指挥台的每次推进都各自留痕 */
  timeline: ProgressEntry[];
}

/** 一次任务推进记录（单位端 / 指挥台各自一条，永不互相覆盖） */
export interface ProgressEntry {
  id: string;
  missionId: string;
  assetId: string;
  side: SyncSide;
  status: MissionStatus;
  note: string;
  /** 事件实际发生时间，用于判定先到/晚到 */
  at: string;
  /** 入库时间（合并到指挥台的时间） */
  mergedAt?: string;
  recordId?: string;
  /** 该条记录未被采纳为当前状态（晚到的一方） */
  divergent?: boolean;
}

/** 断链期间产生的一条本地记录：位置或任务进展 */
export interface OfflineRecord {
  id: string;
  assetId: string;
  kind: 'position' | 'progress';
  at: string;
  /** 位置记录：断链期间移动到的坐标 */
  lat?: number;
  lng?: number;
  /** 任务进展记录 */
  missionId?: string;
  status?: MissionStatus;
  note?: string;
  /** 该条记录带来的覆盖率增量（百分点） */
  coverageDelta?: number;
  /** 是否已入库（合并到指挥台）。未入库的才会重试 */
  persisted?: boolean;
  /** 入库后被判为过期位置 */
  expired?: boolean;
}

/** 一次断链周期内积累的本地批次 */
export interface SyncBatch {
  id: string;
  assetId: string;
  startedAt: string;
  endedAt: string | null;
  records: OfflineRecord[];
  status: 'open' | 'synced' | 'failed';
  lastError?: string;
}

/** 同一任务两侧都推进过：两份记录都保留并标出差异 */
export interface MissionConflict {
  id: string;
  missionId: string;
  assetId: string;
  windowStart: string;
  local: ProgressEntry;
  remote: ProgressEntry;
  /** 先到的一方：其状态被采纳；晚到的一方标 divergent，不覆盖 */
  winner: SyncSide;
  detectedAt: string;
  resolved?: boolean;
}

/** 过期位置档案：只留档，不参与当前位置与覆盖率 */
export interface PositionArchive {
  id: string;
  assetId: string;
  lat: number;
  lng: number;
  at: string;
  archivedAt: string;
  reason: 'expired' | 'superseded';
}

export interface EventLog {
  id: string;
  time: string;
  actor: string;
  message: string;
}
