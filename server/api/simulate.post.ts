import { getRemoteState, simulateRemoteOccupancy } from '~/server/utils/remoteStore'

/** 演示用：模拟另一名值班员在远端同时提交同一隔离点的占用确认 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{ pointId?: string; permitId?: string; actor?: string }>(event)
  const pointId = body.pointId ?? 'IP-411'
  const permitId = body.permitId ?? 'WP-260929-021'
  const actor = body.actor ?? '孙禾'
  const result = simulateRemoteOccupancy(pointId, permitId, actor)
  return { result, state: getRemoteState() }
})
