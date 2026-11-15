import { dispose, init, registerOverlay, type Chart, type Crosshair, type KLineData } from 'klinecharts'
import type { Candle, TradeMarker } from '../engine/replay'

/** 十字光标回看：candle 为光标所指 K 线，dataIndex 是它在可见序列里的下标；candle=null 表示光标离开。 */
export type CrosshairHandler = (candle: Candle | null, dataIndex: number) => void
/** 轻点「选定」一根 K 线，不会传 null。 */
export type SelectHandler = (candle: Candle, dataIndex: number) => void

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
export function indicatorLegend(candles: Candle[], viewLabel = '日线', showMA = true): string {
  const mas = showMA
    ? MA_PERIODS.map((period, i) => {
        const value = maAt(candles, period)
        return `<span class="ma-item" style="color:${MA_COLORS[i]}">MA${period} ${value === null ? '—' : value.toFixed(2)}</span>`
      }).join('')
    : '<span class="ma-off-hint">均线已隐藏</span>'
  // 开关就放在「均线」这一行末尾，纯轨道不占文字宽度，避免 390px 下把图例挤换行。
  const toggle = `<button class="ma-toggle ${showMA ? 'on' : ''}" data-action="toggleMA"
    aria-pressed="${showMA}" aria-label="${showMA ? '隐藏均线' : '显示均线'}"
    title="${showMA ? '隐藏均线' : '显示均线'}"><i></i></button>`
  return `<span class="legend-prefix">均线▾ · ${viewLabel}</span>${mas}${toggle}<span class="legend-tag">前复权</span>`
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

// ---- 买卖点 B / S ---------------------------------------------------
// 用库自带的 overlay 机制而不是另盖一层 DOM：point 绑定 K 线时间戳与价格，
// 缩放 / 左右平移 / y 轴自适应时由库自己重算坐标，标记不会跟 K 线脱节。
const MARKER_NAME = 'klineTradeBS'
const MARKER_GROUP = 'kline-trade-markers'
interface MarkerData {
  side: 'buy' | 'sell'
  stack: number
  count: number
}
let markerRegistered = false

function ensureMarkerOverlay(): void {
  if (markerRegistered) return
  markerRegistered = true
  registerOverlay<MarkerData>({
    name: MARKER_NAME,
    totalStep: 1,
    lock: true,
    visible: true,
    zLevel: 20,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ overlay, coordinates, bounding }) => {
      const p = coordinates[0]
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return []
      const data = overlay.extendData
      const buy = data?.side !== 'sell'
      const size = 14
      const spread = (data?.stack ?? 0) - ((data?.count ?? 1) - 1) / 2
      const cx = p.x + spread * 16
      // 参考图：B 在 K 线上方、S 在 K 线下方，各带一个指向 K 线的小尖角。
      const rawY = buy ? p.y - 26 : p.y + 10
      const y = Math.max(3, Math.min(bounding.height - size - 4, rawY))
      const color = buy ? UP : DOWN
      const tip = buy
        ? [
            { x: cx - 3, y: y + size },
            { x: cx + 3, y: y + size },
            { x: cx, y: y + size + 4 },
          ]
        : [
            { x: cx - 3, y: y },
            { x: cx + 3, y: y },
            { x: cx, y: y - 4 },
          ]
      return [
        {
          type: 'rect',
          attrs: { x: cx - size / 2, y, width: size, height: size },
          styles: { style: 'fill', color, borderRadius: 3 },
          ignoreEvent: true,
        },
        {
          type: 'polygon',
          attrs: { coordinates: tip },
          styles: { style: 'fill', color },
          ignoreEvent: true,
        },
        {
          type: 'text',
          attrs: { x: cx, y: y + size / 2, text: buy ? 'B' : 'S', align: 'center', baseline: 'middle' },
          styles: { color: '#ffffff', size: 10, weight: 'bold', backgroundColor: 'transparent' },
          ignoreEvent: true,
        },
      ]
    },
  })
}

