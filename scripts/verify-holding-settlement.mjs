import assert from 'node:assert/strict'
import {
  calculateSubscriptionShares,
  findSettlementNav,
  getBeijingDateString,
  getCalendarDayDifference,
  getSettlementNavStartDate
} from '../src/utils/tradingDate.ts'
import { calculateHoldingProfit, calculateOfficialHoldingProfit, getValuationComparisonState, hasUsableCurrentEstimate, hasUsableEstimateChange, isDelayedSettlementQdiiFund, isFundPreOpen, isFundTradingHours, isJdYesterdaySummaryCurrent, isLunchBreak, isRetainedMarketEstimate, selectLatestRealChange, shouldRetainCompletedEstimate, shouldRetainCurrentDayEstimate, shouldRetainCurrentIntradayEstimate, shouldUseDelayedQdiiPublishedChange, shouldUseGridEstimateFallback } from '../src/utils/holdingCalculator.ts'
import { deriveHoldingImportBasis } from '../src/utils/holdingImport.ts'

const history = [
  { date: '2026-07-21', netValue: 1.024, totalValue: 0, changeRate: 0.3 },
  { date: '2026-07-20', netValue: 1.021, totalValue: 0, changeRate: 0.2 },
  { date: '2026-07-17', netValue: 1.01, totalValue: 0, changeRate: 0.1 }
]

assert.equal(getSettlementNavStartDate('2026-07-17', 'before'), '2026-07-18')
assert.equal(getSettlementNavStartDate('2026-07-17', 'after'), '2026-07-19')
assert.equal(findSettlementNav(history, getSettlementNavStartDate('2026-07-17', 'before'), '2026-07-17'), null)
assert.equal(findSettlementNav(history, getSettlementNavStartDate('2026-07-17', 'before'), '2026-07-20')?.date, '2026-07-20')
assert.equal(findSettlementNav(history, '2026-07-18', '2026-07-17'), null)
assert.equal(findSettlementNav(history, '2026-07-18', '2026-07-20')?.date, '2026-07-20')
assert.equal(findSettlementNav(history, '2026-07-17', '2026-07-21')?.date, '2026-07-17')
assert.equal(calculateSubscriptionShares(10_000, 15, 1.2), 8_320.833333333334)
assert.equal(calculateSubscriptionShares(10_000, 10_000, 1.2), 0)
assert.equal(getCalendarDayDifference('2026-07-10', '2026-07-20'), 10)
assert.equal(getBeijingDateString(new Date('2026-07-15T16:30:00.000Z')), '2026-07-16')
assert.equal(isJdYesterdaySummaryCurrent({ syncedOn: '2026-07-27' }, '2026-07-27'), true)
assert.equal(isJdYesterdaySummaryCurrent({ syncedOn: '2026-07-27' }, '2026-07-28'), true)
assert.equal(isJdYesterdaySummaryCurrent({ syncedOn: '2026-07-27' }, '2026-07-29'), false)
assert.equal(isJdYesterdaySummaryCurrent({ syncedOn: '2026-07-27', profitDate: '2026-07-26' }, '2026-07-28'), false)

const fridayAfterClose = getValuationComparisonState({
  realChange: -6.89,
  realChangeDate: '2026-07-17',
  estimateChange: -7.15,
  estimateTime: '2026-07-17 15:00',
  now: new Date('2026-07-17T08:00:00.000Z')
})
assert.equal(fridayAfterClose.realChangeLabel, '真实')
assert.equal(fridayAfterClose.hasActualDiff, true)

const saturday = getValuationComparisonState({
  realChange: -6.89,
  realChangeDate: '2026-07-17',
  estimateChange: -7.15,
  estimateTime: '2026-07-17 15:00',
  now: new Date('2026-07-18T02:00:00.000Z')
})
assert.equal(saturday.realChangeLabel, '昨')
assert.equal(saturday.hasActualDiff, true)

