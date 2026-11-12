/** 离线训练片段包：每个周期一个 JSON，运行时按需 fetch，不进 JS 主包。 */

export type PeriodKey = 'm5' | 'm30' | 'm60' | 'day' | 'week' | 'month'

/** Bar = [时间标签, 开, 高, 低, 收, 量]；训练时标签不对外展示。 */
export type Bar = [string, number, number, number, number, number]

export interface Segment {
  c: string
  s: string
  e: string
  b: Bar[]
}

export interface PeriodMeta {
  key: PeriodKey
  label: string
  file: string | null
  visible: number
  max: number
  segments: number
  bytes: number
  note: string
}

export interface DataManifest {
  version: number
  generatedAt: string
  source: string
  adjust: string
  periods: PeriodMeta[]
}

export interface SegmentPackage {
  period: PeriodKey
  label: string
  visible: number
  max: number
  segments: Segment[]
}

const BASE = import.meta.env.BASE_URL
let manifestPromise: Promise<DataManifest> | null = null
const packagePromises = new Map<string, Promise<SegmentPackage>>()

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

/** 片段包文件名带内容 hash，交给 Service Worker 长期缓存即可。 */
export function loadPackage(meta: PeriodMeta): Promise<SegmentPackage> {
  if (!meta.file) throw new Error(`${meta.label} 暂无数据`)
  let pending = packagePromises.get(meta.key)
  if (!pending) {
    pending = getJSON<SegmentPackage>(`${BASE}data/${meta.file}`, 'force-cache').catch(
      (err) => {
        packagePromises.delete(meta.key)
        throw err
      },
    )
    packagePromises.set(meta.key, pending)
  }
  return pending
}

export function pickSegment(pkg: SegmentPackage): Segment {
  const list = pkg.segments
  if (!list.length) throw new Error('片段包为空')
  return list[Math.floor(Math.random() * list.length)]
}
