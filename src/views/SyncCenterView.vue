<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTrackStore } from '../stores/track'

const store = useTrackStore()
const message = ref('')
const deskDefectId = ref('')
const deskTargets = computed(() => [...new Set(store.offlineQueue.filter((item) => item.status !== '已确认').map((item) => item.defectId))])

function sync() {
  const result = store.syncBatch()
  message.value = result.message
}
function simulateDesk() {
  const target = deskDefectId.value || deskTargets.value[0]
  if (!target) {
    message.value = '没有待同步的离线记录，无法模拟并发修改'
    return
  }
  store.simulateDeskEdit(target)
  message.value = `调度台已在离线期间并发修改 ${target} 的派工与状态，同步时将产生字段冲突`
}
function opSummary(op: (typeof store.offlineQueue)[number]) {
  const parts: string[] = []
  if (op.action) parts.push(`整治记录·${op.action.method}`)
  if (op.retest) parts.push(`复测第${op.retest.round}轮`)
  const fields = Object.entries(op.changes).filter(([, value]) => value !== undefined).map(([key]) => ({ owner: '责任工区', status: '状态', measuredValue: '实测值', severity: '严重度', dueDate: '整改期限' })[key] ?? key)
  if (fields.length) parts.push(`字段：${fields.join('、')}`)
  return parts.join('；') || '字段补充'
}
</script>

