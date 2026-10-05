import type { AuditEvent, ConflictRecord, Occupancy, OutboxMutation, Permit, RevisionChange } from '~/types'
import { auditEvents as seedAudit, permits as seedPermits } from '~/utils/mock'

/**
 * 远端权威状态（模拟中心服务）。
 * - 每个许可带 revision，补传时按 baseRevision 判定是否落后
 * - 保留修订历史，能排清顺序的变更自动合并，排不清的进入冲突
 * - applied 是幂等日志：同一 mutationId 重复补传只返回首次结果，不重复落库、不重复写审计
 */

interface RemotePermit extends Permit {
  history: RevisionChange[]
}

interface SyncResult {
  mutationId: string
  status: '已同步' | '已合并' | '冲突'
  revision?: number
  conflictId?: string
  reason?: string
}

interface RemoteState {
  permits: RemotePermit[]
  occupancy: Map<string, Occupancy>
  conflicts: ConflictRecord[]
  audit: AuditEvent[]
  /** 幂等日志：mutationId -> 首次处理结果 */
  applied: Map<string, SyncResult>
}

function nowTime() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** 远端种子：模拟“别人已经改过”——修订号比本机草稿更高，且已有他人占用 */
function seed(): RemoteState {
  const permits: RemotePermit[] = [
    {
      ...structuredClone(seedPermits[0]!),
      revision: 6,
      history: [
        { revision: 5, mutationId: 'SEED-M-ST02', actor: '周野', kind: 'step', permitId: 'WP-260929-018', targetId: 'WP-260929-018', field: 'step:ST-02', value: true, at: '16:32' },
        { revision: 6, mutationId: 'SEED-M-OCC301', actor: '周野', kind: 'occupy', permitId: 'WP-260929-018', targetId: 'IP-301', field: 'occupy:IP-301', value: true, at: '16:35' },
      ],
    },
    {
      ...structuredClone(seedPermits[1]!),
      revision: 3,
      history: [
        { revision: 3, mutationId: 'SEED-M-REV21', actor: '赵清', kind: 'permit', permitId: 'WP-260929-021', targetId: 'WP-260929-021', field: 'reviewRequired', value: true, at: '15:56' },
      ],
    },
    { ...structuredClone(seedPermits[2]!), revision: 1, history: [] },
  ]

  const occupancy = new Map<string, Occupancy>([
    ['IP-301', { pointId: 'IP-301', permitId: 'WP-260929-018', actor: '周野', locked: true, voltageVerified: true, confirmedAt: '16:35', valid: true }],
  ])

  const audit: AuditEvent[] = [
    ...seedAudit.map((event) => ({ ...event, synced: true })),
    { id: 'AE-904', time: '16:35', actor: '周野', action: '确认占用', target: 'IP-301', detail: 'WP-260929-018 塔基 690V 主开关已隔离、锁定并验电', mutationId: 'SEED-M-OCC301', synced: true },
    { id: 'AE-905', time: '15:56', actor: '赵清', action: '复核通过', target: 'WP-260929-021', detail: '共用母线隔离边界需值班负责人重新确认', mutationId: 'SEED-M-REV21', synced: true },
  ]

  return { permits, occupancy, conflicts: [], audit, applied: new Map() }
}

const state: RemoteState = seed()

function fieldOf(mut: OutboxMutation): string {
  switch (mut.kind) {
    case 'step': return `step:${String(mut.op.stepId)}`
    case 'permit': return 'status'
    case 'occupy':
    case 'lock':
    case 'voltage': return `${mut.kind}:${String(mut.pointId)}`
    case 'resolve': return `resolve:${String(mut.op.conflictId)}`
    case 'permit-create': return 'create'
  }
}

function historyValue(mut: OutboxMutation): unknown {
  switch (mut.kind) {
    case 'step': return Boolean(mut.op.done)
    case 'permit': return String(mut.op.status)
    case 'occupy':
    case 'lock':
    case 'voltage': return true
    case 'resolve': return String(mut.op.decision)
    case 'permit-create': return true
  }
}

