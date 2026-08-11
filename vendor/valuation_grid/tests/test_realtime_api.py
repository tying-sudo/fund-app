import json
from unittest.mock import patch

import app
import positions
import pytest
from fastapi.testclient import TestClient


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


def test_fifo_sale_confirmation_is_checked_before_position_write():
    client = TestClient(app.app)
    invalid = client.post("/v1/position/__confirmation_probe__/sell-fifo", json={
        "total_sell_shares": 1,
        "confirmation": "SELL __confirmation_probe__ 2.00",
    })
    assert invalid.status_code == 400
    assert invalid.json()["detail"] == "sale confirmation is invalid"

    valid = client.post("/v1/position/__confirmation_probe__/sell-fifo", json={
        "total_sell_shares": 1,
        "confirmation": "SELL __confirmation_probe__ 1.00",
    })
    assert valid.status_code == 400
    assert "不存在" in valid.json()["detail"]


def test_fifo_api_forwards_request_id_to_atomic_position_write():
    client = TestClient(app.app)
    with patch.object(app, "sell_fifo", return_value={"total_sell_shares": 1}) as sell, \
            patch.object(app, "_strategy_snapshot", return_value={"position": {}}):
        response = client.post("/v1/position/002112/sell-fifo", json={
            "total_sell_shares": 1,
            "request_id": "fifo-request-1",
            "confirmation": "SELL 002112 1.00",
        })

    assert response.status_code == 200
    sell.assert_called_once_with("002112", 1, None, None, "fifo-request-1")


def test_legacy_fifo_aggregate_is_split_without_recalculating_each_batch():
    data = {
        "funds": {
            "002112": {
                "batches": [
                    {"id": "b1", "note": "first"},
                    {"id": "b2", "note": "second"},
                ],
                "sell_records": [{
                    "id": "s20260810fifo1",
                    "sale_type": "fifo_aggregate",
                    "sell_date": "2026-08-10",
                    "sell_nav": 4.6419,
                    "allocations": [
                        {"batch_id": "b1", "sell_shares": 10, "buy_nav": 6, "cost": 60, "gross": 46.42, "fee": 0, "net": 46.42, "profit": -13.58, "profit_pct": -22.6, "hold_days": 45, "sell_fee_rate": 0},
                        {"batch_id": "b2", "sell_shares": 20, "buy_nav": 5, "cost": 100, "gross": 92.84, "fee": 0, "net": 92.84, "profit": -7.16, "profit_pct": -7.2, "hold_days": 40, "sell_fee_rate": 0},
                    ],
                }],
            },
        },
    }
    with patch.object(positions, "load_positions", return_value=data), patch.object(positions, "save_positions") as save:
        result = positions.split_fifo_aggregate_sell_records("002112")

    records = data["funds"]["002112"]["sell_records"]
    assert result == {"migrated_records": 1, "created_records": 2, "skipped_records": []}
    assert [record["batch_id"] for record in records] == ["b1", "b2"]
    assert round(sum(record["profit"] for record in records), 2) == -20.74
    assert all(record["sell_nav"] == 4.6419 for record in records)
    save.assert_called_once_with(data)


def test_legacy_fifo_split_preserves_invalid_record():
    data = {
        "funds": {
            "002112": {
                "batches": [{"id": "b1", "note": "first"}],
                "sell_records": [
                    {
                        "id": "legacy",
                        "sale_type": "fifo_aggregate",
                        "sell_date": "2026-08-10",
                        "sell_nav": 1.2,
                        "allocations": [{"batch_id": "missing", "sell_shares": 10}],
                    },
                    {"id": "s20260810a", "batch_id": "b1", "sell_date": "2026-08-10"},
                ],
            },
        },
    }
    with patch.object(positions, "load_positions", return_value=data), patch.object(positions, "save_positions") as save:
        result = positions.split_fifo_aggregate_sell_records("002112")

    assert result["migrated_records"] == 0
    assert result["skipped_records"] == [{
        "fund_code": "002112", "record_id": "legacy", "reason": "unknown_batch_id",
    }]
    assert data["funds"]["002112"]["sell_records"][0]["id"] == "legacy"
    save.assert_not_called()


def test_legacy_fifo_split_reserves_ids_from_records_after_the_aggregate():
    data = {
        "funds": {
            "002112": {
                "batches": [{"id": "b1", "note": "first"}],
                "sell_records": [
                    {
                        "id": "legacy",
                        "sale_type": "fifo_aggregate",
                        "sell_date": "2026-08-10",
                        "sell_nav": 1.2,
                        "allocations": [{"batch_id": "b1", "sell_shares": 10}],
                    },
                    {"id": "s20260810a", "batch_id": "b1", "sell_date": "2026-08-10"},
                ],
            },
        },
    }
    with patch.object(positions, "load_positions", return_value=data), patch.object(positions, "save_positions"):
        positions.split_fifo_aggregate_sell_records("002112")

    ids = [record["id"] for record in data["funds"]["002112"]["sell_records"]]
    assert ids == ["s20260810b", "s20260810a"]


