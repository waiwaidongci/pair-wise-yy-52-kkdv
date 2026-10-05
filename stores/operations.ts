import { defineStore } from 'pinia'
import type { AuditEvent, ConfirmKind, PendingOp, Permit, RemoteChange, SyncConflict } from '~/types'
import { auditEvents as seedAudit, permits as seedPermits } from '~/utils/mock'

const STORAGE_KEY = 'yy52-permit-ops-v2'

let seq = 0
function nextId(prefix: string) {
  seq += 1
  return `${prefix}-${Date.now().toString(36)}-${seq}`
}
function now() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export const useOperationsStore = defineStore('operations', () => {
  const permits = ref<Permit[]>(structuredClone(seedPermits))
  const audit = ref<AuditEvent[]>(structuredClone(seedAudit))
  const connection = ref<'在线' | '重连中'>('在线')
  const pendingOps = ref<PendingOp[]>([])
  const conflicts = ref<SyncConflict[]>([])
  const remoteRevisions = ref<Record<string, number>>({})
  const remoteChanges = ref<RemoteChange[]>([])
  const latestAlert = ref('18:00–20:00 LINE-A2 存在跨班组重叠作业')
  const loaded = ref(false)

  for (const permit of permits.value) remoteRevisions.value[permit.id] = permit.revision

  const queuedCount = computed(() => pendingOps.value.filter((op) => op.status === '待同步' || op.status === '同步中').length)
  const failedCount = computed(() => pendingOps.value.filter((op) => op.status === '失败').length)
  const openConflicts = computed(() => conflicts.value.filter((item) => item.status === '待确认'))
  const occupancyConflicts = computed(() => openConflicts.value.filter((item) => item.pointId))

  function persist() {
    if (import.meta.client) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        permits: permits.value, audit: audit.value, pendingOps: pendingOps.value,
        conflicts: conflicts.value, remoteRevisions: remoteRevisions.value, remoteChanges: remoteChanges.value,
      }))
    }
  }
  function restore() {
    if (!import.meta.client || loaded.value) return
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const draft = JSON.parse(raw)
      permits.value = draft.permits
      audit.value = draft.audit
      pendingOps.value = draft.pendingOps ?? []
      conflicts.value = draft.conflicts ?? []
      remoteRevisions.value = draft.remoteRevisions ?? {}
      remoteChanges.value = draft.remoteChanges ?? []
    }
    loaded.value = true
  }

  /** 写审计；带 opId 时同一操作同一动作只留一条，重复补传不重复写 */
  function addAudit(actor: string, action: string, target: string, detail: string, opId?: string) {
    if (opId && audit.value.some((event) => event.opId === opId && event.action === action)) return
    audit.value.unshift({ id: nextId('AE'), time: now(), actor, action, target, detail, opId })
    persist()
  }

  function registerConflict(input: { opId?: string; permitId: string; pointId?: string; reason: string; localRevision: number; remoteRevision: number }) {
    const dup = conflicts.value.some((item) => item.status === '待确认'
      && item.permitId === input.permitId && item.pointId === input.pointId
      && (input.opId ? item.opId === input.opId : !item.opId))
    if (dup) return
    conflicts.value.unshift({ id: nextId('CFL'), status: '待确认', ...input })
    persist()
  }

  function enqueue(op: Omit<PendingOp, 'id' | 'queuedAt' | 'status' | 'retries'>) {
    const pending: PendingOp = { ...op, id: nextId('OP'), queuedAt: new Date().toISOString(), status: '待同步', retries: 0 }
    pendingOps.value.push(pending)
    persist()
    return pending
  }

  /** 隔离点占用 / 锁定 / 验电确认：在线直接生效，断网带原修订号排队 */
  function confirmPoint(permitId: string, pointId: string, kind: ConfirmKind, actor = '当前用户') {
    const permit = permits.value.find((item) => item.id === permitId)
    const point = permit?.isolationPoints.find((item) => item.id === pointId)
    if (!permit || !point) return false
    // 同一隔离点只保留一个有效占用，后到的提交不覆盖先到的
    if (kind === '占用' && point.occupiedBy && point.occupiedBy !== actor) {
      registerConflict({
        permitId, pointId,
        reason: `${actor} 与 ${point.occupiedBy} 同时提交同一隔离点占用，仅保留 ${point.occupiedBy} 的有效占用`,
        localRevision: permit.revision,
        remoteRevision: remoteRevisions.value[permitId] ?? permit.revision,
      })
      addAudit(actor, '占用被拒', `${permitId} / ${pointId}`, `隔离点已由 ${point.occupiedBy} 占用，保留原有效占用，冲突待确认`)
      persist()
      return false
    }
    point.confirmations.push({ id: nextId('CF'), kind, actor, time: now(), revision: permit.revision, synced: connection.value === '在线' })
    if (kind === '占用') point.occupiedBy = actor
    if (connection.value === '在线') {
      permit.revision += 1
      remoteRevisions.value[permitId] = permit.revision
      addAudit(actor, '现场确认', `${permitId} / ${pointId}`, `${kind}确认已生效，修订推进到 r${permit.revision}`)
    } else {
      const op = enqueue({ permitId, pointId, kind, actor, baseRevision: permit.revision })
      addAudit(actor, '离线记录', `${permitId} / ${pointId}`, `断网期间${kind}确认暂存本机，基于修订 r${op.baseRevision} 排队待同步`, op.id)
    }
    persist()
    return true
  }

  /** 接收远端修订：他人对许可或隔离点的变更 */
  function receiveRemote(change: { permitId: string; pointId?: string; kind: ConfirmKind | '流程推进'; actor: string; summary: string }) {
    const permit = permits.value.find((item) => item.id === change.permitId)
    if (!permit) return
    const revision = (remoteRevisions.value[change.permitId] ?? permit.revision) + 1
    remoteRevisions.value[change.permitId] = revision
    remoteChanges.value.push({ ...change, revision })
    if (change.pointId && change.kind === '占用') {
      const point = permit.isolationPoints.find((item) => item.id === change.pointId)
      if (point) {
        if (point.occupiedBy && point.occupiedBy !== change.actor) {
          // 两名值班人员同时占用同一隔离点：只留一个有效占用，其余进冲突
          registerConflict({
            permitId: change.permitId, pointId: change.pointId,
            reason: `${change.actor}（远端）与 ${point.occupiedBy} 同时占用同一隔离点，仅保留 ${point.occupiedBy} 的有效占用`,
            localRevision: permit.revision, remoteRevision: revision,
          })
          addAudit('系统', '占用冲突', `${change.permitId} / ${change.pointId}`, `远端 ${change.actor} 的占用未覆盖 ${point.occupiedBy}，待值班负责人确认`)
        } else {
          point.occupiedBy = change.actor
          point.confirmations.push({ id: nextId('CF'), kind: '占用', actor: change.actor, time: now(), revision, synced: true })
        }
      }
    }
    addAudit(change.actor, '远端修订', change.permitId, `${change.summary}（远端 r${revision}）`)
    persist()
  }

  /** 回滚未同步的本机占用，保证同一隔离点只剩一个有效占用 */
  function rollbackOccupancy(permit: Permit, op: PendingOp) {
    const point = permit.isolationPoints.find((item) => item.id === op.pointId)
    if (!point) return
    const remoteOcc = [...remoteChanges.value].reverse().find((item) => item.pointId === op.pointId && item.kind === '占用')
    point.occupiedBy = remoteOcc?.actor
    const index = point.confirmations.findIndex((item) => !item.synced && item.kind === '占用' && item.actor === op.actor)
    if (index >= 0) point.confirmations.splice(index, 1)
  }

  /** 回网后逐条补传：能排清顺序的合并，其余留待确认冲突 */
  function syncQueue() {
    if (connection.value !== '在线') return
    for (const op of [...pendingOps.value]) {
      if (op.status === '冲突') continue
      op.status = '同步中'
      const permit = permits.value.find((item) => item.id === op.permitId)
      if (!permit) {
        op.status = '失败'
        op.retries += 1
        op.lastError = '许可不存在'
        continue
      }
      // 模拟补传传输失败：留在队列等待重试，后续条目一并暂停
      if (Math.random() < 0.15) {
        op.status = '失败'
        op.retries += 1
        op.lastError = '补传超时，等待重试'
        addAudit('系统', '补传失败', `${op.permitId}${op.pointId ? ` / ${op.pointId}` : ''}`, `基于 r${op.baseRevision} 的${op.kind}记录第 ${op.retries} 次补传失败`, op.id)
        break
      }
      const remote = remoteRevisions.value[op.permitId] ?? permit.revision
      const intersecting = remoteChanges.value.filter((change) => change.permitId === op.permitId
        && change.revision > op.baseRevision
        && (op.kind === '流程推进' || !op.pointId || change.pointId === op.pointId))
      if (intersecting.length) {
        op.status = '冲突'
        registerConflict({
          opId: op.id, permitId: op.permitId, pointId: op.pointId,
          reason: `本机基于 r${op.baseRevision} 的${op.kind}与远端 r${remote} 落在同一${op.pointId ? '隔离点' : '许可'}，无法自动排序`,
          localRevision: op.baseRevision, remoteRevision: remote,
        })
        addAudit('系统', '同步冲突', `${op.permitId}${op.pointId ? ` / ${op.pointId}` : ''}`, `基于 r${op.baseRevision} 的补传与远端 r${remote} 冲突，留待确认`, op.id)
        if (op.kind === '占用' && op.pointId) rollbackOccupancy(permit, op)
        continue
      }
      // 顺序可排清：合并到远端修订之后
      permit.revision = remote + 1
      remoteRevisions.value[op.permitId] = permit.revision
      if (op.pointId) {
        const point = permit.isolationPoints.find((item) => item.id === op.pointId)
        const confirmation = point?.confirmations.find((item) => !item.synced && item.actor === op.actor && item.kind === op.kind)
        if (confirmation) confirmation.synced = true
      }
      pendingOps.value.splice(pendingOps.value.indexOf(op), 1)
      addAudit('系统', '补传同步', `${op.permitId}${op.pointId ? ` / ${op.pointId}` : ''}`, `基于 r${op.baseRevision} 的${op.kind}记录已合并到 r${permit.revision}${op.retries ? `（重试 ${op.retries} 次后成功）` : ''}`, op.id)
    }
    persist()
  }

  /** 失败的补传重新排队并逐条重试 */
  function retryPending() {
    for (const op of pendingOps.value) {
      if (op.status === '失败') {
        op.status = '待同步'
        op.lastError = undefined
      }
    }
    syncQueue()
  }

  /** 值班负责人处理冲突：保留本机或采用远端 */
  function resolveConflict(id: string, choice: '保留本地' | '采用远端') {
    const conflict = conflicts.value.find((item) => item.id === id)
    if (!conflict || conflict.status !== '待确认') return
    const permit = permits.value.find((item) => item.id === conflict.permitId)
    const op = conflict.opId ? pendingOps.value.find((item) => item.id === conflict.opId) : undefined
    const point = permit && conflict.pointId ? permit.isolationPoints.find((item) => item.id === conflict.pointId) : undefined
    if (choice === '保留本地' && permit) {
      const remote = remoteRevisions.value[conflict.permitId] ?? permit.revision
      permit.revision = remote + 1
      remoteRevisions.value[conflict.permitId] = permit.revision
      if (point && op) {
        if (op.kind === '占用') point.occupiedBy = op.actor
        const confirmation = point.confirmations.find((item) => !item.synced && item.actor === op.actor && item.kind === op.kind)
        if (confirmation) confirmation.synced = true
      }
      conflict.status = '已保留本地'
    } else {
      if (point) {
        if (op) {
          const index = point.confirmations.findIndex((item) => !item.synced && item.actor === op.actor && item.kind === op.kind)
          if (index >= 0) point.confirmations.splice(index, 1)
        }
        // 采用远端：占用人切换到远端记录的有效占用
        const remoteOcc = [...remoteChanges.value].reverse().find((item) => item.pointId === conflict.pointId && item.kind === '占用')
        if (remoteOcc) point.occupiedBy = remoteOcc.actor
      }
      conflict.status = '已采用远端'
    }
    if (op) pendingOps.value.splice(pendingOps.value.indexOf(op), 1)
    addAudit('值班负责人', '冲突解决', `${conflict.permitId}${conflict.pointId ? ` / ${conflict.pointId}` : ''}`, `${choice}：${conflict.reason}`, conflict.id)
    persist()
  }

  function conflictsFor(permitId: string) {
    return openConflicts.value.filter((item) => item.permitId === permitId)
  }

  function advancePermit(id: string) {
    const permit = permits.value.find((item) => item.id === id)
    if (!permit) return
    const flow: Record<string, Permit['status']> = { 待复核: '待执行', 待执行: '执行中', 执行中: '待结束', 待结束: '待关闭', 待关闭: '已完成' }
    const next = flow[permit.status]
    if (!next) return
    if (permit.status === '待复核' && permit.reviewRequired && !confirm('该许可存在待复核冲突，确认由值班负责人承担审批责任？')) return
    const from = permit.status
    permit.status = next
    permit.reviewRequired = false
    if (connection.value === '在线') {
      permit.revision += 1
      remoteRevisions.value[id] = permit.revision
      addAudit('当前用户', '流程推进', permit.id, `状态由“${from}”变更为“${next}”，修订推进到 r${permit.revision}`)
    } else {
      const op = enqueue({ permitId: id, kind: '流程推进', actor: '当前用户', baseRevision: permit.revision, payload: next })
      addAudit('当前用户', '离线记录', permit.id, `断网期间流程推进到“${next}”暂存本机，基于修订 r${op.baseRevision} 排队待同步`, op.id)
    }
    persist()
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
      permits.value.find((item) => item.id === 'WP-260929-021')!.reviewRequired = true
    }
    addAudit('当前用户', step.done ? '完成步骤' : '撤销步骤', `${permit.id} / ${step.id}`, step.text)
  }
  function addPermit(permit: Permit) {
    permits.value.unshift(permit)
    remoteRevisions.value[permit.id] = permit.revision
    addAudit('当前用户', '新建许可', permit.id, permit.title)
  }
  function acceptAlert() { latestAlert.value = ''; addAudit('值班负责人', '确认冲突', '跨班组重叠', '同意调整 LINE-A2 作业时间，不允许同时开工') }
  function markOffline() { connection.value = '重连中' }
  function markOnline() { connection.value = '在线'; syncQueue() }

  restore()
  return { permits, audit, connection, pendingOps, conflicts, queuedCount, failedCount, openConflicts, occupancyConflicts, latestAlert, confirmPoint, receiveRemote, syncQueue, retryPending, resolveConflict, conflictsFor, advancePermit, toggleStep, addPermit, acceptAlert, markOffline, markOnline, restore }
})
