/** 离线对局包：一局同时携带日线与 5 分钟线，切换时间窗口只是换视图。 */

/** 四个时间窗口，全部是同一局、同一只股票、同一个时间游标。 */
export type PeriodKey = 'm5' | 'day' | 'week' | 'month'

/** Bar = [时间标签, 开, 高, 低, 收, 量]；训练时标签不对外展示。 */
export type Bar = [string, number, number, number, number, number]

/** 静态股本/市值快照（腾讯行情截面反推），用于顶部「市值/流通/额/换」。 */
export interface Fundamentals {
  name: string
  price: number
  floatShares: number
  totalShares: number
  floatMvYi: number
  totalMvYi: number
  pe: number
  turnPct: number
  amountWan: number
}

export interface WindowMeta {
  key: PeriodKey
  label: string
  visible: number
  advance: number
  note: string
}

/**
 * 同一只标的的两套 K 线（周/月 K 由日线在运行时聚合，不额外占体积）。
 * day 从 2015 年起完整保留，训练时引擎只输出「日期 < 当前日」的 K，
 * 当日 K 由 m5 合成，不泄露未来。
 */
export interface SymbolData {
  day: Bar[]
  m5: Bar[]
  fundamentals?: Fundamentals
}

/** 一局 = 某只标的 + 5 分钟序列上的起止游标；signal 是这局要覆盖的信号日。 */
export interface Game {
  c: string
  s: number
  e: number
  signal?: string
}

export interface SessionPackage {
  version: number
  windows: WindowMeta[]
  symbols: Record<string, SymbolData>
  games: Game[]
}

export interface DataManifest {
  version: number
  generatedAt: string
  source: string
  adjust: string
  dataFile: string
  bytes: number
  symbols: number
  games: number
  /** 完整日线总根数，仅用于展示/校验，前端不依赖它做逻辑 */
  historyBars?: number
  /** 选股命中数与信号日数，只用于展示 */
  selection?: { symbols: number; signals: number; scanned: number }
  windows: WindowMeta[]
}

const BASE = import.meta.env.BASE_URL
let manifestPromise: Promise<DataManifest> | null = null
let sessionsPromise: Promise<SessionPackage> | null = null

async function getJSON<T>(url: string, cache: RequestCache): Promise<T> {
  const res = await fetch(url, { cache })
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return (await res.json()) as T
}

/** manifest 走 no-store：数据重生成后能立刻拿到新的带 hash 文件名。 */
export function loadManifest(): Promise<DataManifest> {
  if (!manifestPromise) {
    manifestPromise = getJSON<DataManifest>(`${BASE}data/manifest.json`, 'no-store').catch(
      (err) => {
        manifestPromise = null
        throw err
      },
    )
  }
  return manifestPromise
}

/** 对局包文件名带内容 hash，交给 Service Worker 长期缓存即可。 */
export function loadSessions(manifest: DataManifest): Promise<SessionPackage> {
  if (!sessionsPromise) {
    sessionsPromise = getJSON<SessionPackage>(
      `${BASE}data/${manifest.dataFile}`,
      'force-cache',
    ).catch((err) => {
      sessionsPromise = null
      throw err
    })
  }
  return sessionsPromise
}

export function pickGame(pkg: SessionPackage): Game {
  if (!pkg.games.length) throw new Error('对局包为空')
  return pkg.games[Math.floor(Math.random() * pkg.games.length)]
}

export function windowMeta(pkg: SessionPackage, key: PeriodKey): WindowMeta {
  const meta = pkg.windows.find((w) => w.key === key)
  if (!meta) throw new Error(`未知时间窗口：${key}`)
  return meta
}
