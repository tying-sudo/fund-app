import json
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
from fastapi.testclient import TestClient
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

    @staticmethod
    def holding(code="000001", name="Current", shares="100", cost_price="1.2"):
        return {
            "code": code,
            "name": name,
            "shares": shares,
            "costPrice": cost_price,
            "costAmount": str(float(shares) * float(cost_price)),
            "acquiredDate": "2026-01-02",
        }

    def import_payload(self, codes, holdings, adjustments, replace_codes=None):
        return app.import_jd_positions(app.JdGridImportRequest(
            current_holding_codes=codes,
            replace_transaction_codes=replace_codes or [],
            current_holdings=holdings,
            adjustments=adjustments,
        ))

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
                return Response({"data": {"items": [{"date": "2024-01-02", "nav": 1.25, "changePercent": "0.5"}]}})
            return Response({"Data": None})

        providers._nav_history_cache.clear()
        with patch("valuation.providers.urlopen", side_effect=urlopen_side_effect):
            history = providers.get_fund_nav_history("000001", 1)
        self.assertEqual(history, [{"date": "2024-01-02", "nav": 1.25, "change": 0.5}])

    def test_unreconciled_timeline_keeps_snapshot_while_audit_rows_are_detailed(self):
        result = self.import_payload(
            ["000001"],
            [self.holding()],
            [
                {"id": "buy-1", "code": "000001", "name": "Current", "type": "add", "tradeDate": "2026-07-29", "amount": "60", "shares": "50", "statusCode": "COMPLETE"},
                {"id": "sell-1", "code": "000001", "name": "Current", "type": "reduce", "tradeDate": "2026-07-30", "amount": "24", "shares": "20", "statusCode": "REDEEM_SUCC"},
            ],
        )

        self.assertEqual(result["imported"], 1)
        self.assertEqual(result["audit_imported"], 2)
        fund = positions.load_positions()["funds"]["000001"]
        self.assertEqual(len(fund["batches"]), 1)
        self.assertEqual(fund["batches"][0]["shares"], 100)
        self.assertEqual([item["type"] for item in fund["jd_transactions"]], ["sell", "buy"])
        self.assertTrue(all(item["state"] == "confirmed" for item in fund["jd_transactions"]))

    def test_same_day_pending_purchase_creates_a_visible_fund_without_fake_shares(self):
        result = self.import_payload(
            ["000009"],
            [],
            [{
                "id": "pending-buy", "code": "000009", "name": "New fund", "type": "add",
                "tradeDate": "2026-07-30", "tradeTime": "2026-07-30 10:30:00",
                "amount": "100", "statusCode": "PAY_SUCC", "status": "paid",
            }],
        )

        self.assertEqual(result["imported"], 0)
        self.assertEqual(result["audit_imported"], 1)
        fund = positions.load_positions()["funds"]["000009"]
        self.assertEqual(fund["batches"], [])
        self.assertTrue(fund["jd_pending_position"])
        self.assertEqual(fund["jd_transactions"][0]["state"], "pending")
        self.assertIsNone(fund["jd_transactions"][0]["shares"])

    def test_conversion_creates_both_legs_without_changing_snapshot_totals(self):
        self.import_payload(
            ["000001", "000002"],
            [self.holding("000001", "Source", "50", "2"), self.holding("000002", "Target", "80", "1.25")],
            [{
                "id": "convert-1", "code": "000001", "name": "Source", "type": "convert",
                "tradeDate": "2026-07-30", "shares": "10", "amount": "20",
                "targetCode": "000002", "targetName": "Target", "targetShares": "16",
                "statusCode": "TRANSFORM_SUCC",
            }],
        )

        funds = positions.load_positions()["funds"]
        self.assertEqual(funds["000001"]["batches"][0]["shares"], 50)
        self.assertEqual(funds["000002"]["batches"][0]["shares"], 80)
        self.assertEqual(funds["000001"]["jd_transactions"][0]["type"], "convert_out")
        self.assertEqual(funds["000002"]["jd_transactions"][0]["type"], "convert_in")
        self.assertEqual(funds["000002"]["jd_transactions"][0]["counterparty_code"], "000001")

    def test_repeated_sync_is_idempotent(self):
        payload = (
            ["000001"],
            [self.holding()],
            [{"id": "buy-1", "code": "000001", "type": "add", "tradeDate": "2026-07-30", "amount": "12", "shares": "10", "statusCode": "COMPLETE"}],
        )
        self.import_payload(*payload)
        repeated = self.import_payload(*payload)

        self.assertEqual(repeated["imported"], 0)
        self.assertEqual(repeated["updated"], 0)
        self.assertEqual(len(positions.load_positions()["funds"]["000001"]["jd_transactions"]), 1)
        self.assertIn("duplicate", [item.get("reason") for item in repeated["results"]])
        self.assertEqual(repeated["audit_skipped"], 1)

    def test_pending_order_is_updated_in_place_after_confirmation(self):
        holding = self.holding()
        pending = {"id": "same-order", "code": "000001", "type": "add", "tradeDate": "2026-07-30", "amount": "12", "statusCode": "PAY_SUCC"}
        complete = {**pending, "shares": "10", "statusCode": "COMPLETE", "confirmTime": "2026-07-31 12:00:00"}
        self.import_payload(["000001"], [holding], [pending])
        result = self.import_payload(["000001"], [holding], [complete])

        records = positions.load_positions()["funds"]["000001"]["jd_transactions"]
        self.assertEqual(result["audit_updated"], 1)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["state"], "confirmed")
        self.assertEqual(records[0]["shares"], 10)

    def test_multiple_buys_remain_separate_and_order_ids_are_not_exposed(self):
        self.import_payload(
            ["000001"],
            [self.holding()],
            [
                {"id": "sensitive-order-a", "code": "000001", "type": "add", "tradeDate": "2026-07-29", "amount": "12", "shares": "10", "statusCode": "COMPLETE"},
                {"id": "sensitive-order-b", "code": "000001", "type": "add", "tradeDate": "2026-07-30", "amount": "24", "shares": "20", "statusCode": "COMPLETE"},
            ],
        )

        records = positions.load_positions()["funds"]["000001"]["jd_transactions"]
        self.assertEqual(len(records), 2)
        self.assertTrue(all(item["id"].startswith("jdtx:") for item in records))
        self.assertNotIn("sensitive-order", json.dumps(records))

    def test_verified_current_cycle_replaces_pre_exit_audit_rows(self):
        holding = self.holding(shares="40")
        self.import_payload(
            ["000001"], [holding],
            [
                {"id": "old-buy", "code": "000001", "type": "add", "tradeDate": "2021-01-01", "shares": "100"},
                {"id": "old-exit", "code": "000001", "type": "reduce", "tradeDate": "2022-01-01", "shares": "100"},
            ],
        )
        result = self.import_payload(
            ["000001"], [holding],
            [
                {"id": "rebuild-buy", "code": "000001", "type": "add", "tradeDate": "2025-01-01", "amount": "60", "shares": "60", "statusCode": "COMPLETE", "cycleCodes": ["000001"]},
                {"id": "rebuild-sell", "code": "000001", "type": "reduce", "tradeDate": "2026-01-01", "amount": "20", "shares": "20", "statusCode": "REDEEM_SUCC", "cycleCodes": ["000001"]},
            ],
            ["000001"],
        )

        records = positions.load_positions()["funds"]["000001"]["jd_transactions"]
        self.assertEqual({item["type"] for item in records}, {"buy", "sell"})
        self.assertEqual(len(records), 2)
        self.assertIn("replace_audit", [item.get("action") for item in result["audit_results"]])

    def test_conversion_cycle_membership_does_not_restore_a_pre_cycle_source_leg(self):
        self.import_payload(
            ["000001", "000002"],
            [self.holding("000001", "Rebuilt source", "50", "2"), self.holding("000002", "Target", "80", "1.25")],
            [{
                "id": "target-opening-conversion", "code": "000001", "type": "convert",
                "tradeDate": "2025-01-01", "shares": "10", "targetCode": "000002",
                "targetShares": "16", "cycleCodes": ["000002"],
            }],
        )

        funds = positions.load_positions()["funds"]
        self.assertEqual(funds["000001"].get("jd_transactions", []), [])
        self.assertEqual([item["type"] for item in funds["000002"]["jd_transactions"]], ["convert_in"])

    def test_inactive_transaction_is_not_saved(self):
        result = self.import_payload(
            ["000001"],
            [self.holding()],
            [{"id": "refund", "code": "000001", "type": "add", "tradeDate": "2026-07-30", "statusCode": "REFUND_SUCC"}],
        )

        self.assertIn("inactive_transaction", [item.get("reason") for item in result["audit_results"]])
        self.assertEqual(positions.load_positions()["funds"]["000001"].get("jd_transactions", []), [])

    def test_verified_current_cycle_rebuilds_visible_grid_batches(self):
        with patch("valuation.providers.get_fund_nav_history", return_value=[]):
            result = self.import_payload(
                ["000001"],
                [self.holding(shares="40", cost_price="1")],
                [
                    {"id": "opening-buy", "code": "000001", "type": "add", "tradeDate": "2026-07-01", "amount": "60", "shares": "60", "statusCode": "COMPLETE", "cycleCodes": ["000001"]},
                    {"id": "partial-sell", "code": "000001", "type": "reduce", "tradeDate": "2026-07-02", "amount": "20", "shares": "20", "statusCode": "REDEEM_SUCC", "cycleCodes": ["000001"]},
                ],
                ["000001"],
            )

        fund = positions.load_positions()["funds"]["000001"]
        self.assertEqual(result["imported"], 2)
        self.assertEqual(result["audit_imported"], 2)
        self.assertEqual(len(fund["batches"]), 1)
        self.assertEqual(fund["batches"][0]["source"], "jd_timeline")
        self.assertEqual(fund["batches"][0]["shares"], 40)
        self.assertEqual(len(fund["sell_records"]), 1)

    def test_pending_rows_are_audit_only_when_confirmed_cycle_matches_snapshot(self):
        result = self.import_payload(
            ["000001"],
            [self.holding(shares="40", cost_price="1")],
            [
                {"id": "opening-buy", "code": "000001", "type": "add", "tradeDate": "2026-07-01", "amount": "40", "shares": "40", "statusCode": "COMPLETE", "cycleCodes": ["000001"]},
                {"id": "pending-buy", "code": "000001", "type": "add", "tradeDate": "2026-07-30", "amount": "10", "shares": "10", "statusCode": "PAY_SUCC", "cycleCodes": ["000001"]},
                {"id": "pending-sell", "code": "000001", "type": "reduce", "tradeDate": "2026-07-30", "shares": "5", "statusCode": "REDEEM", "cycleCodes": ["000001"]},
            ],
            ["000001"],
        )

        fund = positions.load_positions()["funds"]["000001"]
        self.assertEqual(result["imported"], 1)
        self.assertEqual(result["audit_imported"], 3)
        self.assertEqual(sum(item["shares"] for item in fund["batches"] if item["status"] == "holding"), 40)
        self.assertEqual([item["state"] for item in fund["jd_transactions"]].count("pending"), 2)

    def test_incomplete_later_capture_preserves_verified_detailed_batches(self):
        self.test_verified_current_cycle_rebuilds_visible_grid_batches()
        fund_before = positions.load_positions()["funds"]["000001"]
        source_ids_before = [item.get("source_ledger_id") for item in fund_before["batches"]]

        with patch("valuation.providers.get_fund_nav_history", return_value=[]):
            result = self.import_payload(
                ["000001"],
                [self.holding(shares="40", cost_price="1")],
                [{"id": "incomplete-row", "code": "000001", "type": "add", "tradeDate": "2026-07-30", "amount": "10", "statusCode": "COMPLETE"}],
            )

        fund_after = positions.load_positions()["funds"]["000001"]
        self.assertIn("unverified_current_timeline", [item.get("reason") for item in result["results"]])
        self.assertEqual([item.get("source_ledger_id") for item in fund_after["batches"]], source_ids_before)
        self.assertTrue(all(item.get("source") == "jd_timeline" for item in fund_after["batches"]))

    def test_unverified_client_replace_request_cannot_prune_server_audit(self):
        holding = self.holding(shares="40", cost_price="1")
        self.import_payload(
            ["000001"], [holding],
            [{
                "id": "stored-buy", "code": "000001", "type": "add",
                "tradeDate": "2026-07-01", "amount": "40", "shares": "40",
                "statusCode": "COMPLETE",
            }],
        )
        before = positions.load_positions()["funds"]["000001"]
        stored_ids = {item["id"] for item in before["jd_transactions"]}

        result = self.import_payload(
            ["000001"], [holding],
            [{
                "id": "overclaimed-buy", "code": "000001", "type": "add",
                "tradeDate": "2026-07-20", "amount": "100", "shares": "100",
                "statusCode": "COMPLETE", "cycleCodes": ["000001"],
            }],
            ["000001"],
        )

        after = positions.load_positions()["funds"]["000001"]
        self.assertTrue(stored_ids.issubset({item["id"] for item in after["jd_transactions"]}))
        self.assertNotIn("replace_audit", [item.get("action") for item in result["audit_results"]])
        self.assertIn("unverified_current_timeline", [item.get("reason") for item in result["results"]])

    def test_capture_shaped_snapshot_round_trips_through_positions_read(self):
        client = TestClient(app.app)
        response = client.post("/v1/positions/jd-import", json={
            "current_holding_codes": ["000001"],
            "current_holdings": [{
                "code": "000001", "name": "Captured holding", "shares": "1,234.56 shares",
                "amount": "1,250.00 CNY", "costPrice": "0.900000 CNY/share",
                "costAmount": "1,111.10 CNY", "acquiredDate": "2026-01-02",
            }],
            "adjustments": [],
        })

        self.assertEqual(response.status_code, 200)
        persisted = client.get("/v1/positions").json()["funds"]["000001"]["batches"][0]
        self.assertEqual(persisted["shares"], 1234.56)
        self.assertEqual(persisted["amount"], 1111.1)
        self.assertEqual(persisted["nav"], 0.9)
        self.assertEqual(persisted["source"], "jd_snapshot")


if __name__ == "__main__":
    unittest.main()
