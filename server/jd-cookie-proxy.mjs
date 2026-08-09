// These are the verified direct H5 endpoints used by the native compatibility
// reader. The newer `newna` holding endpoints require a JD browser transport
// and may return an incomplete list to a server-side request.
const JD_GROUP_URL = 'https://ms.jr.jd.com/gw/generic/base/h5/m/fundHoldGroup'
const JD_DETAIL_URL = 'https://ms.jr.jd.com/gw/generic/jj/h5/m/getNewFundPositionDetail'
const JD_TRADE_URL = 'https://ms.jr.jd.com/gw2/generic/cfGateway/newna/m/queryTradeOrderList'
const JD_REFERER = 'https://roma.jd.com/'
const MAX_COOKIE_LENGTH = 16_384
const PAGE_SIZE = 20
const MAX_PAGES = 200

function validCookie(value) {
  const cookie = String(value ?? '').trim().replace(/^cookie\s*:\s*/i, '')
  if (cookie.length < 3 || cookie.length > MAX_COOKIE_LENGTH || !cookie.includes('=') || /[\r\n\u0000-\u001f\u007f]/.test(cookie)) return null
  return cookie
}

function messageFor(error) {
  const status = Number(error?.status || 0)
  if (status === 401 || status === 403 || error?.code === 'JD_AUTH') return 'JD_AUTH'
  if (status === 429) return 'JD_RATE_LIMIT'
  return 'JD_IMPORT_FAILED'
}

async function jdPost(url, cookie, request, signal) {
  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      Cookie: cookie,
      Referer: JD_REFERER,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36'
    },
    body: `reqData=${encodeURIComponent(JSON.stringify(request))}`
  })
  const text = await response.text()
  if (response.status === 401 || response.status === 403 || /login|登录|未登录|失效|过期/i.test(text.slice(0, 2000))) {
    const error = new Error('JD authentication failed')
    error.code = 'JD_AUTH'
    error.status = response.status
    throw error
  }
  if (!response.ok) {
    const error = new Error('JD upstream request failed')
    error.status = response.status
    throw error
  }
  try {
    const payload = JSON.parse(text)
    if (payload?.success === false || Number(payload?.resultCode) === 3) {
      const error = new Error('JD authentication failed')
      error.code = 'JD_AUTH'
      throw error
    }
    return payload
  } catch (error) {
    if (error?.code === 'JD_AUTH') throw error
    throw new Error('JD response format invalid')
  }
}

function text(value) {
  const result = String(value ?? '').trim()
  return result || undefined
}

function first(object, keys) {
  for (const key of keys) {
    const value = text(object?.[key])
    if (value) return value
  }
  return ''
}

function fundCode(value) {
  const raw = text(value) || ''
  if (/^\d{6}$/.test(raw)) return raw
  const digits = raw.replace(/\D/g, '')
  return /^1\d{6}$/.test(digits) ? digits.slice(1) : ''
}

/**
 * JD uses several product-id fields across account-trade response variants.
 * Prefer the value which is actually present in the current snapshot; that
 * avoids silently dropping an otherwise valid trade when productId is an
 * internal 7-digit identifier or the source/target fields are reordered.
 */
function resolveTradeFundCode(row, currentCodes, codeByName = new Map(), keys = ['fundCode', 'sellProductId', 'sourceFundCode', 'fromFundCode', 'sourceProductId', 'fromProductId', 'productId', 'productCode', 'fundId'], nameKeys = ['fundName', 'productName', 'sellProductName', 'sourceFundName', 'fromFundName', 'targetProductName', 'targetFundName', 'toFundName']) {
  let fallback = ''
  for (const key of keys) {
    const raw = first(row, [key])
    const normalized = fundCode(raw)
    if (currentCodes.has(normalized)) return normalized
    if (!fallback && /^\d{6}$/.test(normalized)) fallback = normalized
    const digits = raw.replace(/\D/g, '')
    for (let index = 0; index <= digits.length - 6; index++) {
      const candidate = digits.slice(index, index + 6)
      if (currentCodes.has(candidate)) return candidate
    }
  }
  for (const key of nameKeys) {
    const byName = codeByName.get(first(row, [key]))
    if (byName && currentCodes.has(byName)) return byName
  }
  return fallback
}

