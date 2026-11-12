import type { Bar, Game, PeriodKey, SymbolData, WindowMeta } from '../data/segments'
import {
  DEFAULT_FEE_SCHEDULE,
  ZERO_FEES,
  addFees,
  classifyInstrument,
  computeFees,
  type FeeBreakdown,
  type FeeSchedule,
  type InstrumentKind,
  type InstrumentRule,
} from './fees'
import {
  runOrders,
  type ConditionalOrder,
  type OrderSide,
} from './orders'

export interface Candle {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/**
 * 当前价在「已揭示历史」中的位置。
 * 只统计日期严格早于当前日的日线 + 当前游标价，绝不碰未来 K 线。
 */
export interface HistoryPosition {
  /** 已揭示的历史日线根数 */
  bars: number
  from: string
  to: string
  high: number
  low: number
  highDate: string
  lowDate: string
  current: number
  /** 当前价高于多少比例的历史交易日收盘价（0~100） */
  rankPct: number
  /** 相对历史最高/最低价的涨跌幅 */
  fromHighPct: number
  fromLowPct: number
  /** 当前价在 [历史最低, 历史最高] 区间中的位置（0~100） */
  positionPct: number
  /** 降采样的历史收盘序列，最后一点是当前价，供界面画走势缩略线 */
  series: number[]
}

export interface Trade {
  /** 第几步推进（资金曲线横轴），不是 K 线序号 */
  index: number
  date: string
  side: 'buy' | 'sell'
  price: number
  shares: number
  fee: number
  /** 旧版本记录没有以下字段，展示时按 fee 兜底。 */
  amount?: number
  fees?: FeeBreakdown
  pnl: number | null
  source?: 'manual' | 'order'
  orderId?: string
}

export interface Score {
  pnlPct: number
  benchmarkPct: number
  excessPct: number
  maxDrawdown: number
  tradeCount: number
  winRate: number
  total: number
}

export interface SessionResult {
  id: string
  code: string
  period: PeriodKey
  periodLabel: string
  startDate: string
  endDate: string
  initialCash: number
  finalEquity: number
  score: Score
  trades: Trade[]
  equityCurve: number[]
  candles: Candle[]
  playedAt: number
  instrumentKind: InstrumentKind
  feeRule: InstrumentRule
  feeTotal: FeeBreakdown
  /** 本局条件单快照，复盘可核对触发价与失败原因 */
  orders?: ConditionalOrder[]
}

export interface EngineConfig {
  initialCash: number
  visibleBars: number
  fees: FeeSchedule
  kind: InstrumentKind
  lotSize: number
  limitRate: number
  view: PeriodKey
  viewLabel: string
}

export const DEFAULT_CONFIG: EngineConfig = {
  initialCash: 100000,
  visibleBars: 60,
  fees: DEFAULT_FEE_SCHEDULE,
  kind: 'stock',
  lotSize: 100,
  limitRate: 0.1,
  view: 'day',
  viewLabel: '日线',
}

export function configForWindow(
  meta: Pick<WindowMeta, 'key' | 'label' | 'visible'>,
  fees: FeeSchedule = DEFAULT_FEE_SCHEDULE,
): EngineConfig {
  return {
    ...DEFAULT_CONFIG,
    fees,
    view: meta.key,
    viewLabel: meta.label,
    visibleBars: meta.visible,
  }
}

const round2 = (n: number): number => Math.round(n * 100) / 100
const round3 = (n: number): number => Math.round(n * 1000) / 1000
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))
const dayOf = (label: string): string => label.slice(0, 10)

function candleFrom(bar: Bar, timestamp: number): Candle {
  return {
    timestamp,
    open: bar[1],
    high: bar[2],
    low: bar[3],
    close: bar[4],
    volume: bar[5],
  }
}

/**
 * 回放引擎：唯一持有完整一局历史的地方。
 *
 * 一局 = 一只标的 + 一个 5 分钟序列上的时间游标。「分时」和「日线」
 * 是同一段行情的两种视图，切换视图只改变 visible() 的聚合方式，
 * 资金、持仓、条件单、时间游标全部不动。日线视图里「当日」那根 K
 * 由当天截至游标的分钟 K 合成，绝不把整日 OHLC 提前暴露出去。
 */
