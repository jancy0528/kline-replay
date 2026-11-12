/** 条件单：纯数据 + 触发判定，不依赖回放引擎，便于单独校验。 */

import type { Bar } from '../data/segments'

export type OrderStatus = 'watching' | 'triggered' | 'failed' | 'paused'
export type OrderTrigger = 'gte' | 'lte'
export type OrderSide = 'buy' | 'sell'

export interface ConditionalOrder {
  id: string
  /** ≥ 触发价买入/卖出，或 ≤ 触发价买入/卖出 */
  trigger: OrderTrigger
  price: number
  side: OrderSide
  shares: number
  status: OrderStatus
  /** 建单时所属标的；换股后暂停，恢复时提醒触发价可能已不适用 */
  code: string
  createdAt: number
  /** 失败/暂停原因、触发价与时间 */
  reason?: string
  triggeredIndex?: number
  triggeredAt?: string
  triggeredPrice?: number
}

export interface OrderExecution {
  ok: boolean
  reason?: string
}

export function newOrderId(): string {
  return `o-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function orderText(o: ConditionalOrder): string {
  const cond = o.trigger === 'lte' ? '小等于' : '大等于'
  const side = o.side === 'buy' ? '买入' : '卖出'
  return `股价条件：股价${cond} ${o.price.toFixed(2)} ${side}，委托股数：${o.shares} 股`
}

export function statusText(o: ConditionalOrder): string {
  if (o.status === 'paused') return `已暂停（${o.reason ?? '手动'}）`
  if (o.status === 'triggered') return '已触发'
  if (o.status === 'failed') return '已失败'
  return '监控中'
}

/**
 * 本根 K 线是否触发。返回实际成交价：
 * 开盘价已经越过触发线时按开盘价成交（不会拿到比市场更优的价格），
 * 否则按触发价成交；结果再夹在当根 K 线的高低区间内。
 */
export function triggerHit(o: ConditionalOrder, bar: Bar): number | null {
  const [, open, high, low] = bar
  if (o.trigger === 'gte') {
    if (high < o.price) return null
    return Math.min(high, Math.max(low, Math.max(open, o.price)))
  }
  if (low > o.price) return null
  return Math.max(low, Math.min(high, Math.min(open, o.price)))
}

/** 按列表从上往下顺序执行；前面成交后资金/持仓变化会直接影响后面的单。 */
export function runOrders(
  orders: ConditionalOrder[],
  bar: Bar,
  index: number,
  execute: (order: ConditionalOrder, price: number) => OrderExecution,
): ConditionalOrder[] {
  let changed = false
  const next = orders.map((o) => {
    if (o.status !== 'watching') return o
    const price = triggerHit(o, bar)
    if (price === null) return o
    changed = true
    const res = execute(o, price)
    return {
      ...o,
      status: res.ok ? ('triggered' as const) : ('failed' as const),
      reason: res.ok ? undefined : (res.reason ?? '条件不满足'),
      triggeredIndex: index,
      triggeredAt: bar[0],
      triggeredPrice: Math.round(price * 1000) / 1000,
    }
  })
  return changed ? next : orders
}

export function pauseOnSwitch(orders: ConditionalOrder[], code: string): ConditionalOrder[] {
  return orders.map((o) =>
    o.status === 'watching'
      ? { ...o, status: 'paused' as const, reason: '换股' }
      : o,
  ).map((o) => ({ ...o, code: o.code || code }))
}
