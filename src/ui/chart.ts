import { dispose, init, type Chart, type KLineData } from 'klinecharts'
import type { Candle } from '../engine/replay'

const BASE_TS = Date.UTC(2020, 0, 1)
const DAY_MS = 86_400_000
/** 开局默认的单根 K 线宽度：390px 屏一屏约 30 根，能看清近期形态。 */
const DEFAULT_BAR_SPACE = 12

/** 对齐截图里的三条均线：MA5 / MA10 / MA20，白 / 黄 / 紫。 */
export const MA_PERIODS = [5, 10, 20] as const
export const MA_COLORS = ['#e8edf7', '#f5c451', '#c07cf0'] as const
export const VOL_MA_PERIODS = [5, 10] as const

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

/**
 * 贴在周期栏下方的图例行，对应截图「均线▾ · MA5:20.82 10:20.89 20:20.39 · 前复权」。
 * 只放三条均线＋前复权：390px 下一行刚好放得下，不需要横滑，也不会把标签挤出裁切。
 * 成交量与量均线数值由副图柱子和十字光标 tooltip 展示。
 */
export function indicatorLegend(candles: Candle[], viewLabel = '日线'): string {
  const mas = MA_PERIODS.map((period, i) => {
    const value = maAt(candles, period)
    return `<span class="ma-item" style="color:${MA_COLORS[i]}">MA${period} ${value === null ? '—' : value.toFixed(2)}</span>`
  }).join('')
  return `<span class="legend-prefix">均线▾ · ${viewLabel}</span>${mas}<span class="legend-tag">前复权</span>`
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
    // 截图里的成交量副图带两条量均线（MA5/MA10），此前关掉了，这里补回。
    chart.createIndicator(
      { name: 'VOL', paneId: 'volume_pane', calcParams: [...VOL_MA_PERIODS] },
      false,
    )
    chart.setPaneOptions({ id: 'volume_pane', height: 92 })
    this.chart = chart
  }

  /**
   * 全量重设。日线视图推进时当日 K 会被重新合成，必须整体替换；
   * keepDrawings=true 时把用户已画好的线按原坐标重建，避免推进一次就丢。
   * 切换时间窗口时坐标系完全不同，应传 false 清掉画线。
   */
  setBars(candles: Candle[], keepDrawings = false): void {
    const saved = keepDrawings && this.chart
      ? this.chart.getOverlays().map((o) => ({ ...o }))
      : []
    this.bars = candles.map(toKLine)
    this.chart?.resetData()
    if (saved.length && this.chart) {
      try {
        this.chart.createOverlay(saved as never)
      } catch {
        // 画线依赖的坐标系已变化，丢弃即可，不影响行情
      }
    }
    // 换局、切换时间窗口时坐标系全变，必须把缩放拉回默认并停在最右端；
    // 否则上一局点过「最早」(barSpace=1) 会继承下来，把 2800 根压成一屏。
    // keepDrawings=true 是同一局内推进造成的当日 K 重合成，视口要保持不变。
    if (!keepDrawings) this.resetViewport()
  }

  private resetViewport(): void {
    if (!this.chart) return
    this.chart.setBarSpace(DEFAULT_BAR_SPACE)
    this.chart.scrollToRealTime()
  }

  get barCount(): number {
    return this.bars.length
  }

  /**
   * 推进一根：时间戳相同说明是「当日 K 被重新合成」，原地替换；不同则追加。
   * 走 subscribeBar 的 update 通道，不整体 resetData——完整日线有 2800 根时
   * 每次推进全量重绘会明显卡顿，而且用户画的线也不会丢。
   */
  pushLatest(candle: Candle): void {
    const bar = toKLine(candle)
    const last = this.bars[this.bars.length - 1]
    if (last && bar.timestamp < last.timestamp) return
    if (last && bar.timestamp === last.timestamp) this.bars[this.bars.length - 1] = bar
    else this.bars.push(bar)
    if (this.pushBar) this.pushBar(bar)
    else this.chart?.resetData()
  }

  /** 放大/缩小：库内部允许的最小 K 线宽度是 1px，一屏约 350 根。 */
  zoom(factor: number): void {
    if (!this.chart) return
    const space = this.chart.getBarSpace().bar
    this.chart.setBarSpace(Math.max(1, Math.min(40, space * factor)))
  }

  /** 回到默认缩放下的最新 K 线（「最早/缩小」之后的复原入口）。 */
  toLatest(): void {
    this.resetViewport()
  }

  /** 缩到最小并跳到历史起点，用来回看 2015 年以来的长期走势。 */
  toEarliest(): void {
    if (!this.chart) return
    this.chart.setBarSpace(1)
    // scrollToDataIndex(i) 把第 i 根放到视口右端。1px 下一屏约 300 根，
    // 取 280 让左端正好落在第 0 根（滚动边界由库自动 clamp）。
    // 不能用 scrollByDistance(大负数)：那会把视口推到数据右侧之外的空白区。
    this.chart.scrollToDataIndex(Math.min(this.bars.length - 1, 280))
  }

  /**
   * 左右平移，单位是「根」。
   * KLineCharts 的 scrollByDistance 正值是往历史方向（视角左移），与按钮语义相反，
   * 所以这里取反：pan(-6) = 看更早，pan(6) = 看更新。
   */
  pan(bars: number): void {
    if (!this.chart) return
    this.chart.scrollByDistance(-bars * this.chart.getBarSpace().bar)
  }

  /** 进入画线模式，由用户在图上点两下完成。 */
  startDrawing(name: string): void {
    this.chart?.createOverlay(name)
  }

  clearDrawings(): void {
    this.chart?.removeOverlay()
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