export class ReplayEngine {
  private readonly minBars: Bar[]
  private readonly dayBars: Bar[]
  private readonly start: number
  private readonly end: number
  private now: number
  private view: PeriodKey
  private label: string
  private step = 0
  private cash: number
  private shares = 0
  private lockedShares = 0
  private avgCost = 0
  private readonly trades: Trade[] = []
  private readonly equityCurve: number[] = []
  private peakEquity: number
  private maxDrawdown = 0
  private ended = false
  private wins = 0
  private closedTrades = 0
  private feeTotal: FeeBreakdown = { ...ZERO_FEES }
  private orders: ConditionalOrder[] = []
  // 完整日线约 2800 根，一次渲染里 visible()/fullCandles() 会被调用多次，
  // 不缓存就会反复构建上万个对象；游标或视图变化后 key 自然失效。
  private visibleCache: { key: string; value: Candle[] } | null = null
  private fullCache: { key: string; value: Candle[] } | null = null

  readonly id: string
  readonly code: string
  readonly startedAt: number
  readonly config: EngineConfig

  private constructor(code: string, symbol: SymbolData, game: Game, config: EngineConfig) {
    this.code = code
    this.minBars = symbol.m5
    this.dayBars = symbol.day
    this.start = game.s
    this.end = game.e
    this.now = game.s
    this.view = config.view
    this.label = config.viewLabel
    this.config = config
    this.cash = config.initialCash
    this.peakEquity = config.initialCash
    this.id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    this.startedAt = Date.now()
    this.equityCurve.push(round2(this.equity))
  }

  static create(symbol: SymbolData, game: Game, config: EngineConfig = DEFAULT_CONFIG): ReplayEngine {
    if (symbol.m5.length < 100) throw new Error('分钟线不足，无法成局')
    if (game.s < 1 || game.e <= game.s || game.e >= symbol.m5.length) {
      throw new Error('对局游标越界')
    }
    const kind = classifyInstrument(game.c)
    return new ReplayEngine(game.c, symbol, game, { ...config, kind })
  }

  // ---- 视图与行情 ----------------------------------------------------

  get currentView(): PeriodKey {
    return this.view
  }

  get viewLabel(): string {
    return this.label
  }

  setView(key: PeriodKey, label: string): void {
    this.view = key
    this.label = label
  }

  get currentPrice(): number {
    return this.minBars[this.now][4]
  }

  get currentLabel(): string {
    return this.minBars[this.now][0]
  }

  get currentDay(): string {
    return dayOf(this.currentLabel)
  }

  get previousClose(): number {
    return this.previousCloseFor(this.currentDay)
  }

  /** 相对前一交易日收盘的涨跌幅，条件单表单与盘口条共用。 */
  get dayChangePct(): number {
    const prev = this.previousCloseFor(this.currentDay)
    return prev ? round2((this.currentPrice / prev - 1) * 100) : 0
  }

  private previousCloseFor(date: string): number {
    for (let i = this.dayBars.length - 1; i >= 0; i -= 1) {
      if (this.dayBars[i][0] < date) return this.dayBars[i][4]
    }
    return this.minBars[0][1]
  }

  /** 日线视图的当日 K：只聚合当天已揭示的分钟 K，不含未来。 */
  private todayCandle(cursor: number): Candle | null {
    const day = dayOf(this.minBars[cursor][0])
    // 从当天第一根开始，不必每次从头扫整个分钟序列
    let first = cursor
    while (first > 0 && dayOf(this.minBars[first - 1][0]) === day) first -= 1
    let high = -Infinity
    let low = Infinity
    let volume = 0
    for (let i = first; i <= cursor; i += 1) {
      const bar = this.minBars[i]
      high = Math.max(high, bar[2])
      low = Math.min(low, bar[3])
      volume += bar[5]
    }
    return {
      timestamp: 0, // 由 candlesUntil 按输出位置重编号为连续序号
      open: this.minBars[first][1],
      high,
      low,
      close: this.minBars[cursor][4],
      volume,
    }
  }