const sunday = getValuationComparisonState({
  realChange: -6.89,
  realChangeDate: '2026-07-17',
  estimateChange: -7.15,
  estimateTime: '2026-07-17 15:00',
  now: new Date('2026-07-18T17:00:00.000Z')
})
assert.equal(sunday.realChangeLabel, '前')
assert.equal(sunday.realChangeAgeDays, 2)
assert.equal(sunday.hasActualDiff, true)

// A published result remains active through the next trading day's pre-open
// window. The estimate must stay the captured intraday value, while "昨" is
// the institution's published NAV change.
const nextTradingPreOpen = getValuationComparisonState({
  realChange: 2.72,
  realChangeDate: '2026-07-20',
  estimateChange: 3.21,
  estimateTime: '2026-07-20 14:59',
  now: new Date('2026-07-20T16:03:00.000Z')
})
assert.equal(nextTradingPreOpen.isCurrentReal, true)
assert.equal(nextTradingPreOpen.realChangeLabel, '昨')
assert.equal(nextTradingPreOpen.hasActualDiff, true)

const weekdayMidnight = getValuationComparisonState({
  realChange: 0.84,
  realChangeDate: '2026-07-27',
  estimateChange: -2.23,
  estimateTime: '2026-07-28 00:08',
  now: new Date('2026-07-27T16:08:00.000Z')
})
assert.equal(weekdayMidnight.realChangeLabel, '昨')
assert.equal(weekdayMidnight.hasActualDiff, false)

const weekdayMidnightSettlement = getValuationComparisonState({
  realChange: 0.84,
  realChangeDate: '2026-07-27',
  estimateChange: -2.23,
  estimateTime: '2026-07-27 15:00',
  now: new Date('2026-07-27T16:08:00.000Z')
})
assert.equal(weekdayMidnightSettlement.realChangeLabel, '昨')
assert.equal(weekdayMidnightSettlement.hasActualDiff, true)

const weekdayPreOpenStalePublication = getValuationComparisonState({
  realChange: 0.83,
  realChangeDate: '2026-07-24',
  estimateChange: 0.87,
  estimateTime: '2026-07-24 15:00',
  now: new Date('2026-07-27T17:20:00.000Z')
})
assert.equal(weekdayPreOpenStalePublication.realChangeLabel, '昨')
assert.equal(weekdayPreOpenStalePublication.hasActualDiff, true)

assert.deepEqual(selectLatestRealChange({
  incomingChange: -2.15,
  incomingDate: '2026-07-17',
  cachedChange: -4.21,
  cachedDate: '2026-07-20'
}), { change: -4.21, date: '2026-07-20' })
assert.deepEqual(selectLatestRealChange({
  incomingChange: -3.86,
  incomingDate: '2026-07-20',
  cachedChange: -4.21,
  cachedDate: '2026-07-20'
}), { change: -3.86, date: '2026-07-20' })

const nextTradingOpen = getValuationComparisonState({
  realChange: 2.72,
  realChangeDate: '2026-07-20',
  estimateChange: 0.35,
  estimateTime: '2026-07-21 09:31',
  now: new Date('2026-07-21T01:31:00.000Z')
})
assert.equal(nextTradingOpen.isCurrentReal, false)
assert.equal(nextTradingOpen.hasActualDiff, false)

const usMarketEstimate = getValuationComparisonState({
  realChange: 3.21,
  realChangeDate: '2026-07-20',
  estimateChange: 0.45,
  estimateTime: '2026-07-21 22:00',
  fundName: '富国全球科技互联网股票(QDII)A',
  now: new Date('2026-07-21T14:00:00.000Z')
})
assert.equal(isFundTradingHours('富国全球科技互联网股票(QDII)A', new Date('2026-07-21T14:00:00.000Z')), true)
assert.equal(usMarketEstimate.isTrading, true)
assert.equal(usMarketEstimate.isCurrentReal, false)
assert.equal(usMarketEstimate.hasActualDiff, false)

