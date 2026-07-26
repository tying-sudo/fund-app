import { deleteRedisKeys, getRedisJson, setRedisJson } from './redis-cache.mjs'

const CACHE_VERSION = 'http:v1'
const MAX_CACHEABLE_BYTES = 1_500_000

const ROUTE_POLICIES = [
  [/^\/api\/fund-list$/, 600],
  [/^\/api\/funds\/\d{6}$/, 1_800],
  [/^\/api\/funds\/\d{6}\/nav-history$/, 21_600],
  [/^\/api\/funds\/\d{6}\/daily-returns$/, 900],
  [/^\/api\/funds\/\d{6}\/performance$/, 1_800],
  [/^\/api\/funds\/\d{6}\/holdings$/, 3_600],
  [/^\/api\/fund-estimate-sources$/, 30],
  [/^\/api\/fund-snapshots$/, 60],
  [/^\/api\/fund-rank$/, 60],
  [/^\/api\/otc-fund-rank$/, 60],
  [/^\/api\/sector-detail$/, 300]
]

export function getHttpCachePolicy(pathname) {
  return ROUTE_POLICIES.find(([pattern]) => pattern.test(pathname))?.[1] || 0
}

export function buildHttpCacheKey(originalUrl) {
  const url = new URL(originalUrl, 'http://cache.local')
  const params = [...url.searchParams.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
  const query = new URLSearchParams(params).toString()
  return `${CACHE_VERSION}:${url.pathname}${query ? `?${query}` : ''}`
}

export function redisHttpCache(req, res, next) {
  if (req.method !== 'GET') return next()
  const policy = getHttpCachePolicy(req.path)
  if (!policy) return next()

  const key = buildHttpCacheKey(req.originalUrl)
  void (async () => {
    const cached = await getRedisJson(key)
    if (cached?.body && Number.isInteger(cached.status)) {
      res.set('X-Cache', 'redis-hit')
      return res.status(cached.status).type('application/json').send(cached.body)
    }

    res.set('X-Cache', 'redis-miss')
    const originalJson = res.json.bind(res)
    res.json = body => {
      const serialized = JSON.stringify(body)
      if (res.statusCode >= 200 && res.statusCode < 300 && Buffer.byteLength(serialized) <= MAX_CACHEABLE_BYTES) {
        void setRedisJson(key, { status: res.statusCode, body: serialized }, policy)
      }
      return originalJson(body)
    }
    next()
  })().catch(next)
}

export function clearRedisHttpCache() {
  return deleteRedisKeys(`${CACHE_VERSION}:*`)
}
