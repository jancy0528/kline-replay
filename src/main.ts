import './style.css'
import {
  loadManifest,
  loadPackage,
  pickSegment,
  type DataManifest,
  type PeriodKey,
  type PeriodMeta,
  type SegmentPackage,
} from './data/segments'
import {
  ReplayEngine,
  configForPeriod,
  type Candle,
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
import { ChartView, formatBigNumberCN, indicatorLegend } from './ui/chart'
import { renderCurve } from './ui/curve'

const root = document.querySelector<HTMLDivElement>('#app')
if (!root) throw new Error('#app not found')
const app: HTMLDivElement = root

type View = 'train' | 'review' | 'records'

const standalone =
  window.matchMedia('(display-mode: standalone)').matches ||
  (window.navigator as Navigator & { standalone?: boolean }).standalone === true

const nf = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 })
const money = (n: number): string => `¥${nf.format(n)}`
const yuan2 = (n: number): string => `¥${n.toFixed(2)}`
const wanLabel = (rate: number): string => `万${toWan(rate)}`
const pct = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
const dateTime = (ts: number): string =>
  new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const feeParts = (f: FeeBreakdown): string =>
  `佣金 ${yuan2(f.commission)} ＋ 印花 ${yuan2(f.stampDuty)} ＋ 过户 ${yuan2(f.transferFee)}`

let view: View = 'train'
let manifest: DataManifest | null = null
let currentMeta: PeriodMeta | null = null
let currentPackage: SegmentPackage | null = null
let engine: ReplayEngine | null = null
let result: SessionResult | null = null
let chartView: ChartView | null = null
let loading = true
let loadingLabel = '离线数据'
let loadError = ''
let autoPlaying = false
let autoTimer = 0
let toastTimer = 0

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

function periodBar(): string {
  const items = manifest?.periods ?? []
  const buttons = items
    .map((p) => {
      const active = p.key === currentMeta?.key
      const disabled = !p.file
      const label = disabled ? `${p.label}·待补` : p.label
      // 不用 disabled：手机上点不到就不知道为什么，改为点击后给出补齐提示
      return `<button data-period="${p.key}" class="${active ? 'on' : ''} ${disabled ? 'pending' : ''}">${label}</button>`
    })
    .join('')
  return `<div class="period-bar">${buttons}</div>`
}

function quoteBar(candles: Candle[]): string {
  const c = candles[candles.length - 1]
  if (!c) return ''
  const prev = candles[candles.length - 2]
  const prevClose = prev?.close ?? c.open
  const chg = prevClose ? (c.close / prevClose - 1) * 100 : 0
  const cls = (v: number): string => (v >= prevClose ? 'up' : 'down')
  return `<div class="quote" id="quote">
    <span>开 <b class="${cls(c.open)}">${c.open.toFixed(2)}</b></span>
    <span>高 <b class="${cls(c.high)}">${c.high.toFixed(2)}</b></span>
    <span>低 <b class="${cls(c.low)}">${c.low.toFixed(2)}</b></span>
    <span>收 <b class="${cls(c.close)}">${c.close.toFixed(2)}</b></span>
    <span class="quote-chg ${chg >= 0 ? 'up' : 'down'}">${pct(chg)}</span>
    <span>量 <b>${formatBigNumberCN(c.volume)}</b></span>
  </div>`
}

function chartTools(): string {
  return `<div class="chart-tools">
    <button data-action="zoomIn">＋</button>
    <button data-action="zoomOut">－</button>
    <button data-action="panLeft">←</button>
    <button data-action="panRight">→</button>
    <button data-action="drawLine">趋势线</button>
    <button data-action="drawHLine">水平线</button>
    <button data-action="clearDraw">清除</button>
  </div>`
}

