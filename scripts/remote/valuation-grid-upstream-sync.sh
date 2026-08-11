#!/usr/bin/env bash
set -Eeuo pipefail

umask 027

readonly APP_ROOT=/opt/valuation-grid
readonly APP_SERVICE=valuation-grid.service
readonly UPSTREAM_GIT=https://github.com/shangjinma-source/valuation_grid.git
readonly UPSTREAM_BRANCH=main
readonly WORK_ROOT=/var/lib/valuation-grid-upstream-sync
readonly REPO_ROOT="${WORK_ROOT}/repo"
readonly LEGACY_MARKER="${WORK_ROOT}/base/.upstream-commit"
readonly BASE_MARKER="${WORK_ROOT}/base-commit"
readonly MERGE_ROOT="${WORK_ROOT}/merge"
readonly CANDIDATE_ROOT="${WORK_ROOT}/candidate"
readonly PLAN_ROOT="${WORK_ROOT}/plan"
readonly BACKUP_PARENT=/var/backups/valuation-grid-upstream
readonly LOCK_FILE=/run/lock/valuation-grid-upstream-sync.lock
readonly JSON_MERGER=/usr/local/libexec/valuation-grid-json-merge
readonly APP_PYTHON="${APP_ROOT}/.venv/bin/python"
readonly POSITIONS_PATH=data/positions.json
readonly LOG_TAG=valuation-grid-upstream-sync

service_stopped=0
apply_started=0
deployment_committed=0
backup_root=

log() {
  logger -t "${LOG_TAG}" -- "$*"
  printf '%s\n' "$*"
}

wait_for_health() {
  local attempt
  for attempt in $(seq 1 30); do
    if curl --fail --silent --show-error --max-time 5 \
      http://127.0.0.1:8000/health >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if [ "${apply_started}" -eq 1 ] && [ "${deployment_committed}" -eq 0 ] \
    && [ -n "${backup_root}" ] && [ -f "${backup_root}/rollback" ]; then
    systemctl stop "${APP_SERVICE}" >/dev/null 2>&1 || true
    service_stopped=1
    rollback_files
  fi
  if [ "${service_stopped}" -eq 1 ]; then
    systemctl start "${APP_SERVICE}" >/dev/null 2>&1 || true
  fi
  if [ -d "${REPO_ROOT}/.git" ]; then
    git -C "${REPO_ROOT}" worktree remove --force "${MERGE_ROOT}" >/dev/null 2>&1 || true
    git -C "${REPO_ROOT}" worktree prune >/dev/null 2>&1 || true
  fi
  rm -rf -- "${MERGE_ROOT}" "${CANDIDATE_ROOT}" "${PLAN_ROOT}"
  exit "${status}"
}
trap cleanup EXIT

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    log "required command is unavailable: $1"
    exit 1
  }
}

