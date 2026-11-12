import type { Bar, PeriodKey, PeriodMeta, Segment } from '../data/segments'
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

export interface Candle {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface Trade {
  index: number
  date: string
  side: 'buy' | 'sell'
  price: number
  shares: number
  fee: number
  /** 旧版本记录没有以下三个字段，展示时按 fee 兜底。 */
  amount?: number
  fees?: FeeBreakdown
  pnl: number | null
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
  /** 本局适用的品种与费率快照：换费率后历史记录仍可核对当时口径。 */
  instrumentKind: InstrumentKind
  feeRule: InstrumentRule
  feeTotal: FeeBreakdown
}

export interface EngineConfig {
  initialCash: number
  visibleBars: number
  maxBars: number
  fees: FeeSchedule
  kind: InstrumentKind
  lotSize: number
  limitRate: number
  period: PeriodKey
  periodLabel: string
}

export const DEFAULT_CONFIG: EngineConfig = {
  initialCash: 100000,
  visibleBars: 60,
  maxBars: 80,
  fees: DEFAULT_FEE_SCHEDULE,
  kind: 'stock',
  lotSize: 100,
  limitRate: 0.1,
  period: 'day',
  periodLabel: '日线',
}

/** 窗口长度随周期变化：月线一次练完整只股票就失去随机意义，必须调短。 */
export function configForPeriod(
  meta: Pick<PeriodMeta, 'key' | 'label' | 'visible' | 'max'>,
  fees: FeeSchedule = DEFAULT_FEE_SCHEDULE,
): EngineConfig {
  return {
    ...DEFAULT_CONFIG,
    fees,
    period: meta.key,
    periodLabel: meta.label,
    visibleBars: meta.visible,
    maxBars: meta.max,
  }
}

const round2 = (n: number): number => Math.round(n * 100) / 100
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

/**
 * 回放引擎：唯一持有完整一局历史的地方。
 * 对 UI 只暴露 visible()（用序号做 timestamp，不含真实日期与股票代码），
 * 训练过程中任何视图都拿不到未来 K 线，复盘后才由 finish() 揭示答案。
 */
export class ReplayEngine {
  private readonly bars: Bar[]
  private cursor: number
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

  readonly id: string
  readonly code: string
  readonly startedAt: number
  readonly config: EngineConfig

  private constructor(code: string, bars: Bar[], config: EngineConfig) {
    this.code = code
    this.bars = bars
    this.config = config
    this.cursor = config.visibleBars - 1
    this.cash = config.initialCash
    this.peakEquity = config.initialCash
    this.id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    this.startedAt = Date.now()
    this.trackEquity()
  }

  static create(segment: Segment, config: EngineConfig = DEFAULT_CONFIG): ReplayEngine {
    const need = config.visibleBars + config.maxBars + 1
    if (segment.b.length < need) {
      throw new Error(`片段长度不足：需要 ${need} 根，实际 ${segment.b.length} 根`)
    }
    // 按标的代码推断品种，决定佣金档与是否征印花税/过户费
    const kind = classifyInstrument(segment.c)
    return new ReplayEngine(segment.c, segment.b.slice(0, need), { ...config, kind })
  }

  /** 时间标签形如 2024-03-05 或 2024-03-05 10:30，前 10 位即交易日。 */
  private tradingDay(index: number): string {
    return this.bars[index][0].slice(0, 10)
  }

