from concurrent.futures import ThreadPoolExecutor
import threading
import time

from realtime_store import MemoryReadDatabase


def test_returns_cached_value_until_ttl_expires():
    store = MemoryReadDatabase()
    calls = 0

    def create_value():
        nonlocal calls
        calls += 1
        return {"value": calls}

    assert store.get_or_compute("valuation:000001", 50, create_value) == {"value": 1}
    assert store.get_or_compute("valuation:000001", 50, create_value) == {"value": 1}
    assert calls == 1

    time.sleep(0.06)
    assert store.get_or_compute("valuation:000001", 50, create_value) == {"value": 2}
    assert store.stats()["hits"] == 1


def test_coalesces_parallel_requests_to_one_computation():
    store = MemoryReadDatabase()
    calls = 0
    lock = threading.Lock()

    def create_value():
        nonlocal calls
        with lock:
            calls += 1
        time.sleep(0.03)
        return {"frame": 1}

    with ThreadPoolExecutor(max_workers=12) as executor:
        results = list(executor.map(lambda _: store.get_or_compute("valuation:batch", 500, create_value), range(12)))

    assert results == [{"frame": 1}] * 12
    assert calls == 1
    assert store.stats()["coalesced"] >= 1


def test_invalidating_a_prefix_keeps_unrelated_snapshots():
    store = MemoryReadDatabase()
    store.get_or_compute("valuation:batch", 1_000, lambda: {"ok": True})
    store.get_or_compute("strategy:signals", 1_000, lambda: {"ok": True})

    assert store.invalidate("valuation:") == 1
    assert store.stats()["entries"] == 1