safe_relative_path() {
  local path=$1
  case "${path}" in
    ''|/*|..|../*|*/..|*/../*|*$'\n'*|*$'\r'*|*$'\t'*) return 1 ;;
    *) return 0 ;;
  esac
}

rollback_files() {
  local rollback_action relative_path production_file backup_file file_mode
  while IFS=$'\t' read -r rollback_action relative_path; do
    [ -n "${relative_path}" ] || continue
    production_file="${APP_ROOT}/${relative_path}"
    backup_file="${backup_root}/files/${relative_path}"
    if [ "${rollback_action}" = restore ]; then
      mkdir -p -- "$(dirname "${production_file}")"
      file_mode=$(stat -c '%a' "${backup_file}")
      install -o valuationgrid -g valuationgrid -m "${file_mode}" \
        "${backup_file}" "${production_file}"
    else
      rm -f -- "${production_file}"
    fi
  done < "${backup_root}/rollback"
}

candidate_manifest() {
  (
    cd "${CANDIDATE_ROOT}"
    find . -type f -not -path './__pycache__/*' -not -name '*.pyc' -print0 \
      | sort -z | xargs -0r sha256sum
  ) | sha256sum | awk '{print $1}'
}

production_manifest() {
  local relative_path source_path
  while IFS= read -r -d '' relative_path; do
    [ "${relative_path}" = "${POSITIONS_PATH}" ] && continue
    source_path="${APP_ROOT}/${relative_path}"
    if [ -L "${source_path}" ]; then
      printf '%s\tsymlink\n' "${relative_path}"
    elif [ -f "${source_path}" ]; then
      printf '%s\t%s\n' "${relative_path}" "$(sha256sum "${source_path}" | awk '{print $1}')"
    else
      printf '%s\tmissing\n' "${relative_path}"
    fi
  done < "${WORK_ROOT}/union-paths" | sha256sum | awk '{print $1}'
}

copy_production_path() {
  local relative_path=$1
  local source_path="${APP_ROOT}/${relative_path}"
  local target_path="${MERGE_ROOT}/${relative_path}"

  if [ -L "${source_path}" ]; then
    log "production symlink rejected: ${relative_path}"
    exit 1
  fi
  if [ -e "${source_path}" ] && [ ! -f "${source_path}" ]; then
    log "production path is not a regular file: ${relative_path}"
    exit 1
  fi
  if [ -f "${source_path}" ]; then
    mkdir -p -- "$(dirname "${target_path}")"
    rm -f -- "${target_path}"
    cp -p -- "${source_path}" "${target_path}"
  else
    rm -f -- "${target_path}"
  fi
}

restore_upstream_positions_in_merge() {
  local target_path="${MERGE_ROOT}/${POSITIONS_PATH}"

  if git -C "${REPO_ROOT}" cat-file -e "${next_commit}:${POSITIONS_PATH}" 2>/dev/null; then
    git -C "${MERGE_ROOT}" checkout "${next_commit}" -- "${POSITIONS_PATH}"
  else
    rm -f -- "${target_path}"
    git -C "${MERGE_ROOT}" rm --cached --ignore-unmatch -- "${POSITIONS_PATH}" >/dev/null
  fi
}

exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  log 'another upstream synchronization is still running'
  exit 0
fi

for command_name in curl git rsync flock sort sha256sum systemctl timeout runuser find xargs chown; do
  require_command "${command_name}"
done
[ -x "${JSON_MERGER}" ] || { log 'JSON merge helper is unavailable'; exit 1; }
[ -x "${APP_PYTHON}" ] || { log 'application Python runtime is unavailable'; exit 1; }
systemctl is-active --quiet "${APP_SERVICE}" || {
  log 'valuation-grid is not active; refusing to synchronize'
  exit 1
}

mkdir -p "${WORK_ROOT}" "${BACKUP_PARENT}"
if [ ! -d "${REPO_ROOT}/.git" ]; then
  temporary_repo="${WORK_ROOT}/repo.new"
  rm -rf -- "${temporary_repo}"
  if ! GIT_TERMINAL_PROMPT=0 timeout 120s git clone --no-checkout \
    "${UPSTREAM_GIT}" "${temporary_repo}"; then
    log 'initial upstream clone failed; production was not changed'
    exit 1
  fi
  mv "${temporary_repo}" "${REPO_ROOT}"
fi

if ! GIT_TERMINAL_PROMPT=0 timeout 120s git -C "${REPO_ROOT}" fetch --prune origin \
  "+refs/heads/${UPSTREAM_BRANCH}:refs/remotes/origin/${UPSTREAM_BRANCH}"; then
  log 'upstream fetch failed; production was not changed'
  exit 1
fi
next_commit=$(git -C "${REPO_ROOT}" rev-parse "refs/remotes/origin/${UPSTREAM_BRANCH}")

if [ ! -s "${BASE_MARKER}" ] && [ -s "${LEGACY_MARKER}" ]; then
  cp -p "${LEGACY_MARKER}" "${BASE_MARKER}"
fi
if [ ! -s "${BASE_MARKER}" ]; then
  printf '%s\n' "${next_commit}" > "${BASE_MARKER}"
  log "initialized upstream merge base at ${next_commit}; production was not changed"
  exit 0
fi

base_commit=$(tr -d '\r\n' < "${BASE_MARKER}")
if ! printf '%s' "${base_commit}" | grep -Eq '^[0-9a-f]{40}$'; then
  log 'upstream merge-base marker is invalid'
  exit 1
fi
if ! git -C "${REPO_ROOT}" cat-file -e "${base_commit}^{commit}" 2>/dev/null; then
  log "recorded merge base is unavailable: ${base_commit}"
  exit 1
fi
if ! git -C "${REPO_ROOT}" merge-base --is-ancestor "${base_commit}" "${next_commit}"; then
  log 'upstream history is not a fast-forward from the recorded base'
  exit 1
fi
if [ "${base_commit}" = "${next_commit}" ]; then
  log "upstream source is unchanged at ${next_commit}"
  exit 0
fi

if ! { git -C "${REPO_ROOT}" ls-tree -r "${base_commit}"; git -C "${REPO_ROOT}" ls-tree -r "${next_commit}"; } | awk '
  $2 != "blob" || ($1 != "100644" && $1 != "100755") { print; invalid=1 }
  END { exit invalid }
' > "${WORK_ROOT}/invalid-tree-entries"; then
  log 'upstream contains a symlink, submodule, or unsupported file mode'
  sed -n '1,10p' "${WORK_ROOT}/invalid-tree-entries"
  exit 1
fi

positions_before=missing
if [ -f "${APP_ROOT}/${POSITIONS_PATH}" ]; then
  positions_before=$(sha256sum "${APP_ROOT}/${POSITIONS_PATH}" | awk '{print $1}')
fi

rm -rf -- "${MERGE_ROOT}" "${CANDIDATE_ROOT}" "${PLAN_ROOT}"
git -C "${REPO_ROOT}" worktree prune
git -C "${REPO_ROOT}" worktree add --detach "${MERGE_ROOT}" "${base_commit}" >/dev/null
git -C "${MERGE_ROOT}" config user.name valuation-grid-sync
git -C "${MERGE_ROOT}" config user.email valuation-grid-sync@localhost

git -C "${REPO_ROOT}" ls-tree -r --name-only -z "${base_commit}" > "${WORK_ROOT}/base-paths"
git -C "${REPO_ROOT}" ls-tree -r --name-only -z "${next_commit}" > "${WORK_ROOT}/next-paths"
sort -zu "${WORK_ROOT}/base-paths" "${WORK_ROOT}/next-paths" > "${WORK_ROOT}/union-paths"

while IFS= read -r -d '' relative_path; do
  safe_relative_path "${relative_path}" || {
    log "unsafe upstream path rejected: ${relative_path}"
    exit 1
  }
  [ "${relative_path}" = "${POSITIONS_PATH}" ] || copy_production_path "${relative_path}"
done < "${WORK_ROOT}/union-paths"

git -C "${MERGE_ROOT}" add -A
if ! git -C "${MERGE_ROOT}" diff --cached --quiet; then
  git -C "${MERGE_ROOT}" commit -m 'Snapshot current production for upstream merge' >/dev/null
fi

other_timestamp=$(git -C "${REPO_ROOT}" show -s --format=%cI "${next_commit}")
git -C "${MERGE_ROOT}" config merge.valuation-json.name 'Structured three-way JSON merge'
git -C "${MERGE_ROOT}" config merge.valuation-json.driver \
  "${JSON_MERGER} --ancestor %O --current %A --other %B --path %P --other-timestamp ${other_timestamp}"
git -C "${MERGE_ROOT}" config merge.keep-production.name 'Keep production positions'
git -C "${MERGE_ROOT}" config merge.keep-production.driver true
attributes_path=$(git -C "${MERGE_ROOT}" rev-parse --git-path info/attributes)
mkdir -p "$(dirname "${attributes_path}")"
printf '%s\n' '*.json merge=valuation-json' 'data/positions.json merge=keep-production' > "${attributes_path}"

set +e
git -C "${MERGE_ROOT}" merge --no-ff --no-commit "${next_commit}" >/dev/null 2>"${WORK_ROOT}/merge-error"
merge_status=$?
set -e

restore_upstream_positions_in_merge
mapfile -d '' conflict_paths < <(git -C "${MERGE_ROOT}" diff --name-only -z --diff-filter=U)
if [ "${#conflict_paths[@]}" -gt 0 ]; then
  # The source repository is authoritative for overlapping source edits.  Git
  # still preserves non-overlapping production changes in the same files.
  for relative_path in "${conflict_paths[@]}"; do
    safe_relative_path "${relative_path}" || {
      log "unsafe conflict path rejected: ${relative_path}"
      exit 1
    }
    if [ "${relative_path}" = "${POSITIONS_PATH}" ]; then
      restore_upstream_positions_in_merge
      git -C "${MERGE_ROOT}" add -- "${relative_path}"
      continue
    fi
    git -C "${MERGE_ROOT}" checkout --theirs -- "${relative_path}"
    git -C "${MERGE_ROOT}" add -- "${relative_path}"
    log "resolved source conflict with upstream overlap: ${relative_path}"
  done
  mapfile -d '' remaining_conflict_paths < <(git -C "${MERGE_ROOT}" diff --name-only -z --diff-filter=U)
  if [ "${#remaining_conflict_paths[@]}" -gt 0 ]; then
    log "upstream merge has ${#remaining_conflict_paths[@]} unresolved conflict(s); production was not changed"
    printf 'conflict: %s\n' "${remaining_conflict_paths[@]:0:20}"
    exit 1
  fi
fi
if [ "${merge_status}" -ne 0 ] && ! git -C "${MERGE_ROOT}" rev-parse -q --verify MERGE_HEAD >/dev/null; then
  log 'Git merge failed before producing a reviewable merge result'
  sed -n '1,20p' "${WORK_ROOT}/merge-error"
  exit 1
fi
git -C "${MERGE_ROOT}" commit --no-edit >/dev/null
merged_commit=$(git -C "${MERGE_ROOT}" rev-parse HEAD)

mkdir -p "${CANDIDATE_ROOT}" "${PLAN_ROOT}"
rsync -a --no-owner --no-group \
  --exclude '.git/' --exclude '.venv/' --exclude '.venv-next/' \
  --exclude '.venv-previous/' --exclude '__pycache__/' --exclude '*.pyc' \
  --exclude 'logs/' --exclude 'data/positions.json' \
  "${APP_ROOT}/" "${CANDIDATE_ROOT}/"
: > "${PLAN_ROOT}/apply"

git -C "${MERGE_ROOT}" ls-files -z > "${WORK_ROOT}/merged-paths"
sort -zu "${WORK_ROOT}/union-paths" "${WORK_ROOT}/merged-paths" > "${WORK_ROOT}/result-paths"
while IFS= read -r -d '' relative_path; do
  [ "${relative_path}" = "${POSITIONS_PATH}" ] && continue
  production_file="${APP_ROOT}/${relative_path}"
  merged_file="${MERGE_ROOT}/${relative_path}"
  candidate_file="${CANDIDATE_ROOT}/${relative_path}"

  if [ -f "${merged_file}" ]; then
    mkdir -p -- "$(dirname "${candidate_file}")"
    cp -p -- "${merged_file}" "${candidate_file}"
    merged_mode=$(stat -c '%a' "${merged_file}")
    production_mode=missing
    [ -f "${production_file}" ] && production_mode=$(stat -c '%a' "${production_file}")
    if [ ! -f "${production_file}" ] || ! cmp -s "${merged_file}" "${production_file}" \
      || [ "${merged_mode}" != "${production_mode}" ]; then
      printf 'copy\t%s\t%s\n' "${merged_mode}" "${relative_path}" >> "${PLAN_ROOT}/apply"
    fi
  else
    rm -f -- "${candidate_file}"
    if [ -e "${production_file}" ]; then
      printf 'delete\t-\t%s\n' "${relative_path}" >> "${PLAN_ROOT}/apply"
    fi
  fi
done < "${WORK_ROOT}/result-paths"

while IFS= read -r -d '' relative_path; do
  case "${relative_path}" in
    *.json)
      [ -f "${MERGE_ROOT}/${relative_path}" ] || continue
      if ! "${APP_PYTHON}" -m json.tool "${MERGE_ROOT}/${relative_path}" >/dev/null; then
        log "merged JSON validation failed: ${relative_path}"
        exit 1
      fi
      ;;
  esac
done < "${WORK_ROOT}/merged-paths"

if ! "${APP_PYTHON}" -m compileall -q "${CANDIDATE_ROOT}"; then
  log 'candidate Python compilation failed; production was not changed'
  exit 1
fi
chown -R valuationgrid:valuationgrid "${CANDIDATE_ROOT}"
candidate_manifest_before=$(candidate_manifest)
if ! runuser -u valuationgrid -- sh -c "cd \"${CANDIDATE_ROOT}\" && PYTHONDONTWRITEBYTECODE=1 \"${APP_PYTHON}\" -c 'import app'"; then
  log 'candidate FastAPI import failed; production was not changed'
  exit 1
fi
candidate_manifest_after=$(candidate_manifest)
if [ "${candidate_manifest_before}" != "${candidate_manifest_after}" ]; then
  log 'candidate import changed files; production was not changed'
  exit 1
fi

snapshot_manifest=$(production_manifest)
if ! systemctl stop "${APP_SERVICE}"; then
  log 'valuation-grid could not be stopped for atomic apply; production was not changed'
  exit 1
fi
service_stopped=1
if [ "${snapshot_manifest}" != "$(production_manifest)" ]; then
  log 'production files changed during candidate validation; retrying next interval'
  exit 1
fi
positions_locked=missing
if [ -f "${APP_ROOT}/${POSITIONS_PATH}" ]; then
  positions_locked=$(sha256sum "${APP_ROOT}/${POSITIONS_PATH}" | awk '{print $1}')
fi
if [ "${positions_before}" != "${positions_locked}" ]; then
  log 'positions changed during candidate validation; retrying next interval'
  exit 1
fi

backup_root="${BACKUP_PARENT}/$(date -u +%Y%m%d-%H%M%S)-${next_commit:0:12}"
mkdir -p "${backup_root}/files"
: > "${backup_root}/rollback"
apply_started=1
while IFS=$'\t' read -r action file_mode relative_path; do
  [ -n "${relative_path}" ] || continue
  production_file="${APP_ROOT}/${relative_path}"
  candidate_file="${CANDIDATE_ROOT}/${relative_path}"
  backup_file="${backup_root}/files/${relative_path}"

  if [ -f "${production_file}" ]; then
    mkdir -p -- "$(dirname "${backup_file}")"
    cp -p -- "${production_file}" "${backup_file}"
    printf 'restore\t%s\n' "${relative_path}" >> "${backup_root}/rollback"
  else
    printf 'delete\t%s\n' "${relative_path}" >> "${backup_root}/rollback"
  fi

  if [ "${action}" = delete ]; then
    rm -f -- "${production_file}"
  else
    mkdir -p -- "$(dirname "${production_file}")"
    install -o valuationgrid -g valuationgrid -m "${file_mode}" \
      "${candidate_file}" "${production_file}"
  fi
done < "${PLAN_ROOT}/apply"

positions_after=missing
if [ -f "${APP_ROOT}/${POSITIONS_PATH}" ]; then
  positions_after=$(sha256sum "${APP_ROOT}/${POSITIONS_PATH}" | awk '{print $1}')
fi
if [ "${positions_before}" != "${positions_after}" ]; then
  log 'positions hash changed during synchronization; rolling back source changes'
  health_failed=1
else
  health_failed=0
fi

if [ "${health_failed}" -eq 0 ]; then
  if systemctl start "${APP_SERVICE}"; then
    service_stopped=0
  else
    log 'valuation-grid failed to start after upstream synchronization'
    health_failed=1
  fi
  if [ "${health_failed}" -eq 0 ] && ! wait_for_health; then
    health_failed=1
  fi
fi

if [ "${health_failed}" -ne 0 ]; then
  systemctl stop "${APP_SERVICE}" >/dev/null 2>&1 || true
  service_stopped=1
  rollback_files
  apply_started=0
  systemctl start "${APP_SERVICE}" >/dev/null 2>&1 || true
  service_stopped=0
  wait_for_health || log 'rollback completed but valuation-grid health is still failing'
  log "upstream deployment failed health validation and was rolled back: ${backup_root}"
  exit 1
fi

marker_tmp="${BASE_MARKER}.tmp"
printf '%s\n' "${next_commit}" > "${marker_tmp}"
mv "${marker_tmp}" "${BASE_MARKER}"
deployment_committed=1
apply_started=0
changed_count=$(awk 'NF { count++ } END { print count+0 }' "${PLAN_ROOT}/apply")
log "upstream sync completed: base=${base_commit:0:12} next=${next_commit:0:12} merged=${merged_commit:0:12} files=${changed_count} positions_sha256=${positions_after} backup=${backup_root}"
