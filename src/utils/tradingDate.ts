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

export function getSettlementNavStartDate(tradeDate: string, timeSlot: 'before' | 'after'): string {
  return timeSlot === 'after' ? addCalendarDays(tradeDate, 1) : tradeDate
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
