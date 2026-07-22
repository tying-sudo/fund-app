import { warmupCache } from './cache.mjs'
import { closeMarketDatabase, getMarketDataStatus } from './market-database.mjs'
import { refreshMarketSecurityQuotes, startMarketHoldingsSync } from './market-holdings-sync.mjs'

const force = process.argv.includes('--force')
const concurrencyArgument = process.argv.find(argument => argument.startsWith('--concurrency='))
const concurrency = Math.min(Math.max(Number(concurrencyArgument?.split('=')[1]) || 4, 1), 8)

try {
  await warmupCache()
  const result = await startMarketHoldingsSync({ force, concurrency })
  await refreshMarketSecurityQuotes({ limit: 5000 })
  console.log(JSON.stringify({ result, status: await getMarketDataStatus() }, null, 2))
} finally {
  await closeMarketDatabase()
}
