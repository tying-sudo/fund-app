import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { Client } = require('C:\\tmp\\codex-ssh-deploy\\node_modules\\ssh2')
const root = process.cwd()
const proxyRoot = '/opt/fund-proxy'
const releaseStamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')

async function environmentValue(name) {
  if (process.env[name]) return process.env[name]
  for (const file of ['.env.production.local', '.env.local']) {
    const source = await readFile(join(root, file), 'utf8').catch(() => '')
    const match = source.match(new RegExp(`^${name}=(.*)$`, 'm'))
    if (match?.[1]) return match[1].trim().replace(/^['"]|['"]$/g, '')
  }
  return ''
}

const host = await environmentValue('DEPLOY_SSH_HOST')
const password = await environmentValue('DEPLOY_SSH_PASSWORD')
const privateKeyPath = await environmentValue('DEPLOY_SSH_PRIVATE_KEY')
const redisPassword = process.env.DEPLOY_REDIS_PASSWORD || ''
if (!host || (!password && !privateKeyPath)) throw new Error('deployment credentials are unavailable')
if (!redisPassword) throw new Error('DEPLOY_REDIS_PASSWORD is required and is never written to the repository')

const privateKey = privateKeyPath ? await readFile(privateKeyPath) : null
const base64 = value => Buffer.from(value).toString('base64')

function connect() {
  return new Promise((resolve, reject) => {
    const client = new Client()
    client.on('ready', () => resolve(client)).on('error', reject).connect({
      host,
      username: 'root',
      ...(privateKey ? { privateKey } : { password }),
      readyTimeout: 20_000
    })
  })
}

function exec(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(error)
      let output = ''
      stream.on('data', data => { output += data })
      stream.stderr.on('data', data => { output += data })
      stream.on('close', code => code === 0 ? resolve(output) : reject(new Error(output || `remote command failed (${code})`)))
    })
  })
}

function sftpFor(client) {
  return new Promise((resolve, reject) => client.sftp((error, sftp) => error ? reject(error) : resolve(sftp)))
}

function upload(sftp, local, remote) {
  return new Promise((resolve, reject) => sftp.fastPut(local, remote, error => error ? reject(error) : resolve()))
}

async function waitFor(client, command, attempts = 20) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await exec(client, command)
    } catch (error) {
      lastError = error
      if (attempt < attempts - 1) await new Promise(resolve => setTimeout(resolve, 1_000))
    }
  }
  throw lastError
}

const client = await connect()
try {
  const sftp = await sftpFor(client)
  const files = ['server.mjs', 'http-cache.mjs', 'redis-cache.mjs', 'package.json', 'package-lock.json']
  const backup = `${proxyRoot}/.redis-cache-backup-${releaseStamp}`
  const redisEnvironment = [
    'REDIS_HOST=127.0.0.1',
    'REDIS_PORT=6379',
    'REDIS_DB=0',
    'REDIS_KEY_PREFIX=fund-proxy:',
    'REDIS_CONNECT_TIMEOUT_MS=1500',
    `REDIS_PASSWORD=${redisPassword}`,
    ''
  ].join('\n')

  await exec(client, `install -d -m 0755 ${backup} /etc/systemd/system/fund-proxy.service.d`)
  await exec(client, `printf %s ${base64(redisEnvironment)} | base64 -d > /etc/fund-proxy-redis.env; chmod 600 /etc/fund-proxy-redis.env`)
  await exec(client, `printf %s ${base64('[Service]\nEnvironmentFile=-/etc/fund-proxy-redis.env\n')} | base64 -d > /etc/systemd/system/fund-proxy.service.d/redis.conf`)
  for (const file of files) {
    const remote = `${proxyRoot}/${file}`
    await exec(client, `test ! -e ${remote} || cp -p ${remote} ${backup}/${file}`)
    await upload(sftp, join(root, 'server', file), `${remote}.uploading`)
    await exec(client, `mv ${remote}.uploading ${remote}`)
  }

  try {
    await exec(client, `cd ${proxyRoot} && npm ci --omit=dev --no-audit --no-fund && node --check server.mjs && node --check http-cache.mjs && node --check redis-cache.mjs && systemctl daemon-reload && systemctl restart fund-proxy`)
    const health = await waitFor(client, "curl --fail --silent --show-error http://127.0.0.1:3000/api/health")
    const firstHeaders = await exec(client, "curl --fail --silent --show-error -D - -o /dev/null 'http://127.0.0.1:3000/api/funds/000001/nav-history?limit=7'")
    const secondHeaders = await exec(client, "curl --fail --silent --show-error -D - -o /dev/null 'http://127.0.0.1:3000/api/funds/000001/nav-history?limit=7'")
    if (!/X-Cache: redis-miss/i.test(firstHeaders) || !/X-Cache: redis-hit/i.test(secondHeaders) || !/\"ping\":\"PONG\"/.test(health)) {
      throw new Error('Redis connection or response-cache verification failed')
    }
    console.log(JSON.stringify({ success: true, backup, health: JSON.parse(health), first: 'redis-miss', second: 'redis-hit' }))
  } catch (error) {
    for (const file of files) await exec(client, `test ! -e ${backup}/${file} || cp -p ${backup}/${file} ${proxyRoot}/${file}`)
    await exec(client, 'systemctl daemon-reload; systemctl restart fund-proxy').catch(() => {})
    throw error
  }
} finally {
  client.end()
}
