export interface GridFund {
  code: string
  alias?: string
}

export interface GridSector {
  name: string
  funds: GridFund[]
}

export interface GridState {
  version?: number
  updated_at?: string
  strategy_order?: string[]
  sectors: GridSector[]
}

export interface GridValuation {
  fund_code: string
  fund_name?: string
  estimation_change?: number | null
  week_change?: number | null
  month_change?: number | null
  confidence?: number | null
  calibrated_confidence?: number | null
  _source?: string
  _nav_date?: string
  _valuation_date?: string
  _frozen?: boolean
}

export interface GridFitness {
  score?: number
  grade?: string
}

export interface GridSignal {
  fund_code: string
  signal_name?: string
  action?: 'buy' | 'sell' | 'hold' | string
  amount?: number | null
  sell_shares?: number | null
  sell_pct?: number | null
  reason?: string
  alert?: boolean
  alert_msg?: string
  priority?: number
  target_batch_id?: string | null
  fee_info?: { sell_fee_rate?: number; estimated_fee?: number; estimated_net_profit?: number | null }
  _is_rebuy?: boolean
  _pending_rebuy_id?: string
  _portfolio_discount?: number
  _portfolio_buy_count?: number
  _portfolio_buy_peers?: string[]
  rebuy_recommendation?: GridRebuyRecommendation
  all_signals?: GridSignal[]
  fifo_sell_plan?: GridFifoSellPlan
  market_regime?: 'bull' | 'neutral' | 'bear' | string
  regime_source?: 'auto' | 'manual' | string
  market_analysis?: {
    day_changes?: Array<{ date?: string; change?: number | null; source?: string }>
    short_3d?: number | null
    short_5d?: number | null
    mid_10d?: number | null
    long_20d?: number | null
    trend?: string
    volatility?: number | null
    market_value?: number | null
    total_cost?: number | null
    unrealized_pnl?: number | null
    unrealized_pnl_pct?: number | null
    realized_pnl?: number | null
    cumulative_pnl?: number | null
    total_profit_pct?: number | null
    market_regime?: 'bull' | 'neutral' | 'bear' | string
    regime_source?: 'auto' | 'manual' | string
    current_nav?: number | null
    today_change?: number | null
    confidence?: number | null
    covered_weight?: number | null
    residual_weight?: number | null
    consecutive_down?: number | null
    max_drawdown?: number | null
    fitness_score?: number | null
    fitness_grade?: string
    decision_note?: string
    strategy_params?: GridStrategyParams
  }
}

/** The source grid's authoritative sell instruction, generated from its batch plan. */
export interface GridFifoSellPlan {
  total_shares?: number
  batch_count?: number
  steps?: GridFifoSellStep[]
  total_estimated_fee?: number
  total_estimated_profit?: number | null
  has_passthrough?: boolean
  passthrough_warning?: string | null
  passthrough_loss_total?: number | null
  instruction?: string
}

export interface GridFifoSellStep {
  batch_id?: string
  buy_date?: string
  sell_shares?: number
  batch_total_shares?: number
  is_full_sell?: boolean
  is_passthrough?: boolean
  hold_days?: number
  fee_rate?: number
  profit_pct?: number | null
  estimated_fee?: number
  estimated_net_profit?: number | null
  reason?: string
  note?: string
}

export interface GridMutationResult {
  success: boolean
  fund_key?: string
  signal?: GridSignal
  position?: GridPosition
  signal_error?: string
}

export interface GridJdImportResult {
  success: boolean
  /** Visible buy/sell batches rebuilt from the verified current cycle. */
  imported: number
  updated?: number
  skipped: number
  partial: number
  results: GridJdImportResultItem[]
  /** Audit-table counters are separate from visible position batches. */
  audit_imported?: number
  audit_updated?: number
  audit_skipped?: number
  audit_results?: GridJdImportResultItem[]
  /** Codes whose reconstructed server-side timeline exactly matches JD shares. */
  verified_cycle_codes?: string[]
}

