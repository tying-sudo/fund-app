import os
import shutil
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


REMOTE_ROOT = Path(__file__).resolve().parents[1]
TRANSACTION_SCRIPT = REMOTE_ROOT / "valuation-grid-upstream-installer-transaction.sh"
BASH = os.environ.get("SYNC_TEST_BASH") or shutil.which("bash")
GIT = shutil.which("git")


class ValuationGridUpstreamInstallerTransactionTest(unittest.TestCase):
    maxDiff = None

    def setUp(self):
        if not BASH:
            self.skipTest("bash is required")
        if not GIT:
            self.skipTest("git is required")
        if not TRANSACTION_SCRIPT.is_file():
            self.fail("installer transaction helper is missing: %s" % TRANSACTION_SCRIPT)

    @staticmethod
    def _posix(path):
        value = str(Path(path).resolve()).replace("\\", "/")
        if len(value) >= 3 and value[1:3] == ":/":
            return "/%s/%s" % (value[0].lower(), value[3:])
        return value

    @staticmethod
    def _write(path, contents, mode=0o644):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(contents, encoding="utf-8", newline="\n")
        path.chmod(mode)

    @staticmethod
    def _snapshot(path):
        info = path.stat()
        return {
            "bytes": path.read_bytes(),
            "mode": stat.S_IMODE(info.st_mode),
            "uid": info.st_uid,
            "gid": info.st_gid,
        }

    @staticmethod
    def _write_executable(path, contents):
        ValuationGridUpstreamInstallerTransactionTest._write(
            path, textwrap.dedent(contents).lstrip(), 0o755
        )

    def _run(self, command, cwd, env):
        return subprocess.run(
            [str(part) for part in command],
            cwd=str(cwd),
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )

    def _git(self, cwd, *args):
        result = self._run(
            [GIT, "-c", "core.autocrlf=false", *args], cwd, os.environ.copy()
        )
        if result.returncode != 0:
            self.fail(
                "git command failed: %s\nstdout:\n%s\nstderr:\n%s"
                % (" ".join(str(part) for part in args), result.stdout, result.stderr)
            )
        return result

    def _make_systemctl(self, fake_bin):
        self._write_executable(
            fake_bin / "systemctl",
            """
            #!/usr/bin/env bash
            set -eu
            state_root=${INSTALLER_TEST_STATE_ROOT:?}
            enabled_file=${state_root}/timer-enabled
            active_file=${state_root}/timer-active
            printf '%s\\n' "$*" >> "${state_root}/systemctl.log"
            command=${1:-}
            shift || true
            while [ "${1:-}" = --quiet ]; do shift; done
            unit=${1:-}
            state_value() { cat "$1"; }
            case "${command}" in
              is-enabled)
                state=$(state_value "${enabled_file}")
                printf '%s\\n' "${state}"
                case "${state}" in enabled|enabled-runtime) exit 0 ;; *) exit 1 ;; esac
                ;;
              is-active)
                if [ "${unit}" = valuation-grid-upstream.timer ] && [ "$(state_value "${active_file}")" = active ]; then
                  exit 0
                fi
                exit 3
                ;;
              is-failed)
                exit 3
                ;;
              disable)
                printf 'disabled\\n' > "${enabled_file}"
                printf 'inactive\\n' > "${active_file}"
                ;;
              enable)
                if [ "${1:-}" = --runtime ]; then shift; fi
                printf 'enabled\\n' > "${enabled_file}"
                ;;
              start)
                if [ "${unit}" = valuation-grid-upstream.service ]; then
                  printf 'manual service start failure\\n' >&2
                  exit 1
                fi
                if [ "${unit}" = valuation-grid-upstream.timer ]; then
                  printf 'active\\n' > "${active_file}"
                fi
                ;;
              stop)
                if [ "${unit}" = valuation-grid-upstream.timer ]; then
                  printf 'inactive\\n' > "${active_file}"
                fi
                ;;
              daemon-reload|reset-failed)
                ;;
              *)
                printf 'unexpected systemctl command: %s\\n' "${command}" >&2
                exit 64
                ;;
            esac
            """,
        )
        self._write_executable(
            fake_bin / "install",
            """
            #!/usr/bin/env bash
            set -eu
            mode=
            while [ "$#" -gt 2 ]; do
              case "$1" in
                -o|-g) shift 2 ;;
                -m) mode=$2; shift 2 ;;
                *) printf 'unexpected install argument: %s\\n' "$1" >&2; exit 64 ;;
              esac
            done
            [ "$#" -eq 2 ] || exit 64
            mkdir -p -- "$(dirname -- "$2")"
            cp -- "$1" "$2"
            chmod "${mode}" "$2"
            """,
        )
        self._write_executable(
            fake_bin / "curl",
            """
            #!/usr/bin/env bash
            printf 'curl should not run after the injected first-sync failure\\n' >&2
            exit 64
            """,
        )
        self._write_executable(
            fake_bin / "flock",
            """
            #!/usr/bin/env bash
            exit 0
            """,
        )

    def test_first_manual_sync_failure_restores_preinstall_state_and_does_not_schedule_new_timer(self):
        temporary = tempfile.TemporaryDirectory(prefix="vg-installer-transaction-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        fake_bin = root / "bin"
        state = root / "state"
        work = root / "work"
        backup = root / "backup"
        source = root / "source"
        managed = root / "managed"
        units = root / "units"
        for path in (state, work, source, managed, units):
            path.mkdir(parents=True, exist_ok=True)
        self._make_systemctl(fake_bin)
        (state / "timer-enabled").write_text("enabled\n", encoding="ascii")
        (state / "timer-active").write_text("active\n", encoding="ascii")

        sync_destination = managed / "valuation-grid-upstream-sync"
        merger_destination = managed / "valuation-grid-json-merge"
        service_destination = units / "valuation-grid-upstream.service"
        timer_destination = units / "valuation-grid-upstream.timer"
        old_files = {
            sync_destination: ("old sync\n", 0o750),
            merger_destination: ("old merger\n", 0o755),
            service_destination: ("[Service]\nExecStart=/old/service\n", 0o644),
            timer_destination: ("[Timer]\nOnBootSec=old\n", 0o640),
        }
        for path, (contents, mode) in old_files.items():
            self._write(path, contents, mode)
        before_files = {path: self._snapshot(path) for path in old_files}

        repo = work / "repo"
        self._git(root, "init", "-q", str(repo))
        self._git(repo, "config", "merge.existing.name", "Keep existing merge rule")
        attributes = repo / ".git" / "info" / "attributes"
        self._write(attributes, "*.existing merge=existing\n", 0o600)
        config = repo / ".git" / "config"
        before_config = self._snapshot(config)
        before_attributes = self._snapshot(attributes)

        sync_source = source / "sync"
        merger_source = source / "merger"
        service_source = source / "service"
        timer_source = source / "timer"
        self._write(sync_source, "#!/usr/bin/env bash\nexit 0\n", 0o750)
        self._write(merger_source, "#!/usr/bin/env python3\n", 0o755)
        self._write(service_source, "[Service]\nExecStart=/new/service\n", 0o644)
        self._write(timer_source, "[Timer]\nOnBootSec=new\n", 0o644)

        env = os.environ.copy()
        env.update(
            {
                "PATH": "%s:%s:/usr/bin:/bin"
                % (self._posix(fake_bin), self._posix(Path(GIT).parent)),
                "INSTALLER_TEST_STATE_ROOT": self._posix(state),
            }
        )
        command = [
            BASH,
            self._posix(TRANSACTION_SCRIPT),
            "install",
            self._posix(backup),
            self._posix(work),
            self._posix(sync_source),
            self._posix(merger_source),
            self._posix(service_source),
            self._posix(timer_source),
            self._posix(sync_destination),
            self._posix(merger_destination),
            self._posix(service_destination),
            self._posix(timer_destination),
        ]

        result = self._run(command, root, env)
        output = result.stdout + result.stderr

        self.assertNotEqual(result.returncode, 0, output)
        self.assertIn("manual service start failure", output)
        self.assertIn("installer rollback restored", output)
        for path, expected in before_files.items():
            self.assertEqual(self._snapshot(path), expected, str(path))
        self.assertEqual(self._snapshot(config), before_config)
        self.assertEqual(self._snapshot(attributes), before_attributes)
        self.assertEqual(
            (state / "timer-enabled").read_text(encoding="ascii"), "enabled\n"
        )
        self.assertEqual(
            (state / "timer-active").read_text(encoding="ascii"), "active\n"
        )
        systemctl_log = (state / "systemctl.log").read_text(encoding="utf-8")
        self.assertNotIn("enable --now valuation-grid-upstream.timer", systemctl_log)
        self.assertLess(
            systemctl_log.index("start valuation-grid-upstream.service"),
            systemctl_log.index("enable valuation-grid-upstream.timer"),
        )

    def test_first_manual_sync_failure_removes_all_new_managed_files_when_none_existed(self):
        temporary = tempfile.TemporaryDirectory(prefix="vg-installer-transaction-absent-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        fake_bin = root / "bin"
        state = root / "state"
        work = root / "work"
        backup = root / "backup"
        source = root / "source"
        managed = root / "managed"
        units = root / "units"
        for path in (state, work, source, managed, units):
            path.mkdir(parents=True, exist_ok=True)
        self._make_systemctl(fake_bin)
        (state / "timer-enabled").write_text("not-found\n", encoding="ascii")
        (state / "timer-active").write_text("inactive\n", encoding="ascii")

        repo = work / "repo"
        self._git(root, "init", "-q", str(repo))
        sync_source = source / "sync"
        merger_source = source / "merger"
        service_source = source / "service"
        timer_source = source / "timer"
        self._write(sync_source, "#!/usr/bin/env bash\nexit 0\n", 0o750)
        self._write(merger_source, "#!/usr/bin/env python3\n", 0o755)
        self._write(service_source, "[Service]\nExecStart=/new/service\n", 0o644)
        self._write(timer_source, "[Timer]\nOnBootSec=new\n", 0o644)
        destinations = [
            managed / "valuation-grid-upstream-sync",
            managed / "valuation-grid-json-merge",
            units / "valuation-grid-upstream.service",
            units / "valuation-grid-upstream.timer",
        ]

        env = os.environ.copy()
        env.update(
            {
                "PATH": "%s:%s:/usr/bin:/bin"
                % (self._posix(fake_bin), self._posix(Path(GIT).parent)),
                "INSTALLER_TEST_STATE_ROOT": self._posix(state),
            }
        )
        result = self._run(
            [
                BASH,
                self._posix(TRANSACTION_SCRIPT),
                "install",
                self._posix(backup),
                self._posix(work),
                self._posix(sync_source),
                self._posix(merger_source),
                self._posix(service_source),
                self._posix(timer_source),
                *[self._posix(path) for path in destinations],
            ],
            root,
            env,
        )
        output = result.stdout + result.stderr

        self.assertNotEqual(result.returncode, 0, output)
        self.assertIn("installer rollback restored", output)
        self.assertTrue(all(not path.exists() for path in destinations))
        systemctl_log = (state / "systemctl.log").read_text(encoding="utf-8")
        self.assertIn("disable --now valuation-grid-upstream.timer", systemctl_log)
        self.assertNotIn("enable --now valuation-grid-upstream.timer", systemctl_log)


if __name__ == "__main__":
    unittest.main(verbosity=2)
