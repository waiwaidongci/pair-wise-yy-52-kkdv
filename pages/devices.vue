<script setup lang="ts">
import { useOperationsStore } from '~/stores/operations'

const store = useOperationsStore()
const selectedDevice = ref('WTG-03')
const selectedPoints = computed(() => store.permits.flatMap((permit) => permit.isolationPoints).filter((point) => point.device.includes(selectedDevice.value)))
const devices = [
  { id: 'WTG-03', name: '3 号风力发电机组', state: '检修隔离', load: '0 kW', points: 3, crew: '机务二班' },
  { id: 'LINE-A2', name: 'A2 集电线路', state: '待隔离', load: '0.8 MW', points: 3, crew: '线路一班' },
  { id: 'BOX-12', name: '12 号箱式变压器', state: '运行', load: '2.4 MW', points: 1, crew: '电气一班' },
  { id: 'BUS-A', name: 'A 段 35kV 母线', state: '运行', load: '18.6 MW', points: 1, crew: '公用' },
]

function permitIdOf(pointId: string) {
  return store.permits.find((permit) => permit.isolationPoints.some((point) => point.id === pointId))?.id ?? ''
}
function occupancyOf(pointId: string) {
  return store.occupancyByPoint.get(pointId)
}
function occState(pointId: string): 'free' | 'valid' | 'conflict' {
  const occ = store.occupancyByPoint.get(pointId)
  if (!occ) return 'free'
  return occ.valid ? 'valid' : 'conflict'
}
function occLabel(pointId: string): string {
  const occ = store.occupancyByPoint.get(pointId)
  if (!occ) return '未占用'
  if (!occ.valid) return `占用冲突 · ${occ.actor} 的确认待值班负责人裁决`
  const flags = [occ.locked ? '已锁定' : '', occ.voltageVerified ? '已验电' : ''].filter(Boolean).join(' · ')
  return `已占用 · ${occ.actor}${flags ? ' · ' + flags : ''}`
}
/** 演示：另一名值班员在远端同时确认同一隔离点占用 */
function simulateForDevice() {
  const point = selectedPoints.value.find((item) => !store.occupancyByPoint.get(item.id)?.valid)
  if (!point) return
  void store.simulateRemote(point.id, permitIdOf(point.id), '孙禾')
}
</script>