/** 图表封装：训练时逐根追加，复盘时一次给全量；x 轴日期始终隐藏。 */
export class ChartView {
  private chart: Chart | null = null
  private bars: KLineData[] = []
  /** 与 bars 一一对应的原始 Candle，十字光标回看时要拿 label 去查当日行情。 */
  private candles: Candle[] = []
  private pushBar: ((bar: KLineData) => void) | null = null
  private markers: TradeMarker[] = []
  private readonly container: HTMLElement
  private readonly onCrosshair?: CrosshairHandler
  /** 轻点「选定」一根 K 线：长按拖动只算临时回看，不产生选定。 */
  private readonly onSelect?: SelectHandler
  private maVisible: boolean
  private bsVisible: boolean
  private crosshairAction: ((data?: unknown) => void) | null = null
  /** 库在光标消失时不会派发 onCrosshairChange，只能靠这些 DOM 事件补一个「离开」信号。 */
  private readonly leaveEvents = ['pointerleave', 'touchend', 'touchcancel', 'pointercancel'] as const
  private readonly onLeave = (): void => this.onCrosshair?.(null, -1)
  /** 轻点判定：按下到抬起的时间与位移都小，才认为是在「选定」一根 K 线。 */
  private pointerStart: { x: number; y: number; t: number } | null = null
  private readonly onPointerDown = (e: PointerEvent): void => {
    this.pointerStart = { x: e.clientX, y: e.clientY, t: performance.now() }
  }
  private readonly onPointerUp = (e: PointerEvent): void => {
    const start = this.pointerStart
    this.pointerStart = null
    if (!start || !this.onSelect) return
    const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y)
    if (moved > 10 || performance.now() - start.t > 400) return
    this.pickAt(e.clientX)
  }

  /** 把屏幕 x 换算成 K 线下标，交给上层作为「选定」的那根。 */
  private pickAt(clientX: number): void {
    if (!this.chart || !this.onSelect || !this.candles.length) return
    const rect = this.container.getBoundingClientRect()
    const converted = this.chart.convertFromPixel([{ x: clientX - rect.left }])
    const point = Array.isArray(converted) ? converted[0] : converted
    const raw = point?.dataIndex
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return
    const index = Math.max(0, Math.min(this.candles.length - 1, Math.round(raw)))
    const candle = this.candles[index]
    if (candle) this.onSelect(candle, index)
  }

  constructor(
    container: HTMLElement,
    onCrosshair?: CrosshairHandler,
    maVisible = true,
    bsVisible = true,
    onSelect?: SelectHandler,
  ) {
    this.container = container
    this.onCrosshair = onCrosshair
    this.maVisible = maVisible
    this.bsVisible = bsVisible
    this.onSelect = onSelect
  }

  mount(): void {
    if (this.chart) return
    ensureMarkerOverlay()
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

    // 十字光标跟随：库派发的 data 只有 { x, y, paneId }，用 convertFromPixel
    // 把 x 换算成 K 线下标。x 轴是各 pane 共用的，不传 paneId 反而更稳，
    // 光标停在成交量副图上也能落到同一根 K 线。
    this.crosshairAction = (data?: unknown): void => {
      const handler = this.onCrosshair
      if (!handler) return
      const cr = (data ?? {}) as Partial<Crosshair>
      if (typeof cr.x !== 'number' || !Number.isFinite(cr.x) || !this.candles.length) return
      const converted = chart.convertFromPixel([{ x: cr.x }])
      const point = Array.isArray(converted) ? converted[0] : converted
      const raw = point?.dataIndex
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return
      const index = Math.max(0, Math.min(this.candles.length - 1, Math.round(raw)))
      const candle = this.candles[index]
      if (candle) handler(candle, index)
    }
    chart.subscribeAction('onCrosshairChange', this.crosshairAction)
    // 光标消失（抬手 / 鼠标移出）时库不会派发事件，靠 DOM 事件补「离开」。
    for (const name of this.leaveEvents) this.container.addEventListener(name, this.onLeave)
    // 轻点 = 选定一根 K 线；长按 / 拖动由上面的阈值过滤掉。
    this.container.addEventListener('pointerdown', this.onPointerDown)
    this.container.addEventListener('pointerup', this.onPointerUp)
    if (!this.maVisible) chart.removeIndicator({ paneId: 'candle_pane', name: 'MA' })
  }

  /**
   * 全量重设。日线视图推进时当日 K 会被重新合成，必须整体替换；
   * keepDrawings=true 时把用户已画好的线按原坐标重建，避免推进一次就丢。
   * 切换时间窗口时坐标系完全不同，应传 false 清掉画线。
   */
  setBars(candles: Candle[], keepDrawings = false): void {
    const saved = keepDrawings && this.chart
      ? this.chart.getOverlays().filter((o) => o.groupId !== MARKER_GROUP).map((o) => ({ ...o }))
      : []
    this.bars = candles.map(toKLine)
    this.candles = candles.slice()
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
    this.applyMarkers()
  }

  /** 重画买卖点。每次成交、推进、切窗口后调用；只增删本组的 overlay。 */
  setMarkers(markers: TradeMarker[]): void {
    this.markers = markers
    this.applyMarkers()
  }

  private applyMarkers(): void {
    if (!this.chart) return
    // 关掉开关时只清掉本组 overlay，markers 仍缓存在实例里，再打开即可原样恢复。
    this.chart.removeOverlay({ groupId: MARKER_GROUP })
    if (!this.bsVisible || !this.markers.length) return
    ensureMarkerOverlay()
    for (const m of this.markers) {
      this.chart.createOverlay({
        name: MARKER_NAME,
        groupId: MARKER_GROUP,
        paneId: 'candle_pane',
        lock: true,
        visible: true,
        zLevel: 20,
        needDefaultPointFigure: false,
        needDefaultXAxisFigure: false,
        needDefaultYAxisFigure: false,
        points: [{
          timestamp: BASE_TS + m.index * DAY_MS,
          dataIndex: m.index,
          value: m.value,
        }],
        extendData: { side: m.side, stack: m.stack, count: m.count },
      })
    }
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
    if (last && bar.timestamp === last.timestamp) {
      this.bars[this.bars.length - 1] = bar
      this.candles[this.candles.length - 1] = candle
    } else {
      this.bars.push(bar)
      this.candles.push(candle)
    }
    if (this.pushBar) this.pushBar(bar)
    else this.chart?.resetData()
  }

  /**
   * 主图 MA5/MA10/MA20 显示开关。直接增删指标而不是改 visible：
   * 库对 overrideIndicator 的 visible 变化不一定触发重绘，删建是必然重绘的，
   * 一次切换重算 2 千多根均线的开销可以忽略。VOL 的成交量柱不受影响。
   */
  setMAVisible(visible: boolean): void {
    if (!this.chart || this.maVisible === visible) return
    this.maVisible = visible
    if (visible) {
      this.chart.createIndicator(
        { name: 'MA', paneId: 'candle_pane', calcParams: [...MA_PERIODS] },
        true,
      )
    } else {
      this.chart.removeIndicator({ paneId: 'candle_pane', name: 'MA' })
    }
  }

  /** B/S 买卖点显示开关：与均线开关一样走「删建重绘」，成交量柱不受影响。 */
  setBSVisible(visible: boolean): void {
    if (this.bsVisible === visible) return
    this.bsVisible = visible
    this.applyMarkers()
  }

  /**
   * 放大/缩小。不能直接 setBarSpace：库按「根数」保留右侧留白，柱宽一变，
   * 留白像素 = 留白根数 × 柱宽 也跟着变，点放大时最后一根 K 会往左退、
   * 右边空出一大块，看起来像图表整体左移而不是放大。
   * 改用 zoomAtDataIndex，以视口右端那根 K 为锚，缩放后它的屏幕位置不动。
   */
  zoom(factor: number): void {
    if (!this.chart || !this.bars.length) return
    const space = this.chart.getBarSpace().bar
    const next = Math.max(1, Math.min(40, space * factor))
    const scale = next / space
    if (scale === 1) return
    const range = this.chart.getVisibleRange()
    const last = this.bars.length - 1
    // 停在最新时锚定最后一根；左拉看历史时锚定当前右端可见那根，
    // 否则会以屏幕外很远的一根为锚，历史画面反而大幅漂移。
    const anchor = range.realTo >= this.bars.length
      ? last
      : Math.max(0, Math.min(last, Math.round(range.to - 1)))
    this.chart.zoomAtDataIndex(scale, anchor)
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

  /** 只清用户画的线，买卖点是行情的一部分，不能被「清除画线」一起删掉。 */
  clearDrawings(): void {
    if (!this.chart) return
    for (const o of this.chart.getOverlays().slice()) {
      if (o.groupId !== MARKER_GROUP) this.chart.removeOverlay({ id: o.id })
    }
  }

  resize(): void {
    this.chart?.resize()
  }

  destroy(): void {
    if (!this.chart) return
    if (this.crosshairAction) {
      this.chart.unsubscribeAction('onCrosshairChange', this.crosshairAction)
      this.crosshairAction = null
    }
    for (const name of this.leaveEvents) this.container.removeEventListener(name, this.onLeave)
    this.container.removeEventListener('pointerdown', this.onPointerDown)
    this.container.removeEventListener('pointerup', this.onPointerUp)
    this.pointerStart = null
    dispose(this.chart)
    this.chart = null
    this.pushBar = null
    this.bars = []
    this.candles = []
    this.markers = []
  }
}
