import type { NetValueRecord } from '@/types/fund'

const BEIJING_TIME_ZONE = 'Asia/Shanghai'

function formatParts(date: Date): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: BEIJING_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    })
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  )
}

export function getBeijingDateString(date = new Date()): string {
  const parts = formatParts(date)
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function getBeijingDayAndMinutes(date = new Date()): { day: number; minutes: number } {
  const parts = formatParts(date)
  const day = new Date(`${getBeijingDateString(date)}T00:00:00Z`).getUTCDay()
  return {
    day,
    minutes: Number(parts.hour) * 60 + Number(parts.minute)
  }
}

export function addCalendarDays(dateString: string, days: number): string {
  const value = new Date(`${dateString}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

function isWeekdayDate(dateString: string): boolean {
  const day = new Date(`${dateString}T00:00:00Z`).getUTCDay()
  return day >= 1 && day <= 5
}

/**
 * Advance by weekday sessions. This supplies the earliest retry/display date;
 * an actual published NAV or JD terminal status still decides confirmation, so
 * public holidays are naturally deferred instead of being guessed here.
 */
export function addWeekdayTradingDays(dateString: string, sessions: number): string {
  let date = dateString
  let remaining = Math.max(0, Math.trunc(sessions))
  for (let attempts = 0; remaining > 0 && attempts < 370; attempts++) {
    date = addCalendarDays(date, 1)
    if (isWeekdayDate(date)) remaining--
  }
  return date
}

export function getTradeTimeSlot(tradeTime: string | undefined): 'before' | 'after' {
  const match = /(?:^|[ T])(\d{1,2}):(\d{2})(?::\d{2})?$/.exec((tradeTime || '').trim())
  // Missing capture time must not make an order eligible one session early.
  if (!match) return 'after'
  return Number(match[1]) * 60 + Number(match[2]) >= 15 * 60 ? 'after' : 'before'
}

export function getSettlementNavStartDate(tradeDate: string, timeSlot: 'before' | 'after'): string {
  // Pricing and confirmation are different: before-close orders use T-day NAV;
  // post-close orders use the first published NAV after T.
  return addCalendarDays(tradeDate, timeSlot === 'before' ? 0 : 1)
}

export function getAdjustmentConfirmationDate(tradeDate: string, timeSlot: 'before' | 'after'): string {
  const pricingDate = timeSlot === 'before' && isWeekdayDate(tradeDate)
    ? tradeDate
    : addWeekdayTradingDays(tradeDate, 1)
  return addWeekdayTradingDays(pricingDate, 1)
}

export function getAdjustmentConfirmationAt(tradeDate: string, timeSlot: 'before' | 'after'): number {
  const confirmationDate = getAdjustmentConfirmationDate(tradeDate, timeSlot)
  return Date.parse(`${confirmationDate}T13:00:00+08:00`)
}

/**
 * A stale prior NAV is still useful after a long holiday when today's live
 * quote proves the next real confirmation session has opened.
 */
export function shouldAttemptAdjustmentSettlement(
  realNavDate?: string | null,
  confirmationSessionDate?: string | null
): boolean {
  return Boolean(realNavDate || confirmationSessionDate)
}

export function findSettlementNav(
  history: NetValueRecord[],
  startDate: string,
  latestKnownDate: string
): NetValueRecord | null {
  return history
    .filter((record) => record.date >= startDate && record.date <= latestKnownDate && record.netValue > 0)
    .sort((a, b) => a.date.localeCompare(b.date))[0] || null
}

/**
 * Resolve the pricing NAV only after the first/second confirmation session is
 * evidenced by published history. Before 15:00 prices at T; at/after 15:00
 * prices at the first session after T. Missing holiday NAVs defer confirmation.
 */
export function findAdjustmentSettlementNav(
  history: NetValueRecord[],
  tradeDate: string,
  timeSlot: 'before' | 'after',
  latestKnownDate: string,
  confirmation?: {
    /** A live same-day quote proves this date is an actual market session. */
    sessionDate?: string | null
    now?: Date
  }
): NetValueRecord | null {
  const records = history
    .filter((record) => record.date >= tradeDate
      && record.date <= latestKnownDate
      && record.netValue > 0
      && isWeekdayDate(record.date))
    .sort((a, b) => a.date.localeCompare(b.date))
    .filter((record, index, sorted) => index === 0 || record.date !== sorted[index - 1].date)
  const pricingRecord = timeSlot === 'before'
    ? records.find((record) => record.date >= tradeDate) || null
    : records.find((record) => record.date > tradeDate) || null
  if (!pricingRecord) return null
  // A later published NAV is definitive evidence that the confirmation
  // session has passed, even when this check runs after market close.
  if (records.some((record) => record.date > pricingRecord.date)) return pricingRecord

  // At 13:00 the confirmation session's NAV is not published yet. A current
  // intraday quote supplies session evidence without guessing public holidays.
  const sessionDate = confirmation?.sessionDate || ''
  if (sessionDate <= pricingRecord.date) return null
  const confirmationAt = Date.parse(`${sessionDate}T13:00:00+08:00`)
  const now = confirmation?.now?.getTime() ?? Date.now()
  return Number.isFinite(confirmationAt) && now >= confirmationAt ? pricingRecord : null
}

export function calculateSubscriptionShares(amount: number, fee: number, settlementNav: number): number {
  if (amount <= 0 || settlementNav <= 0 || fee < 0 || fee >= amount) return 0
  return (amount - fee) / settlementNav
}

export function getCalendarDayDifference(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00Z`)
  const end = Date.parse(`${endDate}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0
  return Math.max(0, Math.floor((end - start) / 86_400_000))
}
