/**
 * 当前这一局的本机存档：刷新、重开浏览器、PWA 被系统回收后继续练。
 *
 * 边界：
 * - 只存账户/游标/成交/条件单等状态，不存行情；行情由对局包按 dataFile 还原。
 * - dataFile 带内容 hash，数据包一旦重生成，旧存档整体作废，避免游标错位。
 * - 与训练记录（records.v1）完全分开，复盘记录照旧只写一次。
 */
import type { Game } from '../data/segments'
import type { EngineSnapshot } from './replay'

export const SESSION_STATE_KEY = 'kline-replay.session.v1'
const VERSION = 1

export interface SavedSession {
  v: number
  dataFile: string
  game: Game
  engine: EngineSnapshot
  /** 刷新前停在复盘页；恢复时用 engine.finish() 重建结果，不重复写记录 */
  review: boolean
  /** 走完 150 天的自动总结只弹一次，刷新后不再弹 */
  endSummaryShown: boolean
  savedAt: number
}

export function loadSavedSession(dataFile: string): SavedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_STATE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<SavedSession> | null
    if (!parsed || parsed.v !== VERSION || parsed.dataFile !== dataFile) return null
    if (!parsed.game || typeof parsed.game.c !== 'string') return null
    if (!parsed.engine || typeof parsed.engine.now !== 'number') return null
    return parsed as SavedSession
  } catch {
    return null
  }
}

export function saveSession(
  input: Omit<SavedSession, 'v' | 'savedAt'>,
): void {
  try {
    const payload: SavedSession = { v: VERSION, savedAt: Date.now(), ...input }
    localStorage.setItem(SESSION_STATE_KEY, JSON.stringify(payload))
  } catch {
    // 隐私模式、配额满：不影响训练，只是下次刷新不能续局
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_STATE_KEY)
  } catch {
    // ignore
  }
}
