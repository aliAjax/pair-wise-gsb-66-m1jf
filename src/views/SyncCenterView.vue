<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTrackStore } from '../stores/track'

const store = useTrackStore()
const weakNetwork = ref(false)
const message = ref('')

const pendingRecords = computed(() => store.offlineRecords.filter((item) => item.status === '待同步' || item.status === '失败'))
const conflictRecords = computed(() => store.offlineRecords.filter((item) => item.status === '冲突'))
const receivedRecords = computed(() => store.offlineRecords.filter((item) => item.status === '已接收'))

function defectName(id: string) {
  const defect = store.defects.find((item) => item.id === id)
  return defect ? `${defect.type}缺陷 · K${Math.floor(defect.mileage / 1000)}+${String(defect.mileage % 1000).padStart(3, '0')}` : id
}

function createAndSync() {
  if (!pendingRecords.value.length) { message.value = '没有待同步的离线记录'; return }
  const batch = store.createBatch(weakNetwork.value)
  store.syncBatch(batch.id)
  const latest = store.syncBatches.find((item) => item.id === batch.id)
  message.value = `批次 ${batch.id} 同步完成：${latest?.status === '全部成功' ? '全部接收' : latest?.status === '部分成功' ? '部分接收，可重试未确认项' : '待处理'}`
}

function retry(batchId: string) {
  store.retryBatch(batchId)
  const batch = store.syncBatches.find((item) => item.id === batchId)
  message.value = `批次 ${batchId} 重试完成：${batch?.status}`
}

function resolve(recordId: string, choice: '现场' | '调度') {
  store.resolveConflict(recordId, choice)
  message.value = `冲突已裁决，采纳${choice}版本`
}

function simulate(defectId: string, kind: 'reassign' | 'status') {
  store.simulateDispatchChange(defectId, kind)
  message.value = `已模拟调度端对 ${defectId} 的${kind === 'reassign' ? '派工变更' : '状态调整'}，再同步即可看到字段冲突`
}

function importLegacy() {
  const result = store.importLegacyLedger()
  message.value = result.message
}

const statusColor: Record<string, string> = { 待同步: 'info', 已接收: 'success', 冲突: 'warning', 失败: 'error' }
const batchColor: Record<string, string> = { 待同步: 'info', 部分成功: 'warning', 全部成功: 'success', 失败: 'error' }
</script>

<template>
  <section class="page">
    <div class="section-head"><div><h2>离线记录同步合并</h2><p>夜间现场离线录入的整治记录与复测值，恢复网络后逐条与调度端合并；不同字段的现场补充保留，同一字段双方改过则列两版标明来源。</p></div></div>

    <div class="metrics">
      <article><span>待同步</span><strong>{{ pendingRecords.length }}</strong><small>离线队列中</small></article>
      <article><span>失败</span><strong>{{ store.offlineRecords.filter((item) => item.status === '失败').length }}</strong><small>可重试未确认项</small></article>
      <article><span>冲突待裁决</span><strong>{{ conflictRecords.length }}</strong><small>两版并列标明来源</small></article>
      <article><span>已接收</span><strong>{{ receivedRecords.length }}</strong><small>不重复写入</small></article>
    </div>

    <div v-if="message" class="validation-message">{{ message }}</div>

    <div class="sync-actions">
      <label class="weak-toggle"><input v-model="weakNetwork" type="checkbox" /> 模拟弱网环境（批次内部分记录同步失败，可继续重试）</label>
      <v-btn color="primary" :disabled="!pendingRecords.length" @click="createAndSync">生成批次并同步 {{ pendingRecords.length ? `(${pendingRecords.length})` : '' }}</v-btn>
      <v-btn variant="outlined" @click="importLegacy">导入旧台账（无版本补齐 V1）</v-btn>
    </div>

    <div class="sim-panel">
      <div class="sim-head"><strong>调度端并发变更模拟</strong><span>现场离线期间，调度台可能同时改了同一处派工或缺陷状态。点击后再同步，可触发字段级冲突。</span></div>
      <div class="sim-row">
        <span class="sim-label">派工变更：</span>
        <v-btn v-for="defect in store.defects" :key="`r-${defect.id}`" size="small" variant="outlined" @click="simulate(defect.id, 'reassign')">{{ defect.id }} 重新派工</v-btn>
      </div>
      <div class="sim-row">
        <span class="sim-label">状态调整：</span>
        <v-btn v-for="defect in store.defects" :key="`s-${defect.id}`" size="small" variant="outlined" @click="simulate(defect.id, 'status')">{{ defect.id }} 状态调整</v-btn>
      </div>
    </div>

    <div v-for="batch in store.syncBatches" :key="batch.id" class="batch-card">
      <div class="batch-head">
        <div><strong>{{ batch.id }}</strong><v-chip size="small" :color="batchColor[batch.status]" class="batch-chip">{{ batch.status }}</v-chip><v-chip v-if="batch.weakNetwork" size="small" color="warning" variant="outlined">弱网</v-chip></div>
        <span>{{ batch.createdAt.replace('T', ' ').slice(0, 16) }} · {{ store.offlineRecords.filter((item) => item.batchId === batch.id && item.status === '已接收').length }}/{{ store.offlineRecords.filter((item) => item.batchId === batch.id).length }} 已接收</span>
      </div>
      <v-table density="compact">
        <thead><tr><th>记录编号</th><th>类型</th><th>缺陷</th><th>现场记录时间</th><th>基础状态</th><th>状态</th><th>合并情况 / 冲突两版</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="record in store.offlineRecords.filter((item) => item.batchId === batch.id)" :key="record.id">
            <td>{{ record.id }}</td>
            <td>{{ record.kind === 'rectification' ? '整治记录' : '复测结果' }}</td>
            <td>{{ defectName(record.entityId) }}</td>
            <td>{{ record.createdAt.replace('T', ' ').slice(0, 16) }}</td>
            <td>{{ record.baseStatus || '—' }}</td>
            <td><v-chip size="small" :color="statusColor[record.status]">{{ record.status }}</v-chip></td>
            <td>
              <div v-if="record.status === '冲突'" class="conflict-box">
                <div v-for="conflict in record.conflicts" :key="conflict.field" class="conflict-row">
                  <span class="conflict-field">{{ conflict.label }}</span>
                  <span class="conflict-version local">现场版：{{ conflict.localValue }}<small>来源 现场</small></span>
                  <span class="conflict-version server">调度版：{{ conflict.serverValue }}<small>来源 调度</small></span>
                </div>
              </div>
              <span v-else-if="record.status === '失败'" class="fail-reason">{{ record.failReason }}</span>
              <span v-else-if="record.status === '已接收'" class="ok-reason">已合并{{ record.mergedAt ? ' · ' + record.mergedAt.replace('T', ' ').slice(0, 16) : '' }}</span>
              <span v-else class="pending-reason">等待同步</span>
            </td>
            <td>
              <template v-if="record.status === '冲突'">
                <v-btn size="small" color="primary" variant="text" @click="resolve(record.id, '现场')">采纳现场版</v-btn>
                <v-btn size="small" variant="text" @click="resolve(record.id, '调度')">采纳调度版</v-btn>
              </template>
              <v-btn v-else-if="record.status === '失败'" size="small" color="warning" variant="text" @click="store.retryRecord(record.id)">重试</v-btn>
              <span v-else>—</span>
            </td>
          </tr>
        </tbody>
      </v-table>
      <div v-if="store.offlineRecords.some((item) => item.batchId === batch.id && item.status === '失败')" class="batch-retry">
        <v-btn size="small" color="warning" @click="retry(batch.id)">重试本批未确认项（{{ store.offlineRecords.filter((item) => item.batchId === batch.id && item.status === '失败').length }}）</v-btn>
        <small>只重试失败项，已接收记录不会重复写入</small>
      </div>
    </div>

    <div v-if="!store.syncBatches.length" class="empty-hint">暂无同步批次。夜间现场在「整治复测」页以离线模式录入后，回到本页生成批次同步。</div>
  </section>
