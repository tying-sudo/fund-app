import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const { Client } = require('C:\\tmp\\codex-ssh-deploy\\node_modules\\ssh2')

const host = process.env.DEPLOY_SSH_HOST
const privateKeyPath = process.env.DEPLOY_SSH_PRIVATE_KEY
const aptMirrorScript = `set -eu
find /etc/apt -maxdepth 2 -type f \\( -name 'sources.list' -o -name '*.list' -o -name '*.sources' \\) -print0 | xargs -0r sed -i \\
  -e 's#https\\?://deb\\.debian\\.org/debian-security#http://mirrors.aliyun.com/debian-security#g' \\
  -e 's#https\\?://security\\.debian\\.org/debian-security#http://mirrors.aliyun.com/debian-security#g' \\
  -e 's#https\\?://mirrors\\.tuna\\.tsinghua\\.edu\\.cn/debian-security#http://mirrors.aliyun.com/debian-security#g' \\
  -e 's#https\\?://deb\\.debian\\.org/debian#http://mirrors.aliyun.com/debian#g' \\
  -e 's#https\\?://mirrors\\.tuna\\.tsinghua\\.edu\\.cn/debian#http://mirrors.aliyun.com/debian#g'
printf '%s\\n' 'Acquire::Retries "2";' 'Acquire::http::Timeout "20";' 'Acquire::https::Timeout "20";' > /etc/apt/apt.conf.d/99-fund-app-network
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl git rsync`

if (!host || !privateKeyPath) {
  throw new Error('DEPLOY_SSH_HOST and DEPLOY_SSH_PRIVATE_KEY are required')
}