function dateOf(value) {
  const raw = text(value) || ''
  if (/^\d{10,13}$/.test(raw)) {
    const timestamp = Number(raw) * (raw.length === 10 ? 1000 : 1)
    const date = new Date(timestamp + 8 * 60 * 60 * 1000)
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : ''
  }
  const match = /^(\d{4})[-/.]?(\d{1,2})[-/.]?(\d{1,2})/.exec(raw.replace('T', ' '))
  if (!match) {
    const compact = /^(\d{4})(\d{2})(\d{2})/.exec(raw)
    if (!compact) return ''
    const result = `${compact[1]}-${compact[2]}-${compact[3]}`
    const parsed = new Date(`${result}T00:00:00Z`)
    return parsed.getUTCFullYear() === Number(compact[1]) && parsed.getUTCMonth() + 1 === Number(compact[2]) && parsed.getUTCDate() === Number(compact[3]) ? result : ''
  }
  const result = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
  const parsed = new Date(`${result}T00:00:00Z`)
  return parsed.getUTCFullYear() === Number(match[1]) && parsed.getUTCMonth() + 1 === Number(match[2]) && parsed.getUTCDate() === Number(match[3]) ? result : ''
}

function timestampOf(value) {
  const date = dateOf(value)
  if (!date) return undefined
  const raw = String(value ?? '').replace('T', ' ')
  const time = /(\d{2}:\d{2})(?::(\d{2}))?/.exec(raw)
  return time ? `${date} ${time[1]}${time[2] ? `:${time[2]}` : ''}` : undefined
}

function numberLike(value) {
  return /[+-]?(?:\d+(?:\.\d+)?|\.\d+)/.exec(String(value ?? '').replace(/,/g, ''))?.[0] || ''
}

function labeled(values, label) {
  return (Array.isArray(values) ? values : []).find(value => String(value?.title1 || '').trim() === label)?.title2 || ''
}

function findAcquiredDate(value, depth = 0) {
  if (!value || depth > 8) return ''
  if (Array.isArray(value)) return value.map(item => findAcquiredDate(item, depth + 1)).find(Boolean) || ''
  if (typeof value !== 'object') return ''
  const labels = ['首次买入日期', '首次购买日期', '首次申购日期', '首购日期', '建仓日期', '持有起始日期', '持有开始日期']
  if (labels.includes(String(value.title1 || '').trim())) return dateOf(value.title2)
  for (const key of ['acquiredDate', 'acquiredTime', 'holdingStartDate', 'holdStartDate', 'firstBuyDate', 'firstPurchaseDate', 'firstSubscribeDate', 'firstApplyDate']) {
    const date = dateOf(value[key])
    if (date) return date
  }
  return Object.values(value).map(item => findAcquiredDate(item, depth + 1)).find(Boolean) || ''
}

function resolveExtJson(product) {
  const parameter = product?.jumpData?.param
  if (!parameter) return ''
  if (parameter.extJson && typeof parameter.extJson === 'object') return JSON.stringify(parameter.extJson)
  if (typeof parameter.extJson === 'string' && parameter.extJson.startsWith('{')) return parameter.extJson
  const built = {}
  for (const key of ['productId', 'distinctCode', 'orderId', 'distinctCodes', 'flowFlag', 'type', 'fromJumpType', 'buSku', 'buSkus']) if (parameter[key] !== undefined) built[key] = parameter[key]
  return Object.keys(built).length ? JSON.stringify(built) : ''
}

function parseDetail(payload, product) {
  const data = payload?.resultData?.data
  const pageInfo = data?.pageInfo || {}
  const code = fundCode(pageInfo.fundCode || product?.productId || product?.fundCode)
  if (!/^\d{6}$/.test(code)) return null
  const amountTemplate = (Array.isArray(data?.templateList) ? data.templateList : []).map(item => item?.templateData?.fundAmount).find(Boolean)
  if (!amountTemplate) return null
  const minor = amountTemplate.minorData || {}
  const major = amountTemplate.majorData || {}
  const amount = text(labeled(minor.dataList, '持有金额'))
  const shares = text(labeled(minor.dataList, '持有份额'))
  const zero = [amount, shares].filter(Boolean).length > 0 && [amount, shares].filter(Boolean).every(value => Math.abs(Number(numberLike(value))) < 1e-6)
  if (!zero && (!shares || Number(numberLike(shares)) <= 0) && (!amount || Number(numberLike(amount)) <= 0)) return null
  const intro = (Array.isArray(data.templateList) ? data.templateList : []).map(item => item?.templateData?.fundIntro).find(Boolean)
  return {
    code,
    name: text(intro?.fundName || product?.productName) || code,
    amount,
    yesterdayIncome: text(labeled(major.yieldList, '昨日收益')),
    profit: text(labeled(major.yieldList, '持有收益')),
    rate: text(labeled(major.yieldList, '持有收益率')),
    shares,
    costPrice: text(labeled(minor.dataList, '持仓成本单价')),
    costAmount: text(labeled(minor.dataList, '持仓成本价')),
    ...(findAcquiredDate([pageInfo, amountTemplate, minor, data]) ? { acquiredDate: findAcquiredDate([pageInfo, amountTemplate, minor, data]) } : {}),
    ...(zero ? { zeroPosition: true } : {}),
    detailExtJson: resolveExtJson(product)
  }
}

