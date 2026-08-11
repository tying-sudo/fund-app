import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


REMOTE_ROOT = Path(__file__).resolve().parents[1]
SYNC_SCRIPT = REMOTE_ROOT / "valuation-grid-upstream-sync.sh"
JSON_MERGER = REMOTE_ROOT / "merge-valuation-grid-json.py"
BASH = os.environ.get("SYNC_TEST_BASH") or shutil.which("bash")
GIT = shutil.which("git")


class ValuationGridUpstreamSyncIntegrationTest(unittest.TestCase):
    maxDiff = None

    def setUp(self):
        if not BASH:
            self.skipTest("bash is required")
        if not GIT:
            self.skipTest("git is required")
        if not SYNC_SCRIPT.is_file():
            self.fail("sync script is missing: %s" % SYNC_SCRIPT)
        if not JSON_MERGER.is_file():
            self.fail("JSON merge helper is missing: %s" % JSON_MERGER)

    @staticmethod
    def _posix(path):
        value = str(Path(path).resolve()).replace("\\", "/")
        if len(value) >= 3 and value[1:3] == ":/":
            return "/%s/%s" % (value[0].lower(), value[3:])
        return value

    def _run(self, command, cwd, env=None, check=True):
        result = subprocess.run(
            [str(part) for part in command],
            cwd=str(cwd),
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        if check and result.returncode != 0:
            self.fail(
                "command failed (%d): %s\nstdout:\n%s\nstderr:\n%s"
                % (
                    result.returncode,
                    " ".join(str(part) for part in command),
                    result.stdout,
                    result.stderr,
                )
            )
        return result

    def _git(self, cwd, *args):
        return self._run(
            [
                GIT,
                "-c",
                "core.autocrlf=false",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "user.name=valuation-grid-test",
                "-c",
                "user.email=valuation-grid-test@localhost",
                *args,
            ],
            cwd,
        )

    @staticmethod
    def _apply_files(root, changes):
        for relative_path, contents in changes.items():
            path = root / relative_path
            if contents is None:
                path.unlink(missing_ok=True)
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(contents, encoding="utf-8", newline="\n")

    @staticmethod
    def _hash(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    @classmethod
    def _tree_hashes(cls, root):
        return {
            path.relative_to(root).as_posix(): cls._hash(path)
            for path in sorted(root.rglob("*"))
            if path.is_file()
        }

    @staticmethod
    def _write_executable(path, contents):
        path.write_text(textwrap.dedent(contents).lstrip(), encoding="utf-8", newline="\n")
        path.chmod(0o755)

    def _instrument_script(self, target):
        contents = SYNC_SCRIPT.read_text(encoding="utf-8")
        replacements = {
            "readonly APP_ROOT=/opt/valuation-grid":
                'readonly APP_ROOT="${SYNC_TEST_APP_ROOT:?}"',
            "readonly UPSTREAM_GIT=https://github.com/shangjinma-source/valuation_grid.git":
                'readonly UPSTREAM_GIT="${SYNC_TEST_UPSTREAM_GIT:?}"',
            "readonly WORK_ROOT=/var/lib/valuation-grid-upstream-sync":
                'readonly WORK_ROOT="${SYNC_TEST_WORK_ROOT:?}"',
            "readonly BACKUP_PARENT=/var/backups/valuation-grid-upstream":
                'readonly BACKUP_PARENT="${SYNC_TEST_BACKUP_PARENT:?}"',
            "readonly LOCK_FILE=/run/lock/valuation-grid-upstream-sync.lock":
                'readonly LOCK_FILE="${SYNC_TEST_LOCK_FILE:?}"',
            "readonly JSON_MERGER=/usr/local/libexec/valuation-grid-json-merge":
                'readonly JSON_MERGER="${SYNC_TEST_JSON_MERGER:?}"',
            'readonly APP_PYTHON="${APP_ROOT}/.venv/bin/python"':
                'readonly APP_PYTHON="${SYNC_TEST_APP_PYTHON:?}"',
        }
        for original, replacement in replacements.items():
            count = contents.count(original)
            self.assertEqual(
                count,
                1,
                "expected one sync-script replacement target: %s" % original,
            )
            contents = contents.replace(original, replacement)
        target.write_text(contents, encoding="utf-8", newline="\n")
        target.chmod(0o755)

    def _make_fake_commands(self, fake_bin):
        fake_bin.mkdir(parents=True)
        self._write_executable(
            fake_bin / "systemctl",
            """
            #!/usr/bin/env bash
            set -eu
            state_root=${SYNC_TEST_STATE_ROOT:?}
            printf '%s\n' "$*" >> "${state_root}/systemctl.log"
            case "${1:-}" in
              is-active|start|stop) exit 0 ;;
              *) exit 0 ;;
            esac
            """,
        )
        self._write_executable(
            fake_bin / "curl",
            """
            #!/usr/bin/env bash
            set -eu
            state_root=${SYNC_TEST_STATE_ROOT:?}
            count_file=${state_root}/curl-count
            count=0
            if [ -f "${count_file}" ]; then read -r count < "${count_file}"; fi
            count=$((count + 1))
            printf '%s\n' "${count}" > "${count_file}"
            if [ "${SYNC_TEST_HEALTH_MODE:-pass}" = fail-first-cycle ] && [ "${count}" -le 30 ]; then
              exit 22
            fi
            exit 0
            """,
        )
        self._write_executable(
            fake_bin / "rsync",
            """
            #!/usr/bin/env bash
            set -eu
            [ "$#" -ge 2 ] || exit 2
            while [ "$#" -gt 2 ]; do shift; done
            source_path=$1
            target_path=$2
            mkdir -p -- "${target_path}"
            cp -a -- "${source_path%/}/." "${target_path%/}/"
            """,
        )
        self._write_executable(
            fake_bin / "install",
            """
            #!/usr/bin/env bash
            set -eu
            file_mode=
            while [ "$#" -gt 2 ]; do
              case "$1" in
                -o|-g) shift 2 ;;
                -m) file_mode=$2; shift 2 ;;
                *) exit 2 ;;
              esac
            done
            [ "$#" -eq 2 ] || exit 2
            mkdir -p -- "$(dirname "$2")"
            cp -p -- "$1" "$2"
            if [ -n "${file_mode}" ]; then chmod "${file_mode}" "$2"; fi
            """,
        )
        for name in ("chown", "flock", "logger", "sleep"):
            self._write_executable(
                fake_bin / name,
                """
                #!/usr/bin/env bash
                exit 0
                """,
            )
        self._write_executable(
            fake_bin / "runuser",
            """
            #!/usr/bin/env bash
            set -eu
            [ "$1" = "-u" ]
            shift 2
            [ "$1" = "--" ]
            shift
            exec "$@"
            """,
        )
        self._write_executable(
            fake_bin / "app-python",
            """
            #!/usr/bin/env bash
            exec "${SYNC_TEST_HOST_PYTHON:?}" "$@"
            """,
        )
        self._write_executable(
            fake_bin / "json-merger",
            """
            #!/usr/bin/env bash
            exec "${SYNC_TEST_HOST_PYTHON:?}" "${SYNC_TEST_JSON_MERGER_SOURCE:?}" "$@"
            """,
        )

    def _fixture(
        self,
        base_files,
        next_changes,
        production_changes=None,
        health_mode="pass",
    ):
        temporary = tempfile.TemporaryDirectory(prefix="vg-sync-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        upstream = root / "upstream"
        app = root / "app"
        work = root / "work"
        backup = root / "backup"
        state = root / "state"
        fake_bin = root / "bin"
        for path in (upstream, app, work, backup, state, root / "run", root / "home"):
            path.mkdir(parents=True, exist_ok=True)

        self._git(upstream, "init", "-b", "main")
        self._apply_files(upstream, base_files)
        self._git(upstream, "add", "-A")
        self._git(upstream, "commit", "-m", "base")
        base_commit = self._git(upstream, "rev-parse", "HEAD").stdout.strip()

        self._apply_files(upstream, next_changes)
        self._git(upstream, "add", "-A")
        self._git(upstream, "commit", "-m", "next")
        next_commit = self._git(upstream, "rev-parse", "HEAD").stdout.strip()

        self._apply_files(app, base_files)
        self._apply_files(app, production_changes or {})
        (work / "base-commit").write_text(base_commit + "\n", encoding="ascii")

        instrumented = root / "valuation-grid-upstream-sync.test.sh"
        self._instrument_script(instrumented)
        self._make_fake_commands(fake_bin)
        git_config = root / "gitconfig"
        git_config.write_text(
            "[core]\n\tautocrlf = false\n[commit]\n\tgpgSign = false\n",
            encoding="ascii",
        )

        env = os.environ.copy()
        env.update(
            {
                "PATH": "%s:/usr/bin:/bin:/cmd" % self._posix(fake_bin),
                "HOME": self._posix(root / "home"),
                "GIT_CONFIG_GLOBAL": self._posix(git_config),
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_TERMINAL_PROMPT": "0",
                "SYNC_TEST_APP_ROOT": self._posix(app),
                "SYNC_TEST_UPSTREAM_GIT": self._posix(upstream),
                "SYNC_TEST_WORK_ROOT": self._posix(work),
                "SYNC_TEST_BACKUP_PARENT": self._posix(backup),
                "SYNC_TEST_LOCK_FILE": self._posix(root / "run" / "sync.lock"),
                "SYNC_TEST_JSON_MERGER": self._posix(fake_bin / "json-merger"),
                "SYNC_TEST_APP_PYTHON": self._posix(fake_bin / "app-python"),
                "SYNC_TEST_HOST_PYTHON": self._posix(sys.executable),
                "SYNC_TEST_JSON_MERGER_SOURCE": self._posix(JSON_MERGER),
                "SYNC_TEST_STATE_ROOT": self._posix(state),
                "SYNC_TEST_HEALTH_MODE": health_mode,
            }
        )
        return {
            "root": root,
            "app": app,
            "work": work,
            "state": state,
            "script": instrumented,
            "env": env,
            "base_commit": base_commit,
            "next_commit": next_commit,
        }

    def _run_sync(self, fixture):
        return self._run(
            [BASH, self._posix(fixture["script"])],
            fixture["root"],
            env=fixture["env"],
            check=False,
        )

    @staticmethod
    def _base_files(extra=None):
        files = {
            "app.py": 'VALUE = "base"\n',
            "module.py": 'VALUE = "base"\n',
            "data/positions.json": '{"funds":[{"code":"BASE","shares":1}]}\n',
        }
        files.update(extra or {})
        return files

    def test_positions_hash_is_unchanged_after_successful_source_sync(self):
        production_positions = '{"funds":[{"code":"PROD","shares":7}]}\n'
        fixture = self._fixture(
            self._base_files(),
            {
                "module.py": 'VALUE = "upstream"\n',
                "data/positions.json": '{"funds":[{"code":"UPSTREAM","shares":99}]}\n',
            },
            {"data/positions.json": production_positions},
        )
        before = self._hash(fixture["app"] / "data" / "positions.json")

        result = self._run_sync(fixture)

        output = result.stdout + result.stderr
        self.assertEqual(result.returncode, 0, output)
        self.assertEqual(self._hash(fixture["app"] / "data" / "positions.json"), before)
        self.assertEqual(
            (fixture["app"] / "data" / "positions.json").read_text(encoding="utf-8"),
            production_positions,
        )
        self.assertEqual(
            (fixture["app"] / "module.py").read_text(encoding="utf-8"),
            'VALUE = "upstream"\n',
        )
        self.assertEqual(
            (fixture["work"] / "base-commit").read_text(encoding="ascii").strip(),
            fixture["next_commit"],
        )
        self.assertIn("positions_sha256=%s" % before, output)

    def test_source_conflict_uses_upstream_for_overlapping_lines(self):
        fixture = self._fixture(
            self._base_files({"settings.py": 'MODE = "base"\n'}),
            {"settings.py": 'MODE = "upstream"\n'},
            {"settings.py": 'MODE = "production"\n'},
        )

        result = self._run_sync(fixture)

        output = result.stdout + result.stderr
        self.assertEqual(result.returncode, 0, output)
        self.assertEqual(
            (fixture["app"] / "settings.py").read_text(encoding="utf-8"),
            'MODE = "upstream"\n',
        )
        self.assertEqual(
            (fixture["work"] / "base-commit").read_text(encoding="ascii").strip(),
            fixture["next_commit"],
        )
        self.assertIn("resolved source conflict with upstream overlap: settings.py", output)

    def test_distinct_json_records_are_merged(self):
        base_events = {"records": [{"id": "base", "value": 1}]}
        production_events = {
            "records": [
                {"id": "base", "value": 1},
                {"id": "production", "value": 2},
            ]
        }
        upstream_events = {
            "records": [
                {"id": "base", "value": 1},
                {"id": "upstream", "value": 3},
            ]
        }
        encode = lambda value: json.dumps(value, separators=(",", ":")) + "\n"
        fixture = self._fixture(
            self._base_files({"data/events.json": encode(base_events)}),
            {"data/events.json": encode(upstream_events)},
            {"data/events.json": encode(production_events)},
        )

        result = self._run_sync(fixture)

        output = result.stdout + result.stderr
        self.assertEqual(result.returncode, 0, output)
        merged = json.loads(
            (fixture["app"] / "data" / "events.json").read_text(encoding="utf-8")
        )
        self.assertEqual(
            merged["records"],
            [
                {"id": "base", "value": 1},
                {"id": "production", "value": 2},
                {"id": "upstream", "value": 3},
            ],
        )
        self.assertEqual(
            (fixture["work"] / "base-commit").read_text(encoding="ascii").strip(),
            fixture["next_commit"],
        )

    def test_health_failure_restores_all_production_hashes(self):
        fixture = self._fixture(
            self._base_files({"obsolete.py": 'VALUE = "keep"\n'}),
            {
                "module.py": 'VALUE = "deployed"\n',
                "obsolete.py": None,
                "new.py": 'VALUE = "new"\n',
            },
            health_mode="fail-first-cycle",
        )
        before = self._tree_hashes(fixture["app"])

        result = self._run_sync(fixture)

        output = result.stdout + result.stderr
        self.assertNotEqual(result.returncode, 0, output)
        self.assertEqual(self._tree_hashes(fixture["app"]), before)
        self.assertFalse((fixture["app"] / "new.py").exists())
        self.assertEqual(
            (fixture["work"] / "base-commit").read_text(encoding="ascii").strip(),
            fixture["base_commit"],
        )
        self.assertGreaterEqual(
            int((fixture["state"] / "curl-count").read_text(encoding="ascii").strip()),
            1,
        )
        self.assertIn("failed health validation and was rolled back", output)


if __name__ == "__main__":
    unittest.main(verbosity=2)
