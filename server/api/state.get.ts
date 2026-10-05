import { getRemoteState } from '~/server/utils/remoteStore'

/** 拉取远端权威状态：许可修订、占用、冲突与审计 */
export default defineEventHandler(() => getRemoteState())
