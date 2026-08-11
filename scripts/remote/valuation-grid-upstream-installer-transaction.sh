#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_SERVICE=valuation-grid.service
readonly SYNC_LOCK_FILE=/run/lock/valuation-grid-upstream-sync.lock

usage() {
  cat >&2 <<'USAGE'
usage:
  valuation-grid-upstream-installer-transaction.sh install \
    <backup-root> <work-root> <sync-source> <merger-source> \
    <service-source> <timer-source> <sync-destination> <merger-destination> \
    <service-destination> <timer-destination>
  valuation-grid-upstream-installer-transaction.sh rollback \
    <backup-root> <work-root> <sync-destination> <merger-destination> \
    <service-destination> <timer-destination>
USAGE
}

require_absolute_directory() {
  local path="$1"
  case "${path}" in
    /?*) ;;
    *)
      printf 'expected an absolute non-root directory path: %s\n' "${path}" >&2
      return 1
      ;;
  esac
  if [ "${path}" = / ]; then
    printf 'refusing to use the filesystem root as a transaction directory\n' >&2
    return 1
  fi
}

record_file() {
  local target_path="$1"
  local name="$2"
  local state_dir="$3"

  if [ -L "${target_path}" ]; then
    printf 'refusing to replace managed symlink: %s\n' "${target_path}" >&2
    return 1
  fi
  if [ -e "${target_path}" ]; then
    if [ ! -f "${target_path}" ]; then
      printf 'managed path is not a regular file: %s\n' "${target_path}" >&2
      return 1
    fi
    cp -a --no-dereference -- "${target_path}" "${state_dir}/files/${name}"
    printf 'present\n' > "${state_dir}/${name}.state"
  else
    printf 'absent\n' > "${state_dir}/${name}.state"
  fi
}

read_state() {
  local state_path="$1"
  local value
  if [ ! -s "${state_path}" ]; then
    printf 'missing transaction state: %s\n' "${state_path}" >&2
    return 1
  fi
  IFS= read -r value < "${state_path}"
  printf '%s\n' "${value}"
}

restore_file() {
  local backup_root="$1"
  local target_path="$2"
  local name="$3"
  local state_dir="${backup_root}/state"
  local saved_state

  saved_state=$(read_state "${state_dir}/${name}.state")
  case "${saved_state}" in
    present)
      if [ ! -f "${state_dir}/files/${name}" ]; then
        printf 'missing backed-up managed file: %s\n' "${name}" >&2
        return 1
      fi
      if [ -e "${target_path}" ] && [ ! -f "${target_path}" ]; then
        printf 'cannot restore over non-file managed path: %s\n' "${target_path}" >&2
        return 1
      fi
      mkdir -p -- "$(dirname -- "${target_path}")"
      rm -f -- "${target_path}"
      cp -a --no-dereference -- "${state_dir}/files/${name}" "${target_path}"
      ;;
    absent)
      if [ -L "${target_path}" ]; then
        rm -f -- "${target_path}"
      elif [ -e "${target_path}" ]; then
        if [ ! -f "${target_path}" ]; then
          printf 'cannot remove non-file managed path: %s\n' "${target_path}" >&2
          return 1
        fi
        rm -f -- "${target_path}"
      fi
      ;;
    *)
      printf 'invalid transaction state for %s: %s\n' "${name}" "${saved_state}" >&2
      return 1
      ;;
  esac
}

snapshot_systemd_state() {
  local state_dir="$1"
  local service_unit="$2"
  local timer_unit="$3"
  local timer_enabled_state

  timer_enabled_state=$(LC_ALL=C systemctl is-enabled "${timer_unit}" 2>/dev/null || true)
  case "${timer_enabled_state}" in
    enabled|enabled-runtime|disabled|not-found) ;;
    *)
      printf 'unsupported existing timer enable state: %s\n' "${timer_enabled_state:-empty}" >&2
      return 1
      ;;
  esac
  printf '%s\n' "${timer_enabled_state}" > "${state_dir}/timer-enabled.state"

  if systemctl is-active --quiet "${timer_unit}"; then
    printf 'active\n' > "${state_dir}/timer-active.state"
  else
    printf 'inactive\n' > "${state_dir}/timer-active.state"
  fi

  # A concurrently running one-shot service cannot be replaced safely. A
  # failed one-shot is intentionally allowed: installing its fix is the
  # recovery path, and a successful start below replaces the failed state.
  if systemctl is-active --quiet "${service_unit}"; then
    printf 'refusing installation while %s is active\n' "${service_unit}" >&2
    return 1
  fi
  printf 'inactive\n' > "${state_dir}/service-active.state"
}

