import sys
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from grid.engine import _build_market_analysis
from grid.helpers import _estimate_current_nav
from valuation import core


HISTORY = [
    {"date": "2026-07-17", "nav": 1.00, "change": -1.0},
    {"date": "2026-07-16", "nav": 1.01, "change": 2.0},
    {"date": "2026-07-15", "nav": 0.99, "change": -0.5},
    {"date": "2026-07-14", "nav": 0.995, "change": 1.5},
    {"date": "2026-07-13", "nav": 0.98, "change": 0.25},
]


class MarketSessionTests(unittest.TestCase):
    def setUp(self):
        core._intraday_estimation_cache.clear()
        core._intraday_cache_loaded = True

    @staticmethod
    def result(change):
        return {
            "fund_code": "018524",
            "estimation_change": change,
            "asof_time": "2026-07-20 14:59:00",
            "notes": [],
        }

    def finalize(self, at, change, history=None, live_date=None):
        with patch.object(core, "beijing_now", return_value=at), \
                patch.object(core, "_is_market_closed", return_value=False):
            return core._finalize_live_estimate(
                self.result(change),
                "018524",
                history or HISTORY,
                "estimation",
                live_date=live_date,
            )

    def test_intraday_value_is_current_and_cached(self):
        value = self.finalize(datetime(2026, 7, 20, 14, 59), 2.5)
        self.assertEqual("estimation", value["_source"])
        self.assertEqual("2026-07-20", value["_valuation_date"])
        self.assertFalse(value["_frozen"])
        self.assertEqual(2.5, core._intraday_estimation_cache["018524"]["est"])

    def test_post_close_freezes_last_intraday_value(self):
        self.finalize(datetime(2026, 7, 20, 14, 59), 2.5)
        at_close = self.finalize(datetime(2026, 7, 20, 15, 5), 9.9)
        later = self.finalize(datetime(2026, 7, 20, 17, 0), -8.8)
        self.assertEqual(2.5, at_close["estimation_change"])
        self.assertEqual(2.5, later["estimation_change"])
        self.assertTrue(at_close["_frozen"])
        self.assertEqual("2026-07-20", later["_valuation_date"])

    def test_published_today_nav_replaces_frozen_estimate(self):
        self.finalize(datetime(2026, 7, 20, 14, 59), 2.5)
        history = [{"date": "2026-07-20", "nav": 1.027, "change": 2.7}, *HISTORY]
        with patch.object(core, "record_deviation") as record:
            settled = self.finalize(datetime(2026, 7, 20, 19, 0), 9.9, history)
        self.assertEqual("nav", settled["_source"])
        self.assertEqual("2026-07-20", settled["_nav_date"])
        self.assertEqual(2.7, settled["estimation_change"])
        self.assertEqual(1.0, settled["confidence"])
        self.assertEqual(1.0, settled["calibrated_confidence"])
        record.assert_called_once()

    def test_stale_live_source_is_not_relabelled_as_today(self):
        value = self.finalize(
            datetime(2026, 7, 20, 14, 59),
            -3.48,
            live_date="2026-07-17",
        )
        self.assertEqual("nav", value["_source"])
        self.assertEqual("2026-07-17", value["_valuation_date"])

    def test_period_change_includes_today_once(self):
        result = {
            "estimation_change": 2.5,
            "_valuation_date": "2026-07-20",
            "_source": "estimation",
        }
        expected = 1.0
        for change in [2.5, -1.0, 2.0, -0.5, 1.5]:
            expected *= 1 + change / 100
        self.assertEqual(round((expected - 1) * 100, 2), core.calculate_period_change(result, HISTORY, 5))

    def test_actual_nav_date_is_not_counted_twice(self):
        history = [{"date": "2026-07-20", "nav": 1.027, "change": 2.7}, *HISTORY]
        result = {
            "estimation_change": 2.7,
            "_valuation_date": "2026-07-20",
            "_source": "nav",
        }
        expected = 1.0
        for change in [2.7, -1.0, 2.0, -0.5, 1.5]:
            expected *= 1 + change / 100
        self.assertEqual(round((expected - 1) * 100, 2), core.calculate_period_change(result, history, 5))

    def test_frozen_estimate_drives_current_nav_and_chart(self):
        nav = _estimate_current_nav(
            0.8,
            2.5,
            HISTORY,
            source="estimation",
            valuation_date="2026-07-20",
        )
        self.assertAlmostEqual(1.025, nav, places=6)
        analysis = _build_market_analysis(
            "018524",
            {
                "estimation_change": 2.5,
                "_source": "estimation",
                "_valuation_date": "2026-07-20",
                "confidence": 0.8,
            },
            HISTORY,
            {"total_shares": 0, "total_cost": 0, "total_invested": 0, "total_received": 0},
        )
        self.assertEqual("2026-07-20", analysis["day_changes"][0]["date"])
        self.assertEqual(1, sum(item["date"] == "2026-07-20" for item in analysis["day_changes"]))


if __name__ == "__main__":
    unittest.main()
