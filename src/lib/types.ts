export type AreaStatus = 'planned' | 'active' | 'closed';
export type AssetStatus = 'ready' | 'assigned' | 'offline' | 'returning';
export type MissionStatus = 'draft' | 'dispatched' | 'in_progress' | 'closed';

export interface SearchArea {
  id: string;
  name: string;
  bounds: [number, number, number, number];
  status: AreaStatus;
  coverage: number;
}

export interface RescueAsset {
  id: string;
  name: string;
  type: 'ship' | 'helicopter' | 'drone' | 'shore';
  status: AssetStatus;
  lat: number;
  lng: number;
  lastSeen: string;
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
}

export interface EventLog {
  id: string;
  time: string;
  actor: string;
  message: string;
}

/** 位置记录：在线时直接入库，断链时先入本地批次，归并后转入轨迹。 */
export interface PositionReport {
  id: string;
  assetId: string;
  lat: number;
  lng: number;
  /** 记录产生时间（单位时钟），用于过期判定与先到先得。 */
  time: string;
  source: 'online' | 'offline';
  /** 归并时已过期的位置只留档，不计入覆盖率。 */
  archived: boolean;
  synced: boolean;
  batchId?: string;
}

/** 任务进展记录：断链期间单位侧推进的任务状态，归并时与指挥台状态对齐。 */
export interface ProgressRecord {
  id: string;
  missionId: string;
  fromStatus: MissionStatus;
  toStatus: MissionStatus;
  note?: string;
  time: string;
  source: 'online' | 'offline';
  synced: boolean;
  /** 两边都推进过时标记为冲突，双方记录都保留。 */
  conflict: boolean;
  conflictId?: string;
  batchId?: string;
}

/** 离线批次中的待归并记录。synced=false 的记录归并失败后仍保留，供只重试未入库部分。 */
export interface OutboxRecord {
  id: string;
  batchId: string;
  kind: 'position' | 'progress';
  payload: {
    assetId?: string;
    lat?: number;
    lng?: number;
    missionId?: string;
    status?: MissionStatus;
    note?: string;
  };
  createdAt: string;
  synced: boolean;
  attempts: number;
  lastError?: string;
}

/** 归并冲突：同一任务两边都推进过时，保留双方记录并标出差异，晚到一方不盖掉先到一方。 */
export interface ConflictRecord {
  id: string;
  missionId: string;
  field: string;
  localValue: string;
  localTime: string;
  remoteValue: string;
  remoteTime: string;
  diff: string;
  time: string;
}

export type MergeStatus = 'idle' | 'success' | 'partial' | 'failed';
