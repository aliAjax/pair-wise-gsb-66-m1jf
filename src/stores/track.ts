import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { seedAudit, seedDefects, seedSegments } from '../data/seed'
import type {
  AuditEntry, ConflictEntry, Defect, DefectStatus, DispatchAlert, OfflineField, OfflineOp,
  RectificationAction, RetestResult, TrackSegment
} from '../types'

const STORAGE_KEY = 'gsb66:track-geometry'
let idSeed = 10

const OFFLINE_FIELDS: OfflineField[] = ['owner', 'status', 'measuredValue', 'severity', 'dueDate']
const FIELD_LABELS: Record<OfflineField, string> = { owner: '责任工区', status: '状态', measuredValue: '实测值', severity: '严重度', dueDate: '整改期限' }

interface PersistedState {
  segments: TrackSegment[]
  defects: Defect[]
  audit: AuditEntry[]
  offlineQueue: OfflineOp[]
  conflicts: ConflictEntry[]
  alerts: DispatchAlert[]
  appliedOpIds: string[]
}

/** 旧台账没有版本号时按首次导入补齐为 V1，历史整治记录和复测结果原样保留 */
function normalize(state: Partial<PersistedState>): PersistedState {
  const audit: AuditEntry[] = state.audit ?? []
  const defects = (state.defects ?? []).map((defect) => {
    if (defect.version != null) return defect
    if (!audit.some((entry) => entry.id === `A-LEGACY-${defect.id}`)) {
      audit.unshift({
        id: `A-LEGACY-${defect.id}`, entityId: defect.id, action: '首次导入补齐版本', operator: '系统',
        detail: `旧台账无版本号，按首次导入补齐为V1，保留${defect.actions.length}条整治记录、${defect.retests.length}轮复测结果`,
        createdAt: new Date().toISOString()
      })
    }
    return { ...defect, version: 1 }
  })
  const segments = (state.segments ?? []).map((segment) => ({ reviewStatus: '正常' as const, ...segment }))
  return {
    segments, defects, audit,
    offlineQueue: state.offlineQueue ?? [],
    conflicts: state.conflicts ?? [],
    alerts: state.alerts ?? [],
    appliedOpIds: state.appliedOpIds ?? []
  }
}

function load(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return normalize(parsed ?? { segments: seedSegments, defects: seedDefects, audit: seedAudit })
  } catch {
    return normalize({ segments: seedSegments, defects: seedDefects, audit: seedAudit })
  }
}

