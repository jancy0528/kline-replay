import type { PeriodKey } from '../data/segments'
import type { SessionResult } from './replay'

export const STORAGE_KEY = 'kline-replay.records.v1'
const KEY = STORAGE_KEY

export interface StoredRecord {
  id: string
  code: string
  /** 旧版本记录没有这两个字段，读取时按「日线」兜底。 */
  period?: PeriodKey
  periodLabel?: string
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
    period: r.period,
    periodLabel: r.periodLabel,
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

/** 供云端同步合并后整体写回；不删除任何一条传入的记录。 */
export function replaceRecords(list: StoredRecord[]): void {
  const sorted = list
    .filter((item) => !!item && typeof item.id === 'string')
    .sort((a, b) => b.playedAt - a.playedAt)
    .slice(0, 500)
  try {
    localStorage.setItem(KEY, JSON.stringify(sorted))
  } catch {
    // 配额满或被系统清理时静默失败，导出仍可用
  }
}

export function clearRecords(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // ignore
  }
}

export interface BackupPayload {
  app: 'kline-replay'
  version: number
  exportedAt: string
  records: StoredRecord[]
}

/** 手动导出与云端快照共用同一格式，云端文件可直接当备份导入。 */
export function buildBackup(records: StoredRecord[]): BackupPayload {
  return {
    app: 'kline-replay',
    version: 2,
    exportedAt: new Date().toISOString(),
    records,
  }
}

export function parseBackup(text: string): StoredRecord[] {
  const parsed: unknown = JSON.parse(text)
  const raw: unknown = Array.isArray(parsed)
    ? parsed
    : (parsed as { records?: unknown }).records
  if (!Array.isArray(raw)) throw new Error('文件格式不对')
  return raw.filter(
    (item): item is StoredRecord =>
      !!item && typeof item === 'object' &&
      typeof (item as StoredRecord).id === 'string' &&
      typeof (item as StoredRecord).playedAt === 'number',
  )
}

/** 按 id 去重合并，本地记录优先；返回合并结果与新增条数。 */
export function mergeRecords(
  local: StoredRecord[],
  incoming: StoredRecord[],
): { list: StoredRecord[]; added: number } {
  const known = new Set(local.map((item) => item.id))
  const list = local.slice()
  let added = 0
  for (const item of incoming) {
    if (!known.has(item.id)) {
      list.push(item)
      known.add(item.id)
      added += 1
    }
  }
  list.sort((a, b) => b.playedAt - a.playedAt)
  return { list: list.slice(0, 500), added }
}

export async function exportRecords(): Promise<'shared' | 'downloaded'> {
  const payload = buildBackup(loadRecords())
  const name = `kline-replay-${new Date().toISOString().slice(0, 10)}.json`
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const file = new File([blob], name, { type: 'application/json' })
  const nav = navigator as Navigator & {
    canShare?: (data: { files: File[] }) => boolean
    share?: (data: { files: File[]; title?: string }) => Promise<void>
  }
  if (nav.canShare?.({ files: [file] }) && nav.share) {
    try {
      await nav.share({ files: [file], title: 'K线回放训练记录' })
      return 'shared'
    } catch {
      // 分享面板不可用或用户取消时，降级成直接下载，保证备份一定能拿到
    }
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
  const incoming = parseBackup(await file.text())
  const { list, added } = mergeRecords(loadRecords(), incoming)
  replaceRecords(list)
  return added
}
