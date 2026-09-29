import { setActivePinia, createPinia } from 'pinia'

// localStorage stub
const mem = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k)
}

const { useTrackStore } = await import('../src/stores/track')

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1 } else console.log('ok:', msg)
}

setActivePinia(createPinia())
const store = useTrackStore()

// 1. legacy backfill: seed defect GD-260927-03 has no version -> V1 + audit
const legacy = store.defects.find((d) => d.id === 'GD-260927-03')!
assert(legacy.version === 1, '旧台账无版本缺陷补齐为V1')
assert(legacy.actions.length === 1 && legacy.retests.length === 1, '历史整治记录和复测结果保留')
assert(store.audit.some((a) => a.action === '首次导入补齐版本' && a.entityId === 'GD-260927-03'), '补齐版本留痕')

// 2. enqueue offline retest (failed) on GD-260929-01, then desk concurrently edits same defect
const target = store.defects.find((d) => d.id === 'GD-260929-01')!
const baseVersion = target.version!
store.enqueueOffline('GD-260929-01', { retest: { round: 1, passed: false, measuredValue: 1448, limit: 1446, note: '夜间复测仍超限', tester: '王磊', testedAt: '2026-09-29T23:40:00' } })
assert(store.offlineQueue.length === 1 && store.offlineQueue[0].status === '待同步', '离线记录写入本地队列')
assert(target.version === baseVersion && target.retests.length === 0, '入队不直接落库')

// desk concurrently changes owner+status
store.simulateDeskEdit('GD-260929-01')

// 3. sync failure mode: batch fails, retry only unconfirmed
store.syncFailureMode = true
const fail = store.syncBatch()
assert(!fail.ok && store.offlineQueue[0].status === '同步失败', '模拟网络中断本批失败')
store.syncFailureMode = false
const retry = store.syncBatch()
assert(retry.ok && store.offlineQueue[0].status === '已确认', '重试未确认项成功')

// 4. after merge: retest appended, status conflict listed (desk changed status, field retest implies 复测不合格)
const after = store.defects.find((d) => d.id === 'GD-260929-01')!
assert(after.retests.length === 1 && after.retests[0].testedAt === '2026-09-29T23:40:00', '复测值合并且保留原始记录时间')
assert(store.conflicts.some((c) => c.entityId === 'GD-260929-01' && c.field === 'status' && !c.resolved), '状态字段冲突列出两版')
const conflict = store.conflicts.find((c) => c.field === 'status')!
assert(conflict.fieldSource === '现场离线' && conflict.deskSource === '调度台', '冲突标明来源')
assert(conflict.fieldValue === '复测不合格' && conflict.deskValue === '待派工', '两版值正确')

// 5. idempotent retry: re-running sync does not duplicate
const again = store.syncBatch()
assert(after.retests.length === 1, '已确认记录不重复写')

// 6. segment invalidated: failed retest on SEG-K102 -> 待复核 + alert
const seg = store.segments.find((s) => s.id === 'SEG-K102')!
assert(seg.reviewStatus === '待复核', '复测不合格使区段回到待复核')
assert(store.alerts.some((a) => a.segmentId === 'SEG-K102' && !a.acknowledged), '提示调度')
const speedResult = store.updateSegmentSpeed('SEG-K102', 160, 100)
assert(speedResult.ok && store.segments.find((s) => s.id === 'SEG-K102')!.reviewStatus === '正常', '重新核定限速后恢复正常')

// 7. conflict resolution: adopt field version
store.resolveConflict(conflict.id, 'field')
assert(after.status === '复测不合格' && store.conflicts.find((c) => c.id === conflict.id)!.resolved, '采用现场版后状态生效')

// 8. non-conflicting field merge: enqueue owner change, no desk edit -> applied directly
store.enqueueOffline('GD-260929-02', { changes: { dueDate: '2026-10-02' } })
store.syncBatch()
const d2 = store.defects.find((d) => d.id === 'GD-260929-02')!
assert(d2.dueDate === '2026-10-02' && !store.conflicts.some((c) => c.entityId === 'GD-260929-02' && !c.resolved), '不同字段现场补充直接保留')

console.log('done')
