import type { Bar } from '../data/bars'

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
  startDate: string
  endDate: string
  initialCash: number
  finalEquity: number
  score: Score
  trades: Trade[]
  equityCurve: number[]
  candles: Candle[]
  playedAt: number
}

export interface EngineConfig {
  initialCash: number
  visibleBars: number
  maxBars: number
  feeRate: number
  minFee: number
  stampRate: number
  lotSize: number
  limitRate: number
}

export const DEFAULT_CONFIG: EngineConfig = {
  initialCash: 100000,
  visibleBars: 60,
  maxBars: 80,
  feeRate: 0.0003,
  minFee: 5,
  stampRate: 0.0005,
  lotSize: 100,
  limitRate: 0.1,
}

const round2 = (n: number): number => Math.round(n * 100) / 100
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))
const randomInt = (max: number): number => Math.floor(Math.random() * max)

/**
 * 回放引擎：唯一持有完整历史数据的地方。
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

  static create(
    data: Record<string, Bar[]>,
    config: EngineConfig = DEFAULT_CONFIG,
  ): ReplayEngine {
    const need = config.visibleBars + config.maxBars + 1
    const codes = Object.keys(data).filter((code) => data[code].length >= need + 20)
    if (codes.length === 0) throw new Error('离线数据不足，请重新运行取数脚本')
    const code = codes[randomInt(codes.length)]
    const all = data[code]
    const start = randomInt(Math.max(1, all.length - need))
    return new ReplayEngine(code, all.slice(start, start + need), config)
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
    if (this.cursor === 0) return { up: false, down: false }
    const prev = this.bars[this.cursor - 1][4]
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
      this.cursor += 1
      this.lockedShares = 0
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
    const fee = Math.max(this.config.minFee, amount * this.config.feeRate)
    if (this.cash + 0.001 < amount + fee) return { ok: false, reason: '可用资金不足' }

    const totalCost = this.avgCost * this.shares + amount + fee
    this.cash -= amount + fee
    this.shares += qty
    this.lockedShares += qty
    this.avgCost = totalCost / this.shares
    this.trades.push({
      index: this.cursor,
      date: this.bars[this.cursor][0],
      side: 'buy',
      price: round2(price),
      shares: qty,
      fee: round2(fee),
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
    const fee =
      Math.max(this.config.minFee, amount * this.config.feeRate) +
      amount * this.config.stampRate
    const pnl = (price - this.avgCost) * qty - fee
    this.cash += amount - fee
    this.shares -= qty
    this.closedTrades += 1
    if (pnl > 0) this.wins += 1
    if (this.shares === 0) this.avgCost = 0
    this.trades.push({
      index: this.cursor,
      date: this.bars[this.cursor][0],
      side: 'sell',
      price: round2(price),
      shares: qty,
      fee: round2(fee),
      pnl: round2(pnl),
    })
    return { ok: true }
  }

  maxBuyable(): number {
    const price = this.bars[this.cursor][4]
    const lot = this.config.lotSize
    const affordable = Math.floor(
      (this.cash - this.config.minFee) / (price * (1 + this.config.feeRate) * lot),
    )
    return Math.max(0, affordable * lot)
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
    }
  }
}
