/**
 * 训练记录的远程备份：GitHub Contents API + 细粒度 PAT。
 *
 * 设计边界：
 * - 本机 localStorage 永远是第一落点，断网照常训练，同步失败只是排队。
 * - token 只存在这台手机的浏览器存储里，不进代码、不进仓库、不上传。
 * - 云端文件与手动导出的 JSON 同格式，可直接当备份导入。
 * - 合并按记录 id 去重，只增不删；sha 做乐观锁，409 冲突自动重试一次。
 */
import {
  buildBackup,
  loadRecords,
  mergeRecords,
  parseBackup,
  replaceRecords,
  type StoredRecord,
} from './records'

const KEY = 'kline-replay.sync.v1'
const STATUS_KEY = 'kline-replay.sync.status.v1'

export const DEFAULT_PATH = 'records/kline-replay.json'

export interface SyncConfig {
  owner: string
  repo: string
  path: string
  token: string
  branch?: string
}

export interface SyncStatus {
  lastAt: number | null
  pending: boolean
  lastError?: string
}

export type SyncMode = 'push' | 'restore'

export interface SyncResult {
  ok: boolean
  mode: SyncMode
  message: string
  added: number
  uploaded: boolean
}

class ConflictError extends Error {}

export function loadSyncConfig(): SyncConfig | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const cfg = JSON.parse(raw) as Partial<SyncConfig>
    if (!cfg.owner || !cfg.repo || !cfg.token) return null
    return {
      owner: cfg.owner,
      repo: cfg.repo,
      token: cfg.token,
      path: cfg.path || DEFAULT_PATH,
      branch: cfg.branch || undefined,
    }
  } catch {
    return null
  }
}

export function saveSyncConfig(cfg: SyncConfig): void {
  localStorage.setItem(
    KEY,
    JSON.stringify({
      owner: cfg.owner.trim(),
      repo: cfg.repo.trim(),
      token: cfg.token.trim(),
      path: (cfg.path || DEFAULT_PATH).trim().replace(/^\/+/, ''),
      branch: cfg.branch?.trim() || undefined,
    }),
  )
}

export function clearSyncConfig(): void {
  localStorage.removeItem(KEY)
  localStorage.removeItem(STATUS_KEY)
}

export function loadSyncStatus(): SyncStatus {
  try {
    const raw = localStorage.getItem(STATUS_KEY)
    if (!raw) return { lastAt: null, pending: false }
    return JSON.parse(raw) as SyncStatus
  } catch {
    return { lastAt: null, pending: false }
  }
}

function saveStatus(status: SyncStatus): void {
  try {
    localStorage.setItem(STATUS_KEY, JSON.stringify(status))
  } catch {
    // ignore
  }
}

function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decodeBase64(base64: string): string {
  const binary = atob(base64.replace(/\s/g, ''))
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function apiUrl(cfg: SyncConfig): string {
  const path = cfg.path
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
  return `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${path}`
}

function headers(cfg: SyncConfig): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${cfg.token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  }
}

interface RemoteSnapshot {
  sha: string | null
  records: StoredRecord[]
}

async function readRemote(cfg: SyncConfig): Promise<RemoteSnapshot> {
  const url = apiUrl(cfg) + (cfg.branch ? `?ref=${encodeURIComponent(cfg.branch)}` : '')
  const res = await fetch(url, { headers: headers(cfg), cache: 'no-store' })
  if (res.status === 404) return { sha: null, records: [] }
  if (res.status === 401 || res.status === 403) {
    throw new Error('凭证无效或权限不足（HTTP ' + res.status + '）')
  }
  if (!res.ok) throw new Error(`读取云端失败：HTTP ${res.status}`)
  const data = (await res.json()) as { content?: string; sha?: string }
  if (!data.content) return { sha: data.sha ?? null, records: [] }
  let records: StoredRecord[] = []
  try {
    records = parseBackup(decodeBase64(data.content))
  } catch {
    // 云端文件内容损坏时不覆盖本地，按空处理并让本轮上传修复它
  }
  return { sha: data.sha ?? null, records }
}