/** 训练页顶部的费率提示：品种、佣金档、税费规则、本局累计费用。 */
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
          <span>第 ${t.index + 1} 根</span>
          <span>${t.shares} 股 @ ${t.price.toFixed(3)}</span>
          ${pnl}
        </div>
        <div class="trade-fee">${feeLine}</div>
      </div>`
    })
    .join('')
}

function mountChart(candles: Candle[]): void {
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
  const candles = e.visible()
  app.innerHTML = `${header('train')}
    <main class="page">
      ${periodBar()}
      <section class="stats">
        <div><span>可用资金</span><b id="s-cash">${money(e.cashValue)}</b></div>
        <div><span>持仓</span><b id="s-shares">${e.shareCount} 股</b></div>
        <div><span>浮动盈亏</span><b id="s-profit" class="${e.profit >= 0 ? 'up' : 'down'}">${pct(e.profitPct)}</b></div>
        <div><span>进度</span><b id="s-progress">${e.index + 1} / ${e.total}</b></div>
      </section>
      <div id="quote-wrap">${quoteBar(candles)}</div>
      <div class="indicator-legend" id="indicator-legend">${indicatorLegend(candles)}</div>
      <div id="chart" class="chart"></div>
      ${chartTools()}
      <p class="blind-note">股票名称与日期已隐藏 · 只能看到已推进的 K 线</p>
      <p class="fee-note" id="fee-note">${feeNote(e)}</p>
      <section class="controls">
        <div class="btn-row">
          <button class="btn primary" data-action="next">下一根 →</button>
          <button class="btn" data-action="auto" id="auto-btn">${autoPlaying ? '暂停 ⏸' : '自动播放 ▶'}</button>
        </div>
        <div class="btn-row">
          <button class="btn" data-action="buy">买 100</button>
          <button class="btn" data-action="buyAll">全仓买</button>
          <button class="btn" data-action="sell">卖 100</button>
          <button class="btn" data-action="sellAll">清仓</button>
        </div>
        <div class="btn-row">
          <button class="btn ghost" data-action="finish">结束并复盘</button>
          <button class="btn ghost" data-action="new">换一局</button>
        </div>
      </section>
      <section class="panel">
        <h3>本局操作</h3>
        <div id="trade-list">${renderTrades(e.tradeList)}</div>
      </section>
    </main>`
  mountChart(candles)
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
      <div class="indicator-legend" id="indicator-legend">${indicatorLegend(r.candles)}</div>
      <div id="chart" class="chart"></div>
      ${chartTools()}
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
  mountChart(r.candles)
}

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
              <span>评分 ${r.score.total}${r.feeTotal ? ` · 费 ${yuan2(r.feeTotal.total)}` : ''}</span>
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
  else renderRecords()
  window.scrollTo(0, 0)
}

function render(): void {
  renderShell()
}

function startGame(): void {
  if (!currentPackage || !currentMeta) return
  stopAutoPlay()
  const cfg = configForPeriod(currentMeta, loadFeeSchedule())
  engine = ReplayEngine.create(pickSegment(currentPackage), cfg)
  result = null
}

function stopAutoPlay(): void {
  autoPlaying = false
  window.clearInterval(autoTimer)
  autoTimer = 0
  const btn = document.getElementById('auto-btn')
  if (btn) btn.textContent = '自动播放 ▶'
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
    const before = engine.visible().length
    const hasMore = engine.advance()
    const after = engine.visible()
    updateTrainUI(after.length > before ? after[after.length - 1] : undefined)
    if (!hasMore) {
      stopAutoPlay()
      toast('已到最后一根，点「结束并复盘」看结果')
    }
  }, 650)
}

function updateTrainUI(newBar?: Candle): void {
  if (!engine) return
  if (newBar) chartView?.appendBar(newBar)
  const candles = engine.visible()
  const legend = document.getElementById('indicator-legend')
  if (legend) legend.innerHTML = indicatorLegend(candles)
  const quote = document.getElementById('quote-wrap')
  if (quote) quote.innerHTML = quoteBar(candles)
  const set = (id: string, text: string, cls?: string): void => {
    const el = document.getElementById(id)
    if (!el) return
    el.textContent = text
    if (cls) el.className = cls
  }
  set('s-cash', money(engine.cashValue))
  set('s-shares', `${engine.shareCount} 股`)
  set('s-profit', pct(engine.profitPct), engine.profit >= 0 ? 'up' : 'down')
  set('s-progress', `${engine.index + 1} / ${engine.total}`)
  set('s-fees', yuan2(engine.totalFees.total))
  const list = document.getElementById('trade-list')
  if (list) list.innerHTML = renderTrades(engine.tradeList)
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

async function switchPeriod(key: PeriodKey): Promise<void> {
  if (!manifest || key === currentMeta?.key) return
  const meta = manifest.periods.find((p) => p.key === key)
  if (!meta) return
  if (!meta.file) {
    toast(`${meta.label} 数据待补：运行取数脚本后重新生成片段包即可启用`)
    return
  }
  loading = true
  loadingLabel = `${meta.label}训练`
  render()
  try {
    const pkg = await loadPackage(meta)
    currentMeta = meta
    currentPackage = pkg
    startGame()
    view = 'train'
  } catch (err) {
    toast(`加载失败：${errText(err)}`)
  } finally {
    loading = false
    render()
  }
}

async function handle(action: string): Promise<void> {
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
    case 'new':
      startGame()
      view = 'train'
      render()
      return
    case 'next': {
      if (!engine) return
      const before = engine.visible().length
      const hasMore = engine.advance()
      const after = engine.visible()
      updateTrainUI(after.length > before ? after[after.length - 1] : undefined)
      if (!hasMore) toast('已到最后一根，点「结束并复盘」看结果')
      return
    }
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
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action],[data-period]')
  if (!target) return
  if (target.dataset.period) void switchPeriod(target.dataset.period as PeriodKey)
  else if (target.dataset.action) void handle(target.dataset.action)
})

// 设置项用 form 包着输入框（消除浏览器告警），但绝不允许回车提交刷新页面
document.addEventListener('submit', (event) => {
  const id = (event.target as HTMLElement).id
  if (id === 'sync-form' || id === 'fee-form') event.preventDefault()
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
    const first =
      manifest.periods.find((p) => p.key === 'day' && p.file) ??
      manifest.periods.find((p) => p.file)
    if (!first) throw new Error('没有可用的训练片段包')
    loadingLabel = `${first.label}训练`
    currentMeta = first
    currentPackage = await loadPackage(first)
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