<template>
  <div class="page">
    <div class="head"><div><p class="eyebrow">LOCKOUT / TAGOUT</p><h1 class="page-title">设备隔离与锁定点</h1><p class="muted">统一维护设备隔离点、锁具、验电步骤和跨班组占用状态。断网时确认仅留本机，回网后逐条补传。</p></div><UButton color="primary" icon="i-heroicons-plus">登记隔离点</UButton></div>
    <UAlert v-if="store.connection === '断网'" class="mb-4" color="red" variant="soft" icon="i-heroicons-no-symbol" title="断网模式" description="当前现场断网：占用、锁定与验电确认仅保存在本机并记录原修订号，恢复联网后逐条补传，重复补传不重复写审计。" />
    <div class="device-grid">
      <article v-for="device in devices" :key="device.id" class="panel device" :class="{ active: selectedDevice === device.id }" @click="selectedDevice = device.id"><div class="inline justify-between"><UBadge variant="subtle">{{ device.id }}</UBadge><UBadge :color="device.state === '运行' ? 'green' : device.state === '检修隔离' ? 'red' : 'amber'" variant="subtle">{{ device.state }}</UBadge></div><h2>{{ device.name }}</h2><div class="kv"><span>当前负荷</span><b>{{ device.load }}</b></div><div class="kv"><span>隔离点</span><b>{{ device.points }} 个</b></div><div class="kv"><span>责任班组</span><b>{{ device.crew }}</b></div></article>
    </div>
    <section class="grid lower"><article class="panel p-4"><h2>{{ selectedDevice }} · 隔离检查单</h2><div v-for="point in selectedPoints" :key="point.id" class="point"><div class="lock-icon"><UIcon name="i-heroicons-lock-closed" /></div><div class="point-info"><b>{{ point.label }}</b><small>{{ point.type }} · {{ point.id }}</small><small :class="occState(point.id) === 'valid' ? 'text-green' : occState(point.id) === 'conflict' ? 'text-red' : 'muted'">{{ occLabel(point.id) }}</small></div><UBadge :color="point.state === '已隔离' ? 'green' : 'amber'" variant="subtle">{{ point.state }}</UBadge><UBadge v-if="store.conflictForPoint(point.id)" color="red" variant="solid">占用冲突</UBadge><div class="inline"><UButton v-if="occState(point.id) !== 'valid'" size="xs" color="primary" variant="soft" @click="store.confirmOccupy(point.id, permitIdOf(point.id))">确认占用</UButton><UButton size="xs" color="gray" variant="outline" :disabled="occState(point.id) !== 'valid' || occupancyOf(point.id)?.locked" @click="store.lockPoint(point.id, permitIdOf(point.id))">加锁</UButton><UButton size="xs" color="gray" variant="outline" :disabled="occState(point.id) !== 'valid' || occupancyOf(point.id)?.voltageVerified" @click="store.verifyVoltage(point.id, permitIdOf(point.id))">验电</UButton></div></div><UAlert v-if="!selectedPoints.length" variant="soft" title="该设备暂无隔离点" description="可在许可中新建隔离点并关联设备。" /></article><article class="panel p-4"><h2>交叉冲突检测</h2><UAlert color="red" variant="soft" title="LINE-A2 与 BOX-12 共用母线隔离边界" description="两个作业在同一时间窗内涉及 BUS-A，需由值班负责人确认先后顺序与交接条件。" /><h3>锁定器具台账</h3><div class="tool"><span>LK-2107</span><b>WTG-03 · 周野</b></div><div class="tool"><span>LK-2118</span><b>LINE-A2 · 待领用</b></div><div class="tool"><span>GND-042</span><b>17 号杆 · 谭勇</b></div><UButton block color="primary" class="mt-4" icon="i-heroicons-check-badge" @click="selectedPoints[0] && store.confirmOccupy(selectedPoints[0].id, permitIdOf(selectedPoints[0].id))">完成隔离确认</UButton><UButton block color="amber" variant="soft" class="mt-2" icon="i-heroicons-user-group" @click="simulateForDevice">模拟同事同时确认占用</UButton><p class="muted mt-2" style="font-size:12px">演示：先断网并在本机确认占用，再点此模拟同事在远端同时提交，回网补传时只保留一个有效占用。</p></article></section>
  </div>
</template>

<style scoped>
.head{display:flex;justify-content:space-between;margin-bottom:18px}.head h1{margin:3px 0 7px}.head p{margin:0}.eyebrow{font-size:12px;color:#2563eb;font-weight:700}.device-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:16px}.device{padding:16px;cursor:pointer}.device.active{border-color:#2563eb;box-shadow:0 0 0 2px #dbeafe}.device h2{font-size:16px;margin:14px 0}.kv{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #edf0f5;font-size:13px}.kv span{color:#667085}.lower{grid-template-columns:1.3fr .7fr;gap:16px}.panel h2{font-size:17px;margin:0 0 14px}.point{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid #edf0f5}.point-info{flex:1;min-width:0}.point-info b,.point-info small{display:block}.point-info small{color:#667085;margin-top:4px}.point-info .text-green{color:#15803d}.point-info .text-red{color:#dc2626}.lock-icon{display:grid;place-items:center;width:34px;height:34px;background:#eff6ff;color:#2563eb;border-radius:7px}.tool{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #edf0f5}.tool span{color:#2563eb;font-family:monospace}.tool b{font-size:13px}
@media(max-width:1050px){.device-grid{grid-template-columns:1fr 1fr}.lower{grid-template-columns:1fr}}@media(max-width:600px){.head{flex-direction:column;gap:12px}.device-grid{grid-template-columns:1fr}}
</style>
