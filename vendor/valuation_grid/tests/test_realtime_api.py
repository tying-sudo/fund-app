from unittest.mock import patch

import app


def test_batch_read_model_deduplicates_a_canonical_fund_set():
    app.realtime_read_model.invalidate()
    request_a = app.BatchRequest(fund_codes=["000002", "000001", "000002"])
    request_b = app.BatchRequest(fund_codes=["000001", "000002"])

    with patch.object(app, "calculate_valuation_batch", return_value=[
        {"fund_code": "000001", "estimation_change": 1.0},
        {"fund_code": "000002", "estimation_change": 2.0},
    ]) as calculate:
        first = app.post_valuation_batch(request_a)
        second = app.post_valuation_batch(request_b)

    assert [item["fund_code"] for item in first["items"]] == ["000002", "000001", "000002"]
    assert [item["fund_code"] for item in second["items"]] == ["000001", "000002"]
    calculate.assert_called_once_with(["000001", "000002"])


def test_strategy_snapshot_reuses_a_short_live_frame():
    app.realtime_read_model.invalidate()
    with patch.object(app, "generate_all_signals", return_value={"signals": [{"fund_code": "000001"}]}) as generate:
        assert app.get_all_strategy_signals()["signals"] == [{"fund_code": "000001"}]
        assert app.get_all_strategy_signals()["signals"] == [{"fund_code": "000001"}]

    generate.assert_called_once_with()