const hangSengAfterHongKongClose = getValuationComparisonState({
  realChange: 3.21,
  realChangeDate: '2026-07-20',
  estimateChange: 2.86,
  estimateTime: '2026-07-20 15:59',
  fundName: '华泰紫金恒生互联网科技业指数型发起基金(QDII)C',
  now: new Date('2026-07-20T16:36:00.000Z')
})
assert.equal(isFundTradingHours('华泰紫金恒生互联网科技业指数型发起基金(QDII)C', new Date('2026-07-20T16:36:00.000Z')), false)
assert.equal(hangSengAfterHongKongClose.isTrading, false)
assert.equal(hangSengAfterHongKongClose.isCurrentReal, true)
assert.equal(hangSengAfterHongKongClose.hasActualDiff, true)

const hangSengPreOpenStampedToday = getValuationComparisonState({
  realChange: 3.21,
  realChangeDate: '2026-07-20',
  estimateChange: 2.86,
  estimateTime: '2026-07-21 00:36',
  fundName: '华泰紫金恒生互联网科技业指数型发起基金(QDII)C',
  now: new Date('2026-07-20T16:36:00.000Z')
})
assert.equal(isFundPreOpen('华泰紫金恒生互联网科技业指数型发起基金(QDII)C', new Date('2026-07-20T16:36:00.000Z')), true)
assert.equal(hangSengPreOpenStampedToday.isTrading, false)
assert.equal(hangSengPreOpenStampedToday.isCurrentReal, true)
assert.equal(hangSengPreOpenStampedToday.hasActualDiff, false)
assert.equal(hasUsableEstimateChange('--'), false)
assert.equal(hasUsableEstimateChange('-7.7739'), true)
assert.equal(hasUsableCurrentEstimate({ source: 'market_snapshot', gszzl: '-0.35', gztime: '2026-07-21 15:00' }, '2026-07-21'), false)
assert.equal(hasUsableCurrentEstimate({ source: 'sina_ds2', gszzl: '-0.53', gztime: '2026-07-21 16:04' }, '2026-07-21'), true)
assert.equal(hasUsableCurrentEstimate({ source: 'holdings_weighted', gszzl: '--', gztime: '2026-07-21 22:00' }, '2026-07-21'), false)
assert.equal(isRetainedMarketEstimate({ frozen: true, gszzl: '-0.53' }), true)
assert.equal(isRetainedMarketEstimate({ frozen: true, gszzl: '--' }), false)
assert.equal(isRetainedMarketEstimate({ frozen: false, gszzl: '-0.53' }), false)
assert.equal(shouldUseGridEstimateFallback('market_snapshot'), true)
assert.equal(shouldUseGridEstimateFallback('sina_ds2'), false)
assert.equal(shouldRetainCompletedEstimate({
  incomingSource: 'market_snapshot',
  incomingEstimateTime: '2026-07-20 15:00',
  cachedSource: 'fundgz',
  cachedEstimateChange: '-7.7739',
  cachedEstimateTime: '2026-07-20 14:59',
  fundName: '华夏柏瑞上证科创板半导体材料设备主题ETF发起式联接C',
  now: new Date('2026-07-20T16:57:00.000Z')
}), true)
assert.equal(shouldRetainCompletedEstimate({
  incomingSource: 'market_snapshot',
  incomingEstimateTime: '2026-07-20 15:00',
  cachedSource: 'market_snapshot',
  cachedEstimateChange: '-7.7739',
  cachedEstimateTime: '2026-07-20 14:59',
  fundName: '华夏柏瑞上证科创板半导体材料设备主题ETF发起式联接C',
  now: new Date('2026-07-20T16:57:00.000Z')
}), false)

const invalidEstimate = getValuationComparisonState({
  realChange: -6.89,
  realChangeDate: '2026-07-17',
  estimateChange: '--',
  estimateTime: '2026-07-17 15:00',
  now: new Date('2026-07-18T17:00:00.000Z')
})
assert.equal(invalidEstimate.realChangeLabel, '前')
assert.equal(invalidEstimate.hasActualDiff, false)

