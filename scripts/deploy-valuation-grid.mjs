import { createRequire } from 'node:module'
import { readdir } from 'node:fs/promises'
import { join, relative, dirname, posix } from 'node:path'

const require = createRequire(import.meta.url)
const { Client } = require('C:\\tmp\\codex-ssh-deploy\\node_modules\\ssh2')

const host = process.env.DEPLOY_SSH_HOST
const password = process.env.DEPLOY_SSH_PASSWORD
const sourceRoot = process.env.DEPLOY_SOURCE_ROOT || join(process.cwd(), 'vendor', 'valuation_grid')
const remoteRoot = '/opt/valuation-grid'

if (!host || !password) {
  throw new Error('DEPLOY_SSH_HOST and DEPLOY_SSH_PASSWORD are required')
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

function getSftp(client) {
  return new Promise((resolve, reject) => client.sftp((error, sftp) => error ? reject(error) : resolve(sftp)))
}

function upload(sftp, localPath, remotePath) {
  return new Promise((resolve, reject) => sftp.fastPut(localPath, remotePath, (error) => error ? reject(error) : resolve()))
}

async function collectFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', '__pycache__', 'data', 'cache'].includes(entry.name)) continue
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collectFiles(fullPath))
    else if (entry.isFile()) files.push(fullPath)
  }
  return files
}

const serviceUnit = `[Unit]
Description=Valuation Grid API
After=network.target

[Service]
User=valuationgrid
Group=valuationgrid
WorkingDirectory=/opt/valuation-grid
Environment=PYTHONUNBUFFERED=1
ExecStart=/opt/valuation-grid/.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8000
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
`

const nginxSite = `server {
    listen 8080;
    server_name _;

    location / {
        allow 10.0.10.0/24;
        allow 127.0.0.1;
        deny all;

        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`

const base64 = (value) => Buffer.from(value).toString('base64')

const client = await connect()
try {
  const installPackages = 'export DEBIAN_FRONTEND=noninteractive && apt-get update && apt-get install -y --no-install-recommends python3-venv nginx'
  try {
    await exec(client, installPackages)
  } catch {
    // The configured mirror can reject archived packages; fall back to Debian's official mirrors.
    await exec(client, "sed -i 's|https://mirrors.tuna.tsinghua.edu.cn/debian-security|https://security.debian.org/debian-security|g; s|https://mirrors.tuna.tsinghua.edu.cn/debian|https://deb.debian.org/debian|g' /etc/apt/sources.list /etc/apt/sources.list.d/*.list 2>/dev/null || true")
    await exec(client, installPackages)
  }
  await exec(client, `id -u valuationgrid >/dev/null 2>&1 || useradd --system --home ${remoteRoot} --shell /usr/sbin/nologin valuationgrid; install -d -o valuationgrid -g valuationgrid ${remoteRoot} ${remoteRoot}/data ${remoteRoot}/cache`)

  const files = await collectFiles(sourceRoot)
  const directories = [...new Set(files.map((file) => dirname(relative(sourceRoot, file))))]
    .filter((directory) => directory !== '.')
    .map((directory) => posix.join(remoteRoot, directory.replaceAll('\\', '/')))
  if (directories.length > 0) await exec(client, `mkdir -p ${directories.join(' ')}`)

  const sftp = await getSftp(client)
  for (const file of files) {
    const remotePath = posix.join(remoteRoot, relative(sourceRoot, file).replaceAll('\\', '/'))
    await upload(sftp, file, remotePath)
  }

  await exec(client, `chown -R valuationgrid:valuationgrid ${remoteRoot}; python3 -m venv ${remoteRoot}/.venv; ${remoteRoot}/.venv/bin/pip install --upgrade pip; ${remoteRoot}/.venv/bin/pip install fastapi uvicorn pydantic requests pillow`)
  await exec(client, `printf %s ${base64(serviceUnit)} | base64 -d > /etc/systemd/system/valuation-grid.service; printf %s ${base64(nginxSite)} | base64 -d > /etc/nginx/sites-available/valuation-grid; ln -sf /etc/nginx/sites-available/valuation-grid /etc/nginx/sites-enabled/valuation-grid; rm -f /etc/nginx/sites-enabled/default; systemctl daemon-reload; systemctl enable --now valuation-grid; nginx -t; systemctl enable --now nginx; systemctl restart nginx`)
  try {
    const health = await exec(client, 'curl --fail --silent --show-error http://127.0.0.1:8000/health')
    console.log(`Deployment complete: ${health.trim()}`)
  } catch (error) {
    const diagnostics = await exec(client, 'systemctl status valuation-grid --no-pager -l || true; journalctl -u valuation-grid -n 60 --no-pager || true')
    throw new Error(`${error.message}\n${diagnostics}`)
  }
} finally {
  client.end()
}
