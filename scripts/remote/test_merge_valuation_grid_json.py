import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("merge-valuation-grid-json.py")


class JsonMergeDriverTest(unittest.TestCase):
    def run_merge(
        self,
        ancestor,
        current,
        other,
        current_name="current.json",
        other_timestamp=None,
        merge_path=None,
    ):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        paths = {
            "ancestor": root / "ancestor.json",
            "current": root / current_name,
            "other": root / "other.json",
        }
        values = {"ancestor": ancestor, "current": current, "other": other}
        for label, path in paths.items():
            path.write_text(
                json.dumps(values[label], ensure_ascii=False), encoding="utf-8"
            )

        before = paths["current"].read_bytes()
        command = [
                sys.executable,
                str(SCRIPT),
                "--ancestor",
                str(paths["ancestor"]),
                "--current",
                str(paths["current"]),
                "--other",
                str(paths["other"]),
            ]
        if other_timestamp:
            command.extend(["--other-timestamp", other_timestamp])
        if merge_path:
            command.extend(["--path", merge_path])
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
        )
        return result, paths["current"], before

    def assert_success(self, ancestor, current, other, expected, **kwargs):
        result, current_path, _ = self.run_merge(
            ancestor, current, other, **kwargs
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(current_path.read_text(encoding="utf-8")), expected)
        return current_path

    def assert_conflict(self, ancestor, current, other, **kwargs):
        result, current_path, before = self.run_merge(
            ancestor, current, other, **kwargs
        )
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("JSON merge conflict", result.stderr)
        self.assertEqual(current_path.read_bytes(), before)

    def test_merges_independent_dictionary_keys(self):
        self.assert_success(
            {"config": {"shared": 1}},
            {"config": {"shared": 1, "local": True}},
            {"config": {"shared": 1, "upstream": True}},
            {"config": {"shared": 1, "local": True, "upstream": True}},
        )

    def test_confidence_records_merge_by_date_when_both_append(self):
        base = {"confidence": [{"date": "2026-08-01", "value": 0.5}]}
        current = {
            "confidence": base["confidence"]
            + [{"date": "2026-08-02", "value": 0.6}]
        }
        other = {
            "confidence": base["confidence"]
            + [{"date": "2026-08-03", "value": 0.7}]
        }
        self.assert_success(
            base,
            current,
            other,
            {
                "confidence": [
                    {"date": "2026-08-03", "value": 0.7},
                    {"date": "2026-08-02", "value": 0.6},
                    {"date": "2026-08-01", "value": 0.5},
                ]
            },
            merge_path="data/confidence_deviations.json",
        )

    def test_signal_records_use_full_composite_key(self):
        def signal(source, action, name):
            return {
                "date": "2026-08-11",
                "time": "10:00",
                "source": source,
                "action": action,
                "signal_name": name,
            }

        common = signal("grid", "hold", "base")
        local = signal("grid", "buy", "local")
        upstream = signal("grid", "sell", "upstream")
        self.assert_success(
            {"signals": [common]},
            {"signals": [common, local]},
            {"signals": [common, upstream]},
            {"signals": [common, local, upstream]},
            merge_path="data/signal_history.json",
        )

    def test_unknown_changed_record_list_merges_with_unique_ids(self):
        self.assert_success(
            {"items": [{"id": "base", "value": 1}]},
            {"items": [{"id": "base", "value": 1}, {"id": "local", "value": 2}]},
            {"items": [{"id": "base", "value": 1}, {"id": "other", "value": 3}]},
            {
                "items": [
                    {"id": "base", "value": 1},
                    {"id": "local", "value": 2},
                    {"id": "other", "value": 3},
                ]
            },
            merge_path="data/unrecognized.json",
        )

    def test_same_record_changed_to_different_values_conflicts(self):
        self.assert_conflict(
            {"items": [{"id": "a", "value": 1}]},
            {"items": [{"id": "a", "value": 2}]},
            {"items": [{"id": "a", "value": 3}]},
        )

    def test_newer_current_snapshot_wins(self):
        self.assert_success(
            {"fund": {"date": "2026-08-09", "est": 1}},
            {
                "fund": {
                    "date": "2026-08-10",
                    "asof_time": "2026-08-10 11:04:53",
                    "est": 2,
                }
            },
            {
                "fund": {
                    "date": "2026-08-10",
                    "asof_time": "2026-08-10 10:30:00",
                    "est": 3,
                }
            },
            {
                "fund": {
                    "date": "2026-08-10",
                    "asof_time": "2026-08-10 11:04:53",
                    "est": 2,
                }
            },
            merge_path="data/intraday_cache.json",
        )

    def test_newer_other_snapshot_wins(self):
        self.assert_success(
            {"fund": {"date": "2026-08-09", "est": 1}},
            {"fund": {"date": "2026-08-10", "est": 2}},
            {"fund": {"date": "2026-08-11", "est": 3}},
            {"fund": {"date": "2026-08-11", "est": 3}},
            merge_path="data/intraday_cache.json",
        )

    def test_equal_snapshot_timestamp_with_different_values_conflicts(self):
        self.assert_conflict(
            {"fund": {"date": "2026-08-09", "est": 1}},
            {
                "fund": {
                    "date": "2026-08-10",
                    "asof_time": "11:00:00",
                    "est": 2,
                }
            },
            {
                "fund": {
                    "date": "2026-08-10",
                    "asof_time": "11:00:00",
                    "est": 3,
                }
            },
            merge_path="data/intraday_cache.json",
        )

    def test_upstream_commit_time_resolves_date_only_snapshot(self):
        self.assert_success(
            {"fund": {"date": "2026-08-09", "est": 1}},
            {
                "fund": {
                    "date": "2026-08-10",
                    "asof_time": "2026-08-10 11:04:53",
                    "est": 2,
                }
            },
            {"fund": {"date": "2026-08-10", "est": 3}},
            {"fund": {"date": "2026-08-10", "est": 3}},
            other_timestamp="2026-08-10T15:04:00+08:00",
            merge_path="data/intraday_cache.json",
        )

    def test_record_deletion_against_unchanged_record_succeeds(self):
        base = {"items": [{"id": "a", "value": 1}, {"id": "b", "value": 2}]}
        self.assert_success(
            base,
            {"items": [{"id": "b", "value": 2}]},
            base,
            {"items": [{"id": "b", "value": 2}]},
        )

    def test_record_deletion_against_modification_conflicts(self):
        self.assert_conflict(
            {"items": [{"id": "a", "value": 1}]},
            {"items": []},
            {"items": [{"id": "a", "value": 2}]},
        )

    def test_unidentifiable_list_changed_on_both_sides_conflicts(self):
        self.assert_conflict(
            {"values": [1]},
            {"values": [1, 2]},
            {"values": [1, 3]},
        )

    def test_positions_filename_receives_only_generic_record_merge(self):
        self.assert_success(
            {"funds": []},
            {"funds": [{"id": "local", "value": 1}]},
            {"funds": [{"id": "upstream", "value": 2}]},
            {
                "funds": [
                    {"id": "local", "value": 1},
                    {"id": "upstream", "value": 2},
                ]
            },
            current_name="positions.json",
        )

    def test_success_output_is_utf8_pretty_printed_with_final_newline(self):
        path = self.assert_success(
            {},
            {"name": "\u57fa\u91d1"},
            {},
            {"name": "\u57fa\u91d1"},
        )
        raw = path.read_bytes()
        self.assertTrue(raw.endswith(b"\n"))
        self.assertIn("\u57fa\u91d1".encode("utf-8"), raw)
        self.assertNotIn(b"\\u57fa", raw)
        self.assertIn(b'\n  "name": ', raw)

    def test_invalid_json_returns_input_error_without_overwriting_current(self):
        result, current_path, _ = self.run_merge({}, {"ok": True}, {})
        self.assertEqual(result.returncode, 0, result.stderr)
        before = current_path.read_bytes()
        ancestor_path = current_path.parent / "ancestor.json"
        ancestor_path.write_text("{broken", encoding="utf-8")
        result = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--ancestor",
                str(ancestor_path),
                "--current",
                str(current_path),
                "--other",
                str(current_path.parent / "other.json"),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
        )
        self.assertGreaterEqual(result.returncode, 2)
        self.assertEqual(current_path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
