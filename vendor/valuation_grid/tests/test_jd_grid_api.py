import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

pil = types.ModuleType("PIL")
sys.modules.setdefault("PIL", pil)
for module_name in ("Image", "ImageDraw", "ImageFont"):
    module = types.ModuleType(f"PIL.{module_name}")
    setattr(pil, module_name, module)
    sys.modules.setdefault(f"PIL.{module_name}", module)

import app
import positions


class JdGridApiTest(unittest.TestCase):
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

    def test_only_current_holding_codes_are_materialized(self):
        result = app.import_jd_positions(app.JdGridImportRequest(
            current_holding_codes=["000001"],
            current_holdings=[{"code": "000001", "name": "Current", "shares": "100"}],
            adjustments=[
                {"id": "buy", "code": "000001", "type": "add", "tradeDate": "2026-07-20", "shares": "100", "amount": "100"},
                {"id": "closed", "code": "000002", "type": "add", "tradeDate": "2026-07-20", "shares": "100", "amount": "100"},
            ],
        ))

        self.assertEqual(result["imported"], 1)
        self.assertEqual(result["skipped"], 1)
        self.assertEqual(set(positions.load_positions()["funds"]), {"000001"})

    def test_conversion_target_can_import_when_it_is_the_current_holding(self):
        result = app.import_jd_positions(app.JdGridImportRequest(
            current_holding_codes=["000001"],
            current_holdings=[{"code": "000001", "name": "Current", "shares": "80"}],
            adjustments=[{
                "id": "convert", "code": "000002", "type": "convert", "tradeDate": "2026-07-20",
                "shares": "50", "amount": "100", "targetCode": "000001", "targetShares": "80",
            }],
        ))

        self.assertEqual(result["imported"], 1)
        target = positions.load_positions()["funds"]["000001"]["batches"][0]
        self.assertEqual(target["shares"], 80)

    def test_old_jd_purchase_uses_its_published_historical_nav_when_amount_is_missing(self):
        with patch("valuation.providers.get_fund_nav_history", return_value=[{
            "date": "2024-01-02", "nav": 1.25,
        }]) as history:
            result = app.import_jd_positions(app.JdGridImportRequest(
                current_holding_codes=["000001"],
                current_holdings=[{"code": "000001", "name": "Current", "shares": "100"}],
                adjustments=[{
                    "id": "old-buy", "code": "000001", "type": "add", "tradeDate": "2024-01-02", "shares": "100",
                }],
            ))

        self.assertEqual(result["imported"], 1)
        batch = positions.load_positions()["funds"]["000001"]["batches"][0]
        self.assertEqual(batch["amount"], 125)
        self.assertEqual(batch["nav"], 1.25)
        self.assertGreater(history.call_args.args[1], 90)

    def test_unreconciled_timeline_never_materializes_partial_batches(self):
        result = app.import_jd_positions(app.JdGridImportRequest(
            current_holding_codes=["000001"],
            current_holdings=[{"code": "000001", "name": "Current", "shares": "60"}],
            adjustments=[
                {"id": "buy", "code": "000001", "type": "add", "tradeDate": "2026-07-01", "shares": "100", "amount": "100"},
                {"id": "sell", "code": "000001", "type": "reduce", "tradeDate": "2026-07-02", "shares": "30", "amount": "30"},
            ],
        ))

        self.assertEqual(result["imported"], 0)
        self.assertIn("unverified_current_timeline", [item["reason"] for item in result["results"]])
        self.assertEqual(positions.load_positions()["funds"], {})

    def test_current_snapshot_never_creates_a_synthetic_grid_batch(self):
        result = app.import_jd_positions(app.JdGridImportRequest(
            current_holding_codes=["000001"],
            current_holdings=[{"code": "000001", "name": "Current", "shares": "100", "costPrice": "1.2", "costAmount": "120", "acquiredDate": "2026-07-01"}],
            adjustments=[],
        ))

        self.assertEqual(result["imported"], 0)
        self.assertEqual(result["skipped"], 1)
        self.assertEqual(result["results"][0]["reason"], "missing_current_cycle_transaction")

    def test_uncovered_current_holding_is_reported_without_a_snapshot_batch(self):
        result = app.import_jd_positions(app.JdGridImportRequest(
            current_holding_codes=["000001", "000002"],
            current_holdings=[
                {"code": "000001", "name": "Existing buy", "shares": "100", "costPrice": "1.2"},
                {"code": "000002", "name": "Snapshot only", "shares": "1000", "amount": "1200", "costPrice": "1", "costAmount": "1000", "acquiredDate": "2026-07-23"},
            ],
            adjustments=[{"id": "buy", "code": "000001", "type": "add", "tradeDate": "2026-07-20", "shares": "100", "amount": "120"}],
        ))

        self.assertEqual(result["imported"], 1)
        self.assertEqual(result["skipped"], 1)
        self.assertEqual(set(positions.load_positions()["funds"]), {"000001"})
        self.assertEqual(result["results"][0]["reason"], "missing_current_cycle_transaction")

    def test_snapshot_cost_never_substitutes_for_a_real_transaction(self):
        result = app.import_jd_positions(app.JdGridImportRequest(
            current_holding_codes=["000001"],
            current_holdings=[{"code": "000001", "name": "Cookie cost", "shares": "1000", "amount": "1200", "costPrice": "1.05", "costAmount": "1050", "acquiredDate": "2026-07-01"}],
            adjustments=[],
        ))

        self.assertEqual(result["imported"], 0)
        self.assertEqual(result["results"][0]["reason"], "missing_current_cycle_transaction")

    def test_snapshot_never_invents_a_trade_date_or_reconstructs_shares(self):
        result = app.import_jd_positions(app.JdGridImportRequest(
            current_holding_codes=["000001"],
            current_holdings=[{
                "code": "000001", "name": "Incomplete snapshot",
                "amount": "1200", "profit": "200",
            }],
            adjustments=[],
        ))

        self.assertEqual(result["imported"], 0)
        self.assertEqual(result["skipped"], 1)
        self.assertEqual(result["results"][0]["reason"], "missing_current_cycle_transaction")

    def test_snapshot_reports_missing_real_trade_date_separately(self):
        result = app.import_jd_positions(app.JdGridImportRequest(
            current_holding_codes=["000001"],
            current_holdings=[{
                "code": "000001", "name": "Dated only by JD history",
                "shares": "100", "costPrice": "1.2", "costAmount": "120",
            }],
            adjustments=[],
        ))

        self.assertEqual(result["imported"], 0)
        self.assertEqual(result["skipped"], 1)
        self.assertEqual(result["results"][0]["reason"], "missing_current_cycle_transaction")


if __name__ == "__main__":
    unittest.main()
