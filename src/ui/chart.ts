import { dispose, init, type Chart, type KLineData } from 'klinecharts'
import type { Candle } from '../engine/replay'

const BASE_TS = Date.UTC(2020, 0, 1)
const DAY_MS = 86_400_000

export const MA_PERIODS = [5, 10, 20, 30] as const
export const MA_COLORS = ['#f5c451', '#4aa8ff', '#c07cf0', '#54d6c0'] as const

/** 库默认把大数字写成 5.14M / 513K，中文界面改用万、亿。 */
export function formatBigNumberCN(value: string | number): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value)
  const a = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  const compact = (v: number): string => String(Number(v.toFixed(2)))
  if (a >= 1e8) return `${sign}${compact(a / 1e8)}亿`
  if (a >= 1e4) return `${sign}${compact(a / 1e4)}万`
  return String(value)
}

function maAt(candles: Candle[], period: number): number | null {
  if (candles.length < period) return null
  let sum = 0
  for (let i = candles.length - period; i < candles.length; i += 1) sum += candles[i].close
  return sum / period
}

/** 图表上方的图例：四条均线当前值 + 最新一根的成交量。 */
export function indicatorLegend(candles: Candle[]): string {
  const mas = MA_PERIODS.map((period, i) => {
    const value = maAt(candles, period)
    return `<span class="ma-item"><i style="background:${MA_COLORS[i]}"></i>MA${period} ${value === null ? '—' : value.toFixed(2)}</span>`
  }).join('')
  const last = candles[candles.length - 1]
  const volume = last ? `${formatBigNumberCN(last.volume)}股` : '—'
  return `${mas}<span class="vol-item">成交量 ${volume}</span>`
}

// A 股习惯：红涨绿跌。KLineCharts 默认相反（绿涨红跌），必须整体翻转。
const UP = '#f0454b'
const DOWN = '#22b07d'
const FLAT = '#8b95ab'
const UP_ALPHA = 'rgba(240, 69, 75, 0.5)'
const DOWN_ALPHA = 'rgba(34, 176, 125, 0.5)'
const FLAT_ALPHA = 'rgba(139, 149, 171, 0.5)'

function applyChinaColors(chart: Chart): void {
  const styles = chart.getStyles()
  const bar = styles.candle.bar
  if (typeof bar !== 'function') {
    bar.upColor = UP
    bar.downColor = DOWN
    bar.noChangeColor = FLAT
    bar.upBorderColor = UP
    bar.downBorderColor = DOWN
    bar.noChangeBorderColor = FLAT
    bar.upWickColor = UP
    bar.downWickColor = DOWN
    bar.noChangeWickColor = FLAT
  }
  const last = styles.candle.priceMark.last
  last.upColor = UP
  last.downColor = DOWN
  last.noChangeColor = FLAT

  const ohlc = styles.indicator.ohlc
  if (typeof ohlc !== 'function') {
    ohlc.upColor = UP
    ohlc.downColor = DOWN
    ohlc.noChangeColor = FLAT
  }
  for (const item of styles.indicator.bars) {
    item.upColor = UP_ALPHA
    item.downColor = DOWN_ALPHA
    item.noChangeColor = FLAT_ALPHA
  }
  styles.indicator.lines.forEach((line, i) => {
    if (i < MA_COLORS.length) line.color = MA_COLORS[i]
  })

  // 默认 always 会把 OHLC 文字常驻左上角并挤成一团；改为跟随十字光标。
  styles.candle.tooltip.showRule = 'follow_cross'
  styles.candle.tooltip.title.show = false
  styles.indicator.tooltip.showRule = 'follow_cross'
  styles.indicator.tooltip.title.show = false
  chart.setStyles(styles)
}

function toKLine(candle: Candle): KLineData {
  return {
    timestamp: BASE_TS + candle.timestamp * DAY_MS,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
  }
}

/** 图表封装：训练时逐根追加，复盘时一次给全量；x 轴日期始终隐藏。 */
export class ChartView {
  private chart: Chart | null = null
  private bars: KLineData[] = []
  private pushBar: ((bar: KLineData) => void) | null = null

  constructor(private readonly container: HTMLElement) {}

  mount(): void {
    if (this.chart) return
    const chart = init(this.container, {
      locale: 'zh-CN',
      styles: 'dark',
      formatter: { formatDate: () => '', formatBigNumber: formatBigNumberCN },
    })
    if (!chart) throw new Error('图表初始化失败')
    chart.setSymbol({ ticker: '训练', pricePrecision: 3, volumePrecision: 0 })
    chart.setPeriod({ span: 1, type: 'day' })
    applyChinaColors(chart)
    chart.setDataLoader({
      getBars: ({ type, callback }) => {
        callback(type === 'init' ? this.bars.slice() : [], false)
      },
      subscribeBar: ({ callback }) => {
        this.pushBar = callback
      },
      unsubscribeBar: () => {
        this.pushBar = null
      },
    })

    // MA 叠在蜡烛主图上；VOL 单独占一个副图，且去掉自带的量均线只留成交量柱。
    chart.createIndicator(
      { name: 'MA', paneId: 'candle_pane', calcParams: [...MA_PERIODS] },
      true,
    )
    chart.createIndicator({ name: 'VOL', paneId: 'volume_pane', calcParams: [] }, false)
    chart.setPaneOptions({ id: 'volume_pane', height: 92 })
    this.chart = chart
  }

  setBars(candles: Candle[]): void {
    this.bars = candles.map(toKLine)
    this.chart?.resetData()
  }

  appendBar(candle: Candle): void {
    const bar = toKLine(candle)
    this.bars.push(bar)
    if (this.pushBar) this.pushBar(bar)
    else this.chart?.resetData()
  }

  resize(): void {
    this.chart?.resize()
  }

  destroy(): void {
    if (!this.chart) return
    dispose(this.chart)
    this.chart = null
    this.pushBar = null
    this.bars = []
  }
}
