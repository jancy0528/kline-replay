import type {
  Bar,
  Fundamentals,
  Game,
  PeriodKey,
  SymbolData,
  WindowMeta,
} from '../data/segments'
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
  /** 日线 'YYYY-MM-DD' / 分钟 'YYYY-MM-DD HH:mm'；周月 K 为该周期最后一天 */
  label: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/** 顶部报价区（用户只要市值/流通/额/换，高低开市盈量比振幅一律不显示）。 */
export interface QuoteMetrics {
  price: number
  change: number
  changePct: number
  marketCapYi: number
  floatCapYi: number
  /** 当日已揭示累计成交额，单位元；界面按万/亿自适应显示 */
  amount: number
  turnoverPct: number
}

/** 自绘分时图用的当日序列；全部来自已揭示分钟 K，不含未来。 */
export interface IntradayPoint {
  time: string
  price: number
  avg: number
  volume: number
  up: boolean
}

export interface IntradayData {
  date: string
  prevClose: number
  points: IntradayPoint[]
  high: number
  low: number
  /** 上下对称的涨跌幅刻度（百分数） */
  boundPct: number
  amount: number
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
    label: bar[0],
    open: bar[1],
    high: bar[2],
    low: bar[3],
    close: bar[4],
    volume: bar[5],
  }
}

/** ISO 周键 / 自然月键，用于把日线聚合成周 K、月 K。 */
function periodKey(label: string, unit: 'week' | 'month'): string {
  if (unit === 'month') return label.slice(0, 7)
  const [y, m, d] = label.slice(0, 10).split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  const day = (date.getUTCDay() + 6) % 7 // 周一=0
  date.setUTCDate(date.getUTCDate() - day)
  return date.toISOString().slice(0, 10) // 以周一作为该周唯一键
}

/** 按周/月把日线聚合成 OHLC；只吃已经揭示的日 K，天然不泄露未来。 */
function aggregateCandles(days: Candle[], unit: 'week' | 'month'): Candle[] {
  const groups: { key: string; bars: Candle[] }[] = []
  for (const bar of days) {
    const key = periodKey(bar.label, unit)
    const last = groups[groups.length - 1]
    if (last && last.key === key) last.bars.push(bar)
    else groups.push({ key, bars: [bar] })
  }
  return groups.map((g, i) => {
    const first = g.bars[0]
    let high = -Infinity
    let low = Infinity
    let volume = 0
    for (const b of g.bars) {
      high = Math.max(high, b.high)
      low = Math.min(low, b.low)
      volume += b.volume
    }
    return {
      timestamp: i,
      label: g.bars[g.bars.length - 1].label,
      open: first.open,
      high,
      low,
      close: g.bars[g.bars.length - 1].close,
      volume,
    }
  })
}

/**
 * 回放引擎：唯一持有完整一局历史的地方。
 *
 * 一局 = 一只标的 + 一个 5 分钟序列上的时间游标，但**推进单位是完整
 * 交易日**：开局游标停在起始日收盘，每次推进落到下一个日末。四窗口
 * 是同一段行情的四种视图，切换只改变 visible() 的聚合方式，资金、
 * 持仓、条件单、时间游标全部不动。当前交易日及其之前的完整 OHLC /
 * 分时都属于已知信息，之后的交易日绝不提前暴露。
 */
export class ReplayEngine {
  private readonly minBars: Bar[]
  private readonly dayBars: Bar[]
  private readonly fund: Fundamentals | null
  private readonly start: number
  private readonly end: number
  /** [start, end] 内每个完整交易日的最后一根 5 分钟 K，用于按天算进度。 */
  private readonly dayEnds: number[]
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
    this.fund = symbol.fundamentals ?? null
    this.start = game.s
    this.end = game.e
    // 训练按「日」决策：开局就把起始日走完，停在该日最后一根 5 分钟 K。
    // 这样切到分时看到的是那天完整的一整天，而不是只有一个点；此后每次
    // 推进都落在下一个日末，四个窗口同步换一天。s 是日首、e 是日末，
    // 由 tools/build_sessions.py 保证。
    const ends: number[] = []
    for (let i = this.start; i <= this.end; i += 1) {
      if (i === this.end || dayOf(this.minBars[i + 1][0]) !== dayOf(this.minBars[i][0])) {
        ends.push(i)
      }
    }
    this.dayEnds = ends
    this.now = this.dayEnds[0] ?? game.s
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
    // s 允许为 0：训练局起点必须能落在当天第一根 5 分钟 K 上
    if (game.s < 0 || game.e <= game.s || game.e >= symbol.m5.length) {
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

  /**
   * 游标所在交易日的第一根分钟 K，且不低于开局游标。
   * 下界必须是 start：否则一开局就会把「训练开始前那半天」也算进当日
   * 成交额/换手/分时线，看起来像已经走完了一天。
   */
  private dayFirstIndex(cursor: number): number {
    const day = dayOf(this.minBars[cursor][0])
    let first = cursor
    while (first > this.start && dayOf(this.minBars[first - 1][0]) === day) first -= 1
    return first
  }

  /** 日线视图的当日 K：只聚合当天已揭示的分钟 K，不含未来。 */
  private todayCandle(cursor: number): Candle | null {
    const day = dayOf(this.minBars[cursor][0])
    const first = this.dayFirstIndex(cursor)
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
      timestamp: 0, // 由 dayCandlesUntil 按输出位置重编号为连续序号
      label: day,
      open: this.minBars[first][1],
      high,
      low,
      close: this.minBars[cursor][4],
      volume,
    }
  }

