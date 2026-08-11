import test from 'node:test'
import assert from 'node:assert/strict'

import {
  gridStrategyConditionSections,
  gridStrategyMetricSnapshot,
  gridStrategySignalLabel,
  gridStrategySignalTone
} from './gridStrategyPresentation.ts'

test('keeps the top-level backend signal and source-project alert priority', () => {
  const signal = {
    signal_name: '止盈卖出(低置信)',
    action: 'sell',
    alert: false
  }
  assert.equal(gridStrategySignalLabel(signal), '止盈卖出(低置信)')
  assert.equal(gridStrategySignalTone(signal), 'alert')
  assert.equal(gridStrategySignalTone({ signal_name: '风险提示', action: 'sell', alert: true }), 'alert')
})

test('reads confidence and sensitivity from the same backend signal snapshot', () => {
  const metrics = gridStrategyMetricSnapshot({
    signal_name: '持有等待',
    market_analysis: {
      confidence: 0.73,
      strategy_params: { vol_sensitivity: 1.18, vol_sensitivity_source: 'auto' }
    }
  })
  assert.deepEqual(metrics, {
    confidence: 0.73,
    sensitivity: 1.18,
    sensitivitySource: 'auto',
    sensitivitySourceLabel: '自动'
  })
})

test('does not invent confidence or sensitivity when the backend omits or nulls them', () => {
  assert.deepEqual(gridStrategyMetricSnapshot({
    market_analysis: {
      confidence: null,
      strategy_params: { vol_sensitivity: null }
    }
  }), {
    confidence: null,
    sensitivity: null,
    sensitivitySource: null,
    sensitivitySourceLabel: '未返回'
  })
})

test('keeps the source project buy, sell, and risk hierarchy with live parameters', () => {
  const sections = gridStrategyConditionSections({
    dip_buy_threshold: -2.4,
    consecutive_dip_trigger: -1.1,
    supplement_max_count: 4,
    supplement_loss_min: -3.2,
    supplement_trigger: -1.3,
    take_profit_trigger: 4.6,
    trail_dd: 1.9,
    stop_loss_base: -8.4,
    disaster_loss_threshold: -10,
    risk_multiplier: 1.22,
    vol_sensitivity: 1.18,
    vol_sensitivity_source: 'manual'
  })

  assert.deepEqual(sections.map(section => section.label), ['买入', '卖出', '风控'])
  assert.match(sections[0].detail, /大跌 ≤-2\.4%/)
  assert.match(sections[0].detail, /补仓最多4次/)
  assert.match(sections[1].detail, /冲高止盈\(P2\) ≥4\.6%/)
  assert.match(sections[1].detail, /止损\(P1\) ≤-8\.4%−费率/)
  assert.match(sections[2].detail, /灾难阀 ≤-10%/)
  assert.match(sections[2].detail, /动态阈值 1\.22× · 灵敏度 1\.18×\(手动\)/)
})

test('marks missing live parameters instead of substituting defaults', () => {
  const sections = gridStrategyConditionSections({})
  assert.match(sections[0].detail, /大跌 ≤--%/)
  assert.match(sections[2].detail, /动态阈值 --× · 灵敏度 --×\(未返回\)/)
})