export interface GridJdImportResultItem {
  ledger_id?: string
  id?: string
  code?: string
  action?: 'buy' | 'sell' | 'seed' | 'convert_in' | 'convert_out' | 'replace_audit' | string
  status: 'imported' | 'updated' | 'partial' | 'skipped'
  reason?: string
  removed?: number
}

export interface GridStrategyParams {
  dip_buy_threshold?: number
  consecutive_dip_trigger?: number
  supplement_max_count?: number
  supplement_loss_min?: number
  supplement_trigger?: number
  take_profit_trigger?: number
  stop_loss_base?: number
  disaster_loss_threshold?: number
  risk_multiplier?: number
  vol_sensitivity?: number
  vol_sensitivity_source?: 'auto' | 'manual' | string
  market_regime?: 'bull' | 'neutral' | 'bear' | string
  regime_first_build_ratio?: number
  regime_entry_scale?: number
  regime_rebuy_discount?: number
  trail_dd?: number
  momentum_score?: number
  vol_state?: string
}

export interface GridRebuyRecommendation {
  amount?: number
  ratio?: number
  trigger_nav?: number
  trend?: string
  window_days?: number
  pending_rebuy_id?: string
  source_signal?: string
  reason?: string
}

export interface GridPosition {
  fund_name?: string
  max_position?: number
  note?: string
  watch_note?: string
  fee_schedule?: GridFeeScheduleItem[]
  batches?: GridBatch[]
  sell_records?: GridSellRecord[]
  jd_transactions?: GridJdTransaction[]
  jd_pending_position?: boolean
  jd_baseline_missing_date?: boolean
  jd_snapshot?: { amount?: number; nav?: number; shares?: number; acquired_date_known?: boolean; synced_at?: string }
  supplement_count?: number
}

export interface GridBatch {
  id?: string
  status?: string
  amount?: number
  nav?: number | null
  shares?: number
  buy_date?: string
  note?: string
  original_amount?: number
}

export interface GridSellRecord {
  id?: string
  batch_id?: string
  sell_date?: string
  sell_shares?: number
  buy_nav?: number | null
  sell_nav?: number | null
  hold_days?: number
  profit?: number | null
  profit_pct?: number | null
}

export interface GridTradeOcrItem {
  type: 'buy' | 'sell'
  operation?: 'conversion' | 'transfer_in' | 'transfer_out' | 'scheduled_buy' | 'buy' | 'sell' | 'redeem' | string
  date: string
  time?: string
  amount?: string
  shares?: string
  source_shares?: string
  source_fund_name?: string
  target_fund_name?: string
  source_fund_code?: string
  target_fund_code?: string
  description?: string
}

export interface GridTradeOcrResult {
  fund_name?: string
  fund_code?: string
  items?: GridTradeOcrItem[]
}

export interface GridFeeScheduleItem {
  days: number | null
  rate: number
}

export interface GridBuyInput {
  amount: number
  nav?: number | null
  note?: string
  buy_date?: string
  is_supplement?: boolean
  owner?: string
  is_rebuy?: boolean
  pending_rebuy_id?: string
}

export interface MarketRegime {
  regime?: 'bull' | 'neutral' | 'bear' | string
  auto?: boolean
  manual?: boolean
  auto_result?: 'bull' | 'neutral' | 'bear' | string
  auto_at?: string
  manual_regime?: 'bull' | 'neutral' | 'bear' | string | null
  params?: Record<string, number | string | boolean>
}

export interface GridVolSensitivity {
  effective?: number
  source?: 'manual' | 'auto' | 'default' | string
  manual?: number | null
  auto_cached?: number | null
  auto_cached_at?: string | null
}

const isLocalPreview = ['localhost', '127.0.0.1'].includes(window.location.hostname)
const apiBase = import.meta.env.VITE_VALUATION_GRID_API_BASE
  || (isLocalPreview ? 'https://www.tyingfund.com' : '')

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, init)
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    const detail = typeof body?.detail === 'string' ? body.detail : ''
    throw new Error(detail ? `请求失败 (${response.status})：${detail}` : `请求失败 (${response.status})`)
  }
  return response.json() as Promise<T>
}

