export type PermitStatus = '待复核' | '待执行' | '执行中' | '待结束' | '待关闭' | '已完成'

export type ConfirmKind = '占用' | '锁定' | '验电'

export interface PointConfirmation {
  id: string
  kind: ConfirmKind
  actor: string
  time: string
  /** 确认时基于的许可修订号 */
  revision: number
  /** 是否已同步到远端；断网期间暂存本机的记录为 false */
  synced: boolean
}

export interface IsolationPoint {
  id: string
  device: string
  label: string
  type: '开关' | '刀闸' | '阀门' | '接地'
  state: '已隔离' | '待操作' | '已恢复'
  /** 当前唯一有效占有人；同一隔离点只保留一个有效占用 */
  occupiedBy?: string
  confirmations: PointConfirmation[]
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

/** 断网期间排队待补传的本机操作，携带原修订号 */
export interface PendingOp {
  id: string
  permitId: string
  pointId?: string
  kind: ConfirmKind | '流程推进'
  actor: string
  baseRevision: number
  queuedAt: string
  status: '待同步' | '同步中' | '失败' | '冲突'
  retries: number
  /** 流程推进的目标状态 */
  payload?: string
  lastError?: string
}

/** 无法自动排序、留待值班负责人确认的同步冲突 */
export interface SyncConflict {
  id: string
  opId?: string
  permitId: string
  pointId?: string
  reason: string
  localRevision: number
  remoteRevision: number
  status: '待确认' | '已保留本地' | '已采用远端'
}

/** 远端已发生的修订，用于补传时判断能否排清顺序 */
export interface RemoteChange {
  permitId: string
  pointId?: string
  kind: ConfirmKind | '流程推进'
  revision: number
  actor: string
  summary: string
}

export interface AuditEvent {
  id: string
  time: string
  actor: string
  action: string
  target: string
  detail: string
  /** 关联的补传操作；同一操作重复补传不重复写审计 */
  opId?: string
}