<template>
  <section class="page">
    <div class="metrics">
      <article><span>待同步</span><strong>{{ store.offlineQueue.filter((item) => item.status === '待同步').length }}</strong><small>现场离线记录</small></article>
      <article><span>同步失败</span><strong>{{ store.offlineQueue.filter((item) => item.status === '同步失败').length }}</strong><small>可继续重试</small></article>
      <article><span>未裁决冲突</span><strong>{{ store.unresolvedConflicts.length }}</strong><small>同一字段双方改过</small></article>
      <article><span>待复核区段</span><strong>{{ store.segments.filter((item) => item.reviewStatus === '待复核').length }}</strong><small>限速版本已失效</small></article>
    </div>

    <div v-if="store.activeAlerts.length" class="alert-band">
      <div v-for="alert in store.activeAlerts" :key="alert.id" class="alert-item">
        <strong>提示调度</strong><span>{{ alert.message }}</span>
        <v-btn size="small" variant="outlined" @click="store.acknowledgeAlert(alert.id)">已知悉</v-btn>
      </div>
    </div>

    <div class="sync-panel">
      <div class="sync-actions">
        <v-btn color="primary" @click="sync">合并本批离线记录</v-btn>
        <v-btn color="secondary" :disabled="!store.pendingOps.length" @click="sync">重试未确认项（{{ store.pendingOps.length }}）</v-btn>
        <v-switch v-model="store.syncFailureMode" label="模拟网络中断（本批失败）" density="compact" hide-details color="error" />
      </div>
      <div class="sync-actions">
        <v-select v-model="deskDefectId" :items="deskTargets" label="模拟调度台并发修改的缺陷" density="compact" variant="outlined" hide-details clearable />
        <v-btn variant="outlined" :disabled="!deskTargets.length" @click="simulateDesk">模拟调度台并发修改</v-btn>
      </div>
      <p class="sync-note">回到网络后逐条合并：不同字段的现场补充直接保留；同一字段被双方改过会列出两版并标明来源。已确认的记录按操作号跳过，重试不会重复写。</p>
      <div v-if="message" class="sync-message">{{ message }}</div>
    </div>

    <div class="panel">
      <h3>离线队列</h3>
      <v-table density="compact">
        <thead><tr><th>操作号</th><th>缺陷</th><th>内容</th><th>来源</th><th>记录时间</th><th>状态</th><th>尝试</th><th>说明</th></tr></thead>
        <tbody>
          <tr v-for="op in store.offlineQueue" :key="op.opId">
            <td>{{ op.opId }}</td><td>{{ op.defectId }}</td><td>{{ opSummary(op) }}</td><td>{{ op.source }}</td>
            <td>{{ op.recordedAt.replace('T', ' ').slice(0, 16) }}</td>
            <td><v-chip size="small" :color="op.status === '已确认' ? 'success' : op.status === '同步失败' ? 'error' : 'warning'">{{ op.status }}</v-chip></td>
            <td>{{ op.attempts }}</td><td>{{ op.lastError ?? '—' }}</td>
          </tr>
          <tr v-if="!store.offlineQueue.length"><td colspan="8" class="empty">暂无离线记录，可在“整治复测”页离线入队</td></tr>
        </tbody>
      </v-table>
    </div>

    <div class="panel">
      <h3>字段冲突（两版并列，标明来源）</h3>
      <v-table density="compact">
        <thead><tr><th>缺陷</th><th>字段</th><th>现场离线版</th><th>调度台版</th><th>状态</th><th>裁决</th></tr></thead>
        <tbody>
          <tr v-for="conflict in store.conflicts" :key="conflict.id">
            <td>{{ conflict.entityId }}</td><td>{{ conflict.fieldLabel }}</td>
            <td><span class="version-tag field">{{ conflict.fieldSource }}</span>{{ String(conflict.fieldValue) }}</td>
            <td><span class="version-tag desk">{{ conflict.deskSource }}</span>{{ String(conflict.deskValue) }}</td>
            <td><v-chip size="small" :color="conflict.resolved ? 'success' : 'error'">{{ conflict.resolved ? '已裁决' : '待裁决' }}</v-chip></td>
            <td>
              <template v-if="!conflict.resolved">
                <v-btn size="small" variant="text" color="primary" @click="store.resolveConflict(conflict.id, 'field')">采用现场版</v-btn>
                <v-btn size="small" variant="text" @click="store.resolveConflict(conflict.id, 'desk')">保留调度台版</v-btn>
              </template>
              <span v-else>—</span>
            </td>
          </tr>
          <tr v-if="!store.conflicts.length"><td colspan="6" class="empty">暂无字段冲突</td></tr>
        </tbody>
      </v-table>
    </div>

    <div class="panel">
      <h3>区段限速复核</h3>
      <v-table density="compact">
        <thead><tr><th>区段</th><th>线路</th><th>限速版本</th><th>复核状态</th><th>失效原因</th></tr></thead>
        <tbody>
          <tr v-for="segment in store.segments" :key="segment.id">
            <td>{{ segment.id }}</td><td>{{ segment.line }}</td><td>V{{ segment.version }}</td>
            <td><v-chip size="small" :color="segment.reviewStatus === '待复核' ? 'error' : 'success'">{{ segment.reviewStatus ?? '正常' }}</v-chip></td>
            <td>{{ segment.invalidReason ?? '—' }}</td>
          </tr>
        </tbody>
      </v-table>
    </div>
  </section>
</template>

<style scoped>
.alert-band { display: grid; gap: 8px; margin-bottom: 14px; }
.alert-item { display: flex; align-items: center; gap: 12px; padding: 11px 14px; background: #fdf0ee; border: 1px solid #e5b7b2; border-left: 3px solid #a63e38; font-size: 12px; }
.alert-item strong { color: #a63e38; white-space: nowrap; }
.alert-item span { flex: 1; color: #6d4a46; }
.sync-panel { background: white; border: 1px solid #dae1e2; padding: 14px 16px; margin-bottom: 14px; display: grid; gap: 10px; }
.sync-actions { display: flex; gap: 14px; align-items: center; }
.sync-actions .v-select { max-width: 320px; }
.sync-note { margin: 0; color: #71807e; font-size: 11px; }
.sync-message { color: #315b72; font-size: 12px; }
.panel { background: white; border: 1px solid #dae1e2; padding: 14px 16px; margin-bottom: 14px; }
.panel h3 { margin: 0 0 10px; font-size: 14px; }
.empty { text-align: center; color: #9aa5a5; }
.version-tag { display: inline-block; margin-right: 6px; padding: 1px 6px; border-radius: 3px; font-size: 10px; color: white; }
.version-tag.field { background: #8c6a2f; }
.version-tag.desk { background: #315b72; }
</style>