function sellConfirmation(fundCode: string, shares: number) {
  return `SELL ${fundCode} ${Number(shares).toFixed(2)}`
}

export function fetchGridState() {
  return request<GridState>('/v1/state')
}

export function saveGridState(state: GridState) {
  return request<{ success: boolean }>('/v1/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state)
  })
}

export async function fetchGridValuations(codes: string[]) {
  const data = await request<{ items?: GridValuation[] }>(`/v1/valuation/batch?_=${Date.now()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fund_codes: codes }),
    cache: 'no-store'
  })
  return data.items || []
}

export async function fetchGridFitness() {
  // The backend persists the original project's backtest output in
  // fitness_cache.json. A nonce makes a newly generated cache visible without
  // discarding the page's local fallback while the request is in flight.
  const data = await request<{ scores?: Record<string, GridFitness> }>(`/v1/fund-fitness?_=${Date.now()}`, {
    cache: 'no-store'
  })
  return data.scores || {}
}

export async function fetchGridFundName(code: string) {
  const data = await request<{ name?: string | null }>(`/v1/fund/${code}/name`)
  return data.name || ''
}

export function fetchGridHistory(code: string, days = 20) {
  return request<{ history?: Array<{ date?: string; nav?: number; change?: number | null }> }>(
    `/v1/fund/${code}/nav-history?days=${Math.max(1, Math.min(2000, Math.round(days)))}`
  )
}

export function recognizeGridTrades(file: string) {
  return request<GridTradeOcrResult>('/api/ocr/grid-trades', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file })
  })
}

export function fetchGridSignals() {
  // Signal generation depends on mutable market-regime settings. A nonce prevents
  // intermediary caches from returning the pre-switch signal snapshot.
  return request<{ generated_at?: string; signals?: GridSignal[]; portfolio_budget?: GridPortfolioBudget }>(
    `/v1/strategy/signals?_=${Date.now()}`,
    { cache: 'no-store' }
  )
}

export interface GridPortfolioBudget {
  max_invest?: number
  invested?: number
  daily_budget?: number
  cash_reserve_ratio?: number
  scope?: string
}

export function fetchGridPositions() {
  return request<{ funds?: Record<string, GridPosition> }>('/v1/positions')
}

export interface GridJdTransaction {
  id: string
  code: string
  fund_name?: string
  type: 'buy' | 'sell' | 'convert_in' | 'convert_out'
  trade_date: string
  trade_time?: string
  amount?: number | null
  shares?: number | null
  nav?: number | null
  state?: 'pending' | 'confirmed' | string
  order_status?: string
  status_code?: string
  confirm_time?: string
  counterparty_code?: string
  counterparty_name?: string
}

export function importGridJdTransactions(input: {
  full_current_holding_codes: string[]
  current_holding_codes: string[]
  replace_transaction_codes: string[]
  resolve_current_cycles_on_server?: boolean
  current_holdings: Array<{
    code: string
    name: string
    amount?: string
    shares?: string
    costPrice?: string
    costAmount?: string
    profit?: string
    profitDate?: string
    acquiredDate?: string
  }>
  adjustments: Array<{
    id: string
    code: string
    name?: string
    type: 'add' | 'reduce' | 'convert'
    tradeDate: string
    tradeTime?: string
    shares?: string
    amount?: string
    targetCode?: string
    targetName?: string
    targetShares?: string
    status?: string
    statusCode?: string
    confirmTime?: string
    cycleCodes?: string[]
  }>
}) {
  return request<GridJdImportResult>('/v1/positions/jd-import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  })
}

export function fetchGridPosition(fundCode: string) {
  return request<GridPosition>(`/v1/position/${encodeURIComponent(fundCode)}`)
}

export function createGridBuy(fundCode: string, input: GridBuyInput) {
  return request<GridMutationResult>(`/v1/position/${encodeURIComponent(fundCode)}/buy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  })
}

