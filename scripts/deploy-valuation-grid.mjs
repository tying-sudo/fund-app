import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { Client } = require('C:\\tmp\\codex-ssh-deploy\\node_modules\\ssh2')
const root = process.cwd()
const gridRoot = join(root, 'vendor', 'valuation_grid')
const gridRemote = '/opt/valuation-grid'
const releaseStamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
const backupRoot = `${gridRemote}/.release-backup-${releaseStamp}`
const gridFiles = [
  'app.py',
  'positions.py',
  'realtime_store.py',
  'valuation/core.py',
  'valuation/providers.py'
]

async function envValue(name) {
  for (const file of ['.env.production.local', '.env.local']) {
    const content = await readFile(join(root, file), 'utf8').catch(() => '')
    const match = content.match(new RegExp(`^${name}=(.*)$`, 'm'))
    if (match?.[1]) return match[1].trim().replace(/^['"]|['"]$/g, '')
  }
  return process.env[name] || ''
}

const host = await envValue('DEPLOY_SSH_HOST')
const privateKeyPath = await envValue('DEPLOY_SSH_PRIVATE_KEY')
const password = await envValue('DEPLOY_SSH_PASSWORD')
if (!host || (!privateKeyPath && !password)) throw new Error('Deployment credentials are unavailable')

const privateKey = privateKeyPath ? await readFile(privateKeyPath) : null

function connect() {
  return new Promise((resolve, reject) => {
    const client = new Client()
    client.on('ready', () => resolve(client)).on('error', reject).connect({
      host,
      username: 'root',
      ...(privateKey ? { privateKey } : { password }),
      readyTimeout: 20_000,
    })
  })
}

function exec(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(error)
      let output = ''
      stream.on('data', (data) => { output += data })
      stream.stderr.on('data', (data) => { output += data })
      stream.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(output || `Remote command failed (${code})`)))
    })
  })
}

function getSftp(client) {
  return new Promise((resolve, reject) => client.sftp((error, sftp) => error ? reject(error) : resolve(sftp)))
}

function upload(sftp, localPath, remotePath) {
  return new Promise((resolve, reject) => sftp.fastPut(localPath, remotePath, (error) => error ? reject(error) : resolve()))
}

async function waitForHealth(client, attempts = 20) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await exec(client, 'curl --fail --silent --show-error http://127.0.0.1:8000/v1/health')
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }
  throw lastError
}

const client = await connect()
try {
  const sftp = await getSftp(client)
  await exec(client, `test -d ${gridRemote}; install -d -m 0755 ${backupRoot}`)
  for (const file of gridFiles) {
    const localPath = join(gridRoot, file)
    const remotePath = `${gridRemote}/${file}`
    const backupPath = `${backupRoot}/${file}`
    await exec(client, `if test -e ${remotePath}; then install -d -m 0755 $(dirname ${backupPath}); cp -p ${remotePath} ${backupPath}; fi`)
    await upload(sftp, localPath, `${remotePath}.uploading`)
    await exec(client, `mv ${remotePath}.uploading ${remotePath}`)
  }

  try {
    await exec(client, `cd ${gridRemote} && .venv/bin/python -m py_compile app.py positions.py valuation/providers.py && .venv/bin/python -c "import app" && systemctl restart valuation-grid`)
    const health = (await waitForHealth(client)).trim()
    console.log(JSON.stringify({ success: true, backupRoot, health }))
  } catch (error) {
    for (const file of gridFiles) {
      await exec(client, `cp -p ${backupRoot}/${file} ${gridRemote}/${file}`).catch(() => {})
    }
    await exec(client, 'systemctl restart valuation-grid').catch(() => {})
    throw error
  }
} finally {
  client.end()
}
