import './style.css'
import { BARS } from './data/bars'
import { ReplayEngine, type Candle, type SessionResult, type Trade } from './engine/replay'
import {
  clearRecords,
  exportRecords,
  importRecords,
  loadRecords,
  saveRecord,
  toStored,
} from './engine/records'
import { ChartView, indicatorLegend } from './ui/chart'
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
const pct = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
const dateTime = (ts: number): string =>
  new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })

let view: View = 'train'
let engine: ReplayEngine | null = null
let result: SessionResult | null = null
let chartView: ChartView | null = null
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
  toastTimer = window.setTimeout(() => el.classList.remove('show'), 2200)
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
    <li><b>点地址栏旁的 <span class="kbd">⋯</span></b>（更多）→ 在弹出菜单选 <b>共享 / Share</b>。若你的 Safari 是「底部」或「顶部」布局，工具栏上直接就有方框箭头图标。</li>
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
      return `<div class="trade">
        <span class="tag ${t.side}">${t.side === 'buy' ? '买' : '卖'}</span>
        <span>第 ${t.index + 1} 根</span>
        <span>${t.shares} 股 @ ${t.price.toFixed(3)}</span>
        ${pnl}
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
  if (!engine) engine = ReplayEngine.create(BARS)
  const e = engine
  app.innerHTML = `${header('train')}
    <main class="page">
      <section class="stats">
        <div><span>可用资金</span><b id="s-cash">${money(e.cashValue)}</b></div>
        <div><span>持仓</span><b id="s-shares">${e.shareCount} 股</b></div>
        <div><span>浮动盈亏</span><b id="s-profit" class="${e.profit >= 0 ? 'up' : 'down'}">${pct(e.profitPct)}</b></div>
        <div><span>进度</span><b id="s-progress">${e.index + 1} / ${e.total}</b></div>
      </section>
      <div class="indicator-legend" id="indicator-legend">${indicatorLegend(e.visible())}</div>
      <div id="chart" class="chart"></div>
      <p class="blind-note">股票名称与日期已隐藏 · 只能看到已推进的 K 线</p>
      <section class="controls">
        <button class="btn primary" data-action="next">下一根 →</button>
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
  mountChart(e.visible())
}

function renderReview(): void {
  const r = result
  if (!r) {
    view = 'train'
    renderTrain()
    return
  }
  app.innerHTML = `${header('train')}
    <main class="page">
      <section class="reveal">
        <div>
          <h2>复盘</h2>
          <p class="reveal-line">标的 <b>${r.code}</b></p>
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
      <p class="blind-note">上图为完整走势；买卖点标记在下方资金曲线上</p>
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

function renderRecords(): void {
  const list = loadRecords()
  const rows = list.length
    ? list
        .map(
          (r) => `<div class="record">
            <div><b>${r.code}</b><span>${dateTime(r.playedAt)}</span></div>
            <div class="record-mid">${r.startDate} ~ ${r.endDate}</div>
            <div class="record-right">
              <b class="${r.score.pnlPct >= 0 ? 'up' : 'down'}">${pct(r.score.pnlPct)}</b>
              <span>评分 ${r.score.total}</span>
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
      <section class="panel">
        <h3>备份与恢复</h3>
        <p class="tip">记录只存在这台设备的浏览器里。iOS 主屏应用长期不用时数据可能被系统清理，请定期导出。</p>
        <div class="btn-row">
          <button class="btn" data-action="export">导出 JSON</button>
          <button class="btn" data-action="import">导入 JSON</button>
          <button class="btn ghost" data-action="clear">清空</button>
        </div>
        <input id="import-file" type="file" accept="application/json,.json" hidden />
      </section>
      ${installGuide}
      <div class="controls"><button class="btn primary" data-action="train">开始训练</button></div>
    </main>`
}

function render(): void {
  chartView?.destroy()
  chartView = null
  if (view === 'train') renderTrain()
  else if (view === 'review') renderReview()
  else renderRecords()
  window.scrollTo(0, 0)
}

function updateTrainUI(newBar?: Candle): void {
  if (!engine) return
  if (newBar) chartView?.appendBar(newBar)
  const legend = document.getElementById('indicator-legend')
  if (legend) legend.innerHTML = indicatorLegend(engine.visible())
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
  const list = document.getElementById('trade-list')
  if (list) list.innerHTML = renderTrades(engine.tradeList)
}

function applyTrade(res: { ok: boolean; reason?: string } | undefined): void {
  if (!res) return
  if (!res.ok) toast(res.reason ?? '操作失败')
  updateTrainUI()
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
    case 'new':
      engine = ReplayEngine.create(BARS)
      result = null
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
      result = engine.finish()
      saveRecord(toStored(result))
      view = 'review'
      render()
      return
    }
    case 'export': {
      try {
        const how = await exportRecords()
        toast(how === 'shared' ? '已调起分享，保存到「文件」即可' : '已导出 JSON 文件')
      } catch {
        toast('导出取消或失败')
      }
      return
    }
    case 'import': {
      document.querySelector<HTMLInputElement>('#import-file')?.click()
      return
    }
    case 'clear':
      if (window.confirm('确定清空本机全部训练记录？建议先导出备份。')) {
        clearRecords()
        toast('已清空')
        render()
      }
      return
    default:
      return
  }
}

app.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')
  if (target) void handle(target.dataset.action ?? '')
})

document.addEventListener('change', (event) => {
  const input = event.target as HTMLInputElement
  if (input.id !== 'import-file' || !input.files?.[0]) return
  const file = input.files[0]
  void importRecords(file)
    .then((count) => {
      toast(`导入 ${count} 条记录`)
      if (view === 'records') render()
    })
    .catch(() => toast('导入失败：文件格式不对'))
  input.value = ''
})

window.addEventListener('resize', () => chartView?.resize())
render()

// 只在生产构建注册，避免开发时被旧缓存挡住热更新
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
      .catch((err) => console.warn('[sw] register failed', err))
  })
}
