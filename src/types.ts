export type DefectStatus = '待派工' | '整治中' | '待复测' | '复测不合格' | '已关闭'
export type DefectType = '轨距' | '高低' | '方向' | '三角坑'
export type Severity = '一级' | '二级' | '三级'

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

export type SegmentReviewStatus = '正常' | '待复核'

export interface TrackSegment {
  id: string
  line: string
  startMileage: number
  endMileage: number
  speedLimit: number
  temporarySpeedLimit?: number
  version: number
  measurements: GeometryMeasurement[]
  /** 限速版本失效后区段回到待复核，不得继续按旧限速显示 */
  reviewStatus?: SegmentReviewStatus
  invalidReason?: string
}

export interface RectificationAction {
  method: '打磨' | '捣固' | '更换' | '垫板调整' | '测量复核'
  note: string
  operator: string
  recordedAt: string
}

export interface RetestResult {
  round: number
  passed: boolean
  measuredValue: number
  limit: number
  note: string
  tester: string
  testedAt: string
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
  /** 旧台账导入的记录可能没有版本号，首次导入时补齐为1 */
  version?: number
}

export interface AuditEntry {
  id: string
  entityId: string
  action: string
  operator: string
  detail: string
  createdAt: string
}

export type SyncSource = '现场离线' | '调度台'
export type OfflineOpStatus = '待同步' | '已确认' | '同步失败'
/** 现场离线可改写的标量字段 */
export type OfflineField = 'owner' | 'status' | 'measuredValue' | 'severity' | 'dueDate'

export interface OfflineOp {
  opId: string
  defectId: string
  /** 现场补充的标量字段 */
  changes: Partial<Record<OfflineField, DefectStatus | Severity | string | number>>
  action?: RectificationAction
  retest?: RetestResult
  /** 记录时刻的标量快照，用于判断调度台是否并发改过同一字段 */
  base: Record<OfflineField, unknown>
  source: SyncSource
  recordedAt: string
  status: OfflineOpStatus
  attempts: number
  lastError?: string
}

export interface ConflictEntry {
  id: string
  entityId: string
  field: OfflineField
  fieldLabel: string
  /** 现场离线版 */
  fieldValue: unknown
  /** 调度台版 */
  deskValue: unknown
  fieldSource: SyncSource
  deskSource: SyncSource
  createdAt: string
  resolved: boolean
}

export interface DispatchAlert {
  id: string
  segmentId: string
  message: string
  createdAt: string
  acknowledged: boolean
}