  /** 截至游标的「安全日线序列」：历史完整日 K + 当日由分钟线合成的不完整 K。 */
  private dayCandlesUntil(cursor: number): Candle[] {
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

  /** all=true 用于复盘，给完整走势；训练时只给已揭示部分。 */
  private candlesUntil(cursor: number, all: boolean): Candle[] {
    if (this.view === 'm5') {
      // 全量累积而非滑动窗口：推进时只需往图表追加一根，用户画的线不会丢。
      const to = all ? this.end : cursor
      return this.minBars.slice(0, to + 1).map((bar, i) => candleFrom(bar, i))
    }
    const days = this.dayCandlesUntil(cursor)
    // 周/月 K 由同一份安全日线序列聚合，不额外存数据包、也绝不包含未来。
    if (this.view === 'week') return aggregateCandles(days, 'week')
    if (this.view === 'month') return aggregateCandles(days, 'month')
    return days
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

  /**
   * 顶部报价区的四项指标。当前训练日落在分时数据覆盖的近 21 个交易日里，
   * 末日前复权价＝真实价，用静态股本快照换算市值/换手不会明显失真。
   * 「额」用当日已揭示分钟 K 的 Σ(收盘×量) 估算，与真实成交额口径一致。
   */
  quoteMetrics(): QuoteMetrics {
    const price = this.currentPrice
    const prev = this.previousClose
    let amount = 0
    let volume = 0
    for (let i = this.dayFirstIndex(this.now); i <= this.now; i += 1) {
      const bar = this.minBars[i]
      amount += bar[4] * bar[5]
      volume += bar[5]
    }
    const fund = this.fund
    return {
      price: round3(price),
      change: round2(price - prev),
      changePct: prev ? round2((price / prev - 1) * 100) : 0,
      marketCapYi: fund ? round2((price * fund.totalShares) / 1e8) : 0,
      floatCapYi: fund ? round2((price * fund.floatShares) / 1e8) : 0,
      amount: round2(amount),
      turnoverPct: fund && fund.floatShares > 0
        ? round2((volume / fund.floatShares) * 100)
        : 0,
    }
  }

  /** 当日已揭示的分时序列：白线价格、黄线均价、红绿量柱、对称涨跌幅刻度。 */
  intraday(): IntradayData | null {
    const day = this.currentDay
    const prevClose = this.previousClose
    if (!prevClose) return null
    const points: IntradayPoint[] = []
    let amount = 0
    let volume = 0
    let high = prevClose
    let low = prevClose
    let prevPrice = prevClose
    for (let i = this.dayFirstIndex(this.now); i <= this.now; i += 1) {
      const bar = this.minBars[i]
      const price = bar[4]
      const v = bar[5]
      amount += price * v
      volume += v
      high = Math.max(high, bar[2])
      low = Math.min(low, bar[3])
      points.push({
        time: bar[0].slice(11, 16),
        price,
        avg: volume > 0 ? amount / volume : price,
        volume: v,
        up: price >= prevPrice,
      })
      prevPrice = price
    }
    if (!points.length) return null
    const boundPct = Math.max(
      1,
      Math.abs((high / prevClose - 1) * 100),
      Math.abs((low / prevClose - 1) * 100),
    )
    return { date: day, prevClose, points, high, low, boundPct: round2(boundPct), amount, volume }
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
   * 进度按「已完成的交易日」算，与图表里画了多少根历史 K 线脱钩：
   * 日线视图带 2015 年起的完整历史，按 K 线数算会一开局就显示
   * 「2786 / 2801」；切换窗口也不该让进度跳变。index 是 0 基天序号，
   * total 是本局总交易日数，界面显示「第 index+1 / total 天」。
   */
  get index(): number {
    let done = 0
    for (const end of this.dayEnds) {
      if (end <= this.now) done += 1
    }
    return Math.max(0, done - 1)
  }

  get total(): number {
    return Math.max(1, this.dayEnds.length)
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

  /**
   * 周/月视图一次推进一根完整周 K / 月 K：先补完当前周期，跨到下一周期末。
   * 与日线视图同思路，条件单仍在 for 循环里按 5 分钟 K 逐根判定。
   */
  private nextPeriodCursor(unit: 'week' | 'month'): number {
    const current = periodKey(this.currentLabel, unit)
    let periodEnd = this.now
    for (let i = this.now; i <= this.end; i += 1) {
      if (periodKey(this.minBars[i][0], unit) !== current) break
      periodEnd = i
    }
    if (periodEnd > this.now) return periodEnd
    for (let i = this.now + 1; i <= this.end; i += 1) {
      const next = periodKey(this.minBars[i][0], unit)
      if (next === current) continue
      let last = i
      while (last + 1 <= this.end && periodKey(this.minBars[last + 1][0], unit) === next) last += 1
      return last
    }
    return this.end
  }

  advance(): boolean {
    if (this.ended) return false
    // 分时和日K 都是「一天一根」：分时一次换出完整一天，日K 多一根完整日线。
    // 周/月视图沿用各自周期。条件单始终在下面按 5 分钟 K 逐根判定。
    const target = this.view === 'week' || this.view === 'month'
      ? this.nextPeriodCursor(this.view)
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