resolve_git_path() {
  local repo_root="$1"
  local git_path="$2"
  case "${git_path}" in
    /*) printf '%s\n' "${git_path}" ;;
    *) printf '%s/%s\n' "${repo_root}" "${git_path}" ;;
  esac
}

snapshot_repository_state() {
  local work_root="$1"
  local state_dir="$2"
  local repo_root="${work_root}/repo"
  local config_path attributes_path

  if [ -e "${work_root}/repo.new" ] || [ -L "${work_root}/repo.new" ]; then
    printf 'refusing installation with an existing clone staging directory: %s\n' "${work_root}/repo.new" >&2
    return 1
  fi
  if [ -L "${repo_root}" ]; then
    printf 'refusing to use a symlinked upstream repository: %s\n' "${repo_root}" >&2
    return 1
  fi
  if [ -e "${repo_root}" ]; then
    if [ ! -d "${repo_root}/.git" ]; then
      printf 'upstream repository is not a Git worktree: %s\n' "${repo_root}" >&2
      return 1
    fi
    printf 'present\n' > "${state_dir}/repo.state"
    config_path=$(resolve_git_path "${repo_root}" "$(git -C "${repo_root}" rev-parse --git-path config)")
    attributes_path=$(resolve_git_path "${repo_root}" "$(git -C "${repo_root}" rev-parse --git-path info/attributes)")
    record_file "${config_path}" repo-config "${state_dir}"
    record_file "${attributes_path}" repo-attributes "${state_dir}"
    printf '%s\n' "${config_path}" > "${state_dir}/repo-config.path"
    printf '%s\n' "${attributes_path}" > "${state_dir}/repo-attributes.path"
  else
    printf 'absent\n' > "${state_dir}/repo.state"
  fi
}

restore_repository_state() {
  local backup_root="$1"
  local work_root="$2"
  local state_dir="${backup_root}/state"
  local repo_root="${work_root}/repo"
  local repo_state config_path attributes_path

  repo_state=$(read_state "${state_dir}/repo.state")
  case "${repo_state}" in
    absent)
      if [ -e "${repo_root}" ] || [ -L "${repo_root}" ]; then
        rm -rf -- "${repo_root}"
      fi
      rm -rf -- "${work_root}/repo.new"
      ;;
    present)
      if [ ! -d "${repo_root}/.git" ]; then
        printf 'cannot restore Git configuration; repository disappeared: %s\n' "${repo_root}" >&2
        return 1
      fi
      config_path=$(read_state "${state_dir}/repo-config.path")
      attributes_path=$(read_state "${state_dir}/repo-attributes.path")
      restore_file "${backup_root}" "${config_path}" repo-config
      restore_file "${backup_root}" "${attributes_path}" repo-attributes
      rm -rf -- "${work_root}/repo.new"
      ;;
    *)
      printf 'invalid repository transaction state: %s\n' "${repo_state}" >&2
      return 1
      ;;
  esac
}

prepare_repository_merge_driver() {
  local work_root="$1"
  local repo_root="${work_root}/repo"
  local config_path attributes_path

  if [ ! -d "${repo_root}/.git" ]; then
    if [ -e "${work_root}/repo.new" ] || [ -L "${work_root}/repo.new" ]; then
      printf 'refusing to overwrite existing clone staging directory: %s\n' "${work_root}/repo.new" >&2
      return 1
    fi
    GIT_TERMINAL_PROMPT=0 timeout 120s git clone --no-checkout \
      https://github.com/shangjinma-source/valuation_grid.git "${work_root}/repo.new"
    mv -- "${work_root}/repo.new" "${repo_root}"
  fi

  git -C "${repo_root}" config merge.valuation-json.name 'Structured three-way JSON merge'
  git -C "${repo_root}" config merge.valuation-json.driver \
    '/usr/local/libexec/valuation-grid-json-merge --ancestor %O --current %A --other %B --path %P'
  git -C "${repo_root}" config merge.keep-production.name 'Keep production positions'
  git -C "${repo_root}" config merge.keep-production.driver true
  config_path=$(resolve_git_path "${repo_root}" "$(git -C "${repo_root}" rev-parse --git-path config)")
  attributes_path=$(resolve_git_path "${repo_root}" "$(git -C "${repo_root}" rev-parse --git-path info/attributes)")
  mkdir -p -- "$(dirname -- "${attributes_path}")"
  printf '%s\n' '*.json merge=valuation-json' 'data/positions.json merge=keep-production' > "${attributes_path}"
  printf 'merge_driver_config=%s\n' "${config_path}"
}

rollback_errors=0

rollback_step() {
  local description="$1"
  shift
  if ! "$@"; then
    printf 'installer rollback failed: %s\n' "${description}" >&2
    rollback_errors=1
  fi
}

restore_timer_state() {
  local backup_root="$1"
  local timer_unit="$2"
  local state_dir="${backup_root}/state"
  local enabled_state active_state

  enabled_state=$(read_state "${state_dir}/timer-enabled.state")
  active_state=$(read_state "${state_dir}/timer-active.state")
  case "${enabled_state}" in
    enabled)
      systemctl enable "${timer_unit}"
      ;;
    enabled-runtime)
      systemctl enable --runtime "${timer_unit}"
      ;;
    disabled)
      systemctl disable "${timer_unit}"
      ;;
    not-found)
      ;;
    *)
      printf 'invalid saved timer enable state: %s\n' "${enabled_state}" >&2
      return 1
      ;;
  esac
  case "${active_state}" in
    active)
      systemctl start "${timer_unit}"
      ;;
    inactive)
      if [ "${enabled_state}" != not-found ]; then
        systemctl stop "${timer_unit}"
      fi
      ;;
    *)
      printf 'invalid saved timer active state: %s\n' "${active_state}" >&2
      return 1
      ;;
  esac
}

acquire_sync_lock() {
  mkdir -p -- "$(dirname -- "${SYNC_LOCK_FILE}")"
  exec 9>"${SYNC_LOCK_FILE}"
  if ! flock -n 9; then
    printf 'another valuation-grid upstream synchronization is still running\n' >&2
    return 1
  fi
}

rollback_action() {
  local backup_root="$1"
  local work_root="$2"
  local sync_destination="$3"
  local merger_destination="$4"
  local service_destination="$5"
  local timer_destination="$6"
  local state_dir="${backup_root}/state"
  local service_unit="${service_destination##*/}"
  local timer_unit="${timer_destination##*/}"

  if [ ! -f "${state_dir}/ready" ]; then
    printf 'installer rollback: no complete transaction snapshot at %s\n' "${backup_root}" >&2
    return 1
  fi

  rollback_errors=0
  # The newly staged timer must be disabled before restoring its old unit, so
  # no new timers.target symlink can survive a failed first synchronization.
  if [ -e "${timer_destination}" ] || [ -L "${timer_destination}" ]; then
    rollback_step 'disable staged timer' systemctl disable --now "${timer_unit}"
  fi
  rollback_step 'stop staged service' systemctl stop "${service_unit}"
  rollback_step 'restore sync script' restore_file "${backup_root}" "${sync_destination}" sync
  rollback_step 'restore JSON merge helper' restore_file "${backup_root}" "${merger_destination}" merger
  rollback_step 'restore service unit' restore_file "${backup_root}" "${service_destination}" service
  rollback_step 'restore timer unit' restore_file "${backup_root}" "${timer_destination}" timer
  rollback_step 'restore Git merge driver configuration' restore_repository_state "${backup_root}" "${work_root}"
  rollback_step 'reload restored systemd units' systemctl daemon-reload
  rollback_step 'clear failed staged service' systemctl reset-failed "${service_unit}"
  rollback_step 'restore previous timer state' restore_timer_state "${backup_root}" "${timer_unit}"

  if [ "${rollback_errors}" -ne 0 ]; then
    return 1
  fi
  printf 'installer rollback restored %s\n' "${backup_root}"
}

