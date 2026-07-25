import json
import tempfile
import unittest
from pathlib import Path

from valuation import core


class StateResilienceTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.original_paths = (
            core.DATA_DIR,
            core.STATE_FILE,
            core.DEFAULT_STATE_FILE,
            core.STATE_BACKUP_DIR,
        )
        core.DATA_DIR = self.root / "data"
        core.STATE_FILE = core.DATA_DIR / "state.json"
        core.DEFAULT_STATE_FILE = self.root / "default_state.json"
        core.STATE_BACKUP_DIR = core.DATA_DIR / "state-backups"

    def tearDown(self):
        (
            core.DATA_DIR,
            core.STATE_FILE,
            core.DEFAULT_STATE_FILE,
            core.STATE_BACKUP_DIR,
        ) = self.original_paths
        self.temp_dir.cleanup()

    def write_seed(self, funds):
        self.root.mkdir(parents=True, exist_ok=True)
        core.DEFAULT_STATE_FILE.write_text(json.dumps({
            "version": 1,
            "updated_at": "2026-07-01 00:00:00",
            "sectors": [{"name": "半导体", "funds": funds}],
        }, ensure_ascii=False), encoding="utf-8")

    def test_missing_runtime_state_recovers_from_tracked_seed(self):
        self.write_seed([{"code": "008888", "alias": ""}])

        state = core.load_state()

        self.assertEqual(state["sectors"][0]["name"], "半导体")
        self.assertEqual(state["sectors"][0]["funds"][0]["code"], "008888")
        self.assertTrue(core.STATE_FILE.exists())

    def test_stale_revision_cannot_replace_newer_state(self):
        self.write_seed([])
        initial = {"version": 1, "sectors": [{"name": "半导体", "funds": [{"code": "008888"}]}]}
        self.assertTrue(core.save_state(initial))
        stale_revision = initial["updated_at"]

        current = {"version": 1, "sectors": [{"name": "半导体", "funds": [{"code": "008888"}, {"code": "006271"}]}]}
        self.assertTrue(core.save_state(current, expected_updated_at=stale_revision))

        stale_write = {"version": 1, "sectors": [{"name": "半导体", "funds": []}]}
        self.assertFalse(core.save_state(stale_write, expected_updated_at=stale_revision))
        self.assertEqual(core._fund_count(core.load_state()), 2)

    def test_destructive_save_keeps_a_server_recovery_point(self):
        self.write_seed([])
        initial = {"version": 1, "sectors": [{"name": "半导体", "funds": [{"code": "008888"}, {"code": "006271"}]}]}
        self.assertTrue(core.save_state(initial))

        replacement = {"version": 1, "sectors": [{"name": "半导体", "funds": []}]}
        self.assertTrue(core.save_state(replacement, expected_updated_at=initial["updated_at"]))

        backups = list(core.STATE_BACKUP_DIR.glob("state-before-delete-*.json"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(core._fund_count(json.loads(backups[0].read_text(encoding="utf-8"))), 2)


if __name__ == "__main__":
    unittest.main()
