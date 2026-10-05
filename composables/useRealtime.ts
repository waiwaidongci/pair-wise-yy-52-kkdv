import type { ConfirmKind } from '~/types'

type RemoteChangeEvent = { permitId: string; pointId?: string; kind: ConfirmKind | '流程推进'; actor: string; summary: string }
type RealtimeEvent =
  | { type: 'connection'; payload: string }
  | { type: 'remote'; change: RemoteChangeEvent }

/** 模拟通道：周期性推送其他值班人员在远端的确认与流程修订 */
const remotePool: RemoteChangeEvent[] = [
  { permitId: 'WP-260929-018', pointId: 'IP-303', kind: '验电', actor: '何岚', summary: '何岚 在远端完成 IP-303 叶轮机械锁验电确认' },
  { permitId: 'WP-260929-018', pointId: 'IP-301', kind: '占用', actor: '周野', summary: '周野 在远端占用 IP-301 塔基 690V 主开关' },
  { permitId: 'WP-260929-021', pointId: 'IP-411', kind: '锁定', actor: '孙禾', summary: '孙禾 在远端完成 IP-411 A2 进线断路器锁定' },
  { permitId: 'WP-260929-021', pointId: 'IP-413', kind: '占用', actor: '孙禾', summary: '孙禾 在远端提交 IP-413 母线侧隔离刀闸占用' },
  { permitId: 'WP-260929-021', kind: '流程推进', actor: '赵清', summary: '赵清 在远端复核推进 WP-260929-021' },
]

export function useRealtime(onEvent: (event: RealtimeEvent) => void) {
  let timer: ReturnType<typeof setInterval> | undefined
  let socket: WebSocket | undefined

  function connect() {
    const url = useRuntimeConfig().public.wsUrl as string | undefined
    if (url && import.meta.client) {
      socket = new WebSocket(url)
      socket.onmessage = (event) => onEvent(JSON.parse(event.data))
      socket.onclose = () => onEvent({ type: 'connection', payload: '重连中' })
      return
    }
    onEvent({ type: 'connection', payload: '在线 · 模拟通道' })
    timer = setInterval(() => {
      const change = remotePool[Math.floor(Math.random() * remotePool.length)]!
      onEvent({ type: 'remote', change: { ...change } })
    }, 12000)
  }
  function disconnect() { if (timer) clearInterval(timer); socket?.close() }
  onMounted(connect)
  onBeforeUnmount(disconnect)
  return { reconnect: connect, disconnect }
}