transaction_backup_root=
transaction_work_root=
transaction_sync_destination=
transaction_merger_destination=
transaction_service_destination=
transaction_timer_destination=

install_failure() {
  local original_status="$1"
  trap - ERR
  set +e
  printf 'installer transaction failed; restoring the pre-install state\n' >&2
  if ! rollback_action \
    "${transaction_backup_root}" \
    "${transaction_work_root}" \
    "${transaction_sync_destination}" \
    "${transaction_merger_destination}" \
    "${transaction_service_destination}" \
    "${transaction_timer_destination}"; then
    printf 'installer rollback failed; inspect %s\n' "${transaction_backup_root}" >&2
  fi
  exit "${original_status}"
}

install_action() {
  local backup_root="$1"
  local work_root="$2"
  local sync_source="$3"
  local merger_source="$4"
  local service_source="$5"
  local timer_source="$6"
  local sync_destination="$7"
  local merger_destination="$8"
  local service_destination="$9"
  local timer_destination="${10}"
  local state_dir="${backup_root}/state"
  local service_unit="${service_destination##*/}"
  local timer_unit="${timer_destination##*/}"
  local timer_enabled_state

  require_absolute_directory "${backup_root}"
  require_absolute_directory "${work_root}"
  if [ -e "${backup_root}" ] || [ -L "${backup_root}" ]; then
    printf 'installer backup already exists: %s\n' "${backup_root}" >&2
    return 1
  fi
  if [ ! -f "${sync_source}" ] || [ ! -f "${merger_source}" ] \
    || [ ! -f "${service_source}" ] || [ ! -f "${timer_source}" ]; then
    printf 'one or more staged installer inputs are missing\n' >&2
    return 1
  fi

  mkdir -p -- "$(dirname -- "${backup_root}")" "${work_root}"
  mkdir -- "${backup_root}"
  mkdir -p -- "${state_dir}/files" "$(dirname -- "${merger_destination}")"
  record_file "${sync_destination}" sync "${state_dir}"
  record_file "${merger_destination}" merger "${state_dir}"
  record_file "${service_destination}" service "${state_dir}"
  record_file "${timer_destination}" timer "${state_dir}"
  snapshot_systemd_state "${state_dir}" "${service_unit}" "${timer_unit}"
  snapshot_repository_state "${work_root}" "${state_dir}"
  acquire_sync_lock
  touch "${state_dir}/ready"

  transaction_backup_root="${backup_root}"
  transaction_work_root="${work_root}"
  transaction_sync_destination="${sync_destination}"
  transaction_merger_destination="${merger_destination}"
  transaction_service_destination="${service_destination}"
  transaction_timer_destination="${timer_destination}"
  trap 'install_failure $?' ERR

  timer_enabled_state=$(read_state "${state_dir}/timer-enabled.state")
  if [ "${timer_enabled_state}" != not-found ]; then
    systemctl disable --now "${timer_unit}"
  fi
  install -o root -g root -m 0750 "${sync_source}" "${sync_destination}"
  install -o root -g root -m 0755 "${merger_source}" "${merger_destination}"
  install -o root -g root -m 0644 "${service_source}" "${service_destination}"
  install -o root -g root -m 0644 "${timer_source}" "${timer_destination}"
  prepare_repository_merge_driver "${work_root}"
  systemctl daemon-reload

  # Do not enable the new timer until this exact staged service has completed
  # and the production API is healthy.  It is like testing a replacement lock
  # by hand before giving it a permanent key in the scheduler.
  systemctl start "${service_unit}"
  systemctl is-active --quiet "${APP_SERVICE}"
  curl --fail --silent --show-error --max-time 15 http://127.0.0.1:8000/health >/dev/null
  test -s "${work_root}/base-commit"
  systemctl enable --now "${timer_unit}"
  systemctl is-enabled --quiet "${timer_unit}"
  systemctl is-active --quiet "${timer_unit}"

  trap - ERR
  printf 'installer_backup=%s\n' "${backup_root}"
}

case "${1:-}" in
  install)
    [ "$#" -eq 11 ] || { usage; exit 2; }
    shift
    install_action "$@"
    ;;
  rollback)
    [ "$#" -eq 7 ] || { usage; exit 2; }
    shift
    rollback_action "$@"
    ;;
  *)
    usage
    exit 2
    ;;
esac
