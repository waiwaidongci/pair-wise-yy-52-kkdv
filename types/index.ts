export type PermitStatus = '待复核' | '待执行' | '执行中' | '待结束' | '待关闭' | '已完成'

export interface IsolationPoint {
  id: string
  device: string
  label: string
  type: '开关' | '刀闸' | '阀门' | '接地'
  state: '已隔离' | '待操作' | '已恢复'
}

export interface Permit {
  id: string
  title: string
  device: string
  crew: string
  owner: string
  window: string
  status: PermitStatus
  risk: '一级' | '二级' | '三级'
  isolationPoints: IsolationPoint[]
  steps: { id: string; text: string; done: boolean; owner: string; evidence?: string }[]
  revision: number
  reviewRequired: boolean
}

export interface AuditEvent {
  id: string
  time: string
  actor: string
  action: string
  target: string
  detail: string
  /** 关联的本机变更 ID，用于补传成功后去重，避免重复写审计 */
  mutationId?: string
  /** false = 断网期间仅存本机，true = 已由远端确认落库 */
  synced?: boolean
}

/** 连接状态：断网期间所有现场确认只留本机 */
export type ConnectionState = '在线' | '断网'

/** 排队状态机：待同步 → 同步中 → 已同步 / 已合并 / 冲突 / 失败(可重试) */
export type MutationStatus = '待同步' | '同步中' | '失败' | '已同步' | '已合并' | '冲突'

export type MutationKind = 'step' | 'permit' | 'occupy' | 'lock' | 'voltage' | 'resolve' | 'permit-create'

/**
 * 断网期间的现场变更记录。
 * baseRevision 记录产生该变更时依据的远端修订号，
 * 回网后逐条补传，由远端按修订号判重合并。
 */
export interface OutboxMutation {
  /** 本机生成的幂等键，补传失败重试也不变 */
  id: string
  kind: MutationKind
  permitId: string
  pointId?: string
  /** 产生该变更时依据的许可修订号 */
  baseRevision: number
  actor: string
  createdAt: string
  op: Record<string, unknown>
  status: MutationStatus
  attempts: number
  lastError?: string
  /** 补传成功后远端返回的最新修订号 */
  resultRevision?: number
  conflictId?: string
}

/** 隔离点占用记录：同一时刻同一隔离点只保留一个有效占用 */
export interface Occupancy {
  pointId: string
  permitId: string
  actor: string
  locked: boolean
  voltageVerified: boolean
  confirmedAt: string
  /** 冲突中落败的占用置为 false，总览提示占用冲突 */
  valid: boolean
  conflictId?: string
}

export type ConflictStatus = '待确认' | '已保留' | '已放弃'

/** 远端修订冲突：能排清顺序的已合并，排不清的留待值班负责人确认 */
export interface ConflictRecord {
  id: string
  mutationId: string
  pointId?: string
  permitId?: string
  kind: MutationKind
  reason: string
  actor: string
  winnerActor?: string
  createdAt: string
  status: ConflictStatus
}

/** 远端修订历史：记录每次修订的操作人、目标字段，用于合并判定 */
export interface RevisionChange {
  revision: number
  mutationId: string
  actor: string
  kind: MutationKind
  permitId: string
  targetId: string
  field: string
  value: unknown
  at: string
}

/** 补传接口返回的单条处理结果 */
export interface SyncResult {
  mutationId: string
  status: '已同步' | '已合并' | '冲突'
  revision?: number
  conflictId?: string
  reason?: string
}
