import './style.css'
import {
  loadManifest,
  loadSessions,
  pickGame,
  windowMeta,
  type DataManifest,
  type PeriodKey,
  type SessionPackage,
} from './data/segments'
import {
  ReplayEngine,
  configForWindow,
  type Candle,
  type HistoryPosition,
  type QuoteMetrics,
  type SessionResult,
  type Trade,
} from './engine/replay'
import {
  clearRecords,
  exportRecords,
  importRecords,
  loadRecords,
  saveRecord,
  toStored,
} from './engine/records'
import {
  KIND_LABEL,
  fromWan,
  hasCustomFees,
  loadFeeSchedule,
  resetFeeSchedule,
  saveFeeSchedule,
  toWan,
  type FeeBreakdown,
  type FeeSchedule,
} from './engine/fees'
import {
  DEFAULT_PATH,
  clearSyncConfig,
  loadSyncConfig,
  loadSyncStatus,
  maskToken,
  queueAutoSync,
  saveSyncConfig,
  startAutoSync,
  syncNow,
  type SyncConfig,
} from './engine/sync'
import {
  newOrderId,
  orderText,
  pauseOnSwitch,
  statusText,
  type ConditionalOrder,
  type OrderSide,
  type OrderStatus,
  type OrderTrigger,
} from './engine/orders'
import { ChartView, indicatorLegend } from './ui/chart'
import { renderCurve } from './ui/curve'
import { renderIntraday } from './ui/intraday'

const root = document.querySelector<HTMLDivElement>('#app')
if (!root) throw new Error('#app not found')
const app: HTMLDivElement = root

type View = 'train' | 'review' | 'records' | 'orders' | 'orderEdit'
type OrderTab = 'watching' | 'triggered' | 'failed'

interface OrderDraft {
  editingId: string | null
  trigger: OrderTrigger
  price: number
  side: OrderSide
  shares: number
  unit: 'shares' | 'amount'
  amount: number
}

const standalone =
  window.matchMedia('(display-mode: standalone)').matches ||
  (window.navigator as Navigator & { standalone?: boolean }).standalone === true

const nf = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 })
const money = (n: number): string => `¥${nf.format(n)}`
const yuan2 = (n: number): string => `¥${n.toFixed(2)}`
const wanLabel = (rate: number): string => `万${toWan(rate)}`
const pct = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
const round2 = (n: number): number => Math.round(n * 100) / 100
const dateTime = (ts: number): string =>
  new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const feeParts = (f: FeeBreakdown): string =>
  `佣金 ${yuan2(f.commission)} ＋ 印花 ${yuan2(f.stampDuty)} ＋ 过户 ${yuan2(f.transferFee)}`

let view: View = 'train'
let manifest: DataManifest | null = null
let sessions: SessionPackage | null = null
let engine: ReplayEngine | null = null
let result: SessionResult | null = null
let chartView: ChartView | null = null
let loading = true
let loadingLabel = '训练数据'
let loadError = ''
let autoPlaying = false
let autoTimer = 0
let toastTimer = 0
let orderTab: OrderTab = 'watching'
let draft: OrderDraft | null = null

function toast(message: string): void {
  let node = document.querySelector<HTMLDivElement>('#toast')
  if (!node) {
    node = document.createElement('div')
    node.id = 'toast'
    node.className = 'toast'
    document.body.appendChild(node)
  }
  const el = node
  el.textContent = message
  el.classList.add('show')
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => el.classList.remove('show'), 2600)
}

const installGuide = standalone
  ? ''
  : `<section class="guide">
  <h2>在 iPhone 上添加到主屏幕</h2>
  <p class="guide-lead">以下步骤在 <b>iPhone 的 Safari</b> 里操作。iOS 26 默认用「紧凑」布局，<b>分享按钮被收进了 ⋯ 里</b>，底部不再有单独的方框箭头图标。</p>
  <div class="ios-bar" aria-hidden="true">
    <span class="ios-pill">jancy0528.github.io</span>
    <span class="ios-more"><i></i><i></i><i></i></span>
    <span class="ios-tap">点这里</span>
  </div>
  <ol class="steps">
    <li><b>先让工具栏出现</b>：若底部只剩一条小胶囊或干脆不见了，向上滑一点点，或点一下屏幕最顶部的时间。</li>
    <li><b>点地址栏旁的 <span class="kbd">⋯</span></b>（更多）→ 在弹出菜单选 <b>共享 / Share</b>。</li>
    <li><b>在分享列表里向下滑</b>，找到 <b>添加到主屏幕</b>，保持 <b>作为 Web App 打开</b> 开启，点右上角 <b>添加</b>。</li>
  </ol>
  <p class="guide-tip">列表里没有「添加到主屏幕」：拉到底 → <b>编辑操作</b> → 把它加进来。也请确认是在 Safari 里，而不是微信／聊天窗口的内嵌浏览器。</p>
  <p class="guide-tip">想让分享按钮长期常驻底部：设置 → App → Safari → 标签页 → 选 <b>底部</b>。</p>
</section>`

function header(active: View): string {
  return `<header class="topbar">
    <div class="brand">K线回放</div>
    <nav>
      <button data-action="train" class="${active === 'train' ? 'on' : ''}">训练</button>
      <button data-action="records" class="${active === 'records' ? 'on' : ''}">记录</button>
    </nav>
  </header>`
}

/** 推进按钮按当前窗口命名：一次推进就是那个周期的一根完整 K。 */
function nextLabel(key: PeriodKey): string {
  if (key === 'week') return '下一周'
  if (key === 'month') return '下一月'
  return '下一天'
}

/** 周期栏：分时 / 日K / 周K / 月K，紧贴图表上方，选中态为红色下划线。 */
function windowBar(e: ReplayEngine): string {
  const items = sessions?.windows ?? []
  const buttons = items
    .map((w) => `<button data-window="${w.key}" class="${w.key === e.currentView ? 'on' : ''}">${w.label}</button>`)
    .join('')
  return `<div class="window-bar"><div class="window-tabs">${buttons}</div></div>`
}

/**
 * 操作条：紧贴成交量副图下方的一行，对应参考图
 * 「换股 / 条件单 / 买入 / 卖出 / 128天 / 下一步」。
 * 训练时最常用的是推进和买卖，必须和 K 线在同一屏，不能滚半天才点到。
 */
function actionBar(e: ReplayEngine): string {
  const watching = e.orderList.filter(
    (o) => o.status === 'watching' || o.status === 'paused',
  ).length
  return `<div class="action-bar">
    <button data-action="new" title="换一局（换股）">换股</button>
    <button data-action="orders" id="action-orders" title="条件单">条件单${watching ? `<i>${watching}</i>` : ''}</button>
    <button data-action="buy" title="买入 100 股">买入</button>
    <button data-action="sell" title="卖出 100 股">卖出</button>
    <span class="action-progress" id="action-progress">${e.index + 1} / ${e.total} 天</span>
    <button class="action-next" data-action="next" id="action-next">${nextLabel(e.currentView)}</button>
  </div>`
}

