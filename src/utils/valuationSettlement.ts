import type { FundEstimate } from '../types/fund.ts'

export interface ValuationSettlement {
  date: string
  estimateChange: number
  realChange: number
  officialNav?: number
  source?: 'grid' | 'native-recovery' | 'local-cache'
}

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' ? value as UnknownRecord : {}
}

function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function normalizeSettlementDate(value: unknown): string {
  const match = String(value || '').trim().match(/^(\d{4})[-/](\d{2})[-/](\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : ''
}

export function parseValuationSettlement(value: unknown): ValuationSettlement | null {
  const data = asRecord(value)
  const date = normalizeSettlementDate(data.date)
  const estimateChange = finiteNumber(data.estimateChange)
  const realChange = finiteNumber(data.realChange)
  const officialNav = finiteNumber(data.officialNav)
  if (!date || estimateChange === undefined || realChange === undefined) return null

  return {
    date,
    estimateChange,
    realChange,
    ...(officialNav !== undefined && officialNav > 0 ? { officialNav } : {}),
    source: data.source as ValuationSettlement['source']
  }
}

export function readNativeOfficialSnapshot(payload: unknown): {
  date: string
  realChange: number
  officialNav: number
} | null {
  const data = asRecord(asRecord(payload).data)
  const profileSnapshot = asRecord(asRecord(data.profile).snapshot)
  const profileDate = normalizeSettlementDate(profileSnapshot.navDate)
  const profileChange = finiteNumber(profileSnapshot.changePercent)
  const profileNav = finiteNumber(profileSnapshot.nav)
  if (profileDate && profileChange !== undefined && profileNav !== undefined && profileNav > 0) {
    return { date: profileDate, realChange: profileChange, officialNav: profileNav }
  }

  const sources = asRecord(data.sources)
  for (const sourceName of ['market_snapshot', 'eastmoney']) {
    const source = asRecord(sources[sourceName])
    const date = normalizeSettlementDate(source.gztime)
    const realChange = finiteNumber(source.gszzl)
    const officialNav = finiteNumber(source.gsz)
    if (date && realChange !== undefined && officialNav !== undefined && officialNav > 0) {
      return { date, realChange, officialNav }
    }
  }
  return null
}

export function recoverNativeValuationSettlement(payload: unknown): ValuationSettlement | null {
  const official = readNativeOfficialSnapshot(payload)
  if (!official) return null

  const sources = asRecord(asRecord(asRecord(payload).data).sources)
  for (const sourceName of ['fundgz', 'holdings_weighted', 'sina_ds2', 'sina_ds3', 'tiantian', 'sina']) {
    const source = asRecord(sources[sourceName])
    if (source.kind === 'official_nav') continue
    const estimateDate = normalizeSettlementDate(source.gztime)
    const estimateChange = finiteNumber(source.gszzl)
    if (estimateDate === official.date && estimateChange !== undefined) {
      return {
        date: official.date,
        estimateChange,
        realChange: official.realChange,
        officialNav: official.officialNav,
        source: 'native-recovery'
      }
    }
  }
  return null
}

export function attachNativeOfficialNav(
  settlement: ValuationSettlement,
  payload: unknown
): ValuationSettlement {
  const official = readNativeOfficialSnapshot(payload)
  return official?.date === settlement.date
    ? { ...settlement, officialNav: official.officialNav }
    : settlement
}

export function shouldApplyValuationSettlement(input: {
  settlementDate: string
  estimateTime?: string | null
  isPreOpen: boolean
}): boolean {
  const settlementDate = normalizeSettlementDate(input.settlementDate)
  const estimateDate = normalizeSettlementDate(input.estimateTime)
  if (!settlementDate) return false
  return input.isPreOpen || !estimateDate || settlementDate >= estimateDate
}

export function buildSettlementEstimate(input: {
  code: string
  name: string
  settlement: ValuationSettlement
  officialNav?: number | null
}): { estimate: FundEstimate; officialNav: number } | null {
  const officialNav = finiteNumber(input.officialNav ?? input.settlement.officialNav)
  const realDenominator = 1 + input.settlement.realChange / 100
  if (officialNav === undefined || officialNav <= 0 || realDenominator <= 0) return null

  const baseNav = officialNav / realDenominator
  if (!Number.isFinite(baseNav) || baseNav <= 0) return null

  return {
    officialNav,
    estimate: {
      fundcode: input.code,
      name: input.name,
      dwjz: baseNav.toFixed(4),
      // Settlement rows price the holding at the published NAV. The captured
      // estimate rate is retained only for the estimate/actual comparison.
      gsz: officialNav.toFixed(4),
      gszzl: input.settlement.estimateChange.toFixed(4),
      gztime: `${input.settlement.date} 15:00`,
      source: 'settlement_cache'
    }
  }
}
