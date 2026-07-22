import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'

const require = createRequire(import.meta.url)
const { Client } = require('C:\\tmp\\codex-ssh-deploy\\node_modules\\ssh2')

const host = process.env.DEPLOY_SSH_HOST
const password = process.env.DEPLOY_SSH_PASSWORD
const publicKeyPath = process.env.DEPLOY_SSH_PUBLIC_KEY

if (!host || !password || !publicKeyPath) {
  throw new Error('DEPLOY_SSH_HOST, DEPLOY_SSH_PASSWORD, and DEPLOY_SSH_PUBLIC_KEY are required')
}

const publicKey = (await readFile(publicKeyPath, 'utf8')).trim()
const encodedKey = Buffer.from(publicKey).toString('base64')

const client = new Client()
await new Promise((resolve, reject) => {
  client.on('ready', resolve).on('error', reject).connect({ host, username: 'root', password, readyTimeout: 20_000 })
})

try {
  const command = `install -d -m 700 /root/.ssh && touch /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys && key="$(printf %s ${encodedKey} | base64 -d)" && (grep -qxF "$key" /root/.ssh/authorized_keys || printf '%s\\n' "$key" >> /root/.ssh/authorized_keys)`
  await new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(error)
      let output = ''
      stream.on('data', (data) => { output += data })
      stream.stderr.on('data', (data) => { output += data })
      stream.on('close', (code) => code === 0 ? resolve() : reject(new Error(output || `Remote command failed (${code})`)))
    })
  })
  console.log('Deployment key installed.')
} finally {
  client.end()
}