</template>

<style scoped>
.section-head { margin-bottom: 14px; }.section-head h2 { margin: 0 0 5px; font-size: 19px; }.section-head p { margin: 0; color: #71807e; font-size: 12px; }
.validation-message { color: #a63e38; font-size: 12px; margin-bottom: 10px; }
.sync-actions { display: flex; align-items: center; gap: 12px; background: white; border: 1px solid #dae2e2; padding: 12px 14px; margin-bottom: 14px; }
.weak-toggle { font-size: 12px; color: #5c6b69; display: flex; align-items: center; gap: 6px; margin-right: auto; }
.sim-panel { background: #f4f7f7; border: 1px dashed #b9c6c6; padding: 12px 14px; margin-bottom: 16px; display: grid; gap: 8px; }
.sim-head { display: flex; justify-content: space-between; align-items: baseline; }.sim-head strong { font-size: 13px; }.sim-head span { color: #71807e; font-size: 11px; }
.sim-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }.sim-label { font-size: 12px; color: #5c6b69; min-width: 70px; }
.batch-card { background: white; border: 1px solid #dae2e2; margin-bottom: 14px; }
.batch-head { display: flex; justify-content: space-between; align-items: center; padding: 11px 14px; border-bottom: 1px solid #e6ecec; }
.batch-head > div { display: flex; align-items: center; gap: 8px; }.batch-head span { color: #71807e; font-size: 11px; }
.batch-chip { margin-left: 4px; }
.conflict-box { display: grid; gap: 6px; }
.conflict-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.conflict-field { font-size: 11px; color: #71807e; background: #eef2f2; padding: 2px 7px; }
.conflict-version { font-size: 12px; padding: 2px 8px; border: 1px solid; display: inline-flex; align-items: center; gap: 6px; }
.conflict-version small { font-size: 10px; opacity: .75; }
.conflict-version.local { color: #b08735; border-color: #e2c896; background: #fbf6e9; }
.conflict-version.server { color: #315b72; border-color: #a9c4d3; background: #eef5f9; }
.fail-reason { color: #a63e38; font-size: 12px; }
.ok-reason { color: #43876b; font-size: 12px; }
.pending-reason { color: #9aa5a5; font-size: 12px; }
.batch-retry { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-top: 1px solid #e6ecec; }.batch-retry small { color: #9aa5a5; font-size: 11px; }
.empty-hint { padding: 30px; text-align: center; color: #9aa5a5; font-size: 12px; background: white; border: 1px dashed #dae2e2; }
</style>