function tradeType(row) {
  const code = first(row, ['tradeTypeCode']).toUpperCase()
  if (code === 'TRANSFER_IN') return 'add'
  if (code === 'TRANSFER_OUT') return 'reduce'
  if (code === 'TRANSFORM') return 'convert'
  const descriptor = `${code} ${first(row, ['tradeTypeName', 'tradeName', 'operationName', 'businessName', 'businessType', 'orderType'])}`.toLowerCase()
  if (/transform|convert|adjust_position|转换|调仓/.test(descriptor)) return 'convert'
  if (/sell|redeem|redemption|赎回|卖出|转出/.test(descriptor)) return 'reduce'
  if (/buy|purchase|subscribe|定投|申购|买入|转入/.test(descriptor)) return 'add'
  return null
}

function mapTrade(row, currentCodes, codeByName = new Map()) {
  const type = tradeType(row)
  if (!type) return null
  const source = resolveTradeFundCode(row, currentCodes, codeByName)
  // JD's decoded conversion rows use product/productName for the fund being
  // converted out, and sellProduct/sellProductName for the fund being
  // converted in. The display label is misleading, so do not infer direction
  // from the Chinese text prefix.
  const target = resolveTradeFundCode(row, currentCodes, codeByName, ['sellProductId', 'targetProductId', 'targetFundCode', 'toFundCode'], ['sellProductName', 'targetProductName', 'targetFundName', 'toFundName'])
  const convertSource = resolveTradeFundCode(row, currentCodes, codeByName, ['productId', 'sourceProductId', 'fromProductId'], ['productName', 'fundName', 'sourceFundName', 'fromFundName'])
  const code = type === 'convert' && convertSource ? convertSource : source
  if (!currentCodes.has(code) && !(type === 'convert' && currentCodes.has(target))) return null
  const rawTime = first(row, ['bizTime', 'tradeTime', 'orderCreateTime', 'orderCreateDate', 'createTime', 'tradeDate'])
  const tradeDate = dateOf(rawTime)
  if (!tradeDate) return null
  let shares = text(first(row, ['confirmUnit', 'tradeUnit', 'confirmShare', 'tradeShare', 'fundShare', 'applyShare', 'share', 'shares']))
  let amount = text(first(row, ['confirmAmount', 'tradeAmount', 'applyAmount', 'amount', 'money']))
  const allAmount = text(first(row, ['allAmount']))
  const unit = text(first(row, ['unit']))
  if (!shares && allAmount && unit === '份') shares = allAmount
  if (!amount && allAmount && unit !== '份') amount = allAmount
  const item = {
    id: first(row, ['orderId', 'bizOrderId', 'tradeOrderId', 'orderNo', 'subOrderId', 'id']) || `${code}:${type}:${rawTime}:${shares || amount || ''}`,
    code, name: text(first(row, type === 'convert'
      ? ['productName', 'sourceFundName', 'fromFundName', 'sellProductName', 'fundName']
      : ['productName', 'fundName', 'sourceFundName', 'fromFundName'])), type, tradeDate,
    ...(timestampOf(rawTime) ? { tradeTime: timestampOf(rawTime) } : {}),
    ...(shares ? { shares } : {}), ...(amount ? { amount } : {}),
    ...(text(first(row, ['orderStatusDesc', 'orderStatusName', 'statusName', 'tradeStatus', 'status', 'orderStatus'])) ? { status: first(row, ['orderStatusDesc', 'orderStatusName', 'statusName', 'tradeStatus', 'status', 'orderStatus']) } : {}),
    ...(text(first(row, ['statusCode', 'orderStatusCode', 'tradeStatusCode'])) ? { statusCode: first(row, ['statusCode', 'orderStatusCode', 'tradeStatusCode']) } : {}),
    ...(text(first(row, ['confirmationTime', 'confirmTime', 'confirmDate', 'redeemTime', 'expectedArrivalTime'])) ? { confirmTime: first(row, ['confirmationTime', 'confirmTime', 'confirmDate', 'redeemTime', 'expectedArrivalTime']) } : {})
  }
  if (type === 'convert') Object.assign(item, {
    targetCode: target,
    targetName: text(first(row, ['sellProductName', 'targetProductName', 'targetFundName', 'toFundName'])),
    // In the decoded JD account list a conversion's displayed allAmount is
    // the inbound leg's confirmed share count when its unit is 份. Dedicated
    // target-share keys are absent in that response variant.
    targetShares: text(first(row, ['targetUnit', 'targetShare', 'targetShares', 'targetFundShare', 'toFundShare', 'convertShare'])) || (unit === '份' ? allAmount : '')
  })
  return item
}

