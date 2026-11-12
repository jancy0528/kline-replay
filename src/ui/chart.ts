import { dispose, init, type Chart, type KLineData } from 'klinecharts'
import type { Candle } from '../engine/replay'

const BASE_TS = Date.UTC(2020, 0, 1)
const DAY_MS = 86_400_000

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
    chart.setSymbol({ ticker: 'TRAINING', pricePrecision: 3, volumePrecision: 0 })
    chart.setPeriod({ span: 1, type: 'day' })
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