async function writeRemote(
  cfg: SyncConfig,
  records: StoredRecord[],
  sha: string | null,
): Promise<void> {
  const body: Record<string, string> = {
    message: `chore: sync kline-replay records (${records.length})`,
    content: encodeBase64(JSON.stringify(buildBackup(records), null, 2)),
  }
  if (sha) body.sha = sha
  if (cfg.branch) body.branch = cfg.branch

  const res = await fetch(apiUrl(cfg), {
    method: 'PUT',
    headers: headers(cfg),
    body: JSON.stringify(body),
  })
  if (res.status === 409) throw new ConflictError('云端同时被其他设备更新')
  if (!res.ok) {
    let detail = ''
    try {
      detail = ((await res.json()) as { message?: string }).message ?? ''
    } catch {
      // ignore
    }
    throw new Error(`写入云端失败：HTTP ${res.status}${detail ? ` · ${detail}` : ''}`)
  }
}

function fail(err: unknown): SyncResult {
  const reason = err instanceof Error ? err.message : '网络不可用'
  saveStatus({ ...loadSyncStatus(), pending: true, lastError: reason })
  return { ok: false, mode: 'push', message: reason, added: 0, uploaded: false }
}

/** 立即同步。mode='restore' 只把云端记录合并回本机，不写入云端。 */
export async function syncNow(cfg: SyncConfig, mode: SyncMode = 'push'): Promise<SyncResult> {
  try {
    const remote = await readRemote(cfg)
    const merged = mergeRecords(loadRecords(), remote.records)
    // 恢复只合并、不删本地；正常同步也顺手把云端独有的记录带回来
    if (merged.added > 0 || mode === 'restore') replaceRecords(merged.list)

    if (mode === 'restore') {
      saveStatus({ lastAt: Date.now(), pending: false })
      return {
        ok: true,
        mode,
        message: merged.added > 0 ? `已从云端恢复 ${merged.added} 条` : '云端没有新记录',
        added: merged.added,
        uploaded: false,
      }
    }

    const remoteIds = new Set(remote.records.map((item) => item.id))
    const needsUpload = remote.sha === null || merged.list.some((item) => !remoteIds.has(item.id))
    if (needsUpload) {
      try {
        await writeRemote(cfg, merged.list, remote.sha)
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err
        // 乐观锁冲突：重拉一次重新合并再写，避免覆盖别的设备刚写的记录
        const fresh = await readRemote(cfg)
        const again = mergeRecords(loadRecords(), fresh.records)
        replaceRecords(again.list)
        await writeRemote(cfg, again.list, fresh.sha)
      }
    }
    saveStatus({ lastAt: Date.now(), pending: false })
    return {
      ok: true,
      mode,
      message: needsUpload ? `已同步 ${merged.list.length} 条到云端` : '云端已是最新',
      added: merged.added,
      uploaded: needsUpload,
    }
  } catch (err) {
    return fail(err)
  }
}

let autoTimer = 0

/** 记录落盘后延迟触发一次，失败会标记 pending，联网后自动重试。 */
export function queueAutoSync(onDone?: (result: SyncResult) => void): void {
  const cfg = loadSyncConfig()
  if (!cfg) return
  window.clearTimeout(autoTimer)
  autoTimer = window.setTimeout(() => {
    void syncNow(cfg).then((result) => onDone?.(result))
  }, 1200)
}

export function startAutoSync(onDone?: (result: SyncResult) => void): void {
  window.addEventListener('online', () => queueAutoSync(onDone))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && loadSyncStatus().pending) {
      queueAutoSync(onDone)
    }
  })
  if (navigator.onLine && loadSyncStatus().pending) queueAutoSync(onDone)
}

/** 供设置页展示，避免把完整 token 渲染到 DOM。 */
export function maskToken(token: string): string {
  if (token.length <= 8) return '••••'
  return `${token.slice(0, 4)}••••${token.slice(-4)}`
}
