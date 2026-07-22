#!/usr/bin/env bash
set -eu -o pipefail

readonly EXPECTED_COMMIT="${1:?expected upstream commit is required}"
readonly APP_ROOT=/opt/valuation-grid
readonly BASE_ROOT=/var/lib/valuation-grid-upstream-sync/base
readonly BASE_MARKER="${BASE_ROOT}/.upstream-commit"
readonly WORK_ROOT=/var/lib/valuation-grid-upstream-sync/manual-reconcile
readonly CANDIDATE_ROOT="${WORK_ROOT}/candidate"
readonly BACKUP_ROOT="${WORK_ROOT}/backup-$(date -u +%Y%m%d-%H%M%S)"
readonly PYTHON="${APP_ROOT}/.venv/bin/python"
readonly FILES=(
  .gitignore
  app.py
  positions.py
  start_remote.ps1
  data/signal_history.json
)

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

test "$(cat "${BASE_MARKER}")" = "${EXPECTED_COMMIT}"
test -x "${PYTHON}"
rm -rf "${CANDIDATE_ROOT}"
mkdir -p "${CANDIDATE_ROOT}" "${BACKUP_ROOT}"
rsync -a --no-owner --no-group \
  --exclude '.git/' --exclude 'cache/' --exclude '.venv/' --exclude '.venv-next/' --exclude '.venv-previous/' \
  "${APP_ROOT}/" "${CANDIDATE_ROOT}/"

for relative_path in "${FILES[@]}"; do
  test -f "${BASE_ROOT}/${relative_path}"
  mkdir -p "$(dirname "${CANDIDATE_ROOT}/${relative_path}")"
  cp -p "${BASE_ROOT}/${relative_path}" "${CANDIDATE_ROOT}/${relative_path}"
done

"${PYTHON}" - "${CANDIDATE_ROOT}/data/signal_history.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding='utf-8') as handle:
    signals = json.load(handle)
if not isinstance(signals, dict):
    raise SystemExit('signal_history.json must be an object')
PY
"${PYTHON}" -m compileall -q "${CANDIDATE_ROOT}/app.py" "${CANDIDATE_ROOT}/valuation" "${CANDIDATE_ROOT}/grid"
(cd "${CANDIDATE_ROOT}" && "${PYTHON}" -c 'import app')

for relative_path in "${FILES[@]}"; do
  mkdir -p "$(dirname "${BACKUP_ROOT}/${relative_path}")"
  cp -p "${APP_ROOT}/${relative_path}" "${BACKUP_ROOT}/${relative_path}"
  install -o valuationgrid -g valuationgrid -m 0644 \
    "${CANDIDATE_ROOT}/${relative_path}" "${APP_ROOT}/${relative_path}"
done

systemctl restart valuation-grid
if ! wait_for_health; then
  for relative_path in "${FILES[@]}"; do
    install -o valuationgrid -g valuationgrid -m 0644 \
      "${BACKUP_ROOT}/${relative_path}" "${APP_ROOT}/${relative_path}"
  done
  systemctl restart valuation-grid
  wait_for_health || true
  echo 'upstream reconciliation failed health validation and was rolled back' >&2
  exit 1
fi

printf 'reconciled=%s\nbackup=%s\n' "${EXPECTED_COMMIT}" "${BACKUP_ROOT}"
