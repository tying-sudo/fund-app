import { Capacitor, registerPlugin } from '@capacitor/core'

interface JdFundPlugin {
  openFundDetail(options: { code: string }): Promise<{ opened: 'jd-finance' }>
  openFundTrade(options: { code: string, action: JdFundTradeAction, itemId?: string }): Promise<{ opened: 'jd-finance' }>
}

const JdFund = registerPlugin<JdFundPlugin>('JdFund')

export type JdFundTradeAction = 'buy' | 'sell' | 'convert'

// JD Finance fund codes and trade product IDs normally share the 1 + code
// pattern. These captured exceptions must stay explicit rather than inferred.
const jdBuyItemIdOverrides: Readonly<Record<string, string>> = {
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

export function resolveJdFundBuyItemId(code: string): string {
  const normalized = normalizeFundCode(code)
  return jdBuyItemIdOverrides[normalized] ?? `1${normalized}`
}

export function buildJdFundTradeUrl(code: string, action: JdFundTradeAction): string {
  const normalized = normalizeFundCode(code)
  if (action === 'buy') {
    return `https://lc.jr.jd.com/finance/fund/fundtrade/index/?source=app&itemId=${resolveJdFundBuyItemId(normalized)}&version=3&fundUtmSource=310&fundUtmParam=add_jjccxq&fromJumpType=2&createOrdermaket=310`
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
    const options = action === 'buy'
      ? { code: normalized, action, itemId: resolveJdFundBuyItemId(normalized) }
      : { code: normalized, action }
    await JdFund.openFundTrade(options)
    return
  }
  window.location.assign(buildJdFundTradeScheme(normalized, action))
}