function connect() {
  return new Promise((resolve, reject) => {
    const client = new Client()
    client.on('ready', () => resolve(client)).on('error', reject).connect({
      host,
      username: 'root',
      privateKey: readFileSync(privateKeyPath),
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

const syncScript = String.raw`#!/usr/bin/env bash
set -eu -o pipefail

readonly APP_ROOT=/opt/valuation-grid
readonly UPSTREAM_API=https://api.github.com/repos/shangjinma-source/valuation_grid
readonly UPSTREAM_COMMIT_API="\${UPSTREAM_API}/commits/HEAD"
readonly UPSTREAM_GIT=https://github.com/shangjinma-source/valuation_grid.git
readonly WORK_ROOT=/var/lib/valuation-grid-upstream-sync
readonly BASE_ROOT="\${WORK_ROOT}/base"
readonly BASE_MARKER="\${BASE_ROOT}/.upstream-commit"
readonly NEXT_ROOT="\${WORK_ROOT}/next"
readonly CANDIDATE_ROOT="\${WORK_ROOT}/candidate"
readonly PLAN_ROOT="\${WORK_ROOT}/plan"
readonly BACKUP_ROOT="\${WORK_ROOT}/production-backup"
readonly DISABLED_FILE="\${WORK_ROOT}/disabled"
readonly CONFIDENCE_SYNC_MARKER="\${WORK_ROOT}/confidence-source-v1"
readonly PENDING_RELEASE="\${WORK_ROOT}/pending-apk-release"
readonly AUTO_RELEASE=/usr/local/sbin/fund-app-auto-release
readonly LOG_TAG=valuation-grid-upstream-sync

log() { logger -t "\${LOG_TAG}" -- "$*"; printf '%s\n' "$*"; }
run_pending_release() {
  local release_commit release_changed release_conflicts
  [ -s "\${PENDING_RELEASE}" ] || return 0
  if [ ! -x "\${AUTO_RELEASE}" ]; then
    log 'APK auto-release command is unavailable; keeping release pending'
    return 1
  fi
  IFS=$'\t' read -r release_commit release_changed release_conflicts < "\${PENDING_RELEASE}"
  if ! printf '%s:%s:%s' "\${release_commit}" "\${release_changed}" "\${release_conflicts}" \
    | grep -Eq '^[0-9a-f]{40}:[0-9]+:[0-9]+$'; then
    log 'pending APK release metadata is invalid; preserving it for inspection'
    return 1
  fi
  if "\${AUTO_RELEASE}" "\${release_commit}" "\${release_changed}" "\${release_conflicts}"; then
    rm -f "\${PENDING_RELEASE}"
    log "APK release published for upstream \${release_commit}"
    return 0
  fi
  log "APK release failed for upstream \${release_commit}; will retry next interval"
  return 1
}
is_runtime_path() {
  case "$1" in
    # Confidence calibration and signal history are explicitly upstream-owned.
    # The production holdings list is user-owned runtime state and must never
    # be imported from the upstream author's data/positions.json.
    data/confidence_deviations.json|data/signal_history.json) return 1 ;;
    data/positions.json) return 0 ;;
    .git/*|.upstream-commit|__pycache__/*|*.pyc|data/*|cache/*|.venv/*|.venv-next/*|.venv-previous/*) return 0 ;;
    *) return 1 ;;
  esac
}
wait_for_health() {
  local attempt
  for attempt in $(seq 1 20); do
    if curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8000/health >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}
validate_confidence_file() {
  "\${APP_ROOT}/.venv/bin/python" - "$1" <<'PY'
import json
import sys

with open(sys.argv[1], encoding='utf-8') as handle:
    value = json.load(handle)
if not isinstance(value, dict):
    raise SystemExit('confidence deviations must be a JSON object')
PY
}
validate_upstream_state_file() {
  "\${APP_ROOT}/.venv/bin/python" - "$1" "$2" <<'PY'
import json
import sys

path, kind = sys.argv[1:]
with open(path, encoding='utf-8') as handle:
    value = json.load(handle)
if not isinstance(value, dict):
    raise SystemExit(f'{kind} must be a JSON object')
if kind == 'positions' and not isinstance(value.get('funds'), dict):
    raise SystemExit('positions must include a funds object')
PY
}
download_upstream_file() {
  local relative_path="$1"
  local target_file="$2"
  local temporary_file="\${target_file}.download"
  rm -f "\${temporary_file}"

  if curl --location --fail --silent --show-error \
    --connect-timeout 15 --max-time 45 \
    "https://raw.githubusercontent.com/shangjinma-source/valuation_grid/\${next_commit}/\${relative_path}" \
    --output "\${temporary_file}"; then
    mv "\${temporary_file}" "\${target_file}"
    return 0
  fi

  # raw.githubusercontent.com is occasionally unavailable from production.
  # The GitHub API is independently checked above and serves the same commit.
  rm -f "\${temporary_file}"
  if curl --location --fail --silent --show-error --retry 1 --retry-all-errors \
    --connect-timeout 15 --max-time 180 --get \
    --data-urlencode "ref=\${next_commit}" \
    -H 'Accept: application/vnd.github.raw+json' \
    "\${UPSTREAM_API}/contents/\${relative_path}" \
    --output "\${temporary_file}"; then
    mv "\${temporary_file}" "\${target_file}"
    return 0
  fi

  rm -f "\${temporary_file}"
  return 1
}
mkdir -p "\${WORK_ROOT}"

if [ -e "\${DISABLED_FILE}" ]; then
  log 'sync is disabled after an upstream 404'
  exit 0
fi

api_body=$(mktemp)
trap 'rm -f "\${api_body}"; rm -rf "\${NEXT_ROOT}" "\${CANDIDATE_ROOT}" "\${PLAN_ROOT}"' EXIT
http_code=$(curl --location --silent --show-error --connect-timeout 15 --max-time 45 \
  --output "\${api_body}" --write-out '%{http_code}' "\${UPSTREAM_API}" || true)

case "\${http_code}" in
  200) ;;
  404)
    touch "\${DISABLED_FILE}"
    log 'upstream returned 404; disabling timer and preserving current deployment'
    systemctl disable --now valuation-grid-upstream.timer
    exit 0
    ;;
  *)
    log "upstream availability check failed (HTTP \${http_code:-network-error}); will retry next interval"
    exit 1
    ;;
esac

if [ ! -x "\${APP_ROOT}/.venv/bin/python" ]; then
  log 'Python runtime is unavailable; preserving current deployment'
  exit 1
fi

# Seed the merge base after a controlled deployment. The first scheduled run
# never copies upstream content over production, because there is no safe base.
if [ ! -d "\${BASE_ROOT}/.git" ]; then
  rm -rf "\${NEXT_ROOT}" "\${CANDIDATE_ROOT}" "\${PLAN_ROOT}"
  if ! GIT_TERMINAL_PROMPT=0 timeout 60s git \
    -c http.lowSpeedLimit=1024 \
    -c http.lowSpeedTime=20 \
    clone --depth 1 "\${UPSTREAM_GIT}" "\${NEXT_ROOT}"; then
    log 'initial upstream clone failed; preserving current deployment and retrying next interval'
    exit 1
  fi
  mv "\${NEXT_ROOT}" "\${BASE_ROOT}"
  git -C "\${BASE_ROOT}" rev-parse HEAD > "\${BASE_MARKER}"
  log 'initialized upstream merge base; no production files changed'
  exit 0
fi

rm -rf "\${NEXT_ROOT}" "\${CANDIDATE_ROOT}" "\${PLAN_ROOT}"
base_commit=$(cat "\${BASE_MARKER}" 2>/dev/null || git -C "\${BASE_ROOT}" rev-parse HEAD)
commit_body=$(mktemp)
trap 'rm -f "\${api_body}" "\${commit_body}"; rm -rf "\${NEXT_ROOT}" "\${CANDIDATE_ROOT}" "\${PLAN_ROOT}"' EXIT
commit_code=$(curl --location --silent --show-error --connect-timeout 15 --max-time 45 \
  --output "\${commit_body}" --write-out '%{http_code}' "\${UPSTREAM_COMMIT_API}" || true)
if [ "\${commit_code}" != 200 ]; then
  log "upstream commit lookup failed (HTTP \${commit_code:-network-error}); preserving current deployment"
  exit 1
fi
next_commit=$(sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{40\}\)".*/\1/p' "\${commit_body}" | head -n 1)
if [ -z "\${next_commit}" ]; then
  log 'upstream API response did not include a commit SHA; preserving current deployment'
  exit 1
fi
if ! run_pending_release; then
  exit 1
fi
if [ "\${base_commit}" = "\${next_commit}" ]; then
  # Before this allowlist existed, production intentionally skipped all data/.
  # Reconcile this one upstream-owned file once without touching user state.
  if [ ! -e "\${CONFIDENCE_SYNC_MARKER}" ] && [ -f "\${BASE_ROOT}/data/confidence_deviations.json" ]; then
    if ! validate_confidence_file "\${BASE_ROOT}/data/confidence_deviations.json"; then
      log 'upstream confidence data is invalid; preserving current deployment'
      exit 1
    fi
    install -o valuationgrid -g valuationgrid -m 0644 \
      "\${BASE_ROOT}/data/confidence_deviations.json" \
      "\${APP_ROOT}/data/confidence_deviations.json"
    systemctl restart valuation-grid
    if ! wait_for_health; then
      log 'health check failed after initial confidence reconciliation'
      exit 1
    fi
    touch "\${CONFIDENCE_SYNC_MARKER}"
    log 'reconciled upstream confidence data for the current baseline'
    exit 0
  fi
  printf '%s\n' "\${next_commit}" > "\${BASE_MARKER}"
  log 'upstream source is unchanged'
  exit 0
fi

compare_body=$(mktemp)
trap 'rm -f "\${api_body}" "\${commit_body}" "\${compare_body}"; rm -rf "\${NEXT_ROOT}" "\${CANDIDATE_ROOT}" "\${PLAN_ROOT}"' EXIT
compare_code=$(curl --location --silent --show-error --connect-timeout 15 --max-time 45 \
  --output "\${compare_body}" --write-out '%{http_code}' \
  "\${UPSTREAM_API}/compare/\${base_commit}...\${next_commit}" || true)
if [ "\${compare_code}" != 200 ]; then
  log "upstream compare failed (HTTP \${compare_code:-network-error}); preserving current deployment"
  exit 1
fi

mkdir -p "\${NEXT_ROOT}"
rsync -a --no-owner --no-group --exclude '.git/' --exclude '.upstream-commit' \
  "\${BASE_ROOT}/" "\${NEXT_ROOT}/"
if ! "\${APP_ROOT}/.venv/bin/python" - "\${compare_body}" > "\${WORK_ROOT}/changed-files" <<'PY'
import json
import sys

with open(sys.argv[1], encoding='utf-8') as handle:
    payload = json.load(handle)
files = payload.get('files', [])
if not files or len(files) > 300:
    raise SystemExit(2)
for item in files:
    status = item.get('status')
    filename = item.get('filename')
    previous = item.get('previous_filename', '')
    if status not in {'added', 'modified', 'removed', 'renamed'} or not filename:
        raise SystemExit(3)
    print(f'{status}\t{filename}\t{previous}')
PY
then
  log 'upstream compare contains no supported incremental file plan; preserving current deployment'
  exit 1
fi

while IFS=$'\t' read -r change_status relative_path previous_path; do
  case "\${relative_path}" in
    *'..'*|/*) log "unsafe upstream path rejected: \${relative_path}"; exit 1 ;;
  esac
  if [ "\${change_status}" = removed ]; then
    rm -f "\${NEXT_ROOT}/\${relative_path}"
    continue
  fi
  if [ "\${change_status}" = renamed ] && [ -n "\${previous_path}" ]; then
    rm -f "\${NEXT_ROOT}/\${previous_path}"
  fi
  mkdir -p "$(dirname "\${NEXT_ROOT}/\${relative_path}")"
  if ! download_upstream_file "\${relative_path}" "\${NEXT_ROOT}/\${relative_path}"; then
    log "failed to download changed upstream file: \${relative_path}"
    exit 1
  fi
done < "\${WORK_ROOT}/changed-files"

mkdir -p "\${CANDIDATE_ROOT}" "\${PLAN_ROOT}"
rsync -a --no-owner --no-group --exclude '.git/' --exclude 'data/' --exclude 'cache/' \
  --exclude '.venv/' --exclude '.venv-next/' --exclude '.venv-previous/' \
  "\${APP_ROOT}/" "\${CANDIDATE_ROOT}/"
if [ -f "\${APP_ROOT}/data/confidence_deviations.json" ]; then
  mkdir -p "\${CANDIDATE_ROOT}/data"
  cp -p "\${APP_ROOT}/data/confidence_deviations.json" "\${CANDIDATE_ROOT}/data/confidence_deviations.json"
fi

changed=0
upstream_overrides=0
while IFS= read -r relative_path; do
  relative_path="\${relative_path#./}"
  is_runtime_path "\${relative_path}" && continue
  base_file="\${BASE_ROOT}/\${relative_path}"
  next_file="\${NEXT_ROOT}/\${relative_path}"
  production_file="\${APP_ROOT}/\${relative_path}"
  candidate_file="\${CANDIDATE_ROOT}/\${relative_path}"

  if [ -f "\${base_file}" ] && [ -f "\${next_file}" ] && cmp -s "\${base_file}" "\${next_file}"; then
    continue
  fi

  changed=$((changed + 1))
  if [ "\${relative_path}" = 'demo.html' ]; then
    log 'preserved local demo.html frontend UI while syncing upstream backend logic'
    continue
  fi
  if [ "\${relative_path}" = 'data/confidence_deviations.json' ]; then
    if [ ! -f "\${next_file}" ]; then
      log 'upstream removed confidence data; preserving production file'
    elif ! validate_confidence_file "\${next_file}"; then
      log 'invalid upstream confidence data; preserving production file'
    else
      cp -p "\${next_file}" "\${candidate_file}"
      printf 'copy\t%s\n' "\${relative_path}" >> "\${PLAN_ROOT}/apply"
    fi
    continue
  fi
  if [ "\${relative_path}" = 'data/signal_history.json' ]; then
    if ! validate_upstream_state_file "\${next_file}" signals; then
      log "invalid upstream state file; preserving production file: \${relative_path}"
      exit 1
    fi
  fi
  if [ ! -e "\${next_file}" ]; then
    if [ -e "\${production_file}" ] && { [ ! -f "\${base_file}" ] || ! cmp -s "\${base_file}" "\${production_file}"; }; then
      upstream_overrides=$((upstream_overrides + 1))
      log "upstream deletion selected over local conflict: \${relative_path}"
    fi
    printf 'delete\t%s\n' "\${relative_path}" >> "\${PLAN_ROOT}/apply"
    rm -f "\${candidate_file}"
    continue
  fi

  mkdir -p "$(dirname "\${candidate_file}")"
  if [ -e "\${production_file}" ] && { [ ! -f "\${base_file}" ] || ! cmp -s "\${production_file}" "\${base_file}"; }; then
    upstream_overrides=$((upstream_overrides + 1))
    log "upstream version selected over local conflict: \${relative_path}"
  fi
  cp -p "\${next_file}" "\${candidate_file}"
  printf 'copy\t%s\n' "\${relative_path}" >> "\${PLAN_ROOT}/apply"
done < <( { cd "\${BASE_ROOT}" && find . -type f -print; cd "\${NEXT_ROOT}" && find . -type f -print; } | sort -u)

if ! "\${APP_ROOT}/.venv/bin/python" -m compileall -q "\${CANDIDATE_ROOT}/app.py" "\${CANDIDATE_ROOT}/valuation" "\${CANDIDATE_ROOT}/grid"; then
  log 'upstream candidate Python validation failed; preserving current deployment'
  exit 1
fi
if ! (cd "\${CANDIDATE_ROOT}" && "\${APP_ROOT}/.venv/bin/python" -c 'import app'); then
  log 'upstream candidate FastAPI import validation failed; preserving current deployment'
  exit 1
fi

if [ -f "\${PLAN_ROOT}/apply" ]; then
  rm -rf "\${BACKUP_ROOT}"
  mkdir -p "\${BACKUP_ROOT}/files"
  while IFS=$'\t' read -r action relative_path; do
    production_file="\${APP_ROOT}/\${relative_path}"
    candidate_file="\${CANDIDATE_ROOT}/\${relative_path}"
    backup_file="\${BACKUP_ROOT}/files/\${relative_path}"
    if [ -e "\${production_file}" ]; then
      mkdir -p "$(dirname "\${backup_file}")"
      cp -p "\${production_file}" "\${backup_file}"
      printf 'restore\t%s\n' "\${relative_path}" >> "\${BACKUP_ROOT}/rollback"
    else
      printf 'delete\t%s\n' "\${relative_path}" >> "\${BACKUP_ROOT}/rollback"
    fi
    if [ "\${action}" = delete ]; then
      rm -f "\${production_file}"
    else
      mkdir -p "$(dirname "\${production_file}")"
      install -o valuationgrid -g valuationgrid -m 0644 "\${candidate_file}" "\${production_file}"
    fi
  done < "\${PLAN_ROOT}/apply"
  systemctl restart valuation-grid
else
  rsync -a --delete --exclude '.git/' --exclude '.upstream-commit' "\${NEXT_ROOT}/" "\${BASE_ROOT}/"
  printf '%s\n' "\${next_commit}" > "\${BASE_MARKER}"
  log "upstream changed only protected runtime files; no source deployment required"
  exit 0
fi

if ! wait_for_health; then
  log 'health check failed after upstream sync; restoring previous production source'
  while IFS=$'\t' read -r rollback_action relative_path; do
    production_file="\${APP_ROOT}/\${relative_path}"
    backup_file="\${BACKUP_ROOT}/files/\${relative_path}"
    if [ "\${rollback_action}" = restore ]; then
      mkdir -p "$(dirname "\${production_file}")"
      install -o valuationgrid -g valuationgrid -m 0644 "\${backup_file}" "\${production_file}"
    else
      rm -f "\${production_file}"
    fi
  done < "\${BACKUP_ROOT}/rollback"
  systemctl restart valuation-grid
  wait_for_health || log 'rollback completed but valuation-grid health is still failing'
  exit 1
fi

rsync -a --delete --exclude '.git/' --exclude '.upstream-commit' "\${NEXT_ROOT}/" "\${BASE_ROOT}/"
printf '%s\n' "\${next_commit}" > "\${BASE_MARKER}"
log "upstream incremental sync completed: \${changed} changed, \${upstream_overrides} conflicts resolved with upstream"
printf '%s\t%s\t%s\n' "\${next_commit}" "\${changed}" "\${upstream_overrides}" > "\${PENDING_RELEASE}"
if ! run_pending_release; then
  exit 1
fi
`.replaceAll('\\${', '${')

const serviceUnit = `[Unit]
Description=Synchronize Valuation Grid upstream source
After=network-online.target valuation-grid.service
Wants=network-online.target

[Service]
Type=oneshot
User=root
ExecStart=/usr/local/sbin/valuation-grid-upstream-sync
TimeoutStartSec=45min
`

const timerUnit = `[Unit]
Description=Run Valuation Grid upstream sync every 15 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=15min
Persistent=true
Unit=valuation-grid-upstream.service

[Install]
WantedBy=timers.target
`

const base64 = (value) => Buffer.from(value).toString('base64')
const client = await connect()

try {
  await exec(client, `printf %s ${base64(aptMirrorScript)} | base64 -d | bash`)
  await exec(client, `printf %s ${base64(syncScript)} | base64 -d > /tmp/valuation-grid-upstream-sync && bash -n /tmp/valuation-grid-upstream-sync && install -o root -g root -m 0750 /tmp/valuation-grid-upstream-sync /usr/local/sbin/valuation-grid-upstream-sync && rm -f /tmp/valuation-grid-upstream-sync`)
  await exec(client, `printf %s ${base64(serviceUnit)} | base64 -d > /etc/systemd/system/valuation-grid-upstream.service`)
  await exec(client, `printf %s ${base64(timerUnit)} | base64 -d > /etc/systemd/system/valuation-grid-upstream.timer`)
  await exec(client, 'rm -f /var/lib/valuation-grid-upstream-sync/disabled && systemctl daemon-reload && systemctl enable --now valuation-grid-upstream.timer')
  let initialRun = 'Initial upstream sync completed.'
  try {
    await exec(client, 'systemctl start valuation-grid-upstream.service')
  } catch {
    initialRun = 'Initial upstream sync was deferred after a transient or upstream failure; the timer will retry.'
  }
  const status = await exec(client, 'test "$(systemctl is-enabled valuation-grid-upstream.timer)" = enabled; test "$(systemctl is-active valuation-grid-upstream.timer)" = active; test "$(systemctl is-active valuation-grid)" = active; curl --fail --silent --show-error --max-time 15 http://127.0.0.1:8000/health; systemctl status valuation-grid-upstream.service --no-pager -n 12 || true')
  console.log(`${initialRun}\n${status.trim()}`)
} finally {
  client.end()
}
