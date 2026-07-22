import { API_BASE_URL } from '@/config/api'

export type FundRankType = 'gp' | 'hh' | 'zq' | 'zs' | 'qdii' | 'fof'
export type MarketRankTab = 'increase' | 'decrease' | 'hot' | 'actual'
export type MarketSectorType = 'industry' | 'concept'
export type MarketSectorSort = 'change' | 'flow'

export interface MarketIndex {
  code: string
  name: string
  price: number
  change: number
  changePercent: number
  volume: number | null
  market: 'cn' | 'hk' | 'us' | 'global'
}

export interface MarketSector {
  code: string
  name: string
  changePercent: number
  netInflow: number | null
  type: string
  classification: 'shenwan_l3' | 'eastmoney_concept' | 'unknown'
  updatedAt: string | null
  source: 'live'
}

export interface MarketFundRank {
  code: string
  name: string
  unitNav: number | null
  dailyReturn: number | null
  yearReturn: number | null
  navDate: string
}

export interface MarketMetadata {
  refreshedAt: string
  market: {
    isOpen: boolean
    isLunchBreak: boolean
    isAfterClose: boolean
    date: string
  }
}

export interface MarketOverview {
  indices: MarketIndex[]
  sectors: MarketSector[]
  ranking: { records: MarketFundRank[]; total: number; page: number; pageSize: number }
  metadata: MarketMetadata
}

export type SectorDetailPeriod = '1d' | '1m' | '3m' | '1y'

export interface SectorTrendPoint {
  time: string
  value: number
  netInflow: number | null
}

export interface SectorConstituent {
  code: string
  name: string
  price: number | null
  changePercent: number | null
  turnover: number | null
  volume: number | null
}

export interface SectorRelatedFund {
  code: string
  name: string
  unitNav: number | null
  dailyReturn: number | null
  navDate: string
  relatedIndex: string
  relatedSource?: 'theme_mapping' | 'constituent_holdings'
  relatedMatchCount?: number
  relatedHoldingRatio?: number
  reportDate?: string
}

export interface SectorDetail {
  sector: {
    code: string
    name: string
    type: MarketSectorType
    price: number | null
    previousClose: number | null
    changePercent: number | null
    netInflow: number | null
    date: string
    mapped: boolean
    source: string
  }
  breadth: { up: number; down: number; flat: number; total: number }
  trend: { period: SectorDetailPeriod; points: SectorTrendPoint[] }
  constituents: SectorConstituent[]
  relatedFunds: SectorRelatedFund[]
  updatedAt: string
}

const RANK_TAB_CONFIG: Record<MarketRankTab, { fundType: FundRankType; order: 'asc' | 'desc' }> = {
  increase: { fundType: 'gp', order: 'desc' },
  decrease: { fundType: 'gp', order: 'asc' },
  hot: { fundType: 'hh', order: 'desc' },
  actual: { fundType: 'zq', order: 'desc' }
}

function numberOrNull(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function numberOrZero(value: unknown): number {
  return numberOrNull(value) ?? 0
}

function mapIndex(value: Record<string, unknown>): MarketIndex {
  return {
    code: String(value.code || ''),
    name: String(value.name || ''),
    price: numberOrZero(value.price),
    change: numberOrZero(value.change),
    changePercent: numberOrZero(value.changePercent),
    volume: numberOrNull(value.volume),
    market: value.market === 'cn' || value.market === 'hk' || value.market === 'us' ? value.market : 'global'
  }
}

function mapSector(value: Record<string, unknown>): MarketSector {
  return {
    code: String(value.code || ''),
    name: String(value.name || ''),
    changePercent: numberOrZero(value.dayReturn),
    netInflow: numberOrNull(value.netInflow),
    type: String(value.type || 'live'),
    classification: value.classification === 'shenwan_l3' || value.classification === 'eastmoney_concept'
      ? value.classification
      : 'unknown',
    updatedAt: value.updatedAt ? String(value.updatedAt) : null,
    source: 'live'
  }
}

function mapFundRank(value: Record<string, unknown>): MarketFundRank | null {
  const code = String(value.code || '')
  const name = String(value.name || '')
  if (!/^\d{6}$/.test(code) || !name) return null
  return {
    code,
    name,
    unitNav: numberOrNull(value.unitNav),
    dailyReturn: numberOrNull(value.dailyReturn),
    yearReturn: numberOrNull(value.yearReturn),
    navDate: String(value.date || '')
  }
}

async function request<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`行情服务暂不可用 (${response.status})`)
  return response.json() as Promise<T>
}