  /** all=true 用于复盘，给完整走势；训练时只给已揭示部分。 */
  private candlesUntil(cursor: number, all: boolean): Candle[] {
    if (this.view === 'm5') {
      // 全量累积而非滑动窗口：推进时只需往图表追加一根，用户画的线不会丢。
      // 视口由图表自动停在右端，需要看更早的行情用缩放/平移。
      const to = all ? this.end : cursor
      return this.minBars.slice(0, to + 1).map((bar, i) => candleFrom(bar, i))
    }
    const day = dayOf(this.minBars[cursor][0])
    const out: Candle[] = []
    // dayBars 按日期递增；当前日及之后的完整日 K 一律不进入训练视图。
    for (const bar of this.dayBars) {
      if (bar[0] >= day) break
      out.push(candleFrom(bar, out.length))
    }
    const today = this.todayCandle(cursor)
    if (today) {
      today.timestamp = out.length
      out.push(today)
    }
    return out
  }

  private viewStamp(): string {
    return `${this.view}:${this.now}:${this.step}`
  }

  visible(): Candle[] {
    const key = this.viewStamp()
    if (this.visibleCache?.key === key) return this.visibleCache.value
    const value = this.candlesUntil(this.now, false)
    this.visibleCache = { key, value }
    return value
  }

  fullCandles(): Candle[] {
    const key = `${this.view}:${this.end}`
    if (this.fullCache?.key === key) return this.fullCache.value
    const value = this.candlesUntil(this.end, true)
    this.fullCache = { key, value }
    return value
  }

  /**
   * 当前价在已揭示历史中的位置。
   * 严格只看「日期 < 当前日」的日线，加上游标处的实时价；完整日线数组里
   * 当前日及之后的 K 全部跳过，因此缩小回看历史不会把未来透露出去。
   */
  historyPosition(): HistoryPosition | null {
    const day = this.currentDay
    const current = this.currentPrice
    let high = -Infinity
    let low = Infinity
    let highDate = ''
    let lowDate = ''
    let from = ''
    let to = ''
    let count = 0
    let below = 0
    const closes: number[] = []
    for (const bar of this.dayBars) {
      if (bar[0] >= day) break
      if (!from) from = bar[0]
      to = bar[0]
      count += 1
      closes.push(bar[4])
      if (bar[2] > high) {
        high = bar[2]
        highDate = bar[0]
      }
      if (bar[3] < low) {
        low = bar[3]
        lowDate = bar[0]
      }
      if (bar[4] <= current) below += 1
    }
    if (!count || !Number.isFinite(high) || !Number.isFinite(low)) return null
    // 长期历史降到 160 点以内画缩略线，末点接上当前价
    const stride = Math.max(1, Math.ceil(closes.length / 160))
    const series: number[] = []
    for (let i = 0; i < closes.length; i += stride) series.push(round3(closes[i]))
    series.push(round3(current))
    const span = high - low
    return {
      bars: count,
      from,
      to,
      high: round3(high),
      low: round3(low),
      highDate,
      lowDate,
      current: round3(current),
      rankPct: round2((below / count) * 100),
      fromHighPct: high > 0 ? round2((current / high - 1) * 100) : 0,
      fromLowPct: low > 0 ? round2((current / low - 1) * 100) : 0,
      positionPct: span > 0 ? round2(clamp(((current - low) / span) * 100, 0, 100)) : 50,
      series,
    }
  }

  // ---- 账户 ----------------------------------------------------------

  private rule(): InstrumentRule {
    return this.config.fees[this.config.kind] ?? this.config.fees.stock
  }

  private trackEquity(): void {
    const value = this.equity
    this.equityCurve.push(round2(value))
    if (value > this.peakEquity) this.peakEquity = value
    if (this.peakEquity > 0) {
      const drawdown = ((this.peakEquity - value) / this.peakEquity) * 100
      if (drawdown > this.maxDrawdown) this.maxDrawdown = drawdown
    }
  }

  get isEnded(): boolean {
    return this.ended
  }

  get cashValue(): number {
    return round2(this.cash)
  }

  get shareCount(): number {
    return this.shares
  }

  get availableShares(): number {
    return this.shares - this.lockedShares
  }

