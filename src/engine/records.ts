import type { SessionResult } from './replay'

const KEY = 'kline-replay.records.v1'

export interface StoredRecord {
  id: string
  code: string
  startDate: string
  endDate: string
  playedAt: number
  initialCash: number
  finalEquity: number
  score: SessionResult['score']
  trades: SessionResult['trades']
  equityCurve: number[]
}

export function toStored(r: SessionResult): StoredRecord {
  return {
    id: r.id,
    code: r.code,
    startDate: r.startDate,
    endDate: r.endDate,
    playedAt: r.playedAt,
    initialCash: r.initialCash,
    finalEquity: r.finalEquity,
    score: r.score,
    trades: r.trades,
    equityCurve: r.equityCurve,
  }
}

export function loadRecords(): StoredRecord[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is StoredRecord =>
        !!item && typeof item === 'object' && typeof (item as StoredRecord).id === 'string',
    )
  } catch {
    return []
  }
}

export function saveRecord(record: StoredRecord): void {
  const list = loadRecords().filter((item) => item.id !== record.id)
  list.unshift(record)
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 200)))
  } catch {
    // 存储配额满或被系统清理时静默失败，导出仍可用
  }
}

export function clearRecords(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // ignore
  }
}

export async function exportRecords(): Promise<'shared' | 'downloaded'> {
  const payload = {
    app: 'kline-replay',
    version: 1,
    exportedAt: new Date().toISOString(),
    records: loadRecords(),
  }
  const name = `kline-replay-${new Date().toISOString().slice(0, 10)}.json`
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const file = new File([blob], name, { type: 'application/json' })
  const nav = navigator as Navigator & {
    canShare?: (data: { files: File[] }) => boolean
    share?: (data: { files: File[]; title?: string }) => Promise<void>
  }
  if (nav.canShare?.({ files: [file] }) && nav.share) {
    await nav.share({ files: [file], title: 'K线回放训练记录' })
    return 'shared'
  }
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
  return 'downloaded'
}

export async function importRecords(file: File): Promise<number> {
  const text = await file.text()
  const parsed: unknown = JSON.parse(text)
  const incoming: unknown = Array.isArray(parsed)
    ? parsed
    : (parsed as { records?: unknown }).records
  if (!Array.isArray(incoming)) throw new Error('文件格式不对')

  const list = loadRecords()
  const known = new Set(list.map((item) => item.id))
  let added = 0
  for (const item of incoming) {
    const candidate = item as StoredRecord
    if (candidate && typeof candidate === 'object' && typeof candidate.id === 'string' && !known.has(candidate.id)) {
      list.push(candidate)
      known.add(candidate.id)
      added += 1
    }
  }
  list.sort((a, b) => b.playedAt - a.playedAt)
  localStorage.setItem(KEY, JSON.stringify(list.slice(0, 500)))
  return added
}