function actionOf(mut: OutboxMutation): { action: string; target: string; detail: string } {
  switch (mut.kind) {
    case 'step':
      return { action: mut.op.done ? '完成步骤' : '撤销步骤', target: `${mut.permitId} / ${String(mut.op.stepId)}`, detail: `现场步骤${mut.op.done ? '已确认' : '已撤销'}` }
    case 'permit':
      return { action: '流程推进', target: mut.permitId, detail: `状态变更为“${String(mut.op.status)}”` }
    case 'occupy':
      return { action: '确认占用', target: String(mut.pointId), detail: `${mut.permitId} 隔离点确认占用` }
    case 'lock':
      return { action: '加锁确认', target: String(mut.pointId), detail: `${mut.permitId} 隔离点已执行机械锁定` }
    case 'voltage':
      return { action: '验电确认', target: String(mut.pointId), detail: `${mut.permitId} 隔离点验电完成，具备接地条件` }
    case 'resolve':
      return { action: String(mut.op.decision) === '保留' ? '确认保留占用' : '放弃占用', target: String(mut.op.conflictId), detail: `冲突 ${String(mut.op.conflictId)} 已由值班负责人处理` }
    case 'permit-create':
      return { action: '新建许可', target: mut.permitId, detail: String((mut.op.permit as Permit).title) }
  }
}

/** 把变更真正落到远端许可/占用上 */
function applyMutation(mut: OutboxMutation, permit: RemotePermit | undefined): void {
  switch (mut.kind) {
    case 'step': {
      const step = permit?.steps.find((item) => item.id === mut.op.stepId)
      if (step) step.done = Boolean(mut.op.done)
      break
    }
    case 'permit': {
      if (permit && mut.op.status) {
        permit.status = mut.op.status as Permit['status']
        permit.reviewRequired = false
      }
      break
    }
    case 'occupy': {
      if (mut.pointId) {
        state.occupancy.set(mut.pointId, {
          pointId: mut.pointId,
          permitId: mut.permitId,
          actor: mut.actor,
          locked: false,
          voltageVerified: false,
          confirmedAt: nowTime(),
          valid: true,
        })
        const point = permit?.isolationPoints.find((item) => item.id === mut.pointId)
        if (point) point.state = '已隔离'
      }
      break
    }
    case 'lock': {
      if (mut.pointId) {
        const current = state.occupancy.get(mut.pointId)
        if (current) current.locked = true
        else state.occupancy.set(mut.pointId, { pointId: mut.pointId, permitId: mut.permitId, actor: mut.actor, locked: true, voltageVerified: false, confirmedAt: nowTime(), valid: true })
      }
      break
    }
    case 'voltage': {
      if (mut.pointId) {
        const current = state.occupancy.get(mut.pointId)
        if (current) current.voltageVerified = true
        else state.occupancy.set(mut.pointId, { pointId: mut.pointId, permitId: mut.permitId, actor: mut.actor, locked: false, voltageVerified: true, confirmedAt: nowTime(), valid: true })
      }
      break
    }
    case 'resolve': {
      const conflict = state.conflicts.find((item) => item.id === mut.op.conflictId)
      if (conflict) {
        conflict.status = mut.op.decision === '保留' ? '已保留' : '已放弃'
        if (mut.op.decision === '放弃' && conflict.pointId) {
          const occ = state.occupancy.get(conflict.pointId)
          if (occ) occ.valid = false
        }
      }
      break
    }
    case 'permit-create': {
      const exists = state.permits.some((item) => item.id === mut.permitId)
      if (!exists) {
        state.permits.unshift({ ...(mut.op.permit as Permit), revision: 1, history: [] })
      }
      break
    }
  }
}

/**
 * 合并判定：
 * - 修订号一致：直接应用
 * - 远端已前进：遍历 baseRevision 之后的修订历史
 *   - 同一操作人的连续编辑（同字段）：后写覆盖先写，可合并
 *   - 不同操作人触碰同一许可的同一字段 / 同一隔离点：冲突，只留一个有效占用
 *   - 其余（不同步骤、不同字段、不同隔离点）：可排序，合并
 */
