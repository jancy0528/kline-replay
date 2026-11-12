import type { Trade } from '../engine/replay'

const W = 320
const H = 96
const PAD = 6

/** 资金曲线 + 买卖点标记（复盘用，纯 SVG，无依赖）。 */
export function renderCurve(values: number[], trades: Trade[]): string {
  if (values.length === 0) {
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="资金曲线"></svg>`
  }
  // 一局未推进 K 线就结束时会只有一个采样点，补成水平线而不是空白
  const points = values.length === 1 ? [values[0], values[0]] : values
  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = max - min || 1
  const x = (i: number): number => PAD + (i / (points.length - 1)) * (W - 2 * PAD)
  const y = (v: number): number => H - PAD - ((v - min) / span) * (H - 2 * PAD)

  const line = points
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join(' ')
  const area = `${line} L${x(points.length - 1).toFixed(1)},${H - PAD} L${x(0).toFixed(1)},${H - PAD} Z`

  const marks = trades
    .map((trade) => {
      const i = Math.min(Math.max(trade.index, 0), points.length - 1)
      const color = trade.side === 'buy' ? '#f0a04b' : '#6ea8fe'
      return `<circle cx="${x(i).toFixed(1)}" cy="${y(points[i]).toFixed(1)}" r="3" fill="${color}" />`
    })
    .join('')

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="资金曲线与买卖点">
  <path d="${area}" fill="rgba(110,168,254,0.10)" />
  <path d="${line}" fill="none" stroke="#6ea8fe" stroke-width="1.6" stroke-linejoin="round" />
  ${marks}
</svg>`
}
