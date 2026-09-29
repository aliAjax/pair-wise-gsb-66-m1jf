export type DefectStatus = '待派工' | '整治中' | '待复测' | '复测不合格' | '已关闭'
export type DefectType = '轨距' | '高低' | '方向' | '三角坑'
export type Severity = '一级' | '二级' | '三级'
export type ReviewStatus = '已复核' | '待复核'
export type DataSource = '现场' | '调度' | '导入'

export interface GeometryMeasurement {
  id: string
  mileage: number
  gauge: number
  level: number
  alignment: number
  twist: number
  measuredAt: string
  detector: string
}

export interface TrackSegment {
  id: string
  line: string
  startMileage: number
  endMileage: number
  speedLimit: number
  temporarySpeedLimit?: number
  version: number
  reviewStatus: ReviewStatus
  reviewReason?: string
  measurements: GeometryMeasurement[]
}

export interface RectificationAction {
  method: '打磨' | '捣固' | '更换' | '垫板调整' | '测量复核'
  note: string
  operator: string
  recordedAt: string
  clientId?: string
}

export interface RetestResult {
  round: number
  passed: boolean
  measuredValue: number
  limit: number
  note: string
  tester: string
  testedAt: string
  clientId?: string
}

export interface Defect {
  id: string
  segmentId: string
  mileage: number
  type: DefectType
  severity: Severity
  measuredValue: number
  limit: number
  status: DefectStatus
  owner: string
  discoveredAt: string
  dueDate: string
  actions: RectificationAction[]
  retests: RetestResult[]
  version: number
  dispatchVersion: number
}

export interface AuditEntry {
  id: string
  entityId: string
  action: string
  operator: string
  detail: string
  createdAt: string
}

// 离线记录：现场无网络时写入本地队列，恢复后逐条与调度端合并
export type OfflineRecordKind = 'rectification' | 'retest'
export type OfflineRecordStatus = '待同步' | '已接收' | '冲突' | '失败'

export interface FieldConflict {
  field: string
  label: string
  localValue: string
  serverValue: string
  localSource: DataSource
  serverSource: DataSource
}

export interface OfflineRecord {
  id: string
  kind: OfflineRecordKind
  entityId: string
  payload: RectificationAction | RetestResult
  createdAt: string
  baseStatus: string          // 离线录入时的缺陷状态快照
  baseDispatchVersion: number // 离线录入时调度端变更计数，用于检测双方是否同改一个字段
  status: OfflineRecordStatus
  batchId?: string
  conflicts: FieldConflict[]
  failReason?: string
  mergedAt?: string
}

export interface BatchSnapshot {
  status: string
}

export interface SyncBatch {
  id: string
  createdAt: string
  status: '待同步' | '部分成功' | '全部成功' | '失败'
  weakNetwork: boolean
  snapshots: Record<string, BatchSnapshot>
}