  /** 昨收：分钟线要跨到上一个交易日，而不是简单取前一根。 */
  private previousDayClose(): number {
    const day = this.tradingDay(this.cursor)
    for (let i = this.cursor - 1; i >= 0; i -= 1) {
      if (this.tradingDay(i) !== day) return this.bars[i][4]
    }
    return this.cursor > 0 ? this.bars[this.cursor - 1][4] : this.bars[0][1]
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

  private rule(): InstrumentRule {
    return this.config.fees[this.config.kind] ?? this.config.fees.stock
  }

  get index(): number {
    return this.cursor
  }

  get total(): number {
    return this.bars.length
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

  get equity(): number {
    return this.cash + this.shares * this.bars[this.cursor][4]
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

  get periodLabel(): string {
    return this.config.periodLabel
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

  visible(): Candle[] {
    return this.bars.slice(0, this.cursor + 1).map((bar, i) => ({
      timestamp: i,
      open: bar[1],
      high: bar[2],
      low: bar[3],
      close: bar[4],
      volume: bar[5],
    }))
  }

  private limitFlags(): { up: boolean; down: boolean } {
    const prev = this.previousDayClose()
    const close = this.bars[this.cursor][4]
    const rate = this.config.limitRate
    return {
      up: close >= prev * (1 + rate) - 0.001,
      down: close <= prev * (1 - rate) + 0.001,
    }
  }

  advance(): boolean {
    if (this.ended) return false
    if (this.cursor < this.bars.length - 1) {
      const previousDay = this.tradingDay(this.cursor)
      this.cursor += 1
      // T+1 按交易日解锁：同一交易日的分钟 K 线之间不允许卖出当日买入的股份
      if (this.tradingDay(this.cursor) !== previousDay) this.lockedShares = 0
      this.trackEquity()
    }
    if (this.cursor >= this.bars.length - 1) this.ended = true
    return !this.ended
  }

  buy(requested: number = this.config.lotSize): { ok: boolean; reason?: string } {
    if (this.ended) return { ok: false, reason: '本局已结束' }
    const lot = this.config.lotSize
    const qty = Math.floor(requested / lot) * lot
    if (qty <= 0) return { ok: false, reason: `最小 ${lot} 股` }
    if (this.limitFlags().up) return { ok: false, reason: '涨停，无法买入' }

    const price = this.bars[this.cursor][4]
    const amount = qty * price
    const fees = computeFees(amount, 'buy', this.config.kind, this.config.fees)
    if (this.cash + 0.001 < amount + fees.total) return { ok: false, reason: '可用资金不足' }

    const totalCost = this.avgCost * this.shares + amount + fees.total
    this.cash -= amount + fees.total
    this.shares += qty
    this.lockedShares += qty
    this.avgCost = totalCost / this.shares
    this.feeTotal = addFees(this.feeTotal, fees)
    this.trades.push({
      index: this.cursor,
      date: this.bars[this.cursor][0],
      side: 'buy',
      price: round2(price),
      shares: qty,
      fee: fees.total,
      amount: round2(amount),
      fees,
      pnl: null,
    })
    return { ok: true }
  }

  sell(requested: number = this.config.lotSize): { ok: boolean; reason?: string } {
    if (this.ended) return { ok: false, reason: '本局已结束' }
    const lot = this.config.lotSize
    const qty = Math.min(this.availableShares, Math.floor(requested / lot) * lot)
    if (qty <= 0) {
      return {
        ok: false,
        reason: this.lockedShares > 0 ? 'T+1：当日买入次日才能卖' : '没有可卖持仓',
      }
    }
    if (this.limitFlags().down) return { ok: false, reason: '跌停，无法卖出' }

    const price = this.bars[this.cursor][4]
    const amount = qty * price
    const fees = computeFees(amount, 'sell', this.config.kind, this.config.fees)
    const pnl = (price - this.avgCost) * qty - fees.total
    this.cash += amount - fees.total
    this.shares -= qty
    this.closedTrades += 1
    if (pnl > 0) this.wins += 1
    if (this.shares === 0) this.avgCost = 0
    this.feeTotal = addFees(this.feeTotal, fees)
    this.trades.push({
      index: this.cursor,
      date: this.bars[this.cursor][0],
      side: 'sell',
      price: round2(price),
      shares: qty,
      fee: fees.total,
      amount: round2(amount),
      fees,
      pnl: round2(pnl),
    })
    return { ok: true }
  }

  /** 精确求解：最低佣金让费用非线性，先估上界再逐手回退，保证全仓买入不会买超。 */
  maxBuyable(): number {
    const price = this.bars[this.cursor][4]
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
    const first = this.bars[0][4]
    const last = this.bars[this.bars.length - 1][4]
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
      period: this.config.period,
      periodLabel: this.config.periodLabel,
      startDate: this.bars[0][0],
      endDate: this.bars[this.bars.length - 1][0],
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
      candles: this.bars.map((bar, i) => ({
        timestamp: i,
        open: bar[1],
        high: bar[2],
        low: bar[3],
        close: bar[4],
        volume: bar[5],
      })),
      playedAt: this.startedAt,
      instrumentKind: this.config.kind,
      feeRule: { ...this.rule() },
      feeTotal: { ...this.feeTotal },
    }
  }
}
