import type { OutboxMutation } from '~/types'
import { getRemoteState, processMutation } from '~/server/utils/remoteStore'

/**
 * 逐条补传断网期间的现场变更。
 * 请求体为单条排队记录（OutboxMutation），服务端按 baseRevision 判重合并，
 * 返回处理结果、本次新增审计与最新远端状态。同一 mutationId 重复请求幂等。
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<OutboxMutation>(event)
  if (!body || !body.id || !body.kind || !body.permitId) {
    throw createError({ statusCode: 400, statusMessage: '无效的补传记录：缺少 id / kind / permitId' })
  }
  const result = processMutation(body)
  return {
    result,
    state: getRemoteState(),
  }
})