export async function fetchMarketOverview(fundType: FundRankType): Promise<MarketOverview> {
  const payload = await request<{
    data?: { indices?: Record<string, unknown>[]; sectors?: Record<string, unknown>[]; ranking?: { records?: Record<string, unknown>[]; total?: number; page?: number; pageSize?: number } }
    metadata?: MarketMetadata
  }>(`/api/market-overview?ft=${fundType}&rankSize=12`)

  const ranking = payload.data?.ranking || {}
  return {
    indices: (payload.data?.indices || []).map(mapIndex).filter(index => index.code && index.name),
    sectors: (payload.data?.sectors || []).map(mapSector).filter(sector => sector.code && sector.name),
    ranking: {
      records: (ranking.records || []).map(mapFundRank).filter((item): item is MarketFundRank => item !== null),
      total: numberOrZero(ranking.total),
      page: numberOrZero(ranking.page) || 1,
      pageSize: numberOrZero(ranking.pageSize) || 12
    },
    metadata: {
      ...(payload.metadata || {
        refreshedAt: new Date().toISOString(),
        market: { isOpen: false, isLunchBreak: false, isAfterClose: false, date: '' }
      })
    }
  }
}

export async function fetchMarketIndices(): Promise<MarketIndex[]> {
  const payload = await request<{ data?: Record<string, unknown>[] }>('/api/market-indices')
  return (payload.data || []).map(mapIndex).filter(index => index.code && index.name)
}

/**
 * Reference-compatible ranking tabs backed by the same proxy cache as the
 * deployed real-time-fund market page. Period returns are NAV data, not live
 * valuation estimates.
 */
export async function fetchMarketRanking(tab: MarketRankTab, pageSize = 20): Promise<MarketFundRank[]> {
  const config = RANK_TAB_CONFIG[tab]
  const params = new URLSearchParams({
    ft: config.fundType,
    sc: '1nzf',
    st: config.order,
    pi: '1',
    pn: String(pageSize)
  })
  const payload = await request<{ records?: Record<string, unknown>[] }>(`/api/fund-rank?${params.toString()}`)
  return (payload.records || []).map(mapFundRank).filter((item): item is MarketFundRank => item !== null)
}

/** Full live sector table from the backend proxy (Eastmoney industry/concept lists). */
export async function fetchAllMarketSectors(
  type: MarketSectorType,
  sort: MarketSectorSort,
  order: 'asc' | 'desc',
  limit = 500
): Promise<MarketSector[]> {
  const params = new URLSearchParams({ type, sort, order, limit: String(Math.min(Math.max(limit, 1), 500)) })
  const payload = await request<{ data?: Record<string, unknown>[] }>(`/api/sector?${params.toString()}`)
  return (payload.data || []).map(row => mapSector({ ...row, type, source: 'live' })).filter(sector => sector.code && sector.name)
}

export async function fetchSectorDetail(
  code: string,
  name: string,
  type: MarketSectorType,
  period: SectorDetailPeriod
): Promise<SectorDetail> {
  const params = new URLSearchParams({ code, name, type, period })
  const payload = await request<{ data?: SectorDetail }>(`/api/sector-detail?${params.toString()}`)
  if (!payload.data?.sector?.code) throw new Error('板块详情数据无效')
  return payload.data
}
