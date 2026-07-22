export type GridTradeDirection = 'buy' | 'sell'

export interface GridConversionTransferIn {
  amount: number
  targetShares: number
}

export interface GridTradeSemanticItem {
  type: GridTradeDirection
  operation?: string
  source_fund_name?: string
  target_fund_name?: string
  source_fund_code?: string
  target_fund_code?: string
}

function normalizeFundName(value: string | undefined) {
  return String(value || '')
    .replace(/[\s()（）\-]/g, '')
    .replace(/发起式/g, '发起')
    .replace(/[.…]+$/g, '')
    .toLowerCase()
}

function matchesFundName(left: string | undefined, right: string | undefined) {
  const a = normalizeFundName(left)
  const b = normalizeFundName(right)
  if (!a || !b) return false
  if (a === b) return true
  return Math.min(a.length, b.length) >= 8 && (a.startsWith(b) || b.startsWith(a))
}

export function resolveGridTradeDirection(
  item: GridTradeSemanticItem,
  currentFundCode: string,
  currentFundName = '',
  screenshotFundName = ''
): GridTradeDirection {
  if (['transfer_in', 'scheduled_buy', 'buy'].includes(item.operation || '')) return 'buy'
  if (['transfer_out', 'redeem', 'sell'].includes(item.operation || '')) return 'sell'
  if (item.operation !== 'conversion') return item.type

  if (item.target_fund_code && item.target_fund_code === currentFundCode) return 'buy'
  if (item.source_fund_code && item.source_fund_code === currentFundCode) return 'sell'
  const contextName = currentFundName || screenshotFundName
  if (matchesFundName(contextName, item.target_fund_name)) return 'buy'
  if (matchesFundName(contextName, item.source_fund_name)) return 'sell'
  return item.type
}

function normalizedTime(value: string | undefined) {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(value || '').trim())
  if (!match) return ''
  return `${match[1].padStart(2, '0')}:${match[2]}:${match[3] || '00'}`
}

export function resolveGridTradeConfirmationDate(
  orderDate: string,
  orderTime: string | undefined,
  availableNavDates: string[]
) {
  const dates = [...new Set(availableNavDates.filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort()
  const time = normalizedTime(orderTime)
  const beforeCutoff = !time || time < '15:00:00'
  if (beforeCutoff && dates.includes(orderDate)) return orderDate
  return dates.find(date => date > orderDate) || ''
}

export function calculateGridConversionTransferIn(
  sourceShares: number,
  sourceNav: number,
  targetNav: number
): GridConversionTransferIn | null {
  if (![sourceShares, sourceNav, targetNav].every(value => Number.isFinite(value) && value > 0)) return null
  const amount = Number((sourceShares * sourceNav).toFixed(2))
  return {
    amount,
    targetShares: Number((amount / targetNav).toFixed(2))
  }
}
