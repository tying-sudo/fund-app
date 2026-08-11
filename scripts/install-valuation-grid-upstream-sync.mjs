import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { Client } = require('C:\\tmp\\codex-ssh-deploy\\node_modules\\ssh2')

const host = process.env.DEPLOY_SSH_HOST
const user = process.env.DEPLOY_SSH_USER || 'root'
const privateKeyPath = process.env.DEPLOY_SSH_PRIVATE_KEY
const scriptRoot = dirname(fileURLToPath(import.meta.url))
const syncScript = readFileSync(join(scriptRoot, 'remote', 'valuation-grid-upstream-sync.sh'))
const jsonMerger = readFileSync(join(scriptRoot, 'remote', 'merge-valuation-grid-json.py'))
const installerTransaction = readFileSync(join(scriptRoot, 'remote', 'valuation-grid-upstream-installer-transaction.sh'))

if (!host || !privateKeyPath) {
  throw new Error('DEPLOY_SSH_HOST and DEPLOY_SSH_PRIVATE_KEY are required')
}

const serviceUnit = `[Unit]
Description=Merge Valuation Grid upstream into production
After=network-online.target valuation-grid.service
Wants=network-online.target

[Service]
Type=oneshot
User=root
ExecStart=/usr/local/sbin/valuation-grid-upstream-sync
TimeoutStartSec=45min
Nice=10
IOSchedulingClass=idle
`

const timerUnit = `[Unit]
Description=Check Valuation Grid upstream every 15 minutes

[Timer]
OnBootSec=5min
OnUnitInactiveSec=15min
RandomizedDelaySec=60
Persistent=true
Unit=valuation-grid-upstream.service

[Install]
WantedBy=timers.target
`

function connect () {
  return new Promise((resolve, reject) => {
    const client = new Client()
    client.on('ready', () => resolve(client)).on('error', reject).connect({
      host,
      username: user,
      privateKey: readFileSync(privateKeyPath),
      readyTimeout: 20_000
    })
  })
}

function execResult (client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(error)
      let output = ''
      const append = (data) => {
        if (output.length < 128_000) output += data.toString()
      }
      stream.on('data', append)
      stream.stderr.on('data', append)
      stream.on('close', (code) => resolve({ code, output }))
    })
  })
}

async function exec (client, command) {
  const result = await execResult(client, command)
  if (result.code !== 0) {
    throw new Error(result.output.trim() || `Remote command failed (${result.code})`)
  }
  return result.output
}

function upload (client, remotePath, contents) {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) return reject(error)
      sftp.writeFile(remotePath, contents, { mode: 0o600 }, (writeError) => {
        if (writeError) reject(writeError)
        else resolve()
      })
    })
  })
}

const client = await connect()
const suffix = `${Date.now()}-${process.pid}`
const remoteSync = `/tmp/valuation-grid-upstream-sync-${suffix}`
const remoteMerger = `/tmp/valuation-grid-json-merge-${suffix}`
const remoteTransaction = `/tmp/valuation-grid-upstream-installer-${suffix}`
const remoteService = `/tmp/valuation-grid-upstream-${suffix}.service`
const remoteTimer = `/tmp/valuation-grid-upstream-${suffix}.timer`
const backupRoot = `/var/backups/valuation-grid-upstream-installer/${suffix}`
const remoteCleanup = [remoteSync, remoteMerger, remoteTransaction, remoteService, remoteTimer]
  .map((path) => `'${path}'`)
  .join(' ')

try {
  await exec(client, 'for command_name in awk bash chown cmp cp curl find flock git install logger mkdir mv rm rsync runuser sed seq sha256sum sort stat systemctl timeout tr xargs python3; do command -v "$command_name" >/dev/null || { echo "missing prerequisite: $command_name" >&2; exit 1; }; done')
  await Promise.all([
    upload(client, remoteSync, syncScript),
    upload(client, remoteMerger, jsonMerger),
    upload(client, remoteTransaction, installerTransaction),
    upload(client, remoteService, Buffer.from(serviceUnit)),
    upload(client, remoteTimer, Buffer.from(timerUnit))
  ])

  await exec(client, `bash -n '${remoteSync}' && bash -n '${remoteTransaction}' && python3 -m py_compile '${remoteMerger}'`)
  const install = await execResult(client, `bash '${remoteTransaction}' install '${backupRoot}' /var/lib/valuation-grid-upstream-sync '${remoteSync}' '${remoteMerger}' '${remoteService}' '${remoteTimer}' /usr/local/sbin/valuation-grid-upstream-sync /usr/local/libexec/valuation-grid-json-merge /etc/systemd/system/valuation-grid-upstream.service /etc/systemd/system/valuation-grid-upstream.timer`)
  if (install.code !== 0) {
    const diagnostics = await execResult(client, 'systemctl show valuation-grid-upstream.service -p Result -p ExecMainStatus -p ActiveState -p SubState --no-pager; journalctl -u valuation-grid-upstream.service -n 30 --no-pager --output=cat')
    throw new Error(`Upstream synchronization failed and the installer transaction was rolled back.\n${diagnostics.output.trim()}\n${install.output.trim()}`)
  }

  const status = await exec(client, 'systemctl is-enabled valuation-grid-upstream.timer; systemctl is-active valuation-grid-upstream.timer; systemctl is-active valuation-grid; systemctl show valuation-grid-upstream.service -p Result -p ExecMainStatus --no-pager; curl --fail --silent --show-error --max-time 15 http://127.0.0.1:8000/health; tail -n 1 /var/lib/valuation-grid-upstream-sync/base-commit')
  console.log(`Installed and ran valuation-grid upstream merge sync.\n${status.trim()}`)
} finally {
  await execResult(client, `rm -f -- ${remoteCleanup}`).catch(() => {})
  client.end()
}
