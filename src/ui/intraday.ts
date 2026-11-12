/**
 * 自绘分时图：白色价格线 + 黄色均价线 + 0% 昨收中轴 + 上下对称涨跌幅刻度
 * + 真实交易时间轴 + 红绿分时量柱。对应同花顺分时页（不含集合竞价段、五档盘口）。
 *
 * 为什么不用 KLineCharts：它 y 轴按可见区间自动取值、x 轴是等距 K 线索引，
 * 做不到「以昨收为轴的对称 ±刻度」和「09:30/11:30/15:00 真实时间轴」，
 * 也没有 VWAP 均价线。分时本来就固定一屏、不需要缩放平移，SVG 更可控。
 *
 * 只接收引擎已揭示的当日分钟点，绝不读未来数据。
 */
import type { IntradayData } from '../engine/replay'

const W = 360
const MAIN_TOP = 20
const MAIN_H = 168
const MAIN_BOTTOM = MAIN_TOP + MAIN_H
const VOL_TOP = 208
const VOL_H = 52
const PAD_L = 6
const PAD_R = 42
const PLOT_W = W - PAD_L - PAD_R

const WHITE = '#e8edf7'
const YELLOW = '#f5c451'
const UP = '#f0454b'
const DOWN = '#22b07d'
const GRID = 'rgba(255,255,255,0.09)'

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** 09:30~11:30 占左半，13:00~15:00 占右半；午休不占宽度，与行情软件一致。 */
function timeRatio(time: string): number {
  const [h, m] = time.split(':').map(Number)
  const minutes = h * 60 + m
  if (minutes <= 11 * 60 + 30) return clamp((minutes - 9 * 60 - 30) / 120, 0, 1) * 0.5
  return 0.5 + clamp((minutes - 13 * 60) / 120, 0, 1) * 0.5
}

function fmtAmount(v: number): string {
  if (v >= 1e8) return `${(v / 1e8).toFixed(2)}亿`
  if (v >= 1e4) return `${(v / 1e4).toFixed(0)}万`
  return String(Math.round(v))
}

export function renderIntraday(data: IntradayData | null): string {
  if (!data || !data.points.length) {
    return '<div class="intraday empty">当日分时数据加载中…</div>'
  }
  const { prevClose, points, boundPct } = data
  const upper = prevClose * (1 + boundPct / 100)
  const lower = prevClose * (1 - boundPct / 100)
  const span = upper - lower || prevClose * 0.02
  const x = (t: string): number => PAD_L + timeRatio(t) * PLOT_W
  const y = (p: number): number =>
    MAIN_TOP + clamp((upper - p) / span, 0, 1) * MAIN_H

  const priceLine = points.map((p) => `${x(p.time).toFixed(1)},${y(p.price).toFixed(1)}`).join(' ')
  const avgLine = points.map((p) => `${x(p.time).toFixed(1)},${y(p.avg).toFixed(1)}`).join(' ')
  const maxVol = Math.max(...points.map((p) => p.volume), 1)
  const barW = Math.max(2, PLOT_W / 48 - 1.2)
  const volBars = points
    .map((p) => {
      const h = (p.volume / maxVol) * (VOL_H - 6)
      return `<rect x="${(x(p.time) - barW / 2).toFixed(1)}" y="${(VOL_TOP + VOL_H - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${p.up ? UP : DOWN}" opacity="0.85"/>`
    })
    .join('')

  const gridV = [0, 0.25, 0.5, 0.75, 1]
    .map((r) => `<line x1="${(PAD_L + r * PLOT_W).toFixed(1)}" y1="${MAIN_TOP}" x2="${(PAD_L + r * PLOT_W).toFixed(1)}" y2="${MAIN_BOTTOM}" stroke="${GRID}" stroke-dasharray="3 4"/>`)
    .join('')
  const midY = MAIN_TOP + MAIN_H / 2

  const labels = [
    { y: MAIN_TOP + 11, price: upper, pct: boundPct, cls: 'up' },
    { y: midY + 3.5, price: prevClose, pct: 0, cls: 'flat' },
    { y: MAIN_BOTTOM - 3, price: lower, pct: -boundPct, cls: 'down' },
  ]
  const priceLabels = labels
    .map((l) => `<text x="${PAD_L + 3}" y="${l.y}" class="id-axis ${l.cls}">${l.price.toFixed(2)}</text>`)
    .join('')
  const pctLabels = labels
    .map((l) => `<text x="${W - PAD_R + 5}" y="${l.y}" class="id-axis ${l.cls}">${l.pct >= 0 ? '+' : ''}${l.pct.toFixed(2)}%</text>`)
    .join('')

  const last = points[points.length - 1]
  const lastX = x(last.time)
  const lastY = y(last.price)
  const pctNow = (last.price / prevClose - 1) * 100
  const nowCls = pctNow >= 0 ? 'up' : 'down'

  return `<div class="intraday">
    <svg viewBox="0 0 ${W} ${VOL_TOP + VOL_H + 20}" preserveAspectRatio="none" role="img" aria-label="当日分时走势">
      <line x1="${PAD_L}" y1="${MAIN_TOP}" x2="${PAD_L + PLOT_W}" y2="${MAIN_TOP}" stroke="${GRID}" stroke-dasharray="3 4"/>
      <line x1="${PAD_L}" y1="${MAIN_BOTTOM}" x2="${PAD_L + PLOT_W}" y2="${MAIN_BOTTOM}" stroke="${GRID}" stroke-dasharray="3 4"/>
      <line x1="${PAD_L}" y1="${midY}" x2="${PAD_L + PLOT_W}" y2="${midY}" stroke="rgba(255,255,255,0.22)" stroke-dasharray="4 4"/>
      ${gridV}
      <polyline points="${priceLine}" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linejoin="round"/>
      <polyline points="${avgLine}" fill="none" stroke="${YELLOW}" stroke-width="1.2" stroke-linejoin="round"/>
      <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="2.6" fill="${WHITE}"/>
      ${priceLabels}${pctLabels}
      <text x="${PAD_L + 3}" y="${VOL_TOP - 4}" class="id-axis dim">分时量</text>
      <text x="${W - PAD_R + 5}" y="${VOL_TOP - 4}" class="id-axis ${nowCls}">${pctNow >= 0 ? '+' : ''}${pctNow.toFixed(2)}%</text>
      ${volBars}
      <text x="${PAD_L + 3}" y="${VOL_TOP + VOL_H + 14}" class="id-axis dim">09:30</text>
      <text x="${PAD_L + PLOT_W / 2}" y="${VOL_TOP + VOL_H + 14}" class="id-axis dim" text-anchor="middle">11:30</text>
      <text x="${PAD_L + PLOT_W}" y="${VOL_TOP + VOL_H + 14}" class="id-axis dim" text-anchor="end">15:00</text>
    </svg>
    <div class="intraday-legend">
      <span><i style="background:${WHITE}"></i>最新 ${last.price.toFixed(2)}</span>
      <span><i style="background:${YELLOW}"></i>均价 ${last.avg.toFixed(2)}</span>
      <span class="${nowCls}">${pctNow >= 0 ? '+' : ''}${pctNow.toFixed(2)}%</span>
      <span class="dim">额 ${fmtAmount(data.amount)}</span>
    </div>
  </div>`
}