  get lockedShareCount(): number {
    return this.lockedShares
  }

  get costPrice(): number {
    return this.avgCost
  }

  get equity(): number {
    return this.cash + this.shares * this.currentPrice
  }

  get marketValue(): number {
    return round2(this.shares * this.currentPrice)
  }

  get profit(): number {
    return round2(this.equity - this.config.initialCash)
  }

  get profitPct(): number {
    return round2((this.equity / this.config.initialCash - 1) * 100)
  }

  get tradeList(): Trade[] {
    return this.trades.slice()
  }

  get instrumentKind(): InstrumentKind {
    return this.config.kind
  }

  get feeRule(): InstrumentRule {
    return this.rule()
  }

  get totalFees(): FeeBreakdown {
    return { ...this.feeTotal }
  }

  /**
   * 进度按统一的时间游标算（已推进的 5 分钟 K 根数），与图表里画了多少根
   * 历史 K 线脱钩：日线视图带 2015 年起的完整历史，若按 K 线数算会一开局
   * 就显示「2786 / 2801」，看起来像快结束了；切换窗口也不该让进度跳变。
   */
  get index(): number {
    return this.now - this.start
  }

  get total(): number {
    return this.end - this.start
  }

  get orderList(): ConditionalOrder[] {
    return this.orders.slice()
  }

  setOrders(list: ConditionalOrder[]): void {
    this.orders = list.slice()
  }

  // ---- 推进 ----------------------------------------------------------

  /** 日线视图一次推进一根完整日 K：先补完当天，再逐日往前。 */
  private nextDayCursor(): number {
    const day = this.currentDay
    let todayEnd = this.now
    for (let i = this.now; i <= this.end; i += 1) {
      if (dayOf(this.minBars[i][0]) !== day) break
      todayEnd = i
    }
    if (todayEnd > this.now) return todayEnd
    for (let i = this.now + 1; i <= this.end; i += 1) {
      if (dayOf(this.minBars[i][0]) === day) continue
      const nextDay = dayOf(this.minBars[i][0])
      let last = i
      while (last + 1 <= this.end && dayOf(this.minBars[last + 1][0]) === nextDay) last += 1
      return last
    }
    return this.end
  }

  advance(): boolean {
    if (this.ended) return false
    const target = this.view === 'm5'
      ? Math.min(this.now + 1, this.end)
      : this.nextDayCursor()

    for (let i = this.now + 1; i <= target; i += 1) {
      const bar = this.minBars[i]
      const prevDay = dayOf(this.minBars[i - 1][0])
      if (dayOf(bar[0]) !== prevDay) this.lockedShares = 0
      this.now = i
      // 条件单按 5 分钟 K 逐根判定，日线视图下一次跨多根也会依次执行
      this.orders = runOrders(this.orders, bar, i, (o, price) =>
        this.executeOrder(o, price, i),
      )
    }
    this.step += 1
    this.trackEquity()
    if (this.now >= this.end) this.ended = true
    return !this.ended
  }

  // ---- 成交 ----------------------------------------------------------

  private limitFlagsAt(bar: Bar): { up: boolean; down: boolean } {
    const prev = this.previousCloseFor(dayOf(bar[0]))
    const rate = this.config.limitRate
    return {
      up: bar[4] >= prev * (1 + rate) - 0.001,
      down: bar[4] <= prev * (1 - rate) + 0.001,
    }
  }

