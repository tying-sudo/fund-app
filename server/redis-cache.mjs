import { createClient } from 'redis'

const DEFAULT_CONNECT_TIMEOUT_MS = 1_500
const DEFAULT_KEY_PREFIX = 'fund-proxy:'

let client = null
let connectPromise = null
let lastError = null
let lastReadyAt = null

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function isRedisConfigured() {
  return Boolean(process.env.REDIS_URL || process.env.REDIS_HOST)
}

export function redisKeyPrefix() {
  return String(process.env.REDIS_KEY_PREFIX || DEFAULT_KEY_PREFIX)
}

function redisUrl() {
  if (process.env.REDIS_URL) return process.env.REDIS_URL
  const host = process.env.REDIS_HOST || '127.0.0.1'
  const port = positiveInteger(process.env.REDIS_PORT, 6379)
  const database = Math.max(0, Number(process.env.REDIS_DB) || 0)
  const password = process.env.REDIS_PASSWORD
  const credentials = password ? `:${encodeURIComponent(password)}@` : ''
  return `redis://${credentials}${host}:${port}/${database}`
}

async function getClient() {
  if (!isRedisConfigured()) return null
  if (!client) {
    client = createClient({
      url: redisUrl(),
      socket: {
        connectTimeout: positiveInteger(process.env.REDIS_CONNECT_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS),
        reconnectStrategy: retries => Math.min(5_000, 100 * (retries + 1))
      }
    })
    client.on('error', error => {
      lastError = error.message || String(error)
    })
    client.on('ready', () => {
      lastError = null
      lastReadyAt = new Date().toISOString()
    })
  }
  if (!client.isOpen) {
    if (!connectPromise) {
      connectPromise = client.connect().catch(error => {
        lastError = error.message || String(error)
        return null
      }).finally(() => {
        connectPromise = null
      })
    }
    await connectPromise
  }
  return client.isReady ? client : null
}

export async function getRedisJson(key) {
  try {
    const active = await getClient()
    if (!active) return null
    const value = await active.get(`${redisKeyPrefix()}${key}`)
    return value === null ? null : JSON.parse(value)
  } catch (error) {
    lastError = error.message || String(error)
    return null
  }
}

export async function setRedisJson(key, value, ttlSeconds) {
  try {
    const active = await getClient()
    if (!active) return false
    await active.set(`${redisKeyPrefix()}${key}`, JSON.stringify(value), { EX: positiveInteger(ttlSeconds, 1) })
    return true
  } catch (error) {
    lastError = error.message || String(error)
    return false
  }
}

export async function deleteRedisKeys(pattern) {
  try {
    const active = await getClient()
    if (!active) return 0
    let deleted = 0
    for await (const keys of active.scanIterator({ MATCH: `${redisKeyPrefix()}${pattern}`, COUNT: 100 })) {
      if (keys.length) deleted += await active.del(keys)
    }
    return deleted
  } catch (error) {
    lastError = error.message || String(error)
    return 0
  }
}

export async function getRedisStatus({ ping = false } = {}) {
  const status = {
    configured: isRedisConfigured(),
    connected: Boolean(client?.isReady),
    keyPrefix: redisKeyPrefix(),
    readyAt: lastReadyAt,
    error: lastError
  }
  if (!ping || !status.configured) return status
  try {
    const active = await getClient()
    status.connected = Boolean(active)
    if (active) {
      await active.ping()
      status.ping = 'PONG'
    }
  } catch (error) {
    lastError = error.message || String(error)
    status.error = lastError
  }
  return status
}
