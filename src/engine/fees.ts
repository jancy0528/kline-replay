/**
 * 交易费用模型：用户券商费率 + 2026 年现行税费规则。
 *
 * 券商佣金（买卖双向、单笔不足最低按最低收）：
 *   股票 万 2.85 / 封闭式基金 万 3 / 沪深场内基金 万 3，最低 ¥5。
 *   按「全佣」处理，即报价已含经手费 + 证管费，不再叠加规费。
 * 印花税：仅卖出股票按成交额万 5 单边征收；ETF / 场内基金 / 封基免征。
 * 过户费：中国结算，沪深统一按成交额万 0.1 双向收取；基金份额不收。
 *
 * 依据：证券交易印花税自 2023-08 起减半为 0.05% 单边；中国结算自 2022-04
 * 起沪深过户费统一为成交金额 0.001%。费率可在本机「记录 → 费率设置」覆盖。
 */

export type InstrumentKind = 'stock' | 'closed_fund' | 'exchange_fund'

export interface InstrumentRule {
  label: string
  /** 佣金率，小数；0.000285 = 万 2.85 */
  commissionRate: number
  /** 单笔最低佣金（元） */
  minCommission: number
  /** 印花税率，仅卖出方向；0 表示免征 */
  stampDutyRate: number
  /** 过户费率，买卖双向；0 表示不收 */
  transferRate: number
}

export interface FeeSchedule {
  stock: InstrumentRule
  closed_fund: InstrumentRule
  exchange_fund: InstrumentRule
}

export const DEFAULT_FEE_SCHEDULE: FeeSchedule = {
  stock: {
    label: '股票',
    commissionRate: 0.000285,
    minCommission: 5,
    stampDutyRate: 0.0005,
    transferRate: 0.00001,
  },
  closed_fund: {
    label: '封闭式基金',
    commissionRate: 0.0003,
    minCommission: 5,
    stampDutyRate: 0,
    transferRate: 0,
  },
  exchange_fund: {
    label: '沪深场内基金',
    commissionRate: 0.0003,
    minCommission: 5,
    stampDutyRate: 0,
    transferRate: 0,
  },
}

export const KIND_LABEL: Record<InstrumentKind, string> = {
  stock: '股票',
  closed_fund: '封基',
  exchange_fund: '场内基金',
}

/** 从代码推断品种，兼容 sh./sz./bj. 前缀与纯 6 位代码。 */
export function classifyInstrument(code: string): InstrumentKind {
  const digits = code.replace(/^[a-zA-Z]+\./, '').replace(/\D/g, '').slice(-6)
  // 老封闭式基金：沪 500xxx、深 184xxx / 180xxx
  if (/^(500|184|180)/.test(digits)) return 'closed_fund'
  // 交易所基金：沪 50x/51x/52x/56x/58x，深 15x/16x/159
  if (/^(50|51|52|56|58|15|16)/.test(digits)) return 'exchange_fund'
  return 'stock'
}

export interface FeeBreakdown {
  commission: number
  stampDuty: number
  transferFee: number
  total: number
}

export const ZERO_FEES: FeeBreakdown = {
  commission: 0,
  stampDuty: 0,
  transferFee: 0,
  total: 0,
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

/** 按分计费：扣款与成交记录共用同一个值，避免现金与明细出现分位误差。 */
export function computeFees(
  amount: number,
  side: 'buy' | 'sell',
  kind: InstrumentKind,
  schedule: FeeSchedule = DEFAULT_FEE_SCHEDULE,
): FeeBreakdown {
  const rule = schedule[kind] ?? schedule.stock
  const commission = round2(Math.max(rule.minCommission, amount * rule.commissionRate))
  const stampDuty = side === 'sell' ? round2(amount * rule.stampDutyRate) : 0
  const transferFee = round2(amount * rule.transferRate)
  return {
    commission,
    stampDuty,
    transferFee,
    total: round2(commission + stampDuty + transferFee),
  }
}

export function addFees(a: FeeBreakdown, b: FeeBreakdown): FeeBreakdown {
  return {
    commission: round2(a.commission + b.commission),
    stampDuty: round2(a.stampDuty + b.stampDuty),
    transferFee: round2(a.transferFee + b.transferFee),
    total: round2(a.total + b.total),
  }
}

/** 小数费率 ↔ 「万分之」，供设置面板使用。 */
export const toWan = (rate: number): number => Math.round(rate * 10000 * 1000) / 1000
export const fromWan = (wan: number): number => wan / 10000

const STORAGE_KEY = 'kline-replay.fees.v1'

const clampRate = (value: unknown, fallback: number): number => {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 && n <= 0.01 ? n : fallback
}

const clampMoney = (value: unknown, fallback: number): number => {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 && n <= 1000 ? n : fallback
}

/** 读取本机覆盖费率；解析失败或数值越界时逐项回退到默认，不让脏数据污染账目。 */
export function loadFeeSchedule(): FeeSchedule {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_FEE_SCHEDULE
    const parsed = JSON.parse(raw) as Partial<Record<InstrumentKind, Partial<InstrumentRule>>>
    const build = (kind: InstrumentKind): InstrumentRule => {
      const base = DEFAULT_FEE_SCHEDULE[kind]
      const override = parsed?.[kind] ?? {}
      return {
        label: base.label,
        commissionRate: clampRate(override.commissionRate, base.commissionRate),
        minCommission: clampMoney(override.minCommission, base.minCommission),
        stampDutyRate: clampRate(override.stampDutyRate, base.stampDutyRate),
        transferRate: clampRate(override.transferRate, base.transferRate),
      }
    }
    return {
      stock: build('stock'),
      closed_fund: build('closed_fund'),
      exchange_fund: build('exchange_fund'),
    }
  } catch {
    return DEFAULT_FEE_SCHEDULE
  }
}

export function saveFeeSchedule(schedule: FeeSchedule): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(schedule))
}

export function resetFeeSchedule(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}

export function hasCustomFees(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null
  } catch {
    return false
  }
}