export function createGridWatch(fundCode: string, input: { max_position: number; note?: string; owner?: string }) {
  return request<GridMutationResult>(`/v1/position/${encodeURIComponent(fundCode)}/watch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  })
}

export function sellGridPositionFifo(fundCode: string, input: { total_sell_shares: number; request_id?: string; sell_nav?: number; sell_date?: string }) {
  return request<GridMutationResult>(`/v1/position/${encodeURIComponent(fundCode)}/sell-fifo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, confirmation: sellConfirmation(fundCode, input.total_sell_shares) })
  })
}

export function sellGridBatch(fundCode: string, input: { batch_id: string; sell_shares: number; sell_nav?: number; sell_date?: string }) {
  return request<GridMutationResult>(`/v1/position/${encodeURIComponent(fundCode)}/sell`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, confirmation: sellConfirmation(fundCode, input.sell_shares) })
  })
}

export function deleteGridBatch(fundCode: string, batchId: string) {
  return request<GridMutationResult>(`/v1/position/${encodeURIComponent(fundCode)}/batch/${encodeURIComponent(batchId)}`, { method: 'DELETE' })
}

export function updateGridBuyNav(fundCode: string, batchId: string, nav: number) {
  return request<GridMutationResult>(`/v1/position/${encodeURIComponent(fundCode)}/buy-nav`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batch_id: batchId, nav })
  })
}

export function updateGridSellNav(fundCode: string, sellRecordId: string, nav: number) {
  return request<GridMutationResult>(`/v1/position/${encodeURIComponent(fundCode)}/sell-nav`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sell_record_id: sellRecordId, sell_nav: nav })
  })
}

export function deleteGridSellRecord(fundCode: string, sellRecordId: string) {
  return request<GridMutationResult>(`/v1/position/${encodeURIComponent(fundCode)}/sell-record/${encodeURIComponent(sellRecordId)}`, { method: 'DELETE' })
}

export function removeGridPosition(fundCode: string) {
  const code = encodeURIComponent(fundCode)
  // The deployed grid requires the displayed fund key as an explicit delete
  // confirmation. Keeping it in the URL is compatible with older servers.
  return request<{ success: boolean }>(`/v1/position/${code}?confirm=${code}`, { method: 'DELETE' })
}

export function renameGridPosition(fundCode: string, owner: string) {
  return request<{ success: boolean; new_key?: string }>(`/v1/position/${encodeURIComponent(fundCode)}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ new_owner: owner })
  })
}

export function updateGridPositionConfig(fundCode: string, input: { max_position?: number; fund_name?: string }) {
  return request<{ success: boolean }>(`/v1/position/${encodeURIComponent(fundCode)}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  })
}

export function updateGridFeeSchedule(fundCode: string, schedule: GridFeeScheduleItem[]) {
  return request<{ success: boolean; schedule?: GridFeeScheduleItem[] }>(`/v1/position/${encodeURIComponent(fundCode)}/fee-schedule`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schedule })
  })
}

export function fetchGridVolSensitivity(fundCode: string) {
  return request<GridVolSensitivity>(`/v1/position/${encodeURIComponent(fundCode)}/vol-sensitivity`, { cache: 'no-store' })
}

export function updateGridVolSensitivity(fundCode: string, sensitivity: number) {
  return request<{ success: boolean; sensitivity?: number }>(`/v1/position/${encodeURIComponent(fundCode)}/vol-sensitivity`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sensitivity })
  })
}

export function clearGridVolSensitivity(fundCode: string) {
  return request<{ success: boolean }>(`/v1/position/${encodeURIComponent(fundCode)}/vol-sensitivity`, { method: 'DELETE' })
}

export function recalibrateGridVolSensitivity(fundCode: string) {
  return request<{ success: boolean } & GridVolSensitivity>(`/v1/position/${encodeURIComponent(fundCode)}/vol-sensitivity/calibrate`, { method: 'POST' })
}

export function fetchMarketRegime() {
  return request<MarketRegime>(`/v1/market-regime?_=${Date.now()}`, { cache: 'no-store' })
}

export function saveMarketRegime(regime: 'bull' | 'neutral' | 'bear', manualOverride: boolean) {
  return request<MarketRegime>('/v1/market-regime', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ regime, auto: true, manual_override: manualOverride })
  })
}
