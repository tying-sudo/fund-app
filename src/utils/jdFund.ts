import { Capacitor, registerPlugin } from '@capacitor/core'

interface JdFundPlugin {
  openFundDetail(options: { code: string }): Promise<{ opened: 'jd-finance' }>
}

const JdFund = registerPlugin<JdFundPlugin>('JdFund')

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

export async function openJdFundDetail(code: string): Promise<void> {
  const normalized = normalizeFundCode(code)
  if (Capacitor.getPlatform() === 'android') {
    await JdFund.openFundDetail({ code: normalized })
    return
  }
  window.location.assign(buildJdFundScheme(normalized))
}
