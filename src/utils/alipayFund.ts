import { Capacitor, registerPlugin } from '@capacitor/core'

const ALIPAY_FUND_APP_ID = '20000793'
const ALIPAY_FUND_DETAIL_BASE_URL = `https://${ALIPAY_FUND_APP_ID}.h5app.alipay.com/www/detail.html`

interface AlipayFundPlugin {
  openFundDetail(options: { code: string }): Promise<{ opened: 'alipay' | 'web' }>
}

const AlipayFund = registerPlugin<AlipayFundPlugin>('AlipayFund')

function normalizeFundCode(code: string): string {
  const normalized = code.trim()
  if (!/^\d{6}$/.test(normalized)) throw new Error('Fund code must be six digits')
  return normalized
}

export function buildAlipayFundDetailUrl(code: string): string {
  return `${ALIPAY_FUND_DETAIL_BASE_URL}?fundCode=${encodeURIComponent(normalizeFundCode(code))}`
}

export function buildAlipayFundScheme(code: string): string {
  const detailUrl = buildAlipayFundDetailUrl(code)
  return `alipays://platformapi/startapp?appId=${ALIPAY_FUND_APP_ID}`
    + `&pullRefresh=NO&appClearTop=false&startMultApp=YES&url=${encodeURIComponent(detailUrl)}`
}

function openWebFallback(detailUrl: string) {
  const opened = window.open(detailUrl, '_blank')
  if (opened) opened.opener = null
  else window.location.assign(detailUrl)
}

export async function openAlipayFundDetail(code: string): Promise<void> {
  const normalizedCode = normalizeFundCode(code)
  const detailUrl = buildAlipayFundDetailUrl(normalizedCode)

  if (Capacitor.getPlatform() === 'android') {
    try {
      await AlipayFund.openFundDetail({ code: normalizedCode })
      return
    } catch (error) {
      console.warn('[AlipayFund] Native launch failed, opening the web detail page:', error)
      openWebFallback(detailUrl)
      return
    }
  }

  if (Capacitor.isNativePlatform()) {
    window.location.assign(buildAlipayFundScheme(normalizedCode))
    return
  }

  openWebFallback(detailUrl)
}
