import { randomBytes } from 'node:crypto'

const CAPTURE_TTL_MS = 2 * 60 * 1000
const sessions = new Map()

function prune(now = Date.now()) {
  for (const [token, session] of sessions) if (session.expiresAt <= now) sessions.delete(token)
}

export function createJdBrowserCaptureSession() {
  prune()
  const token = randomBytes(32).toString('base64url')
  sessions.set(token, { expiresAt: Date.now() + CAPTURE_TTL_MS, holdings: null })
  return { token, expiresInSeconds: CAPTURE_TTL_MS / 1000 }
}

export function hasJdBrowserCaptureSession(token) {
  prune()
  return typeof token === 'string' && sessions.has(token)
}

export function storeJdBrowserCaptureHoldings(token, holdings) {
  const session = sessions.get(token)
  if (!session || !Array.isArray(holdings)) return false
  session.holdings = holdings
  return true
}

export function getJdBrowserCaptureHoldings(token) {
  return sessions.get(token)?.holdings || null
}

export function consumeJdBrowserCaptureSession(token) {
  sessions.delete(token)
}
