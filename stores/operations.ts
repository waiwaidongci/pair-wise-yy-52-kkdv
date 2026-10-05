import { defineStore } from 'pinia'
import type { AuditEvent, ConflictRecord, ConnectionState, Occupancy, OutboxMutation, Permit, SyncResult } from '~/types'
import { auditEvents as seedAudit, permits as seedPermits } from '~/utils/mock'

const STORAGE_KEY = 'yy52-permit-ops-v2'

function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}
function nowTime() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

interface RemoteState {
  permits: Permit[]
  occupancy: Occupancy[]
  conflicts: ConflictRecord[]
  audit: AuditEvent[]
}

export const useOperationsStore = defineStore('operations', () => {
  const permits = ref<Permit[]>(structuredClone(seedPermits))
  const audit = ref<AuditEvent[]>(structuredClone(seedAudit).map((event) => ({ ...event, synced: true })))
  const occupancy = ref<Occupancy[]>([])
  const conflicts = ref<ConflictRecord[]>([])
  const outbox = ref<OutboxMutation[]>([])
  const connection = ref<ConnectionState>('在线')
  const latestAlert = ref('18:00–20:00 LINE-A2 存在跨班组重叠作业')
  const loaded = ref(false)

  /** 待补传条数（顶部徽标） */
  const pendingCount = computed(() => outbox.value.filter((m) => m.status !== '已同步' && m.status !== '已合并').length)
  /** 待值班负责人确认的占用冲突 */
  const conflictCount = computed(() => conflicts.value.filter((c) => c.status === '待确认').length)
  const pendingConflicts = computed(() => conflicts.value.filter((c) => c.status === '待确认'))
  /** 按隔离点取有效占用（无效占用让位） */
  const occupancyByPoint = computed(() => {
    const map = new Map<string, Occupancy>()
    for (const occ of occupancy.value) if (!map.has(occ.pointId) || occ.valid) map.set(occ.pointId, occ)
    return map
  })
  /** 某许可还有多少条未同步变更（许可页同步徽标） */
  function pendingForPermit(permitId: string) {
    return outbox.value.filter((m) => m.permitId === permitId && m.status !== '已同步' && m.status !== '已合并').length
  }
  function conflictForPoint(pointId: string) {
    return conflicts.value.find((c) => c.pointId === pointId && c.status === '待确认')
  }

  function persist() {
    if (import.meta.client) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        permits: permits.value,
        audit: audit.value,
        occupancy: occupancy.value,
        conflicts: conflicts.value,
        outbox: outbox.value,
        connection: connection.value,
      }))
    }
  }

  function restore() {
    if (!import.meta.client || loaded.value) return
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      try {
        const draft = JSON.parse(raw)
        if (Array.isArray(draft.permits)) permits.value = draft.permits
        if (Array.isArray(draft.audit)) audit.value = draft.audit
        if (Array.isArray(draft.occupancy)) occupancy.value = draft.occupancy
        if (Array.isArray(draft.conflicts)) conflicts.value = draft.conflicts
        if (Array.isArray(draft.outbox)) outbox.value = draft.outbox
        if (draft.connection === '在线' || draft.connection === '断网') connection.value = draft.connection
      } catch { /* 损坏的本地缓存忽略 */ }
    }
    loaded.value = true
  }

  /** 断网期间审计先落本机，带 mutationId；补传成功后由远端版本替换，不重复写 */
  function localAudit(actor: string, action: string, target: string, detail: string, mutationId: string) {
    audit.value.unshift({ id: uid('AE'), time: nowTime(), actor, action, target, detail, mutationId, synced: false })
  }

  /**
   * 入队一条现场变更：本机立即生效（断网可用），同时记录原修订号排队。
   * 在线时入队即触发逐条补传。
   */
  function enqueue(entry: Omit<OutboxMutation, 'id' | 'baseRevision' | 'status' | 'attempts' | 'createdAt'>): OutboxMutation {
    const permit = permits.value.find((p) => p.id === entry.permitId)
    const mut: OutboxMutation = {
      id: uid('MUT'),
      baseRevision: permit?.revision ?? 1,
      status: '待同步',
      attempts: 0,
      createdAt: new Date().toISOString(),
      ...entry,
    }
    outbox.value.push(mut)
    persist()
    if (connection.value === '在线') void flushOutbox()
    return mut
  }

  function toggleStep(permitId: string, stepId: string) {
    const permit = permits.value.find((item) => item.id === permitId)
    const step = permit?.steps.find((item) => item.id === stepId)
    if (!permit || !step) return
    const previous = permit.steps.filter((item) => item.done).length
    step.done = !step.done
    if (previous === 2 && permit.steps.filter((item) => item.done).length === 3 && permit.id === 'WP-260929-018') {
      latestAlert.value = 'WP-260929-018 检测到 LINE-A2 共用母线隔离点，需要复核'
      permit.reviewRequired = true
      const other = permits.value.find((item) => item.id === 'WP-260929-021')
      if (other) other.reviewRequired = true
    }
    const mut = enqueue({ kind: 'step', permitId, actor: '当前用户', op: { stepId, done: step.done } })
    localAudit('当前用户', step.done ? '完成步骤' : '撤销步骤', `${permitId} / ${stepId}`, step.text, mut.id)
    persist()
  }

  function advancePermit(id: string) {
    const permit = permits.value.find((item) => item.id === id)
    if (!permit) return
    const flow: Record<string, Permit['status']> = { 待复核: '待执行', 待执行: '执行中', 执行中: '待结束', 待结束: '待关闭', 待关闭: '已完成' }
    const next = flow[permit.status]
    if (!next) return
    if (permit.status === '待复核' && permit.reviewRequired && !confirm('该许可存在待复核冲突，确认由值班负责人承担审批责任？')) return
    permit.status = next
    permit.reviewRequired = false
    const mut = enqueue({ kind: 'permit', permitId: id, actor: '当前用户', op: { status: next } })
    localAudit('当前用户', '流程推进', id, `状态由“${Object.keys(flow).find((key) => flow[key] === next)}”变更为“${next}”`, mut.id)
    persist()
  }

  function addPermit(permit: Permit) {
    permits.value.unshift(permit)
    const mut = enqueue({ kind: 'permit-create', permitId: permit.id, actor: '当前用户', op: { permit } })
    localAudit('当前用户', '新建许可', permit.id, permit.title, mut.id)
    persist()
  }

  /** 现场确认隔离点占用：断网只留本机，回网凭 baseRevision 补传，冲突时只留一个有效占用 */
  function confirmOccupy(pointId: string, permitId: string) {
    const permit = permits.value.find((p) => p.id === permitId)
    const point = permit?.isolationPoints.find((p) => p.id === pointId)
    if (!permit || !point) return
    point.state = '已隔离'
    occupancy.value = occupancy.value.filter((o) => o.pointId !== pointId)
    occupancy.value.push({ pointId, permitId, actor: '当前用户', locked: false, voltageVerified: false, confirmedAt: nowTime(), valid: true })
    const mut = enqueue({ kind: 'occupy', permitId, pointId, actor: '当前用户', op: { pointId, permitId } })
    localAudit('当前用户', '确认占用', pointId, `${permitId} ${point.label} 已确认占用（断网留本机，待回网补传）`, mut.id)
    persist()
  }

  function lockPoint(pointId: string, permitId: string) {
    const occ = occupancy.value.find((o) => o.pointId === pointId)
    if (occ) occ.locked = true
    else occupancy.value.push({ pointId, permitId, actor: '当前用户', locked: true, voltageVerified: false, confirmedAt: nowTime(), valid: true })
    const mut = enqueue({ kind: 'lock', permitId, pointId, actor: '当前用户', op: { pointId, permitId } })
    localAudit('当前用户', '加锁确认', pointId, `${permitId} 隔离点已执行机械锁定`, mut.id)
    persist()
  }

  function verifyVoltage(pointId: string, permitId: string) {
    const occ = occupancy.value.find((o) => o.pointId === pointId)
    if (occ) occ.voltageVerified = true
    else occupancy.value.push({ pointId, permitId, actor: '当前用户', locked: false, voltageVerified: true, confirmedAt: nowTime(), valid: true })
    const mut = enqueue({ kind: 'voltage', permitId, pointId, actor: '当前用户', op: { pointId, permitId } })
    localAudit('当前用户', '验电确认', pointId, `${permitId} 隔离点验电完成，具备接地条件`, mut.id)
    persist()
  }

  /** 值班负责人处理占用冲突：保留远端有效占用，或放弃本方占用 */
  function resolveConflict(conflictId: string, decision: '保留' | '放弃') {
    const conflict = conflicts.value.find((c) => c.id === conflictId)
    if (!conflict) return
    conflict.status = decision === '保留' ? '已保留' : '已放弃'
    if (decision === '放弃' && conflict.pointId) {
      const occ = occupancy.value.find((o) => o.pointId === conflict.pointId)
      if (occ) occ.valid = false
    }
    const mut = enqueue({ kind: 'resolve', permitId: conflict.permitId ?? '', pointId: conflict.pointId, actor: '值班负责人', op: { conflictId, decision } })
    localAudit('值班负责人', decision === '保留' ? '确认保留占用' : '放弃占用', conflict.pointId ?? conflictId, conflict.reason, mut.id)
    persist()
  }

  /** 用远端权威状态覆盖本机；本机排队中但远端尚不存在的乐观变更保留 */
  function applyRemoteState(state: RemoteState) {
    const remoteIds = new Set(state.permits.map((p) => p.id))
    permits.value = [...state.permits, ...permits.value.filter((p) => !remoteIds.has(p.id))]

    const remotePoints = new Set(state.occupancy.map((o) => o.pointId))
    const pendingLocal = occupancy.value.filter(
      (o) => !remotePoints.has(o.pointId) && outbox.value.some((m) => m.pointId === o.pointId && m.status !== '已同步' && m.status !== '已合并'),
    )
    occupancy.value = [...state.occupancy, ...pendingLocal]

    conflicts.value = state.conflicts

    // 审计去重：同一 mutationId 只保留远端落库版本，本机待传版本补传成功后移除，不重复写
    const syncedIds = new Set(state.audit.map((e) => e.mutationId).filter(Boolean) as string[])
    audit.value = [
      ...state.audit.map((e) => ({ ...e, synced: true })),
      ...audit.value.filter((e) => !e.mutationId || !syncedIds.has(e.mutationId)),
    ]
  }

  async function fetchRemoteState() {
    try {
      const state = await $fetch<RemoteState>('/api/state')
      applyRemoteState(state)
      loaded.value = true
      persist()
    } catch {
      loaded.value = true
    }
  }

  /**
   * 逐条补传：一条失败不阻塞后续，失败项置“失败”待重试；
   * 重复补传服务端按 mutationId 幂等，不重复落库、不重复写审计。
   */
  async function flushOutbox() {
    if (connection.value === '断网') return
    const pending = outbox.value.filter((m) => m.status === '待同步' || m.status === '失败')
    for (const mut of pending) {
      mut.status = '同步中'
      mut.attempts += 1
      persist()
      try {
        const { result, state } = await $fetch<{ result: SyncResult; state: RemoteState }>('/api/sync', { method: 'POST', body: mut })
        applyRemoteState(state)
        mut.status = result.status === '冲突' ? '冲突' : result.status === '已合并' ? '已合并' : '已同步'
        mut.resultRevision = result.revision
        mut.conflictId = result.conflictId
        mut.lastError = undefined
        if (result.status === '冲突' && result.conflictId) {
          const occ = occupancy.value.find((o) => o.pointId === mut.pointId && o.actor === '当前用户')
          if (occ) {
            occ.valid = false
            occ.conflictId = result.conflictId
          }
          latestAlert.value = `隔离点 ${mut.pointId} 占用冲突：远端已由他人确认有效占用，需值班负责人在总览确认`
        }
      } catch (error) {
        mut.status = '失败'
        mut.lastError = error instanceof Error ? error.message : String(error)
      }
      persist()
    }
  }

  function goOffline() {
    connection.value = '断网'
    persist()
  }

  async function goOnline() {
    connection.value = '在线'
    await fetchRemoteState()
    await flushOutbox()
  }

  function retryFailed() {
    connection.value = '在线'
    return flushOutbox()
  }

  /** 演示：模拟另一名值班员在远端同时提交同一隔离点的占用确认 */
  async function simulateRemote(pointId: string, permitId: string, actor = '孙禾') {
    try {
      const { state } = await $fetch<{ state: RemoteState }>('/api/simulate', { method: 'POST', body: { pointId, permitId, actor } })
      applyRemoteState(state)
      latestAlert.value = `${actor} 已在远端同时确认 ${pointId} 占用；你在本机的确认将在回网补传时做冲突校验，只保留一个有效占用`
      persist()
    } catch { /* 演示接口不可用时忽略 */ }
  }

  function acceptAlert() {
    latestAlert.value = ''
    addAuditLocal('值班负责人', '确认冲突', '跨班组重叠', '同意调整 LINE-A2 作业时间，不允许同时开工')
  }
  function addAuditLocal(actor: string, action: string, target: string, detail: string) {
    audit.value.unshift({ id: uid('AE'), time: nowTime(), actor, action, target, detail, synced: true })
    persist()
  }

  restore()
  return {
    permits, audit, occupancy, conflicts, outbox, connection, latestAlert, loaded,
    pendingCount, conflictCount, pendingConflicts, occupancyByPoint, pendingForPermit, conflictForPoint,
    persist, restore, fetchRemoteState, enqueue, toggleStep, advancePermit, addPermit,
    confirmOccupy, lockPoint, verifyVoltage, resolveConflict, flushOutbox,
    goOffline, goOnline, retryFailed, simulateRemote, acceptAlert,
  }
})