export const useTrackStore = defineStore('track', () => {
  const initial = load()
  const segments = ref<TrackSegment[]>(initial.segments)
  const defects = ref<Defect[]>(initial.defects)
  const audit = ref<AuditEntry[]>(initial.audit)
  const offlineQueue = ref<OfflineOp[]>(initial.offlineQueue)
  const conflicts = ref<ConflictEntry[]>(initial.conflicts)
  const alerts = ref<DispatchAlert[]>(initial.alerts)
  /** 已被接收的离线操作，重试时跳过，保证不重复写 */
  const appliedOpIds = ref<string[]>(initial.appliedOpIds)
  /** 演示用：模拟本批同步网络中断 */
  const syncFailureMode = ref(false)
  const keyword = ref('')
  const status = ref<DefectStatus | '全部'>('全部')
  const selectedSegmentId = ref(segments.value[0]?.id ?? '')

  const filtered = computed(() => defects.value.filter((item) => {
    const segment = segments.value.find((value) => value.id === item.segmentId)
    const text = `${item.id} ${segment?.line ?? ''} ${item.type} ${item.owner}`.toLowerCase()
    return (!keyword.value || text.includes(keyword.value.toLowerCase())) && (status.value === '全部' || item.status === status.value)
  }))

  const selectedSegment = computed(() => segments.value.find((item) => item.id === selectedSegmentId.value))
  const pendingOps = computed(() => offlineQueue.value.filter((item) => item.status !== '已确认'))
  const unresolvedConflicts = computed(() => conflicts.value.filter((item) => !item.resolved))
  const activeAlerts = computed(() => alerts.value.filter((item) => !item.acknowledged))

  function versionOf(defect: Defect) {
    return defect.version ?? 1
  }

  function bumpVersion(defect: Defect) {
    defect.version = versionOf(defect) + 1
  }

  function assign(defectIds: string[], owner: string) {
    for (const id of defectIds) {
      const defect = defects.value.find((item) => item.id === id)
      if (!defect) continue
      defect.owner = owner
      defect.status = '整治中'
      bumpVersion(defect)
      addAudit(id, '批量派工', '当前用户', `任务分配至${owner}`)
    }
  }

  function addAction(id: string, action: RectificationAction) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return
    defect.actions.unshift(action)
    defect.status = '待复测'
    bumpVersion(defect)
    addAudit(id, '提交整治记录', action.operator, `${action.method}：${action.note}`)
    evaluateSegmentSpeedValidity(defect.segmentId)
  }

  function addRetest(id: string, retest: RetestResult) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return
    defect.retests.unshift(retest)
    defect.status = retest.passed ? '已关闭' : '复测不合格'
    bumpVersion(defect)
    addAudit(id, '提交复测', retest.tester, retest.passed ? '复测通过' : `第${retest.round}轮未通过`)
    evaluateSegmentSpeedValidity(defect.segmentId, { failedRetest: !retest.passed })
  }

  function transition(id: string, next: DefectStatus) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return { ok: false, message: '缺陷不存在' }
    if (next === '已关闭' && (!defect.retests.length || !defect.retests.some((item) => item.passed))) return { ok: false, message: '没有合格复测记录，不能关闭' }
    if (next === '待复测' && !defect.actions.length) return { ok: false, message: '缺少整治记录，不能申请复测' }
    const prev = defect.status
    defect.status = next
    bumpVersion(defect)
    addAudit(id, `状态流转：${next}`, '当前用户', `由${prev}流转至${next}`)
    return { ok: true, message: `已流转至${next}` }
  }

  function addAudit(entityId: string, action: string, operator: string, detail: string) {
    audit.value.unshift({ id: `A-${Date.now()}-${idSeed++}`, entityId, action, operator, detail, createdAt: new Date().toISOString() })
  }

  function updateSegmentSpeed(id: string, speed: number, temporary: number | undefined) {
    const segment = segments.value.find((item) => item.id === id)
    if (!segment) return { ok: false, message: '区段不存在' }
    const conflict = defects.value.some((item) => item.segmentId === id && item.status !== '已关闭' && item.severity === '一级')
    if (conflict && (!temporary || temporary >= speed)) return { ok: false, message: '一级缺陷未关闭时必须设置更低临时限速' }
    segment.speedLimit = speed
    segment.temporarySpeedLimit = temporary
    segment.version += 1
    if (segment.reviewStatus === '待复核') {
      segment.reviewStatus = '正常'
      segment.invalidReason = undefined
      addAudit(id, '限速复核完成', '工务调度', `重新核定后区段恢复显示，新版本V${segment.version}`)
    }
    addAudit(id, '更新区段速度版本', '工务调度', `正式限速${speed} km/h，临时限速${temporary ?? '无'}`)
    return { ok: true, message: '区段速度版本已更新' }
  }

  /**
   * 缺陷更新后校验区段已计算的限速版本是否仍然成立；
   * 失效则区段回到待复核并提示调度，界面上不得继续按旧限速显示。
   */
  function evaluateSegmentSpeedValidity(segmentId: string, trigger: { failedRetest?: boolean } = {}) {
    const segment = segments.value.find((item) => item.id === segmentId)
    if (!segment) return
    const related = defects.value.filter((item) => item.segmentId === segmentId)
    const reasons: string[] = []
    const openLevel1 = related.some((item) => item.severity === '一级' && item.status !== '已关闭')
    if (openLevel1 && (!segment.temporarySpeedLimit || segment.temporarySpeedLimit >= segment.speedLimit)) reasons.push('一级缺陷未关闭且临时限速未低于正式限速')
    if (trigger.failedRetest) reasons.push('新合并的复测结果不合格，原限速版本计算依据已变化')
    if (!reasons.length || segment.reviewStatus === '待复核') return
    segment.reviewStatus = '待复核'
    segment.invalidReason = reasons.join('；')
    alerts.value.unshift({
      id: `AL-${Date.now()}-${idSeed++}`, segmentId,
      message: `${segment.line} 限速版本V${segment.version}已失效：${segment.invalidReason}。区段回到待复核，不得继续按旧限速显示。`,
      createdAt: new Date().toISOString(), acknowledged: false
    })
    addAudit(segmentId, '限速版本失效', '系统', `区段回到待复核：${segment.invalidReason}`)
  }

  function acknowledgeAlert(id: string) {
    const alert = alerts.value.find((item) => item.id === id)
    if (alert) alert.acknowledged = true
  }

  /** 现场离线记录写入本地队列，不直接落库 */
  function enqueueOffline(defectId: string, payload: { changes?: OfflineOp['changes']; action?: RectificationAction; retest?: RetestResult }) {
    const defect = defects.value.find((item) => item.id === defectId)
    if (!defect) return { ok: false, message: '缺陷不存在' }
    const changes: OfflineOp['changes'] = { ...(payload.changes ?? {}) }
    if (payload.retest && changes.status === undefined) changes.status = payload.retest.passed ? '已关闭' : '复测不合格'
    if (payload.action && !payload.retest && changes.status === undefined) changes.status = '待复测'
    const base: Record<string, unknown> = {}
    for (const field of OFFLINE_FIELDS) base[field] = defect[field]
    const op: OfflineOp = {
      opId: `OP-${Date.now()}-${idSeed++}`, defectId, changes, action: payload.action, retest: payload.retest,
      base, source: '现场离线', recordedAt: new Date().toISOString(), status: '待同步', attempts: 0
    }
    offlineQueue.value.unshift(op)
    const operator = payload.action?.operator ?? payload.retest?.tester ?? '现场人员'
    addAudit(defectId, '离线补录入队', operator, `现场离线记录${op.opId}已写入本地队列，回到网络后逐条合并`)
    return { ok: true, message: `已写入离线队列（${op.opId}），待回网合并` }
  }

  function addConflict(entityId: string, field: OfflineField, fieldValue: unknown, deskValue: unknown) {
    conflicts.value.unshift({
      id: `CF-${Date.now()}-${idSeed++}`, entityId, field, fieldLabel: FIELD_LABELS[field],
      fieldValue, deskValue, fieldSource: '现场离线', deskSource: '调度台',
      createdAt: new Date().toISOString(), resolved: false
    })
    addAudit(entityId, '字段冲突', '系统', `${FIELD_LABELS[field]}被现场与调度台同时修改，已列出两版待裁决`)
  }

  /** 逐条合并：不同字段的现场补充保留，同一字段双方改过则列出两版 */
  function applyOp(op: OfflineOp) {
    const defect = defects.value.find((item) => item.id === op.defectId)
    if (!defect) return { conflicts: 0 }
    let conflictCount = 0
    let changed = false
    for (const field of OFFLINE_FIELDS) {
      const value = op.changes[field]
      if (value === undefined || value === op.base[field]) continue
      const current = defect[field] as unknown
      const deskChanged = current !== op.base[field]
      if (deskChanged && current !== value) {
        conflictCount += 1
        addConflict(defect.id, field, value, current)
      } else {
        ;(defect as unknown as Record<string, unknown>)[field] = value
        changed = true
      }
    }
    if (op.action && !defect.actions.some((item) => item.recordedAt === op.action!.recordedAt && item.operator === op.action!.operator && item.method === op.action!.method)) {
      defect.actions.unshift(op.action)
      changed = true
    }
    if (op.retest && !defect.retests.some((item) => item.testedAt === op.retest!.testedAt && item.tester === op.retest!.tester)) {
      const round = defect.retests.some((item) => item.round === op.retest!.round)
        ? Math.max(0, ...defect.retests.map((item) => item.round)) + 1
        : op.retest.round
      defect.retests.unshift({ ...op.retest, round })
      changed = true
    }
    if (changed) {
      bumpVersion(defect)
      addAudit(defect.id, '离线记录合并', '系统', `合并现场离线记录${op.opId}，保留原始记录时间和复测轮次`)
    }
    evaluateSegmentSpeedValidity(defect.segmentId, { failedRetest: !!op.retest && !op.retest.passed })
    return { conflicts: conflictCount }
  }

  /** 合并本批离线记录；只处理未确认项，已接收的操作按opId跳过不重复写 */
  function syncBatch() {
    const pending = offlineQueue.value.filter((item) => item.status !== '已确认')
    if (!pending.length) return { ok: false, message: '没有待同步的离线记录' }
    if (syncFailureMode.value) {
      for (const op of pending) {
        op.status = '同步失败'
        op.attempts += 1
        op.lastError = '网络中断，本批未确认'
      }
      addAudit('SYNC', '同步失败', '系统', `本批${pending.length}条离线记录未确认，可继续重试`)
      return { ok: false, message: `同步失败：${pending.length}条未确认，可继续重试（仅重试未确认项）` }
    }
    let merged = 0
    let skipped = 0
    let conflictCount = 0
    for (const op of pending) {
      if (appliedOpIds.value.includes(op.opId)) {
        op.status = '已确认'
        skipped += 1
        continue
      }
      conflictCount += applyOp(op).conflicts
      appliedOpIds.value.push(op.opId)
      op.status = '已确认'
      op.attempts += 1
      op.lastError = undefined
      merged += 1
    }
    addAudit('SYNC', '离线记录合并', '系统', `本批合并${merged}条，跳过已接收${skipped}条，产生${conflictCount}处字段冲突`)
    return { ok: true, message: `已合并${merged}条${skipped ? `，${skipped}条已接收跳过` : ''}，字段冲突${conflictCount}处` }
  }

  /** 冲突裁决：采用现场版或保留调度台版 */
  function resolveConflict(id: string, choice: 'field' | 'desk') {
    const conflict = conflicts.value.find((item) => item.id === id)
    if (!conflict || conflict.resolved) return
    const defect = defects.value.find((item) => item.id === conflict.entityId)
    if (defect && choice === 'field') {
      ;(defect as unknown as Record<string, unknown>)[conflict.field] = conflict.fieldValue
      bumpVersion(defect)
      evaluateSegmentSpeedValidity(defect.segmentId, { failedRetest: defect.status === '复测不合格' })
    }
    conflict.resolved = true
    addAudit(conflict.entityId, '冲突裁决', '当前用户', `${conflict.fieldLabel}采用${choice === 'field' ? '现场离线版' : '调度台版'}`)
  }

  /** 演示用：模拟调度台在离线期间并发改了同一处派工 */
  function simulateDeskEdit(defectId: string) {
    const defect = defects.value.find((item) => item.id === defectId)
    if (!defect) return
    defect.owner = defect.owner === '工务一工区' ? '工务二工区' : '工务一工区'
    defect.status = defect.status === '整治中' ? '待派工' : '整治中'
    bumpVersion(defect)
    addAudit(defectId, '调度台并发修改', '工务调度', `离线期间改派至${defect.owner}并调整状态为${defect.status}`)
  }

  function reset() {
    const fresh = normalize({ segments: structuredClone(seedSegments), defects: structuredClone(seedDefects), audit: structuredClone(seedAudit) })
    segments.value = fresh.segments
    defects.value = fresh.defects
    audit.value = fresh.audit
    offlineQueue.value = []
    conflicts.value = []
    alerts.value = []
    appliedOpIds.value = []
  }

  watch(
    [segments, defects, audit, offlineQueue, conflicts, alerts, appliedOpIds],
    () => localStorage.setItem(STORAGE_KEY, JSON.stringify({
      segments: segments.value, defects: defects.value, audit: audit.value,
      offlineQueue: offlineQueue.value, conflicts: conflicts.value, alerts: alerts.value, appliedOpIds: appliedOpIds.value
    })),
    { deep: true }
  )

  return {
    segments, defects, audit, offlineQueue, conflicts, alerts, syncFailureMode,
    keyword, status, selectedSegmentId, filtered, selectedSegment, pendingOps, unresolvedConflicts, activeAlerts,
    assign, addAction, addRetest, transition, updateSegmentSpeed, acknowledgeAlert,
    enqueueOffline, syncBatch, resolveConflict, simulateDeskEdit, evaluateSegmentSpeedValidity, reset
  }
})
