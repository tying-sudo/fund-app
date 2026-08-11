import type { GridStrategyParams } from '../api/gridNative.ts'

export interface GridStrategySignalSnapshot {
  signal_name?: string | null
  action?: string | null
  alert?: boolean | null
  market_analysis?: {
    confidence?: number | null
    strategy_params?: GridStrategyParams | null
  } | null
}

export interface GridStrategyMetricSnapshot {
  confidence: number | null
  sensitivity: number | null
  sensitivitySource: string | null
  sensitivitySourceLabel: string
}

export interface GridStrategyConditionSection {
  key: 'buy' | 'sell' | 'risk'
  label: '买入' | '卖出' | '风控'
  detail: string
}

function finiteNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function displayParam(value: unknown, digits?: number) {
  const number = finiteNumber(value)
  if (number === null) return '--'
  return digits === undefined ? String(number) : number.toFixed(digits)
}

export function gridStrategySignalLabel(signal?: GridStrategySignalSnapshot | null) {
  const label = signal?.signal_name?.trim()
  return label || '观察'
}

export function gridStrategySignalTone(signal?: GridStrategySignalSnapshot | null) {
  if (signal?.alert || gridStrategySignalLabel(signal).includes('低置信')) return 'alert'
  if (signal?.action === 'sell') return 'sell'
  if (signal?.action === 'buy') return 'buy'
  return 'hold'
}

export function gridStrategyMetricSnapshot(signal?: GridStrategySignalSnapshot | null): GridStrategyMetricSnapshot {
  const params = signal?.market_analysis?.strategy_params
  const source = typeof params?.vol_sensitivity_source === 'string' && params.vol_sensitivity_source
    ? params.vol_sensitivity_source
    : null
  return {
    confidence: finiteNumber(signal?.market_analysis?.confidence),
    sensitivity: finiteNumber(params?.vol_sensitivity),
    sensitivitySource: source,
    sensitivitySourceLabel: source === 'manual' ? '手动' : source === 'auto' ? '自动' : source === 'default' ? '默认' : '未返回'
  }
}

export function gridStrategyConditionSections(params?: GridStrategyParams | null): GridStrategyConditionSection[] {
  const sensitivitySource = params?.vol_sensitivity_source === 'manual'
    ? '手动'
    : params?.vol_sensitivity_source === 'auto'
      ? '自动'
      : params?.vol_sensitivity_source === 'default'
        ? '默认'
        : '未返回'

  return [
    {
      key: 'buy',
      label: '买入',
      detail: `大跌 ≤${displayParam(params?.dip_buy_threshold)}% · 连跌低吸 ≤${displayParam(params?.consecutive_dip_trigger)}%且前日跌 · 补仓最多${displayParam(params?.supplement_max_count)}次(浮亏≤${displayParam(params?.supplement_loss_min)}%且当日≤${displayParam(params?.supplement_trigger)}%，间隔≥2交易日+再跌≥1.2%) · 趋势建仓(5日≤-3%或10日≤-5%) · 延迟回补(净值回落1.5-2%后触发，强趋势60%/中性35%，15天窗口) · 趋势自适应仓位(强趋势买入×1.4/弱趋势×0.8)`
    },
    {
      key: 'sell',
      label: '卖出',
      detail: `冲高止盈(P2) ≥${displayParam(params?.take_profit_trigger)}% · 慢涨止盈(P2) 评分≥54(窄化窗口) · 回撤止盈(P2.2) 峰值回撤≥${displayParam(params?.trail_dd)}% · 扭亏评分化(nz_bonus=min(12,浮盈×2)，走统一评分门槛) · 趋弱(P3) 按盈利分级减仓(薄利70%/中利50%/厚利30%) · 止损(P1) ≤${displayParam(params?.stop_loss_base)}%−费率 · 短期深亏≤-6%安全网减30% · 回补仓位L2保护期10天`
    },
    {
      key: 'risk',
      label: '风控',
      detail: `灾难阀 ≤${displayParam(params?.disaster_loss_threshold)}%(极端亏损卖50%/暴跌卖30%) · 补仓禁入(10日≤-10%+连跌≥5 或 回撤≥15%+波动≥2.5%) · 补仓节奏阀(间隔≥2交易日，急跌可缩至2日) · FIFO穿透亏损>50元自动暂缓 · 总仓位风控(灾难保底/时间豁免/趋势确认三层) · 趋势确认减仓(连跌≥6天+10日≤-10%双确认，浅亏≤-6%不减) · L3分级减仓(新仓<25天+非暴跌减70%) · 趋势自适应仓位(强趋势上限×1.6/弱趋势×0.7) · 动态阈值 ${displayParam(params?.risk_multiplier)}× · 灵敏度 ${displayParam(params?.vol_sensitivity, 2)}×(${sensitivitySource})`
    }
  ]
}
