import tempfile
import unittest
from pathlib import Path

import positions


class JdGridImportTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.original_paths = positions.DATA_DIR, positions.POS_FILE, positions.POS_BACKUP_FILE, positions.POS_LOCK_FILE
        positions.DATA_DIR = root / "data"
        positions.POS_FILE = positions.DATA_DIR / "positions.json"
        positions.POS_BACKUP_FILE = positions.DATA_DIR / "positions.backup.json"
        positions.POS_LOCK_FILE = positions.DATA_DIR / ".positions.lock"

    def tearDown(self):
        positions.DATA_DIR, positions.POS_FILE, positions.POS_BACKUP_FILE, positions.POS_LOCK_FILE = self.original_paths
        self.temp_dir.cleanup()

    def import_rows(self, *rows):
        return positions.import_jd_grid_transactions(list(rows))

    def buy(self, ledger_id="jd:buy:source", code="000001", date="2026-07-01", amount=100, nav=1):
        return {"ledger_id": ledger_id, "code": code, "action": "buy", "trade_date": date, "amount": amount, "nav": nav, "note": "JD"}

    def sell(self, ledger_id="jd:sell:source", code="000001", date="2026-07-02", shares=40, nav=1.1):
        return {"ledger_id": ledger_id, "code": code, "action": "sell", "trade_date": date, "shares": shares, "nav": nav, "note": "JD"}

    def test_buy_is_idempotent(self):
        first = self.import_rows(self.buy())
        second = self.import_rows(self.buy())

        self.assertEqual(first["imported"], 1)
        self.assertEqual(second["imported"], 0)
        self.assertEqual(second["skipped"], 1)
        fund = positions.load_positions()["funds"]["000001"]
        self.assertEqual(len(fund["batches"]), 1)
        self.assertEqual(fund["batches"][0]["shares"], 100)

    def test_fifo_sell_uses_oldest_batches(self):
        result = self.import_rows(
            self.buy("jd:buy:first", date="2026-07-01", amount=100, nav=1),
            self.buy("jd:buy:second", date="2026-07-02", amount=100, nav=1),
            self.sell(shares=150),
        )

        self.assertEqual(result["imported"], 3)
        batches = positions.load_positions()["funds"]["000001"]["batches"]
        self.assertEqual(batches[0]["status"], "sold")
        self.assertEqual(batches[1]["shares"], 50)

    def test_unmatched_and_partial_sells_are_recorded_without_crashing(self):
        unmatched = self.import_rows(self.sell())
        partial = self.import_rows(self.buy(), self.sell("jd:partial:source", shares=150))

        self.assertEqual(unmatched["skipped"], 1)
        self.assertEqual(partial["partial"], 1)
        ledger = positions.load_positions()["imported_transaction_ids"]
        self.assertEqual(ledger["jd:sell:source"]["outcome"], "skipped")
        self.assertEqual(ledger["jd:partial:source"]["outcome"], "partial")

    def test_conversion_legs_can_be_imported_independently(self):
        result = self.import_rows(
            self.buy("jd:seed:source", amount=100, nav=1),
            self.sell("jd:convert:source", shares=50),
            self.buy("jd:convert:target", code="000002", amount=55, nav=1.1),
        )

        self.assertEqual(result["imported"], 3)
        funds = positions.load_positions()["funds"]
        self.assertEqual(funds["000001"]["batches"][0]["shares"], 50)
        self.assertEqual(funds["000002"]["batches"][0]["shares"], 50)

    def test_snapshot_seed_never_adds_to_an_existing_grid_position(self):
        self.import_rows(self.buy("manual:buy"))
        result = self.import_rows({
            "ledger_id": "jd:snapshot:000001", "code": "000001", "action": "seed",
            "trade_date": "2026-07-24", "amount": 120, "nav": 1.2, "shares": 100,
        })

        self.assertEqual(result["imported"], 0)
        self.assertEqual(result["skipped"], 1)
        self.assertEqual(len(positions.load_positions()["funds"]["000001"]["batches"]), 1)

    def test_verified_timeline_replaces_an_earlier_snapshot_baseline(self):
        self.import_rows({
            "ledger_id": "jd:snapshot:000001", "code": "000001", "action": "seed",
            "trade_date": "2026-07-24", "amount": 120, "nav": 1.2, "shares": 100,
            "note": "京东导入·当前持仓基线",
        })
        verified = self.buy("jd:real:source", amount=100, nav=1)
        verified["timeline_verified"] = True
        result = self.import_rows(verified)

        self.assertEqual(result["imported"], 1)
        batches = positions.load_positions()["funds"]["000001"]["batches"]
        self.assertEqual(len(batches), 1)
        self.assertEqual(batches[0]["source"], "jd_timeline")
        self.assertEqual(batches[0]["source_ledger_id"], "jd:real:source")

    def test_verified_timeline_rebuilds_old_jd_batches_but_preserves_manual_funds(self):
        verified_old = self.buy("jd:old:source", amount=100, nav=1)
        verified_old["timeline_verified"] = True
        self.import_rows(verified_old)
        verified_new = self.buy("jd:old:source", amount=120, nav=1.2)
        verified_new["timeline_verified"] = True
        result = self.import_rows(verified_new)

        self.assertEqual(result["imported"], 1)
        rebuilt = positions.load_positions()["funds"]["000001"]["batches"]
        self.assertEqual(len(rebuilt), 1)
        self.assertEqual(rebuilt[0]["amount"], 120)
        self.assertEqual(rebuilt[0]["source"], "jd_timeline")

        self.import_rows(self.buy("manual:buy", code="000002", amount=100, nav=1))
        protected = self.buy("jd:timeline:source", code="000002", amount=120, nav=1.2)
        protected["timeline_verified"] = True
        blocked = self.import_rows(protected)
        self.assertEqual(blocked["imported"], 0)
        self.assertEqual(blocked["results"][0]["reason"], "existing_manual_grid_position")
        self.assertEqual(positions.load_positions()["funds"]["000002"]["batches"][0]["amount"], 100)


if __name__ == "__main__":
    unittest.main()