  private execute(
    side: OrderSide,
    requested: number,
    price: number,
    index: number,
    label: string,
    source: 'manual' | 'order',
    orderId?: string,
  ): { ok: boolean; reason?: string } {
    if (this.ended) return { ok: false, reason: '本局已结束' }
    const lot = this.config.lotSize
    let qty = Math.floor(requested / lot) * lot
    if (qty <= 0) return { ok: false, reason: `最小 ${lot} 股` }
    const flags = this.limitFlagsAt(this.minBars[index])
    if (side === 'buy' && flags.up) return { ok: false, reason: '涨停，无法买入' }
    if (side === 'sell' && flags.down) return { ok: false, reason: '跌停，无法卖出' }

    if (side === 'sell') {
      qty = Math.min(this.availableShares, qty)
      if (qty <= 0) {
        return {
          ok: false,
          reason: this.lockedShares > 0 ? 'T+1：当日买入次日才能卖' : '没有可卖持仓',
        }
      }
    }

    const amount = qty * price
    const fees = computeFees(amount, side, this.config.kind, this.config.fees)
    let pnl: number | null = null
    if (side === 'buy') {
      if (this.cash + 0.001 < amount + fees.total) {
        return { ok: false, reason: '可用资金不足' }
      }
      const totalCost = this.avgCost * this.shares + amount + fees.total
      this.cash -= amount + fees.total
      this.shares += qty
      this.lockedShares += qty
      this.avgCost = totalCost / this.shares
    } else {
      pnl = (price - this.avgCost) * qty - fees.total
      this.cash += amount - fees.total
      this.shares -= qty
      this.closedTrades += 1
      if (pnl > 0) this.wins += 1
      if (this.shares === 0) this.avgCost = 0
    }

    this.feeTotal = addFees(this.feeTotal, fees)
    this.trades.push({
      index: this.step,
      date: label,
      side,
      price: round3(price),
      shares: qty,
      fee: fees.total,
      amount: round2(amount),
      fees,
      pnl: pnl === null ? null : round2(pnl),
      source,
      orderId,
    })
    return { ok: true }
  }

  private executeOrder(o: ConditionalOrder, price: number, index: number) {
    return this.execute(
      o.side,
      o.shares,
      price,
      index,
      this.minBars[index][0],
      'order',
      o.id,
    )
  }

  buy(requested: number = this.config.lotSize): { ok: boolean; reason?: string } {
    return this.execute('buy', requested, this.currentPrice, this.now, this.currentLabel, 'manual')
  }

  sell(requested: number = this.config.lotSize): { ok: boolean; reason?: string } {
    return this.execute('sell', requested, this.currentPrice, this.now, this.currentLabel, 'manual')
  }

  /** 精确求解：最低佣金让费用非线性，先估上界再逐手回退，保证全仓买入不会买超。 */
  maxBuyable(): number {
    const price = this.currentPrice
    const lot = this.config.lotSize
    const rule = this.rule()
    let lots = Math.floor(
      this.cash / (price * (1 + rule.commissionRate + rule.transferRate) * lot),
    )
    while (lots > 0) {
      const qty = lots * lot
      const amount = qty * price
      const fees = computeFees(amount, 'buy', this.config.kind, this.config.fees)
      if (this.cash + 0.001 >= amount + fees.total) return qty
      lots -= 1
    }
    return 0
  }

  finish(): SessionResult {
    this.ended = true
    const finalEquity = round2(this.equity)
    const first = this.minBars[this.start][4]
    const last = this.minBars[this.end][4]
    const benchmarkPct = round2((last / first - 1) * 100)
    const pnlPct = round2((finalEquity / this.config.initialCash - 1) * 100)
    const excessPct = round2(pnlPct - benchmarkPct)
    const winRate =
      this.closedTrades > 0 ? round2((this.wins / this.closedTrades) * 100) : 0
    const tradeCount = this.trades.length
    const total = clamp(
      Math.round(
        50 + excessPct * 1.5 - this.maxDrawdown * 0.8 - Math.max(0, tradeCount - 8) * 0.4,
      ),
      0,
      100,
    )

    return {
      id: this.id,
      code: this.code,
      period: this.view,
      periodLabel: this.label,
      startDate: this.minBars[this.start][0],
      endDate: this.minBars[this.end][0],
      initialCash: this.config.initialCash,
      finalEquity,
      score: {
        pnlPct,
        benchmarkPct,
        excessPct,
        maxDrawdown: round2(this.maxDrawdown),
        tradeCount,
        winRate,
        total,
      },
      trades: this.trades.slice(),
      equityCurve: this.equityCurve.slice(),
      candles: this.fullCandles(),
      playedAt: this.startedAt,
      instrumentKind: this.config.kind,
      feeRule: { ...this.rule() },
      feeTotal: { ...this.feeTotal },
      orders: this.orders.slice(),
    }
  }
}
