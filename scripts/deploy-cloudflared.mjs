import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Client } = require('C:\\tmp\\codex-ssh-deploy\\node_modules\\ssh2')

const host = process.env.DEPLOY_SSH_HOST
const password = process.env.DEPLOY_SSH_PASSWORD
const tunnelToken = process.env.CLOUDFLARED_TUNNEL_TOKEN

if (!host || !password || !tunnelToken) {
  throw new Error('DEPLOY_SSH_HOST, DEPLOY_SSH_PASSWORD, and CLOUDFLARED_TUNNEL_TOKEN are required')
}

function connect() {
  return new Promise((resolve, reject) => {
    const client = new Client()
    client.on('ready', () => resolve(client)).on('error', reject).connect({
      host,
      username: 'root',
      password,
      readyTimeout: 20_000
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

const serviceUnit = `[Unit]
Description=Cloudflare Tunnel for Fund App
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/cloudflared/fund-app.env
ExecStart=/usr/local/bin/cloudflared tunnel --no-autoupdate run --token $CLOUDFLARED_TUNNEL_TOKEN
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`

const base64 = (value) => Buffer.from(value).toString('base64')
const client = await connect()
try {
  await exec(client, 'command -v cloudflared >/dev/null')
  await exec(client, `install -d -m 700 /etc/cloudflared; printf %s ${base64(`CLOUDFLARED_TUNNEL_TOKEN=${tunnelToken}\n`)} | base64 -d > /etc/cloudflared/fund-app.env; chmod 600 /etc/cloudflared/fund-app.env; printf %s ${base64(serviceUnit)} | base64 -d > /etc/systemd/system/fund-app-tunnel.service; systemctl daemon-reload; systemctl enable fund-app-tunnel; systemctl restart fund-app-tunnel; sleep 5; systemctl is-active --quiet fund-app-tunnel`)
  console.log('Cloudflare Tunnel service is active')
} finally {
  client.end()
}