function addFirstInboundDates(items, adjustments) {
  for (const item of items) {
    if (item.acquiredDate) continue
    const firstInbound = adjustments
      .filter(adjustment => {
        const status = `${adjustment.statusCode || ''} ${adjustment.status || ''}`.toLowerCase()
        const active = !/cancel|refund|fail|closed|reject|撤单|退款|失败|关闭|驳回/.test(status)
        return active && ((adjustment.type === 'add' && adjustment.code === item.code)
          || (adjustment.type === 'convert' && adjustment.targetCode === item.code))
      })
      .sort((left, right) => adjustmentSortKey(left).localeCompare(adjustmentSortKey(right)))[0]
    if (firstInbound?.tradeDate) item.acquiredDate = firstInbound.tradeDate
  }
}

function adjustmentSortKey(adjustment) {
  return adjustment.tradeTime || `${adjustment.tradeDate || ''} 23:59:59`
}

export async function importJdCookie(cookie, { onProgress } = {}) {
  const normalized = validCookie(cookie)
  if (!normalized) { const error = new Error('Invalid JD cookie'); error.code = 'JD_AUTH'; throw error }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 90_000)
  try {
    onProgress?.({ stage: 'reading_holdings', message: 'Reading JD holdings' })
    const groupPayload = await jdPost(JD_GROUP_URL, normalized, { clientVersion: '9.9.9', clientType: 'android', apiVersion: 1, sortKey: '1', sortDirection: 'DESC', viewType: '1', appChannel: 'fund_jjcc', extParams: { channelCode: 'outside' } }, controller.signal)
    const groups = groupPayload?.resultData?.resultData?.fundData?.fundList
    if (!Array.isArray(groups)) throw new Error('JD holdings response invalid')
    const products = groups.flatMap(group => Array.isArray(group?.productList) ? group.productList : [])
    const items = []
    const closedItems = []
    for (let index = 0; index < products.length; index++) {
      const product = products[index]
      const extJson = resolveExtJson(product)
      // A missing detail token makes the aggregate snapshot incomplete. Do not
      // silently import a subset of an account, which looks like a five-fund
      // import and can incorrectly remove local holdings downstream.
      if (!extJson) throw new Error('JD holdings snapshot incomplete')
      const detailPayload = await jdPost(JD_DETAIL_URL, normalized, { extJson, version: 202, clientVersion: '9.9.9', clientType: 'h5' }, controller.signal)
      const item = parseDetail(detailPayload, product)
      if (item) (item.zeroPosition ? closedItems : items).push(item)
      onProgress?.({ stage: 'reading_holdings', message: 'Reading JD holdings', current: index + 1, total: products.length })
    }
    const currentCodes = new Set(items.map(item => item.code))
    const adjustments = []
    let tradeWarning = ''
    let page = 1
    let allCount = 0
    while (page <= MAX_PAGES) {
      onProgress?.({ stage: 'reading_trades', message: 'Reading JD trades', current: page, total: Math.max(allCount, page) })
      const payload = await jdPost(JD_TRADE_URL, normalized, { businessCode: 'FUND', tradeTypeCodeList: [], pageNo: page, pageSize: String(PAGE_SIZE), pageType: 'na', title: '基金交易', orderCreateStartDate: '2000-01-01 00:00:00', orderCreateEndDate: `${new Date().toISOString().slice(0, 10)} 23:59:59` }, controller.signal)
      const data = payload?.resultData?.data
      // JD's newna transaction API is often envelope-encrypted. This proxy has
      // no decryption contract; returning a successful empty timeline would
      // make grid reconciliation delete or seed the wrong batches.
      if (!data || typeof data !== 'object') {
        tradeWarning = 'JD trade timeline was not returned in decoded form; existing grid batches were preserved'
        break
      }
      const rows = Array.isArray(data?.tradeOrderVoList) ? data.tradeOrderVoList : []
      allCount = Math.max(allCount, Number(payload?.allCount || payload?.resultData?.allCount || data?.allCount || 0))
      for (const row of rows) { const item = mapTrade(row, currentCodes); if (item && !adjustments.some(existing => existing.id === item.id)) adjustments.push(item) }
      if (rows.length < PAGE_SIZE || (allCount > 0 && page * PAGE_SIZE >= allCount)) break
      page++
    }
    for (const item of items) {
      // `acquiredDate` is a holding-view datum. Do not infer it from the
      // incomplete transaction feed or use an import date as a replacement;
      // grid batches must retain their own confirmed trade dates.
      delete item.detailExtJson
      delete item.zeroPosition
    }
    onProgress?.({ stage: 'normalizing', message: 'JD import complete' })
    return {
      items,
      closedItems,
      adjustments,
      tradeDiagnostic: `account pages ${page}`,
      ...(tradeWarning ? { tradeWarning } : {})
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Normalize a JD page capture after the page has performed its own encrypted
 * request/response handling. This deliberately contains no Cookie or JD
 * request code, so a browser extension can hand off only the decoded data.
 */
export function importJdBrowserCapture(capture) {
  const suppliedItems = Array.isArray(capture?.items) ? capture.items : null
  const groups = capture?.groupPayload?.resultData?.resultData?.fundData?.fundList
  const detailPayloads = Array.isArray(capture?.detailPayloads) ? capture.detailPayloads : []
  const items = []
  const closedItems = []
  if (suppliedItems) {
    for (const value of suppliedItems) {
      const code = fundCode(value?.code)
      const name = text(value?.name)
      const amount = text(value?.amount)
      const shares = text(value?.shares)
      if (!/^\d{6}$/.test(code) || !name || (!amount && !shares)) continue
      items.push({
        code,
        name,
        ...(amount ? { amount } : {}),
        ...(shares ? { shares } : {}),
        ...(text(value?.costAmount) ? { costAmount: text(value.costAmount) } : {}),
        ...(text(value?.costPrice) ? { costPrice: text(value.costPrice) } : {}),
        ...(dateOf(value?.acquiredDate) ? { acquiredDate: dateOf(value.acquiredDate) } : {})
      })
    }
  } else {
    if (!Array.isArray(groups)) throw new Error('JD browser holdings response invalid')
    const products = groups.flatMap(group => Array.isArray(group?.productList) ? group.productList : [])
    if (!products.length || detailPayloads.length !== products.length) throw new Error('JD browser holdings capture incomplete')
    for (let index = 0; index < products.length; index++) {
      const item = parseDetail(detailPayloads[index], products[index])
      if (item) (item.zeroPosition ? closedItems : items).push(item)
    }
  }
  if (!items.length) throw new Error('JD browser holdings capture empty')

  const currentCodes = new Set(items.map(item => item.code))
  const codeByName = new Map(items.map(item => [item.name, item.code]))
  const adjustments = []
  const rawTrades = Array.isArray(capture?.tradeRows) ? capture.tradeRows.slice(0, 4_000) : []
  for (const row of rawTrades) {
    const item = mapTrade(row, currentCodes, codeByName)
    if (item && !adjustments.some(existing => existing.id === item.id)) adjustments.push(item)
  }
  // The browser capture is a complete account feed. When JD's holding detail
  // omits its acquisition date, the earliest effective inbound record is the
  // user's real first purchase/transfer-in date and can safely seed a batch.
  addFirstInboundDates(items, adjustments)
  for (const item of items) {
    delete item.detailExtJson
    delete item.zeroPosition
  }
  return {
    items,
    closedItems,
    adjustments,
    firstInboundDatesComplete: true,
    tradeDiagnostic: `browser decoded ${rawTrades.length} records, usable ${adjustments.length}`,
    ...(rawTrades.length ? {} : { tradeWarning: 'JD browser did not return decoded trade records; existing grid batches were preserved' })
  }
}

export { validCookie }
