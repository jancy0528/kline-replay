import { dispose, init, type Chart, type KLineData } from 'klinecharts'
import type { Candle } from '../engine/replay'

const BASE_TS = Date.UTC(2020, 0, 1)
const DAY_MS = 86_400_000

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
      formatter: { formatDate: () => '' },
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
