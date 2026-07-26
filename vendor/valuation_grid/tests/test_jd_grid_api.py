import sys
import tempfile
import types
import unittest
import json
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
from valuation import providers


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

    def test_history_ignores_eastmoney_null_placeholders(self):
        class Response:
            def read(self):
                return json.dumps({"Data": {"LSJZList": [
                    {"FSRQ": "2026-07-24", "DWJZ": "1.2345", "JZZZL": "0.12"},
                    None,
                ]}}).encode("utf-8")

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        providers._nav_history_cache.clear()
        with patch("valuation.providers.urlopen", return_value=Response()):
            history = providers.get_fund_nav_history("000001", 1)

        self.assertEqual(history, [{"date": "2026-07-24", "nav": 1.2345, "change": 0.12}])

    def test_history_uses_fund_proxy_when_eastmoney_data_is_null(self):
        class Response:
            def __init__(self, payload):
                self.payload = payload

            def read(self):
                return json.dumps(self.payload).encode("utf-8")

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        def urlopen_side_effect(request, timeout):
            if "127.0.0.1:3000" in request.full_url:
                return Response({"data": {"items": [{
                    "date": "2024-01-02", "nav": 1.25, "changePercent": "0.5",
                }]}})
            return Response({"Data": None})

        providers._nav_history_cache.clear()
        with patch("valuation.providers.urlopen", side_effect=urlopen_side_effect):
            history = providers.get_fund_nav_history("000001", 1)

        self.assertEqual(history, [{"date": "2024-01-02", "nav": 1.25, "change": 0.5}])

    def test_pingzhong_fallback_keeps_full_series_in_descending_date_order(self):
        class Response:
            def read(self):
                return (
                    'var Data_netWorthTrend = ['
                    '{"x":1704124800000,"y":1.25,"equityReturn":0.5},'
                    '{"x":1704038400000,"y":1.2,"equityReturn":-1}'
                    '];'
                ).encode("utf-8")

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        with patch("valuation.providers.urlopen", return_value=Response()):
            history = providers._get_pingzhong_nav_history("000001", 2)

        self.assertEqual(history, [
            {"date": "2024-01-02", "nav": 1.25, "change": 0.5},
            {"date": "2024-01-01", "nav": 1.2, "change": -1.0},
        ])

    def test_only_current_holding_codes_are_materialized(self):
        with patch("valuation.providers.get_fund_nav_history", return_value=[{"date": "2026-07-20", "nav": 1}]):
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
        with patch("valuation.providers.get_fund_nav_history", return_value=[{"date": "2026-07-20", "nav": 1.25}]):
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

    def test_amount_only_buy_and_sell_use_order_time_confirmation_nav(self):
        with patch("valuation.providers.get_fund_nav_history", return_value=[
            {"date": "2026-07-03", "nav": 1.2},
            {"date": "2026-07-02", "nav": 1.2},
            {"date": "2026-07-01", "nav": 1.1},
        ]):
            result = app.import_jd_positions(app.JdGridImportRequest(
                current_holding_codes=["000001"],
                current_holdings=[{"code": "000001", "name": "Current", "shares": "50"}],
                adjustments=[
                    {
                        "id": "buy-after-cutoff", "code": "000001", "type": "add",
                        "tradeDate": "2026-07-01", "tradeTime": "2026-07-01 16:00:00", "amount": "120",
                    },
                    {
                        "id": "sell", "code": "000001", "type": "reduce",
                        "tradeDate": "2026-07-03", "tradeTime": "2026-07-03 10:00:00", "amount": "60",
                    },
                ],
            ))

        self.assertEqual(result["imported"], 2)
        batch = positions.load_positions()["funds"]["000001"]["batches"][0]
        self.assertEqual(batch["nav"], 1.2)
        self.assertEqual(batch["shares"], 50)

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
        with patch("valuation.providers.get_fund_nav_history", return_value=[{"date": "2026-07-20", "nav": 1.2}]):
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