const lunch = new Date('2026-07-20T04:00:00.000Z')
assert.equal(isLunchBreak(lunch), true)
assert.equal(shouldRetainCurrentIntradayEstimate({
  incomingEstimateChange: '--',
  incomingEstimateTime: '2026-07-17 15:00',
  cachedEstimateChange: '-1.23',
  cachedEstimateTime: '2026-07-20 11:29',
  now: lunch
}), true)
assert.equal(shouldRetainCurrentIntradayEstimate({
  incomingEstimateChange: '0.45',
  incomingEstimateTime: '2026-07-20 13:05',
  cachedEstimateChange: '-1.23',
  cachedEstimateTime: '2026-07-20 11:29',
  now: lunch
}), false)
assert.equal(shouldRetainCurrentDayEstimate({
  incomingEstimateChange: '-3.48',
  incomingEstimateTime: '2026-07-17 15:00',
  cachedEstimateChange: '1.26',
  cachedEstimateTime: '2026-07-20 14:59',
  now: new Date('2026-07-20T07:35:00.000Z')
}), true)
assert.equal(shouldRetainCurrentDayEstimate({
  incomingEstimateChange: '0.36',
  incomingEstimateTime: '2026-07-20 20:00',
  cachedEstimateChange: '1.26',
  cachedEstimateTime: '2026-07-20 14:59',
  now: new Date('2026-07-20T12:05:00.000Z')
}), false)

const holding = {
  code: '018524', name: '华泰紫金恒生互联网科技业指数型发起基金(QDII)C', shareClass: 'C',
  amount: 3600, buyNetValue: 0.8012, costPrice: 0.8012, shares: 4493.26,
  buyDate: '2026-05-22', holdingDays: 59, createdAt: 0
}
const postCloseEstimate = {
  fundcode: '018524', name: holding.name, dwjz: '0.8192', gsz: '0.8457',
  gszzl: '3.24', gztime: '2026-07-20 16:00'
}
const estimatedResult = calculateHoldingProfit({
  holding,
  estimate: postCloseEstimate,
  realChange: -3.48,
  realChangeDate: '2026-07-17',
  realNav: 0.8192,
  now: new Date('2026-07-20T08:06:00.000Z')
})
assert.equal(estimatedResult.currentValue, 0.8457)
assert.equal(estimatedResult.todayProfit, 119.25)

// Some providers retain an older dwjz while publishing a current gszzl. The
// daily profit must follow the published daily rate, not the multi-session NAV
// gap, otherwise yesterday's return is added to today's card total.
const delayedNavEstimateResult = calculateHoldingProfit({
  holding: { ...holding, code: '017472', shares: 1200, amount: 2200 },
  estimate: {
    fundcode: '017472', name: '国泰中证机床ETF发起联接C',
    dwjz: '1.8489', gsz: '2.0041', gszzl: '1.75', gztime: '2026-07-22 11:32'
  },
  now: new Date('2026-07-22T03:32:00.000Z')
})
assert.equal(delayedNavEstimateResult.todayProfit, 41.36)
assert.ok(delayedNavEstimateResult.todayProfit < 50)

assert.deepEqual(calculateOfficialHoldingProfit({ nav: 1.01, changeRate: 1 }, 1000), {
  profit: 10,
  profitRate: 1,
  baseValue: 1000
})

// Re-adding a fund must rebuild the asset card's yesterday result from the
// latest completed NAV instead of relying on the deleted list item's cache.
assert.deepEqual(calculateOfficialHoldingProfit({ nav: 1.9442, changeRate: -1.29 }, 1200), {
  profit: -30.49,
  profitRate: -1.29,
  baseValue: 2363.53
})

const actualResult = calculateHoldingProfit({
  holding,
  estimate: postCloseEstimate,
  realChange: 3.30,
  realChangeDate: '2026-07-20',
  realNav: 0.8462,
  now: new Date('2026-07-20T12:30:00.000Z')
})
assert.equal(actualResult.currentValue, 0.8462)
assert.equal(actualResult.todayProfit, 121.46)

