import { Capacitor, registerPlugin } from '@capacitor/core'

interface JdFundPlugin {
  openFundDetail(options: { code: string }): Promise<{ opened: 'jd-finance' }>
  openFundTrade(options: { code: string, action: JdFundTradeAction }): Promise<{ opened: 'jd-finance' }>
}

const JdFund = registerPlugin<JdFundPlugin>('JdFund')

export type JdFundTradeAction = 'buy' | 'sell' | 'convert'

// Offline fallback only. Android resolves the canonical purchase URL from JD's
// public fund-detail API before opening it, because item IDs are not derivable
// from fund codes.
const capturedJdBuyItemIds: Readonly<Record<string, string>> = {
  '001470': '105457',
  '002112': '105109',
  '010524': '113000',
  '100055': '107138'
}

function normalizeFundCode(code: string): string {
  const normalized = code.trim()
  if (!/^\d{6}$/.test(normalized)) throw new Error('Fund code must be six digits')
  return normalized
}

export function buildJdFundScheme(code: string): string {
  const normalized = normalizeFundCode(code)
  const detailUrl = `https://lc.jr.jd.com/finance/funddetail/home/?fundCode=${normalized}&fundUtmSource=340&fundUtmParam=AppShare`
  return `jdmobile://share?jumpType=7&jumpUrl=${encodeURIComponent(detailUrl)}`
}

export function resolveJdFundBuyItemId(code: string): string | null {
  const normalized = normalizeFundCode(code)
  return capturedJdBuyItemIds[normalized] ?? null
}

export function buildJdFundTradeUrl(code: string, action: JdFundTradeAction): string {
  const normalized = normalizeFundCode(code)
  if (action === 'buy') {
    const itemId = resolveJdFundBuyItemId(normalized)
    if (itemId) {
      return `https://lc.jr.jd.com/finance/fund/fundtrade/index/?source=app&itemId=${itemId}&version=3`
    }
    return `https://lc.jr.jd.com/finance/funddetail/home/?fundCode=${normalized}&fundUtmSource=340&fundUtmParam=AppShare`
  }

  const params = new URLSearchParams({
    fundCode: normalized,
    distinctCode: '1',
    fromJumpType: '2',
    createOrdermaket: '310'
  })
  if (action === 'convert') {
    params.set('curType', 'transfer')
    params.set('hideTabFlag', '1')
  }
  return `https://lc.jr.jd.com/fund/newfundtrade/redeem/?${params.toString()}`
}

export function buildJdFundTradeScheme(code: string, action: JdFundTradeAction): string {
  return `jdmobile://share?jumpType=7&jumpUrl=${encodeURIComponent(buildJdFundTradeUrl(code, action))}`
}

export async function openJdFundDetail(code: string): Promise<void> {
  const normalized = normalizeFundCode(code)
  if (Capacitor.getPlatform() === 'android') {
    await JdFund.openFundDetail({ code: normalized })
    return
  }
  window.location.assign(buildJdFundScheme(normalized))
}

export async function openJdFundTrade(code: string, action: JdFundTradeAction): Promise<void> {
  const normalized = normalizeFundCode(code)
  if (Capacitor.getPlatform() === 'android') {
    await JdFund.openFundTrade({ code: normalized, action })
    return
  }
  window.location.assign(buildJdFundTradeScheme(normalized, action))
}
