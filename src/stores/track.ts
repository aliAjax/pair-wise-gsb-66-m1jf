import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { legacyDefects, legacySegments, seedAudit, seedDefects, seedSegments } from '../data/seed'
import type { AuditEntry, Defect, DefectStatus, FieldConflict, OfflineRecord, OfflineRecordKind, RectificationAction, RetestResult, SyncBatch, TrackSegment, BatchSnapshot } from '../types'

const STORAGE_KEY = 'gsb66:track-geometry'
let idSeed = 10

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      return {
        segments: parsed.segments ?? seedSegments,
        defects: (parsed.defects ?? seedDefects).map((item: Defect) => ({ ...item, dispatchVersion: item.dispatchVersion ?? 0 })),
        audit: parsed.audit ?? seedAudit,
        offlineRecords: parsed.offlineRecords ?? [],
        syncBatches: parsed.syncBatches ?? []
      }
    }
  } catch {
    // 本地数据损坏时回退到种子数据
  }
  return { segments: seedSegments, defects: seedDefects.map((item) => ({ ...item })), audit: seedAudit, offlineRecords: [] as OfflineRecord[], syncBatches: [] as SyncBatch[] }
}

export const useTrackStore = defineStore('track', () => {
  const initial = load()
  const segments = ref<TrackSegment[]>(initial.segments)
  const defects = ref<Defect[]>(initial.defects)
  const audit = ref<AuditEntry[]>(initial.audit)
  const offlineRecords = ref<OfflineRecord[]>(initial.offlineRecords)
  const syncBatches = ref<SyncBatch[]>(initial.syncBatches)
  const keyword = ref('')
  const status = ref<DefectStatus | '全部'>('全部')
  const selectedSegmentId = ref(segments.value[0]?.id ?? '')

  const filtered = computed(() => defects.value.filter((item) => {
    const segment = segments.value.find((value) => value.id === item.segmentId)
    const text = `${item.id} ${segment?.line ?? ''} ${item.type} ${item.owner}`.toLowerCase()
    return (!keyword.value || text.includes(keyword.value.toLowerCase())) && (status.value === '全部' || item.status === status.value)
  }))

  const selectedSegment = computed(() => segments.value.find((item) => item.id === selectedSegmentId.value))

  const pendingCount = computed(() => offlineRecords.value.filter((item) => item.status === '待同步' || item.status === '失败').length)
  const conflictCount = computed(() => offlineRecords.value.filter((item) => item.status === '冲突').length)

  function nextId(prefix: string) {
    return `${prefix}-${Date.now()}-${idSeed++}`
  }

  function addAudit(entityId: string, action: string, operator: string, detail: string) {
    audit.value.unshift({ id: `A-${Date.now()}-${idSeed++}`, entityId, action, operator, detail, createdAt: new Date().toISOString() })
  }

  // 缺陷变更后，若影响限速计算，区段回到待复核，旧限速不得继续作为执行依据
  function invalidateSegmentReview(defect: Defect, reason: string) {
    const segment = segments.value.find((item) => item.id === defect.segmentId)
    if (!segment) return
    const affectsSpeed = defect.severity === '一级' && defect.status !== '已关闭'
    if (affectsSpeed && segment.reviewStatus !== '待复核') {
      segment.reviewStatus = '待复核'
      segment.reviewReason = `缺陷 ${defect.id}（${defect.type}）${reason}，已计算的限速版本失效，待调度重新复核`
      addAudit(segment.id, '限速版本待复核', '系统', segment.reviewReason)
    }
  }

  function assign(defectIds: string[], owner: string) {
    for (const id of defectIds) {
      const defect = defects.value.find((item) => item.id === id)
      if (!defect) continue
      defect.owner = owner
      defect.status = '整治中'
      defect.version += 1
      defect.dispatchVersion += 1
      addAudit(id, '批量派工', '当前用户', `任务分配至${owner}`)
    }
  }

  function addAction(id: string, action: RectificationAction) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return
    defect.actions.unshift(action)
    defect.status = '待复测'
    defect.version += 1
    addAudit(id, '提交整治记录', action.operator, `${action.method}：${action.note}`)
    invalidateSegmentReview(defect, '提交整治记录后状态变更')
  }

  function addRetest(id: string, retest: RetestResult) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return
    defect.retests.unshift(retest)
    defect.status = retest.passed ? '已关闭' : '复测不合格'
    defect.version += 1
    addAudit(id, '提交复测', retest.tester, retest.passed ? '复测通过' : `第${retest.round}轮未通过`)
    invalidateSegmentReview(defect, retest.passed ? '复测通过' : '复测未通过')
  }

  function transition(id: string, next: DefectStatus) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return { ok: false, message: '缺陷不存在' }
    if (next === '已关闭' && (!defect.retests.length || !defect.retests.some((item) => item.passed))) return { ok: false, message: '没有合格复测记录，不能关闭' }
    if (next === '待复测' && !defect.actions.length) return { ok: false, message: '缺少整治记录，不能申请复测' }
    const before = defect.status
    defect.status = next
    defect.version += 1
    defect.dispatchVersion += 1
    addAudit(id, `状态流转：${next}`, '当前用户', `由${before}流转至${next}`)
    invalidateSegmentReview(defect, `状态流转为${next}`)
    return { ok: true, message: `已流转至${next}` }
  }

  function updateSegmentSpeed(id: string, speed: number, temporary: number | undefined) {
    const segment = segments.value.find((item) => item.id === id)
    if (!segment) return { ok: false, message: '区段不存在' }
    const conflict = defects.value.some((item) => item.segmentId === id && item.status !== '已关闭' && item.severity === '一级')
    if (conflict && (!temporary || temporary >= speed)) return { ok: false, message: '一级缺陷未关闭时必须设置更低临时限速' }
    segment.speedLimit = speed
    segment.temporarySpeedLimit = temporary
    segment.version += 1
    segment.reviewStatus = '已复核'
    segment.reviewReason = undefined
    addAudit(id, '更新区段速度版本', '工务调度', `正式限速${speed} km/h，临时限速${temporary ?? '无'}，限速版本复核通过`)
    return { ok: true, message: '区段速度版本已更新并复核通过' }
  }

  // ---- 离线记录：现场无网络时写入本地队列 ----
  function createOfflineRecord(kind: OfflineRecordKind, entityId: string, payload: RectificationAction | RetestResult) {
    const defect = defects.value.find((item) => item.id === entityId)
    const record: OfflineRecord = {
      id: nextId('OFF'),
      kind,
      entityId,
      payload: { ...payload, clientId: undefined },
      createdAt: new Date().toISOString(),
      baseStatus: defect?.status ?? '',
      baseDispatchVersion: defect?.dispatchVersion ?? 0,
      status: '待同步',
      conflicts: []
    }
    record.payload.clientId = record.id
    offlineRecords.value.unshift(record)
    const label = kind === 'rectification' ? '整治记录' : '复测结果'
    const operator = kind === 'rectification' ? (payload as RectificationAction).operator : (payload as RetestResult).tester
    addAudit(entityId, '离线补录', operator, `现场离线${label}已写入本地队列（${record.id}），待恢复网络后逐条合并`)
    return record
  }

  // ---- 同步批次：把当前待同步/失败项打成一批，逐条合并 ----
  function createBatch(weakNetwork: boolean): SyncBatch {
    const records = offlineRecords.value.filter((item) => item.status === '待同步' || item.status === '失败')
    const snapshots: Record<string, BatchSnapshot> = {}
    for (const record of records) {
      const defect = defects.value.find((item) => item.id === record.entityId)
      if (defect) snapshots[defect.id] = { status: defect.status }
    }
    const batch: SyncBatch = {
      id: nextId('BATCH'),
      createdAt: new Date().toISOString(),
      status: '待同步',
      weakNetwork,
      snapshots
    }
    syncBatches.value.unshift(batch)
    for (const record of records) record.batchId = batch.id
    return batch
  }

  function targetStatusOf(record: OfflineRecord): DefectStatus {
    if (record.kind === 'rectification') return '待复测'
    return (record.payload as RetestResult).passed ? '已关闭' : '复测不合格'
  }

  function attemptSync(record: OfflineRecord, weakNetwork: boolean): { ok: boolean; message: string } {
    // 幂等：已接收的记录绝不重复写
    if (record.status === '已接收') return { ok: true, message: '已接收，跳过' }
    const defect = defects.value.find((item) => item.id === record.entityId)
    if (!defect) {
      record.status = '失败'
      record.failReason = '缺陷台账中不存在该实体，无法合并'
      return { ok: false, message: record.failReason }
    }
    const alreadyWritten = record.kind === 'rectification'
      ? defect.actions.some((item) => item.clientId === record.id)
      : defect.retests.some((item) => item.clientId === record.id)
    if (alreadyWritten) {
      record.status = '已接收'
      record.mergedAt = new Date().toISOString()
      return { ok: true, message: '记录已写入，确认为已接收' }
    }
    // 弱网模拟：批次内部分记录同步失败，可重试
    if (weakNetwork && Math.random() < 0.4) {
      record.status = '失败'
      record.failReason = '网络中断，服务端未确认接收'
      return { ok: false, message: record.failReason }
    }
    // 字段级合并：现场补充的 actions/retests 是不同字段，保留；状态字段若双方都改过则列两版
    const conflicts: FieldConflict[] = []
    const target = targetStatusOf(record)
    if (defect.dispatchVersion !== record.baseDispatchVersion) {
      conflicts.push({
        field: 'status',
        label: '缺陷状态',
        localValue: target,
        serverValue: defect.status,
        localSource: '现场',
        serverSource: '调度'
      })
    }
    if (record.kind === 'rectification') {
      defect.actions.unshift(record.payload as RectificationAction)
    } else {
      defect.retests.unshift(record.payload as RetestResult)
    }
    if (conflicts.length) {
      // 现场补充的整治/复测记录已保留；冲突字段待裁决，不覆盖调度版本
      record.status = '冲突'
      record.conflicts = conflicts
      addAudit(defect.id, '同步冲突待裁决', '系统', `现场${record.kind === 'rectification' ? '整治记录' : '复测结果'}与调度端状态变更冲突：现场版「${target}」/ 调度版「${defect.status}」，已列两版标明来源`)
      return { ok: false, message: '存在字段冲突，待裁决' }
    }
    defect.status = target
    defect.version += 1
    record.status = '已接收'
    record.mergedAt = new Date().toISOString()
    addAudit(defect.id, '离线记录已合并', record.kind === 'rectification' ? (record.payload as RectificationAction).operator : (record.payload as RetestResult).tester,
      `现场${record.kind === 'rectification' ? '整治记录' : '复测结果'}（${record.id}）合并完成，状态更新为「${target}」`)
    invalidateSegmentReview(defect, `现场${record.kind === 'rectification' ? '整治记录' : '复测结果'}合并后状态为「${target}」`)
    return { ok: true, message: '合并成功' }
  }

  function refreshBatchStatus(batch: SyncBatch) {
    const records = offlineRecords.value.filter((item) => item.batchId === batch.id)
    if (!records.length) { batch.status = '待同步'; return }
    const received = records.filter((item) => item.status === '已接收').length
    const pending = records.some((item) => item.status === '失败' || item.status === '冲突')
    if (received === records.length) batch.status = '全部成功'
    else if (pending) batch.status = '部分成功'
    else batch.status = '待同步'
  }

  function syncBatch(batchId: string) {
    const batch = syncBatches.value.find((item) => item.id === batchId)
    if (!batch) return
    const records = offlineRecords.value.filter((item) => item.batchId === batchId && item.status !== '已接收')
    for (const record of records) attemptSync(record, batch.weakNetwork)
    refreshBatchStatus(batch)
  }

  function retryBatch(batchId: string) {
    const batch = syncBatches.value.find((item) => item.id === batchId)
    if (!batch) return
    // 只重试未确认（失败）项，已接收项不再重写
    const records = offlineRecords.value.filter((item) => item.batchId === batchId && item.status === '失败')
    for (const record of records) attemptSync(record, batch.weakNetwork)
    refreshBatchStatus(batch)
  }

  function retryRecord(recordId: string) {
    const record = offlineRecords.value.find((item) => item.id === recordId)
    if (!record || record.status !== '失败') return
    const batch = syncBatches.value.find((item) => item.id === record.batchId)
    attemptSync(record, batch?.weakNetwork ?? false)
    if (batch) refreshBatchStatus(batch)
  }

  // 冲突裁决：选择采纳哪一版，另一版留痕可查
  function resolveConflict(recordId: string, choice: '现场' | '调度') {
    const record = offlineRecords.value.find((item) => item.id === recordId)
    if (!record || record.status !== '冲突') return
    const defect = defects.value.find((item) => item.id === record.entityId)
    if (choice === '现场' && defect) {
      const target = targetStatusOf(record)
      defect.status = target
      defect.version += 1
      invalidateSegmentReview(defect, `冲突裁决采纳现场版，状态为「${target}」`)
    }
    record.status = '已接收'
    record.mergedAt = new Date().toISOString()
    const conflict = record.conflicts[0]
    addAudit(record.entityId, '冲突裁决', '调度员', `采纳${choice}版本：${conflict?.label ?? '状态'}以「${choice === '现场' ? record.conflicts[0]?.localValue : record.conflicts[0]?.serverValue}」为准；另一版已留痕`)
    record.conflicts = []
    if (record.batchId) {
      const batch = syncBatches.value.find((item) => item.id === record.batchId)
      if (batch) refreshBatchStatus(batch)
    }
  }

  // 模拟调度端在现场离线期间的并发变更（派工/状态调整）
  function simulateDispatchChange(defectId: string, kind: 'reassign' | 'status') {
    const defect = defects.value.find((item) => item.id === defectId)
    if (!defect) return
    if (kind === 'reassign') {
      const owners = ['工务一工区', '工务二工区', '桥隧工区']
      const next = owners[Math.floor(Math.random() * owners.length)]
      defect.owner = next
      defect.version += 1
      defect.dispatchVersion += 1
      addAudit(defectId, '调度派工变更', '调度台（模拟）', `现场离线期间调度台重新派工至${next}`)
    } else {
      const next: DefectStatus = defect.status === '整治中' ? '待派工' : '整治中'
      defect.status = next
      defect.version += 1
      defect.dispatchVersion += 1
      addAudit(defectId, '调度状态调整', '调度台（模拟）', `现场离线期间调度台将状态调整为「${next}」`)
      invalidateSegmentReview(defect, `调度端状态调整为「${next}」`)
    }
  }

  // 旧台账导入：无版本号按首次导入补齐 V1，历史整治记录和复测结果保留可查
  function importLegacyLedger(): { imported: number; message: string } {
    let imported = 0
    for (const legacy of legacyDefects) {
      if (defects.value.some((item) => item.id === legacy.id)) continue
      const version = legacy.version && legacy.version > 0 ? legacy.version : 1
      defects.value.push({ ...legacy, version })
      addAudit(legacy.id, '旧台账导入', '系统', `旧台账无版本号，按首次导入补齐 V${version}；历史整治记录 ${legacy.actions.length} 条、复测结果 ${legacy.retests.length} 条保留可查`)
      imported += 1
    }
    for (const legacy of legacySegments) {
      const existing = segments.value.find((item) => item.id === legacy.id)
      if (existing) {
        if (!existing.version || existing.version <= 0) {
          existing.version = 1
          addAudit(legacy.id, '旧台账导入', '系统', '旧台账区段无版本号，按首次导入补齐 V1')
        }
        continue
      }
      segments.value.push({ ...legacy, version: 1 })
      addAudit(legacy.id, '旧台账导入', '系统', '旧台账区段无版本号，按首次导入补齐 V1')
      imported += 1
    }
    return { imported, message: `旧台账导入完成：补齐版本 ${imported} 项，历史整治与复测记录可在整治复测页查询` }
  }

  function reset() {
    segments.value = structuredClone(seedSegments)
    defects.value = structuredClone(seedDefects)
    audit.value = structuredClone(seedAudit)
    offlineRecords.value = []
    syncBatches.value = []
  }

  watch([segments, defects, audit, offlineRecords, syncBatches], () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      segments: segments.value,
      defects: defects.value,
      audit: audit.value,
      offlineRecords: offlineRecords.value,
      syncBatches: syncBatches.value
    }))
  }, { deep: true })

  return {
    segments, defects, audit, offlineRecords, syncBatches,
    keyword, status, selectedSegmentId,
    filtered, selectedSegment, pendingCount, conflictCount,
    assign, addAction, addRetest, transition, updateSegmentSpeed,
    createOfflineRecord, createBatch, syncBatch, retryBatch, retryRecord, resolveConflict,
    simulateDispatchChange, importLegacyLedger, reset
  }
})