const staleResult = calculateHoldingProfit({
  holding,
  estimate: { ...postCloseEstimate, gsz: '0.8192', gszzl: '-3.48', gztime: '2026-07-17 15:00' },
  realChange: -3.48,
  realChangeDate: '2026-07-17',
  realNav: 0.8192,
  now: new Date('2026-07-20T08:06:00.000Z')
})
assert.equal(staleResult.todayProfit, 0)

// Global QDII NAVs are published with a delay. Before the new publication the
// live estimate drives daily P/L; after publication, JD attributes the newly
// published official return to today's income while the estimate still prices
// the current holding value.
const delayedQdiiHolding = {
  ...holding,
  code: '100055',
  name: '富国全球科技互联网股票(QDII)A',
  shares: 100,
  amount: 100
}
const delayedQdiiEstimate = {
  fundcode: '100055', name: delayedQdiiHolding.name, dwjz: '1.0000', gsz: '1.0444',
  gszzl: '4.44', gztime: '2026-07-21 23:29'
}
const delayedQdiiNow = new Date('2026-07-21T15:29:00.000Z')
assert.equal(isDelayedSettlementQdiiFund(delayedQdiiHolding.name), true)
assert.equal(shouldUseDelayedQdiiPublishedChange({
  fundName: delayedQdiiHolding.name,
  realChange: 1.09,
  realChangeDate: '2026-07-20',
  isCurrentPublication: false,
  now: delayedQdiiNow
}), false)
assert.equal(calculateHoldingProfit({
  holding: delayedQdiiHolding,
  estimate: delayedQdiiEstimate,
  realChange: 1.09,
  realChangeDate: '2026-07-20',
  realNav: 1.0109,
  realChangeIsCurrentPublication: false,
  now: delayedQdiiNow
}).todayProfit, 4.44)

const screenshotPreOpenResult = calculateHoldingProfit({
  holding: delayedQdiiHolding,
  estimate: { ...delayedQdiiEstimate, gsz: '1.0472', gszzl: '4.72', gztime: '2026-07-22 10:54' },
  realChange: 1.09,
  realChangeDate: '2026-07-21',
  realNav: 1.0109,
  realChangeIsCurrentPublication: true,
  now: new Date('2026-07-22T02:54:10.000Z')
})
assert.equal(screenshotPreOpenResult.currentValue, 1.0472)
assert.equal(screenshotPreOpenResult.todayProfit, 1.09)

assert.equal(calculateHoldingProfit({
  holding: delayedQdiiHolding,
  estimate: { ...delayedQdiiEstimate, gsz: '--', gszzl: '--', gztime: '2026-07-22 10:54' },
  realChange: 1.09,
  realChangeDate: '2026-07-21',
  realNav: 1.0109,
  realChangeIsCurrentPublication: true,
  now: new Date('2026-07-22T02:54:10.000Z')
}).todayProfit, 1.09)

const hongKongQdiiHolding = { ...delayedQdiiHolding, name: '华泰紫金恒生互联网科技业指数型发起基金(QDII)C' }
assert.equal(isDelayedSettlementQdiiFund(hongKongQdiiHolding.name), false)
assert.equal(calculateHoldingProfit({
  holding: hongKongQdiiHolding,
  estimate: { ...delayedQdiiEstimate, name: hongKongQdiiHolding.name },
  realChange: 1.09,
  realChangeDate: '2026-07-20',
  now: delayedQdiiNow
}).todayProfit, 4.44)

const importedBasis = deriveHoldingImportBasis({
  amount: '1,210.69', profit: '-189.31', rate: '-14.13%'
}, 1.5)
assert.equal(importedBasis?.principal, 1400)
assert.equal(Math.round(importedBasis.shares * 1.5 * 100) / 100, 1210.69)
assert.equal(Math.round(importedBasis.costPrice * importedBasis.shares * 100) / 100, 1400)

console.log('Holding settlement checks passed.')