/** 次要操作收进折叠面板，不再挤占图表与操作条之间的黄金位置。 */
function moreOps(intraday: boolean): string {
  const draw = intraday ? '' : `<div class="btn-row">
      <button class="btn ghost" data-action="drawLine">趋势线</button>
      <button class="btn ghost" data-action="drawHLine">水平线</button>
    </div>
    <div class="btn-row"><button class="btn ghost" data-action="clearDraw">清除画线</button></div>`
  return `<details class="more-ops">
    <summary>更多操作 <span>全仓 / 清仓 / 自动播放 / 画线 / 复盘</span> ▾</summary>
    <div class="more-ops-body">
      <div class="btn-row">
        <button class="btn" data-action="buyAll">全仓买</button>
        <button class="btn" data-action="sellAll">清仓</button>
      </div>
      <div class="btn-row">
        <button class="btn" data-action="auto" id="auto-btn">${autoPlaying ? '暂停 ⏸' : '自动播放 ▶'}</button>
        <button class="btn ghost" data-action="finish">结束并复盘</button>
      </div>
      ${draw}
    </div>
  </details>`
}

/** 金额自适应：刚开盘只有几百万时显示「万」，放量后显示「亿」。 */
function fmtAmountYuan(n: number): string {
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)}亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(0)}万`
  return `${Math.round(n)}`
}

/**
 * 顶部报价区，对齐同花顺：左侧大字现价 + 涨跌额/幅，右侧两列。
 * 按用户要求只保留 市值 / 流通 / 额 / 换，去掉 高低开、市盈、量比、振幅。
 */
function quotePanel(q: QuoteMetrics): string {
  const cls = q.change >= 0 ? 'up' : 'down'
  const sign = q.change >= 0 ? '+' : ''
  return `<div class="quote-panel" id="quote">
    <div class="quote-main">
      <b class="quote-price ${cls}">${q.price.toFixed(2)}</b>
      <div class="quote-chg ${cls}"><span>${sign}${q.change.toFixed(2)}</span><span>${sign}${q.changePct.toFixed(2)}%</span></div>
    </div>
    <div class="quote-grid">
      <div><span>市值</span><b>${q.marketCapYi.toFixed(2)}亿</b></div>
      <div><span>额</span><b>${fmtAmountYuan(q.amount)}</b></div>
      <div><span>流通</span><b>${q.floatCapYi.toFixed(2)}亿</b></div>
      <div><span>换</span><b>${q.turnoverPct.toFixed(2)}%</b></div>
    </div>
  </div>`
}

/** 分时图上方那行：均价 / 最新 / 涨跌 / 涨跌幅（不含集合竞价）。 */
function intradayLegend(q: QuoteMetrics, avg: number): string {
  const cls = q.change >= 0 ? 'up' : 'down'
  const sign = q.change >= 0 ? '+' : ''
  return `<span class="legend-prefix">分时</span>
    <span class="ma-item avg">均价 ${avg.toFixed(2)}</span>
    <span class="ma-item">最新 ${q.price.toFixed(2)}</span>
    <span class="ma-item ${cls}">${sign}${q.change.toFixed(2)}</span>
    <span class="ma-item ${cls}">${sign}${q.changePct.toFixed(2)}%</span>`
}

/**
 * 历史位置标尺：用「当前日之前」的已揭示历史画一条收盘走势缩略线，
 * 直接回答「现在的股价处在历史什么位置」，不用肉眼把 2800 根 K 拉一遍。
 * 数据只来自已揭示历史，不泄露未来。
 */
function historyBar(h: HistoryPosition | null): string {
  if (!h || h.series.length < 2) return ''
  const W = 300
  const H = 44
  const top = 4
  const bottom = H - 3
  const span = h.high - h.low || 1
  const y = (v: number): number =>
    bottom - ((Math.min(h.high, Math.max(h.low, v)) - h.low) / span) * (bottom - top)
  const pts = h.series
    .map((v, i) => `${((i / (h.series.length - 1)) * W).toFixed(1)},${y(v).toFixed(1)}`)
    .join(' ')
  const dotY = y(h.current).toFixed(1)
  const isHigh = h.fromHighPct >= 0
  const isLow = h.fromLowPct <= 0
  const tag = isHigh
    ? '创历史新高'
    : isLow
      ? '创历史新低'
      : `高于历史 ${h.rankPct.toFixed(0)}% 的交易日`
  // 收成一行可展开的迷你条：周期栏与图表之间不能塞东西，
  // 但上一轮用户明确要「知道当前价在历史什么位置」，用 details 兼顾两者。
  return `<details class="history-bar">
    <summary>
      <span>历史位置</span>
      <b class="${isHigh ? 'up' : isLow ? 'down' : ''}">${tag}</b>
      <span class="history-span">${h.from.slice(0, 7)} 起 · ${h.bars} 根日线 ▾</span>
    </summary>
    <div class="history-body">
      <svg class="history-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <polygon class="spark-area" points="0,${bottom} ${pts} ${W},${bottom}" />
        <polyline class="spark-line" points="${pts}" />
        <line class="spark-now" x1="0" y1="${dotY}" x2="${W}" y2="${dotY}" />
        <circle class="spark-dot" cx="${W - 1.5}" cy="${dotY}" r="2.6" />
      </svg>
      <div class="history-scale">
        <span>低 ${h.low.toFixed(2)}</span>
        <span>距高 ${pct(h.fromHighPct)} · 距低 ${pct(h.fromLowPct)}</span>
        <span>高 ${h.high.toFixed(2)}</span>
      </div>
      <div class="history-track"><i style="left:${h.positionPct}%"></i></div>
    </div>
  </details>`
}

/** 截图里左下角的半透明圆形缩放浮层，绝对定位压在图表上。 */
function chartOverlayTools(intraday: boolean): string {
  if (intraday) return ''
  return `<div class="chart-overlay">
    <button data-action="earliest" aria-label="最早">«</button>
    <button data-action="zoomIn" aria-label="放大">＋</button>
    <button data-action="zoomOut" aria-label="缩小">－</button>
    <button data-action="panLeft" aria-label="看更早">‹</button>
    <button data-action="panRight" aria-label="看更新">›</button>
    <button data-action="latest" aria-label="回到最新">⤢</button>
  </div>`
}

/** 复盘页的画线工具行；训练页已收进「更多操作」，不再占首屏。 */
function chartTools(intraday: boolean): string {
  if (intraday) return ''
  return `<div class="chart-tools">
    <button data-action="drawLine">趋势线</button>
    <button data-action="drawHLine">水平线</button>
    <button data-action="clearDraw">清除画线</button>
    <span>缩小左拉或点「«」可看 2015 年起完整历史</span>
  </div>`
}

function feeNote(e: ReplayEngine): string {
  const r = e.feeRule
  const stamp = r.stampDutyRate ? `${wanLabel(r.stampDutyRate)}·卖出` : '免'
  const transfer = r.transferRate ? `${wanLabel(r.transferRate)}·双向` : '免'
  return `<span class="fee-kind">${KIND_LABEL[e.instrumentKind]}</span>
    <span>佣金 ${wanLabel(r.commissionRate)}（最低 ${yuan2(r.minCommission)}）· 印花 ${stamp} · 过户 ${transfer}</span>
    <span class="fee-total">本局费用 <b id="s-fees">${yuan2(e.totalFees.total)}</b></span>`
}

function renderTrades(trades: Trade[]): string {
  if (trades.length === 0) return '<p class="empty">还没有操作</p>'
  return trades
    .slice()
    .reverse()
    .slice(0, 20)
    .map((t) => {
      const pnl =
        t.pnl === null
          ? ''
          : `<b class="${t.pnl >= 0 ? 'up' : 'down'}">${t.pnl >= 0 ? '+' : ''}${nf.format(t.pnl)}</b>`
      const feeLine = t.fees
        ? `费用 ${yuan2(t.fees.total)} ＝ ${feeParts(t.fees)}`
        : `费用 ${yuan2(t.fee)}`
      return `<div class="trade">
        <div class="trade-main">
          <span class="tag ${t.side}">${t.side === 'buy' ? '买' : '卖'}</span>
          ${t.source === 'order' ? '<span class="tag order">条件</span>' : ''}
          <span>第 ${t.index + 1} 天</span>
          <span>${t.shares} 股 @ ${t.price.toFixed(3)}</span>
          ${pnl}
        </div>
        <div class="trade-fee">${t.date.slice(5, 16)} · ${feeLine}</div>
      </div>`
    })
    .join('')
}

function mountChart(candles: Candle[], intraday: boolean): void {
  // 分时窗走自绘 SVG，不初始化 KLineCharts（坐标系完全不同，复用反而会串数据）
  if (intraday) return
  const el = document.querySelector<HTMLElement>('#chart')
  if (!el) return
  chartView = new ChartView(el)
  chartView.mount()
  chartView.setBars(candles)
}

function renderTrain(): void {
  if (!engine) startGame()
  const e = engine
  if (!e) return
  const intraday = e.currentView === 'm5'
  const candles = e.visible()
  const q = e.quoteMetrics()
  const id = intraday ? e.intraday() : null
  const avg = id?.points[id.points.length - 1]?.avg ?? q.price
  const legend = intraday ? intradayLegend(q, avg) : indicatorLegend(candles, e.viewLabel)
  app.innerHTML = `${header('train')}
    <main class="page">
      <div id="quote-wrap">${quotePanel(q)}</div>
      ${windowBar(e)}
      <div class="indicator-legend" id="indicator-legend">${legend}</div>
      <div class="chart-area">
        ${intraday
          ? `<div id="intraday-wrap">${renderIntraday(id)}</div>`
          : '<div id="chart" class="chart"></div>'}
        ${chartOverlayTools(intraday)}
      </div>
      <div id="action-bar-wrap">${actionBar(e)}</div>
      <section class="stats compact">
        <div><span>可用资金</span><b id="s-cash">${money(e.cashValue)}</b></div>
        <div><span>持仓</span><b id="s-shares">${e.shareCount} 股</b></div>
        <div><span>浮动盈亏</span><b id="s-profit" class="${e.profit >= 0 ? 'up' : 'down'}">${pct(e.profitPct)}</b></div>
      </section>
      ${moreOps(intraday)}
      <div id="history-wrap">${historyBar(e.historyPosition())}</div>
      <p class="fee-note" id="fee-note">${feeNote(e)}</p>
      <p class="blind-note">股票名称与日期已隐藏 · 每次推进一个完整交易日，分时整屏换一天 · 四个窗口是同一局同一只股票 · 缩小左拉或点「«」可看 2015 年起完整历史</p>
      <section class="panel">
        <h3>本局操作</h3>
        <div id="trade-list">${renderTrades(e.tradeList)}</div>
      </section>
    </main>`
  mountChart(candles, intraday)
}

function renderReview(): void {
  const r = result
  if (!r) {
    view = 'train'
    renderTrain()
    return
  }
  const stampText = r.feeRule.stampDutyRate
    ? `${wanLabel(r.feeRule.stampDutyRate)}（卖出单边）`
    : '免征'
  const transferText = r.feeRule.transferRate
    ? `${wanLabel(r.feeRule.transferRate)}（双向）`
    : '免征'
  const orderRows = (r.orders ?? [])
    .map((o) => `<div class="order-review-row">
        <span>${orderText(o)}</span>
        <b class="${o.status === 'triggered' ? 'up' : o.status === 'failed' ? 'down' : ''}">${statusText(o)}${o.triggeredPrice ? ` @ ${o.triggeredPrice.toFixed(3)}` : ''}${o.status === 'failed' && o.reason ? ` · ${o.reason}` : ''}</b>
      </div>`)
    .join('')
  app.innerHTML = `${header('train')}
    <main class="page">
      <section class="reveal">
        <div>
          <h2>复盘</h2>
          <p class="reveal-line">标的 <b>${r.code}</b> · <b>${r.periodLabel}</b></p>
          <p class="reveal-line">${r.startDate} ~ ${r.endDate}</p>
        </div>
        <div class="score-big"><span>评分</span><b>${r.score.total}</b></div>
      </section>
      <section class="stats">
        <div><span>最终权益</span><b>${money(r.finalEquity)}</b></div>
        <div><span>本局收益</span><b class="${r.score.pnlPct >= 0 ? 'up' : 'down'}">${pct(r.score.pnlPct)}</b></div>
        <div><span>买入持有</span><b class="${r.score.benchmarkPct >= 0 ? 'up' : 'down'}">${pct(r.score.benchmarkPct)}</b></div>
        <div><span>超额收益</span><b class="${r.score.excessPct >= 0 ? 'up' : 'down'}">${pct(r.score.excessPct)}</b></div>
        <div><span>最大回撤</span><b>${r.score.maxDrawdown.toFixed(2)}%</b></div>
        <div><span>交易 / 胜率</span><b>${r.score.tradeCount} / ${r.score.winRate}%</b></div>
      </section>
      <div class="indicator-legend" id="indicator-legend">${indicatorLegend(r.candles, r.periodLabel)}</div>
      <div class="chart-area"><div id="chart" class="chart"></div>${chartOverlayTools(false)}</div>
      ${chartTools(false)}
      <p class="blind-note">上图为完整走势；买卖点标记在下方资金曲线上</p>
      <section class="panel">
        <h3>本局手续费</h3>
        <div class="fee-grid">
          <div><span>合计 · 占初始资金 ${((r.feeTotal.total / r.initialCash) * 100).toFixed(2)}%</span><b>${yuan2(r.feeTotal.total)}</b></div>
          <div><span>券商佣金</span><b>${yuan2(r.feeTotal.commission)}</b></div>
          <div><span>印花税</span><b>${yuan2(r.feeTotal.stampDuty)}</b></div>
          <div><span>过户费</span><b>${yuan2(r.feeTotal.transferFee)}</b></div>
        </div>
        <p class="tip fee-tip">${KIND_LABEL[r.instrumentKind]} · 佣金 ${wanLabel(r.feeRule.commissionRate)}（单笔最低 ${yuan2(r.feeRule.minCommission)}）· 印花 ${stampText} · 过户 ${transferText}。费用已在每笔成交时从资金实时扣除。</p>
      </section>
      ${r.orders?.length ? `<section class="panel"><h3>条件单（${r.orders.length}）</h3>${orderRows}</section>` : ''}
      <section class="panel">
        <h3>资金曲线</h3>
        ${renderCurve(r.equityCurve, r.trades)}
        <p class="legend"><i class="dot buy"></i>买入 <i class="dot sell"></i>卖出</p>
      </section>
      <section class="panel">
        <h3>成交明细</h3>
        <div>${renderTrades(r.trades)}</div>
      </section>
      <section class="controls">
        <button class="btn primary" data-action="new">再来一局</button>
        <button class="btn ghost" data-action="records">查看记录</button>
      </section>
    </main>`
  mountChart(r.candles, false)
}

// ---- 条件单 ---------------------------------------------------------

function subbar(title: string, right: string): string {
  return `<header class="subbar">
    <button data-action="orders" class="subbar-back">‹</button>
    <h2>${title}</h2>
    ${right}
  </header>`
}

function renderOrders(): void {
  const e = engine
  const list = e?.orderList ?? []
  const count = (s: OrderStatus): number =>
    s === 'watching' ? list.filter((o) => o.status === 'watching' || o.status === 'paused').length
      : list.filter((o) => o.status === s).length
  const tabs: { key: OrderTab; label: string }[] = [
    { key: 'watching', label: '监控中' },
    { key: 'triggered', label: '已触发' },
    { key: 'failed', label: '已失败' },
  ]
  const tabHtml = tabs
    .map((t) => `<button data-action="orderTab" data-value="${t.key}" class="${orderTab === t.key ? 'on' : ''}">${t.label} ${count(t.key)}</button>`)
    .join('')
  const shown = list.filter((o) =>
    orderTab === 'watching'
      ? o.status === 'watching' || o.status === 'paused'
      : o.status === orderTab,
  )
  const cards = shown.length
    ? shown
        .map((o) => {
          const detail =
            o.status === 'triggered'
              ? `成交 @ ${o.triggeredPrice?.toFixed(3) ?? '—'} · ${o.triggeredAt?.slice(5, 16) ?? ''}`
              : o.status === 'failed'
                ? o.reason ?? '条件不满足'
                : ''
          const ops = `<div class="order-ops">
            <button data-action="orderMove" data-id="${o.id}" data-dir="-1">上移</button>
            <button data-action="orderMove" data-id="${o.id}" data-dir="1">下移</button>
            ${o.status === 'paused'
              ? `<button data-action="orderResume" data-id="${o.id}">恢复</button>`
              : o.status === 'watching'
                ? `<button data-action="orderPause" data-id="${o.id}">暂停</button>`
                : ''}
            <button data-action="orderEdit" data-id="${o.id}">编辑</button>
            <button data-action="orderDelete" data-id="${o.id}">删除</button>
          </div>`
          return `<div class="order-card">
            <p class="order-desc">${orderText(o)}</p>
            <p class="order-status ${o.status}">${statusText(o)}${detail ? ` · ${detail}` : ''}</p>
            ${ops}
          </div>`
        })
        .join('')
    : `<p class="empty">${orderTab === 'watching' ? '还没有监控中的条件单' : '暂无记录'}</p>`

  app.innerHTML = `${subbar('条件单', '<button data-action="orderNew" class="subbar-add">＋</button>')}
    <main class="page">
      <div class="order-tabs">${tabHtml}</div>
      <div class="order-list">${cards}</div>
      <div class="btn-row order-actions">
        <button class="btn ghost" data-action="train">退出</button>
        <button class="btn primary" data-action="orderNew">新建条件单</button>
      </div>
      <section class="panel order-help">
        <h3>说明</h3>
        <p>1. 发生换股或手动暂停时，条件单会进入暂停状态，需要手动恢复或编辑后才会继续生效；恢复前请确认触发价是否仍适用于新的一局。</p>
        <p>2. 条件单按列表从上往下顺序执行，上面的单执行完后可能导致后面的无法执行（资金不足、持仓不足、T+1、涨跌停），因此尽量避免多个条件单同时触发。</p>
        <p>3. 每次推进按 5 分钟 K 线的最高／最低价判定触发，按触发价成交，佣金、印花、过户费照常扣除；日线窗口一次跨多根也会逐根判定。</p>
      </section>
    </main>`
}

function defaultDraft(e: ReplayEngine): OrderDraft {
  const price = round2(e.currentPrice)
  return {
    editingId: null,
    trigger: 'lte',
    price,
    side: 'buy',
    shares: 100,
    unit: 'shares',
    amount: round2(100 * price),
  }
}

function syncDraftFromInputs(): void {
  if (!draft) return
  const priceEl = document.querySelector<HTMLInputElement>('#order-price')
  const qtyEl = document.querySelector<HTMLInputElement>('#order-qty')
  const price = Number(priceEl?.value)
  const qty = Number(qtyEl?.value)
  if (Number.isFinite(price) && price > 0) {
    draft.price = round2(price)
    if (draft.unit === 'shares') draft.amount = round2(draft.shares * draft.price)
  }
  if (Number.isFinite(qty) && qty > 0) {
    if (draft.unit === 'shares') {
      draft.shares = Math.max(100, Math.floor(qty / 100) * 100)
      draft.amount = round2(draft.shares * draft.price)
    } else {
      draft.amount = round2(qty)
      draft.shares = Math.max(100, Math.floor(draft.amount / draft.price / 100) * 100)
    }
  }
}

function orderFormBody(e: ReplayEngine): string {
  const d = draft
  if (!d) return ''
  const chg = e.dayChangePct
  const qtyValue = d.unit === 'shares' ? d.shares : d.amount
  const qtyStep = d.unit === 'shares' ? 100 : 1000
  const qtyLabel = d.unit === 'shares' ? '委托股数' : '委托金额（元）'
  const qtySuffix = d.unit === 'shares' ? '股' : '元'
  return `<div class="order-quote">
      <div class="order-quote-top">当前价：<b class="${chg >= 0 ? 'up' : 'down'}">${e.currentPrice.toFixed(2)}</b>
        <span class="${chg >= 0 ? 'up' : 'down'}">涨跌幅：${pct(chg)}</span></div>
      <div class="order-quote-grid">
        <div><span>市值</span><b>${money(e.marketValue)}</b></div>
        <div><span>持仓 / 可用</span><b>${e.shareCount} / ${e.availableShares}</b></div>
        <div><span>成本 / 现价</span><b>${e.costPrice ? e.costPrice.toFixed(2) : '—'} / ${e.currentPrice.toFixed(2)}</b></div>
        <div><span>可用资金</span><b>${money(e.cashValue)}</b></div>
      </div>
    </div>
    <div class="order-section-title">监控条件 <span>股价条件 ▾</span></div>
    <div class="order-line">
      <label>股价达到</label>
      <div class="stepper">
        <button data-action="orderStep" data-field="price" data-delta="-0.01">－</button>
        <input id="order-price" type="number" inputmode="decimal" step="0.01" min="0.01" value="${d.price.toFixed(2)}" />
        <button data-action="orderStep" data-field="price" data-delta="0.01">＋</button>
      </div>
      <span class="unit-label">元</span>
    </div>
    <div class="trigger-toggle">
      <button data-action="orderTrigger" data-value="gte" class="${d.trigger === 'gte' ? 'on' : ''}">≥ 涨到就${d.side === 'buy' ? '买' : '卖'}</button>
      <button data-action="orderTrigger" data-value="lte" class="${d.trigger === 'lte' ? 'on' : ''}">≤ 跌到就${d.side === 'buy' ? '买' : '卖'}</button>
    </div>
    <div class="order-line">
      <label>委托方向</label>
      <div class="seg-radio">
        <button data-action="orderSide" data-value="buy" class="${d.side === 'buy' ? 'on' : ''}">买入</button>
        <button data-action="orderSide" data-value="sell" class="${d.side === 'sell' ? 'on' : ''}">卖出</button>
      </div>
    </div>
    <div class="order-line">
      <label>${qtyLabel}</label>
      <div class="stepper">
        <button data-action="orderStep" data-field="qty" data-delta="-${qtyStep}">－</button>
        <input id="order-qty" type="number" inputmode="decimal" step="${qtyStep}" min="1" value="${qtyValue}" />
        <button data-action="orderStep" data-field="qty" data-delta="${qtyStep}">＋</button>
      </div>
      <span class="unit-label">${qtySuffix}</span>
      <button class="unit-switch" data-action="orderUnit">↺${d.unit === 'shares' ? '金额' : '股数'}</button>
    </div>
    <div class="ratio-row">
      <button data-action="orderRatio" data-value="1">全仓</button>
      <button data-action="orderRatio" data-value="0.1">1/10仓</button>
      <button data-action="orderRatio" data-value="0.2">1/5仓</button>
      <button data-action="orderRatio" data-value="0.5">1/2仓</button>
      <button data-action="orderRatio" data-value="0.3333">1/3仓</button>
    </div>`
}

function renderOrderEdit(): void {
  const e = engine
  if (!e) {
    view = 'train'
    renderTrain()
    return
  }
  if (!draft) draft = defaultDraft(e)
  app.innerHTML = `${subbar(draft.editingId ? '编辑条件单' : '条件单', '<button data-action="orderSubmit" class="subbar-save">✓</button>')}
    <main class="page">
      <div id="order-form-body">${orderFormBody(e)}</div>
      <div class="btn-row order-actions">
        <button class="btn ghost" data-action="orderCancel">取消</button>
        <button class="btn primary" data-action="orderSubmit">提交</button>
      </div>
      <p class="tip order-tip">条件单只是挂单，不会立即成交。推进 K 线时按当根 5 分钟 K 的最高／最低价判定，触发后按触发价成交；成交仍受整手、涨跌停、T+1、可用资金与持仓约束，手续费照常计入。</p>
    </main>`
}

function refreshOrderForm(): void {
  if (!engine) return
  const el = document.querySelector<HTMLElement>('#order-form-body')
  if (el) el.innerHTML = orderFormBody(engine)
}

function mutateOrders(fn: (list: ConditionalOrder[]) => void): void {
  if (!engine) return
  const list = engine.orderList
  fn(list)
  engine.setOrders(list)
  render()
}

function submitOrder(): void {
  if (!engine || !draft) return
  syncDraftFromInputs()
  const d = draft
  const shares = Math.max(0, Math.floor(d.shares / 100) * 100)
  if (!(d.price > 0) || shares < 100) {
    toast('请填写有效触发价，委托股数至少 100 股')
    return
  }
  const list = engine.orderList
  if (d.editingId) {
    const i = list.findIndex((o) => o.id === d.editingId)
    if (i < 0) return
    list[i] = {
      ...list[i],
      trigger: d.trigger,
      price: d.price,
      side: d.side,
      shares,
      status: 'watching',
      reason: undefined,
      triggeredIndex: undefined,
      triggeredAt: undefined,
      triggeredPrice: undefined,
      code: engine.code,
    }
  } else {
    list.push({
      id: newOrderId(),
      trigger: d.trigger,
      price: d.price,
      side: d.side,
      shares,
      status: 'watching',
      code: engine.code,
      createdAt: Date.now(),
    })
  }
  engine.setOrders(list)
  draft = null
  orderTab = 'watching'
  view = 'orders'
  toast(d.editingId ? '条件单已更新，监控中' : '条件单已创建，监控中')
  render()
}

// ---- 记录页 ---------------------------------------------------------

function feePanel(): string {
  const s = loadFeeSchedule()
  const w = (rate: number): string => String(toWan(rate))
  return `<section class="panel">
    <h3>交易费率设置${hasCustomFees() ? '<span class="badge">已自定义</span>' : ''}</h3>
    <p class="tip">按你的券商实际费率计费：佣金买卖双向、单笔不足最低按最低收；印花税仅卖出股票、过户费双向，<b>场内基金与封基免此二项</b>。修改后<b>下一局生效</b>，已完成记录保留当时费率。</p>
    <form class="field-grid" id="fee-form" autocomplete="off">
      <label>股票佣金（万分之）<input id="fee-stock" type="number" inputmode="decimal" step="0.01" min="0" max="30" value="${w(s.stock.commissionRate)}" /></label>
      <label>封基佣金（万分之）<input id="fee-closed" type="number" inputmode="decimal" step="0.01" min="0" max="30" value="${w(s.closed_fund.commissionRate)}" /></label>
      <label>场内基金佣金（万分之）<input id="fee-fund" type="number" inputmode="decimal" step="0.01" min="0" max="30" value="${w(s.exchange_fund.commissionRate)}" /></label>
      <label>单笔最低佣金（元）<input id="fee-min" type="number" inputmode="decimal" step="0.01" min="0" max="1000" value="${s.stock.minCommission}" /></label>
      <label>股票印花税（万分之·卖出）<input id="fee-stamp" type="number" inputmode="decimal" step="0.01" min="0" max="30" value="${w(s.stock.stampDutyRate)}" /></label>
      <label>股票过户费（万分之·双向）<input id="fee-transfer" type="number" inputmode="decimal" step="0.001" min="0" max="30" value="${w(s.stock.transferRate)}" /></label>
    </form>
    <div class="btn-row">
      <button class="btn" data-action="feeSave">保存费率</button>
      <button class="btn ghost" data-action="feeReset">恢复默认</button>
    </div>
  </section>`
}

function syncPanel(): string {
  const cfg = loadSyncConfig()
  const status = loadSyncStatus()
  const state = !cfg
    ? '未配置 · 需要一个私有仓与细粒度 PAT'
    : `已配置 <b>${cfg.owner}/${cfg.repo}</b> · 凭证 ${maskToken(cfg.token)} · 上次 ${status.lastAt ? dateTime(status.lastAt) : '尚未同步'}${status.pending ? ' · <b class="down">待重试</b>' : ''}`
  return `<section class="panel">
    <h3>远程仓库同步</h3>
    <p class="tip">记录先写本机，再自动备份到你的私有仓。请在 GitHub 生成一个<b>细粒度 PAT</b>，只授予该仓库的 Contents 读写权限；凭证仅存这台手机，不进代码也不进公开仓。断网照常训练，恢复后自动补传。</p>
    <div class="sync-state">${state}${status.lastError ? `<span class="sync-err">上次失败：${status.lastError}</span>` : ''}</div>
    <form class="field-grid" id="sync-form" autocomplete="off">
      <label>用户名 / 组织<input id="sync-owner" type="text" placeholder="jancy0528" value="${cfg?.owner ?? ''}" /></label>
      <label>私有仓库名<input id="sync-repo" type="text" placeholder="kline-replay-data" value="${cfg?.repo ?? ''}" /></label>
      <label>文件路径<input id="sync-path" type="text" placeholder="${DEFAULT_PATH}" value="${cfg?.path ?? ''}" /></label>
      <label>细粒度 PAT<input id="sync-token" type="password" autocomplete="off" placeholder="${cfg ? '留空则沿用已存凭证' : 'github_pat_…'}" /></label>
    </form>
    <div class="btn-row sync-buttons">
      <button class="btn" data-action="syncSave">保存并同步</button>
      <button class="btn" data-action="syncNow">立即同步</button>
      <button class="btn" data-action="syncRestore">从云端恢复</button>
      <button class="btn ghost" data-action="syncClear">清除凭证</button>
    </div>
  </section>`
}

function renderRecords(): void {
  const list = loadRecords()
  const rows = list.length
    ? list
        .map(
          (r) => `<div class="record">
            <div><b>${r.code}</b><span>${r.periodLabel ?? '日线'} · ${dateTime(r.playedAt)}</span></div>
            <div class="record-mid">${r.startDate.slice(0, 10)} ~ ${r.endDate.slice(0, 10)}</div>
            <div class="record-right">
              <b class="${r.score.pnlPct >= 0 ? 'up' : 'down'}">${pct(r.score.pnlPct)}</b>
              <span>评分 ${r.score.total}${r.feeTotal ? ` · 费 ${yuan2(r.feeTotal.total)}` : ''}${r.orders?.length ? ` · 条件单 ${r.orders.length}` : ''}</span>
            </div>
          </div>`,
        )
        .join('')
    : '<p class="empty">还没有训练记录，先去练一局。</p>'

  app.innerHTML = `${header('records')}
    <main class="page">
      <section class="panel">
        <h3>训练记录（${list.length}）</h3>
        <div class="records">${rows}</div>
      </section>
      ${syncPanel()}
      ${feePanel()}
      <section class="panel">
        <h3>本地文件备份</h3>
        <p class="tip">记录只存在这台设备的浏览器里。iOS 主屏应用长期不用时数据可能被系统清理，请定期导出，或开启上面的远程同步。</p>
        <div class="btn-row">
          <button class="btn" data-action="export">导出 JSON</button>
          <button class="btn" data-action="import">导入 JSON</button>
          <button class="btn ghost" data-action="clear">清空本机</button>
        </div>
        <input id="import-file" type="file" accept="application/json,.json" hidden />
      </section>
      ${installGuide}
      <div class="controls"><button class="btn primary" data-action="train">开始训练</button></div>
    </main>`
}

function renderShell(): void {
  chartView?.destroy()
  chartView = null
  if (loadError) {
    app.innerHTML = `${header('train')}<main class="page"><section class="panel"><h3>数据加载失败</h3><p class="tip">${loadError}</p><p class="tip">离线数据随站点一起部署，请确认网络可用后重新打开；若在开发环境，先运行数据生成脚本。</p><button class="btn" data-action="retry">重试</button></section></main>`
    return
  }
  if (loading) {
    app.innerHTML = `${header('train')}<main class="page"><div class="loading"><span class="spinner"></span>正在加载${loadingLabel}…</div></main>`
    return
  }
  if (view === 'train') renderTrain()
  else if (view === 'review') renderReview()
  else if (view === 'orders') renderOrders()
  else if (view === 'orderEdit') renderOrderEdit()
  else renderRecords()
  window.scrollTo(0, 0)
}

function render(): void {
  renderShell()
}

function startGame(): void {
  if (!sessions) return
  stopAutoPlay()
  const game = pickGame(sessions)
  const symbol = sessions.symbols[game.c]
  if (!symbol) return
  const meta = windowMeta(sessions, engine?.currentView ?? 'day')
  const cfg = configForWindow(meta, loadFeeSchedule())
  // 条件单是账户级的：换股后仍在列表里，但监控中的自动暂停
  const carried = engine ? pauseOnSwitch(engine.orderList, game.c) : []
  engine = ReplayEngine.create(symbol, game, cfg)
  engine.setOrders(carried)
  result = null
  draft = null
}

function switchWindow(key: PeriodKey): void {
  if (!sessions || !engine || key === engine.currentView) return
  const meta = sessions.windows.find((w) => w.key === key)
  if (!meta) return
  engine.setView(key, meta.label)
  view = 'train'
  render()
  toast(`已切到${meta.label}：同一只股票、同一时间，账户与条件单不变`)
}

function stopAutoPlay(): void {
  autoPlaying = false
  window.clearInterval(autoTimer)
  autoTimer = 0
  const btn = document.getElementById('auto-btn')
  if (btn) btn.textContent = '自动播放 ▶'
}

function notifyOrders(before: ConditionalOrder[], after: ConditionalOrder[]): void {
  for (const o of after) {
    const prev = before.find((x) => x.id === o.id)
    if (!prev || prev.status !== 'watching' || o.status === 'watching') continue
    if (o.status === 'triggered') {
      toast(`条件单触发：${o.side === 'buy' ? '买入' : '卖出'} ${o.shares} 股 @ ${o.triggeredPrice?.toFixed(2) ?? '—'}`)
    } else if (o.status === 'failed') {
      toast(`条件单失败：${o.reason ?? '条件不满足'}`)
    }
    return
  }
}

function updateTrainUI(): void {
  if (!engine || view !== 'train') return
  const e = engine
  const intraday = e.currentView === 'm5'
  const candles = e.visible()
  const q = e.quoteMetrics()
  const quote = document.getElementById('quote-wrap')
  if (quote) quote.innerHTML = quotePanel(q)

  if (intraday) {
    const id = e.intraday()
    const box = document.getElementById('intraday-wrap')
    if (box) box.innerHTML = renderIntraday(id)
    const legend = document.getElementById('indicator-legend')
    if (legend) legend.innerHTML = intradayLegend(q, id?.points[id.points.length - 1]?.avg ?? q.price)
  } else {
    const last = candles[candles.length - 1]
    const count = chartView?.barCount ?? 0
    // 完整日线有 2800 根，推进时不再整体 resetData：
    // 根数不变 = 当日 K 被重新合成（原地替换），+1 = 新增一根，其余才全量重设。
    if (last && chartView && (candles.length === count || candles.length === count + 1)) {
      chartView.pushLatest(last)
    } else {
      chartView?.setBars(candles, true)
    }
    const legend = document.getElementById('indicator-legend')
    if (legend) legend.innerHTML = indicatorLegend(candles, e.viewLabel)
  }

  const historyWrap = document.getElementById('history-wrap')
  if (historyWrap) {
    const wasOpen = historyWrap.querySelector('details')?.open ?? false
    historyWrap.innerHTML = historyBar(e.historyPosition())
    if (wasOpen) {
      const details = historyWrap.querySelector('details')
      if (details) details.open = true
    }
  }
  const set = (id: string, text: string, cls?: string): void => {
    const el = document.getElementById(id)
    if (!el) return
    el.textContent = text
    if (cls) el.className = cls
  }
  set('s-cash', money(engine.cashValue))
  set('s-shares', `${engine.shareCount} 股`)
  set('s-profit', pct(engine.profitPct), engine.profit >= 0 ? 'up' : 'down')
  // 操作条只局部改文字，绝不重建按钮节点：一局 150 天用户会连续快点
  // 「下一天」，整条重建会让后续点击落在已被移除的旧节点上而丢步。
  set('action-progress', `${engine.index + 1} / ${engine.total} 天`)
  set('action-next', nextLabel(engine.currentView))
  const orders = document.getElementById('action-orders')
  if (orders) {
    const watching = engine.orderList.filter(
      (o) => o.status === 'watching' || o.status === 'paused',
    ).length
    orders.innerHTML = `条件单${watching ? `<i>${watching}</i>` : ''}`
  }
  set('s-fees', yuan2(engine.totalFees.total))
  const list = document.getElementById('trade-list')
  if (list) list.innerHTML = renderTrades(engine.tradeList)
}

function advanceStep(): void {
  if (!engine) return
  const before = engine.orderList
  const hasMore = engine.advance()
  updateTrainUI()
  notifyOrders(before, engine.orderList)
  if (!hasMore) toast('已到最后一根，点「结束并复盘」看结果')
}

function toggleAutoPlay(): void {
  if (autoPlaying) {
    stopAutoPlay()
    return
  }
  autoPlaying = true
  const btn = document.getElementById('auto-btn')
  if (btn) btn.textContent = '暂停 ⏸'
  autoTimer = window.setInterval(() => {
    if (!engine || view !== 'train') {
      stopAutoPlay()
      return
    }
    advanceStep()
    if (engine.isEnded) stopAutoPlay()
  }, 650)
}

function applyTrade(res: { ok: boolean; reason?: string } | undefined): void {
  if (!res) return
  if (!res.ok) toast(res.reason ?? '操作失败')
  updateTrainUI()
}

function readSyncForm(): SyncConfig {
  const cfg = loadSyncConfig()
  const val = (selector: string): string =>
    document.querySelector<HTMLInputElement>(selector)?.value.trim() ?? ''
  return {
    owner: val('#sync-owner') || cfg?.owner || '',
    repo: val('#sync-repo') || cfg?.repo || '',
    path: val('#sync-path') || cfg?.path || DEFAULT_PATH,
    token: val('#sync-token') || cfg?.token || '',
  }
}

function readFeeForm(): FeeSchedule {
  const s = loadFeeSchedule()
  const num = (id: string): number =>
    Number(document.querySelector<HTMLInputElement>(id)?.value)
  const rate = (id: string, fallback: number): number => {
    const n = num(id)
    return Number.isFinite(n) && n >= 0 && n <= 30 ? fromWan(n) : fallback
  }
  const rawMin = num('#fee-min')
  const min =
    Number.isFinite(rawMin) && rawMin >= 0 && rawMin <= 1000
      ? rawMin
      : s.stock.minCommission
  return {
    stock: {
      ...s.stock,
      commissionRate: rate('#fee-stock', s.stock.commissionRate),
      minCommission: min,
      stampDutyRate: rate('#fee-stamp', s.stock.stampDutyRate),
      transferRate: rate('#fee-transfer', s.stock.transferRate),
    },
    closed_fund: {
      ...s.closed_fund,
      commissionRate: rate('#fee-closed', s.closed_fund.commissionRate),
      minCommission: min,
    },
    exchange_fund: {
      ...s.exchange_fund,
      commissionRate: rate('#fee-fund', s.exchange_fund.commissionRate),
      minCommission: min,
    },
  }
}

async function handle(action: string, target: HTMLElement): Promise<void> {
  const id = target.dataset.id
  const value = target.dataset.value ?? ''
  switch (action) {
    case 'train':
      if (view !== 'train') {
        view = 'train'
        render()
      }
      return
    case 'records':
      view = 'records'
      render()
      return
    case 'retry':
      loadError = ''
      loading = true
      render()
      await boot()
      return
    case 'new': {
      startGame()
      view = 'train'
      render()
      if (engine?.orderList.some((o) => o.status === 'paused')) {
        toast('上一局监控中的条件单已暂停，可在条件单里恢复或编辑')
      }
      return
    }
    case 'next':
      advanceStep()
      return
    case 'auto':
      toggleAutoPlay()
      return
    case 'zoomIn':
      chartView?.zoom(1.25)
      return
    case 'zoomOut':
      chartView?.zoom(0.8)
      return
    case 'panLeft':
      chartView?.pan(-6)
      return
    case 'panRight':
      chartView?.pan(6)
      return
    case 'earliest':
      chartView?.toEarliest()
      toast('已缩到最小并跳到 2015 年附近，点「最新」回到当前')
      return
    case 'latest':
      chartView?.toLatest()
      return
    case 'drawLine':
      chartView?.startDrawing('segment')
      toast('在图上点两下画趋势线')
      return
    case 'drawHLine':
      chartView?.startDrawing('horizontalStraightLine')
      toast('在图上点一下画水平线')
      return
    case 'clearDraw':
      chartView?.clearDrawings()
      return
    case 'buy':
      applyTrade(engine?.buy(100))
      return
    case 'buyAll':
      applyTrade(engine ? engine.buy(engine.maxBuyable()) : undefined)
      return
    case 'sell':
      applyTrade(engine?.sell(100))
      return
    case 'sellAll':
      applyTrade(engine ? engine.sell(engine.availableShares) : undefined)
      return
    case 'finish': {
      if (!engine) return
      stopAutoPlay()
      result = engine.finish()
      saveRecord(toStored(result))
      queueAutoSync()
      view = 'review'
      render()
      return
    }
    // ---- 条件单 ----
    case 'orders':
      orderTab = 'watching'
      view = 'orders'
      render()
      return
    case 'orderTab':
      orderTab = value as OrderTab
      render()
      return
    case 'orderNew':
      if (!engine) return
      draft = defaultDraft(engine)
      view = 'orderEdit'
      render()
      return
    case 'orderCancel':
      draft = null
      view = 'orders'
      render()
      return
    case 'orderStep': {
      if (!draft) return
      syncDraftFromInputs()
      const delta = Number(target.dataset.delta)
      if (target.dataset.field === 'price') {
        draft.price = Math.max(0.01, round2(draft.price + delta))
        draft.amount = round2(draft.shares * draft.price)
      } else if (draft.unit === 'shares') {
        draft.shares = Math.max(100, Math.floor((draft.shares + delta) / 100) * 100)
        draft.amount = round2(draft.shares * draft.price)
      } else {
        draft.amount = Math.max(100, round2(draft.amount + delta))
        draft.shares = Math.max(100, Math.floor(draft.amount / draft.price / 100) * 100)
      }
      refreshOrderForm()
      return
    }
    case 'orderTrigger':
      if (!draft) return
      syncDraftFromInputs()
      draft.trigger = value === 'gte' ? 'gte' : 'lte'
      refreshOrderForm()
      return
    case 'orderSide': {
      if (!draft) return
      syncDraftFromInputs()
      draft.side = value === 'sell' ? 'sell' : 'buy'
      // 买入默认回踩买、卖出默认冲高卖，用户仍可手动改触发方向
      draft.trigger = draft.side === 'buy' ? 'lte' : 'gte'
      refreshOrderForm()
      return
    }
    case 'orderUnit':
      if (!draft) return
      syncDraftFromInputs()
      draft.unit = draft.unit === 'shares' ? 'amount' : 'shares'
      refreshOrderForm()
      return
    case 'orderRatio': {
      if (!draft || !engine) return
      syncDraftFromInputs()
      const ratio = Number(value) || 1
      const max = draft.side === 'buy' ? engine.maxBuyable() : engine.availableShares
      draft.shares = Math.max(100, Math.floor((max * ratio) / 100) * 100)
      draft.amount = round2(draft.shares * draft.price)
      draft.unit = 'shares'
      refreshOrderForm()
      return
    }
    case 'orderSubmit':
      submitOrder()
      return
    case 'orderEdit': {
      const o = engine?.orderList.find((x) => x.id === id)
      if (!o) return
      draft = {
        editingId: o.id,
        trigger: o.trigger,
        price: o.price,
        side: o.side,
        shares: o.shares,
        unit: 'shares',
        amount: round2(o.shares * o.price),
      }
      view = 'orderEdit'
      render()
      return
    }
    case 'orderDelete':
      mutateOrders((list) => {
        const i = list.findIndex((o) => o.id === id)
        if (i >= 0) list.splice(i, 1)
      })
      return
    case 'orderMove': {
      const dir = Number(target.dataset.dir)
      mutateOrders((list) => {
        const i = list.findIndex((o) => o.id === id)
        const j = i + dir
        if (i >= 0 && j >= 0 && j < list.length) {
          const tmp = list[i]
          list[i] = list[j]
          list[j] = tmp
        }
      })
      return
    }
    case 'orderResume':
      mutateOrders((list) => {
        const o = list.find((x) => x.id === id)
        if (o && o.status === 'paused') {
          o.status = 'watching'
          o.reason = undefined
          if (engine) o.code = engine.code
        }
      })
      toast('已恢复监控；请确认触发价仍适用于当前这一局')
      return
    case 'orderPause':
      mutateOrders((list) => {
        const o = list.find((x) => x.id === id)
        if (o && o.status === 'watching') {
          o.status = 'paused'
          o.reason = '手动'
        }
      })
      return
    // ---- 设置 / 备份 ----
    case 'feeSave': {
      try {
        saveFeeSchedule(readFeeForm())
        toast('费率已保存，下一局生效')
      } catch {
        toast('保存失败：本机存储不可用')
      }
      render()
      return
    }
    case 'feeReset':
      resetFeeSchedule()
      toast('已恢复默认费率，下一局生效')
      render()
      return
    case 'export': {
      try {
        const how = await exportRecords()
        toast(how === 'shared' ? '已调起分享，保存到「文件」即可' : '已导出 JSON 文件')
      } catch {
        toast('导出取消或失败')
      }
      return
    }
    case 'import':
      document.querySelector<HTMLInputElement>('#import-file')?.click()
      return
    case 'clear':
      if (window.confirm('确定清空本机全部训练记录？建议先导出或开启远程同步。')) {
        clearRecords()
        toast('已清空本机记录')
        render()
      }
      return
    case 'syncSave': {
      const cfg = readSyncForm()
      if (!cfg.owner || !cfg.repo || !cfg.token) {
        toast('请填写用户名、仓库名和 PAT')
        return
      }
      saveSyncConfig(cfg)
      toast('凭证已保存，正在同步…')
      const res = await syncNow(cfg)
      toast(res.message)
      render()
      return
    }
    case 'syncNow': {
      const cfg = loadSyncConfig()
      if (!cfg) {
        toast('请先填写凭证并点「保存并同步」')
        return
      }
      toast('正在同步…')
      const res = await syncNow(cfg)
      toast(res.message)
      render()
      return
    }
    case 'syncRestore': {
      const cfg = loadSyncConfig()
      if (!cfg) {
        toast('请先填写凭证并点「保存并同步」')
        return
      }
      toast('正在从云端恢复…')
      const res = await syncNow(cfg, 'restore')
      toast(res.message)
      render()
      return
    }
    case 'syncClear':
      if (window.confirm('清除本机保存的同步凭证？云端记录不会被删除。')) {
        clearSyncConfig()
        toast('已清除凭证')
        render()
      }
      return
    default:
      return
  }
}

app.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>(
    '[data-action],[data-window]',
  )
  if (!target) return
  if (target.dataset.window) void switchWindow(target.dataset.window as PeriodKey)
  else if (target.dataset.action) void handle(target.dataset.action, target)
})

// 设置项用 form 包着输入框（消除浏览器告警），但绝不允许回车提交刷新页面
document.addEventListener('submit', (event) => {
  const id = (event.target as HTMLElement).id
  if (id === 'sync-form' || id === 'fee-form') event.preventDefault()
})

// 条件单表单：输入时不重渲染，避免光标跳动；只在点 ± / 切换时局部刷新
document.addEventListener('input', (event) => {
  const input = event.target as HTMLInputElement
  if (input.id === 'order-price' || input.id === 'order-qty') syncDraftFromInputs()
})

document.addEventListener('change', (event) => {
  const input = event.target as HTMLInputElement
  if (input.id !== 'import-file' || !input.files?.[0]) return
  const file = input.files[0]
  void importRecords(file)
    .then((count) => {
      toast(`导入 ${count} 条记录`)
      if (view === 'records') render()
      queueAutoSync()
    })
    .catch(() => toast('导入失败：文件格式不对'))
  input.value = ''
})

window.addEventListener('resize', () => chartView?.resize())

async function boot(): Promise<void> {
  loading = true
  loadError = ''
  render()
  try {
    manifest = await loadManifest()
    sessions = await loadSessions(manifest)
    if (!sessions.games.length || !sessions.windows.length) {
      throw new Error('对局包不完整')
    }
    startGame()
    loading = false
    render()
    startAutoSync()
  } catch (err) {
    loading = false
    loadError = errText(err)
    render()
  }
}

void boot()

// 只在生产构建注册，避免开发时被旧缓存挡住热更新
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
      .catch((err) => console.warn('[sw] register failed', err))
  })
}
