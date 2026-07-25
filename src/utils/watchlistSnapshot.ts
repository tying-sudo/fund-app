import type { FundEstimate } from '@/types/fund'

export interface WatchlistSnapshotInput {
  estimate: FundEstimate
  incomingChange?: number
  incomingDate?: string
  cachedChange?: number
  cachedDate?: string
  cachedOfficialValue?: string
  cachedOfficialValueDate?: string
}

export interface WatchlistSnapshotResult {
  realChange?: number
  realChangeDate?: string
  officialValue?: string
  officialValueDate?: string
}

function normalizeDate(value: unknown): string {
  const match = String(value || '').trim().match(/^(\d{4})[-/](\d{2})[-/](\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : ''
}

function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function positiveValue(value: unknown): string | undefined {
  const parsed = finiteNumber(value)
  return parsed !== undefined && parsed > 0 ? String(value) : undefined
}

export function resolveWatchlistSnapshot(input: WatchlistSnapshotInput): WatchlistSnapshotResult {
  const snapshotDate = input.estimate.source === 'market_snapshot'
    ? normalizeDate(input.estimate.gztime)
    : ''
  const snapshotChange = snapshotDate ? finiteNumber(input.estimate.gszzl) : undefined
  const snapshotValue = snapshotDate ? positiveValue(input.estimate.gsz) : undefined

  const candidates = [
    {
      change: input.cachedChange,
      date: normalizeDate(input.cachedDate),
      priority: 1
    },
    {
      change: input.incomingChange,
      date: normalizeDate(input.incomingDate),
      priority: 2
    },
    {
      change: snapshotChange,
      date: snapshotDate,
      priority: 3
    }
  ].filter(candidate => finiteNumber(candidate.change) !== undefined && candidate.date)

  candidates.sort((left, right) => (
    left.date.localeCompare(right.date) || left.priority - right.priority
  ))
  const latest = candidates[candidates.length - 1]
  const realChange = latest ? finiteNumber(latest.change) : undefined
  const realChangeDate = latest?.date || undefined

  const cachedOfficialDate = normalizeDate(input.cachedOfficialValueDate)
  let officialValue = cachedOfficialDate === realChangeDate
    ? positiveValue(input.cachedOfficialValue)
    : undefined
  let officialValueDate = officialValue ? cachedOfficialDate : undefined

  if (snapshotValue && snapshotDate === realChangeDate) {
    officialValue = snapshotValue
    officialValueDate = snapshotDate
  }

  return { realChange, realChangeDate, officialValue, officialValueDate }
}

export function resolveWatchlistDisplayValue(input: {
  estimateValue?: string
  lastValue?: string
  realChange?: number
  realChangeDate?: string
  officialValue?: string
  officialValueDate?: string
  isCurrentReal: boolean
}): string | undefined {
  if (!input.isCurrentReal || finiteNumber(input.realChange) === undefined) return input.estimateValue

  const officialDate = normalizeDate(input.officialValueDate)
  const realDate = normalizeDate(input.realChangeDate)
  const officialValue = positiveValue(input.officialValue)
  if (officialValue && officialDate && officialDate === realDate) return officialValue

  const lastValue = finiteNumber(input.lastValue)
  if (lastValue !== undefined && lastValue > 0) {
    return (lastValue * (1 + Number(input.realChange) / 100)).toFixed(4)
  }
  return input.estimateValue
}