function decide(mut: OutboxMutation, permit: RemotePermit | undefined): { decision: 'apply' | 'merge' | 'conflict'; blocker?: RevisionChange } {
  if (mut.kind === 'permit-create') {
    return state.permits.some((item) => item.id === mut.permitId) ? { decision: 'conflict' } : { decision: 'apply' }
  }
  if (!permit) return { decision: 'conflict' }

  // 占用冲突优先判定：无论修订是否一致，同一点已有他人有效占用即冲突，只留一个有效占用
  if (mut.kind === 'occupy' && mut.pointId) {
    const current = state.occupancy.get(mut.pointId)
    if (current && current.valid && current.actor !== mut.actor) {
      return {
        decision: 'conflict',
        blocker: { revision: permit.revision, mutationId: 'SEED', actor: current.actor, kind: 'occupy', permitId: mut.permitId, targetId: mut.pointId, field: 'occupy:' + mut.pointId, value: true, at: current.confirmedAt },
      }
    }
  }

  if (permit.revision === mut.baseRevision) return { decision: 'apply' }

  const field = fieldOf(mut)
  const targetId = mut.pointId ?? mut.permitId
  for (const change of permit.history) {
    if (change.revision <= mut.baseRevision) continue
    // 同一操作人在本机的连续编辑，远端只保留最后一版，可合并
    if (change.actor === mut.actor) continue
    if (change.kind === mut.kind && change.targetId === targetId && change.field === field) {
      return { decision: 'conflict', blocker: change }
    }
  }

  return { decision: 'merge' }
}

/** 处理一条补传变更（幂等） */
export function processMutation(mut: OutboxMutation): SyncResult {
  const cached = state.applied.get(mut.id)
  if (cached) return cached

  const permit = state.permits.find((item) => item.id === mut.permitId)
  const { decision, blocker } = decide(mut, permit)

  if (decision === 'conflict') {
    const conflictId = `CF-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const winner = blocker?.actor ?? '远端'
    const conflict: ConflictRecord = {
      id: conflictId,
      mutationId: mut.id,
      pointId: mut.pointId,
      permitId: mut.permitId,
      kind: mut.kind,
      reason: mut.kind === 'occupy'
        ? `隔离点 ${mut.pointId} 同时收到 ${mut.actor} 与 ${winner} 的占用确认，只保留一个有效占用`
        : `${mut.actor} 与 ${winner} 对同一许可 ${mut.permitId} 的同一字段产生冲突，需值班负责人确认`,
      actor: mut.actor,
      winnerActor: winner,
      createdAt: nowTime(),
      status: '待确认',
    }
    state.conflicts.unshift(conflict)
    state.audit.unshift({
      id: `AE-${Date.now().toString(36)}`,
      time: nowTime(),
      actor: '系统',
      action: '占用冲突',
      target: mut.pointId ?? mut.permitId,
      detail: conflict.reason,
      mutationId: mut.id,
      synced: true,
    })
    const result: SyncResult = { mutationId: mut.id, status: '冲突', conflictId, reason: conflict.reason }
    state.applied.set(mut.id, result)
    return result
  }

  applyMutation(mut, permit)

  let revision = permit?.revision ?? 1
  if (permit) {
    revision = permit.revision + 1
    permit.revision = revision
    permit.history.push({
      revision,
      mutationId: mut.id,
      actor: mut.actor,
      kind: mut.kind,
      permitId: mut.permitId,
      targetId: mut.pointId ?? mut.permitId,
      field: fieldOf(mut),
      value: historyValue(mut),
      at: nowTime(),
    })
  }

  const { action, target, detail } = actionOf(mut)
  state.audit.unshift({
    id: `AE-${Date.now().toString(36)}`,
    time: nowTime(),
    actor: mut.actor,
    action,
    target,
    detail,
    mutationId: mut.id,
    synced: true,
  })

  const result: SyncResult = { mutationId: mut.id, status: decision === 'apply' ? '已同步' : '已合并', revision }
  state.applied.set(mut.id, result)
  return result
}

/** 模拟另一名值班员在远端同时提交占用确认（演示用） */
export function simulateRemoteOccupancy(pointId: string, permitId: string, actor: string): SyncResult {
  const mut: OutboxMutation = {
    id: `SIM-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    kind: 'occupy',
    permitId,
    pointId,
    baseRevision: state.permits.find((item) => item.id === permitId)?.revision ?? 1,
    actor,
    createdAt: new Date().toISOString(),
    op: { pointId, permitId },
    status: '已同步',
    attempts: 1,
  }
  return processMutation(mut)
}

export function getRemoteState() {
  return {
    permits: state.permits.map((permit) => ({
      id: permit.id,
      title: permit.title,
      device: permit.device,
      crew: permit.crew,
      owner: permit.owner,
      window: permit.window,
      status: permit.status,
      risk: permit.risk,
      isolationPoints: permit.isolationPoints,
      steps: permit.steps,
      revision: permit.revision,
      reviewRequired: permit.reviewRequired,
    })),
    occupancy: [...state.occupancy.values()],
    conflicts: state.conflicts,
    audit: state.audit,
  }
}