def test_sell_record_ids_remain_unique_after_twenty_six_same_day_records():
    records = [
        {"id": f"s20260810{chr(ord('a') + index)}"}
        for index in range(26)
    ]

    assert positions._next_sell_record_id(records, "2026-08-10") == "s2026081027"


def test_strategy_position_excludes_sold_batches():
    data = {
        "funds": {
            "002112": {
                "batches": [
                    {
                        "id": "holding", "status": "holding", "buy_date": "2026-08-01",
                        "amount": 100, "shares": 10,
                    },
                    {
                        "id": "sold", "status": "sold", "buy_date": "2026-07-01",
                        "amount": 500, "shares": 50,
                    },
                ],
                "sell_records": [],
            },
        },
    }
    with patch.object(positions, "load_positions", return_value=data):
        strategy_position = positions.get_fund_position("002112")

    assert [batch["id"] for batch in strategy_position["batches"]] == ["holding"]
    assert strategy_position["total_amount"] == 100
    assert strategy_position["total_shares"] == 10


def test_fifo_request_id_is_persisted_and_replayed_without_double_sell(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    monkeypatch.setattr(positions, "DATA_DIR", data_dir)
    monkeypatch.setattr(positions, "POS_FILE", data_dir / "positions.json")
    monkeypatch.setattr(positions, "POS_BACKUP_FILE", data_dir / "positions.backup.json")
    monkeypatch.setattr(positions, "POS_LOCK_FILE", data_dir / ".positions.lock")
    positions.save_positions({
        "funds": {
            "002112": {
                "batches": [
                    {
                        "id": "b1", "status": "holding", "buy_date": "2026-07-01",
                        "amount": 10, "nav": 1, "shares": 10, "note": "first",
                    },
                    {
                        "id": "b2", "status": "holding", "buy_date": "2026-07-02",
                        "amount": 10, "nav": 1, "shares": 10, "note": "second",
                    },
                ],
                "sell_records": [],
                "supplement_count": 0,
            },
        },
    })

    first = positions.sell_fifo(
        "002112", 15, sell_nav=1.2, sell_date="2026-08-10", request_id="fifo-request-1"
    )
    replay = positions.sell_fifo(
        "002112", 15, sell_nav=1.2, sell_date="2026-08-10", request_id="fifo-request-1"
    )
    stored = positions.load_positions()

    assert first["batch_count"] == 2
    assert replay == {**first, "idempotent_replay": True}
    assert len(stored["funds"]["002112"]["sell_records"]) == 2
    assert stored["funds"]["002112"]["batches"][1]["shares"] == 5
    assert stored["processed_position_requests"]["fifo-request-1"]["result"] == first
    assert positions.POS_BACKUP_FILE.exists()

    with pytest.raises(ValueError, match="request_id 已用于不同的持仓请求"):
        positions.sell_fifo(
            "002112", 4, sell_nav=1.2, sell_date="2026-08-10", request_id="fifo-request-1"
        )


def test_legacy_fifo_migration_is_idempotent_and_keeps_pre_migration_backup(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    monkeypatch.setattr(positions, "DATA_DIR", data_dir)
    monkeypatch.setattr(positions, "POS_FILE", data_dir / "positions.json")
    monkeypatch.setattr(positions, "POS_BACKUP_FILE", data_dir / "positions.backup.json")
    monkeypatch.setattr(positions, "POS_LOCK_FILE", data_dir / ".positions.lock")
    positions.save_positions({
        "funds": {
            "002112": {
                "batches": [{"id": "b1", "note": "first"}],
                "sell_records": [{
                    "id": "legacy",
                    "sale_type": "fifo_aggregate",
                    "sell_date": "2026-08-10",
                    "sell_nav": 1.2,
                    "allocations": [{"batch_id": "b1", "sell_shares": 10}],
                }],
            },
        },
    })

    first = positions.split_fifo_aggregate_sell_records("002112")
    second = positions.split_fifo_aggregate_sell_records("002112")
    backup = json.loads(positions.POS_BACKUP_FILE.read_text(encoding="utf-8"))

    assert first["migrated_records"] == 1
    assert second["migrated_records"] == 0
    assert len(positions.load_positions()["funds"]["002112"]["sell_records"]) == 1
    assert backup["funds"]["002112"]["sell_records"][0]["sale_type"] == "fifo_aggregate"
