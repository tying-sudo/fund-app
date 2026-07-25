#!/usr/bin/env python3
"""Optional Python adapter for the three valuation-provider contracts.

The Node API remains the public request boundary. This script is intentionally
standalone so a worker, scheduled job, or browser fallback can run it without
copying parsing rules into a client.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from typing import Any, Callable

import requests
from bs4 import BeautifulSoup

TIMEOUT_SECONDS = 8
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
    "Accept": "application/json,text/plain,application/javascript,*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": "https://fund.eastmoney.com/",
}


def request(session: requests.Session, url: str) -> requests.Response:
    response = session.get(url, headers=HEADERS, timeout=TIMEOUT_SECONDS)
    response.raise_for_status()
    return response


def provider_result(source: str, code: str, **values: Any) -> dict[str, Any]:
    return {
        "source": source,
        "fundCode": code,
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "available": False,
        "value": None,
        "change": None,
        "time": None,
        "kind": "estimate",
        **values,
    }


def fetch_tiantian(session: requests.Session, code: str) -> dict[str, Any]:
    url = "https://fundcomapi.tiantianfunds.com/mm/newCore/FundValuationLast"
    response = session.get(url, params={"FCODES": code, "FIELDS": "FCODE,SHORTNAME,GSZZL,GZTIME,GSZ,NAV,PDATE"}, headers=HEADERS, timeout=TIMEOUT_SECONDS)
    response.raise_for_status()
    item = next((row for row in response.json().get("data", []) if str(row.get("FCODE")) == code), None)
    if not item:
        return provider_result("tiantian", code, error="provider returned no matching fund")
    is_live = item.get("GSZ") is not None and item.get("GSZZL") is not None and item.get("GZTIME")
    return provider_result(
        "tiantian", code, available=True, name=item.get("SHORTNAME"), value=item.get("GSZ") if is_live else item.get("NAV"),
        change=item.get("GSZZL"), time=item.get("GZTIME") or item.get("PDATE"), kind="estimate" if is_live else "official_nav"
    )


def fetch_sina(session: requests.Session, code: str) -> dict[str, Any]:
    # The compact quote endpoint is attempted first. Some network locations
    # return 403, so use Sina's documented estimate payload as a same-provider fallback.
    quote_url = f"https://hq.sinajs.cn/list=fu_{code}"
    try:
        quote = request(session, quote_url).text
        if not re.search(rf"hq_str_fu_{re.escape(code)}=", quote):
            raise ValueError("quote payload does not contain the requested symbol")
    except (requests.RequestException, ValueError) as exc:
        quote_error = str(exc)
    else:
        quote_error = None

    fallback_url = f"https://stock.finance.sina.com.cn/fundInfo/api/openapi.php/FdFundService.getEstimateNetworthPic?symbol={code}"
    response = request(session, fallback_url)
    points = response.json().get("result", {}).get("data", {}).get("networth", [])
    point = next((item for item in reversed(points) if item.get("pre_nav") is not None and item.get("growthrate") is not None), None)
    if not point:
        return provider_result("sina", code, error="provider returned no estimate", note=quote_error)
    return provider_result(
        "sina", code, available=True, value=point.get("pre_nav"), change=float(point.get("growthrate")) * 100,
        time=f"{point.get('pre_date', '')} {point.get('min_time', '')}".strip(), kind="estimate",
        note="hq.sinajs.cn unavailable; used Sina estimate fallback" if quote_error else "hq.sinajs.cn verified"
    )


def fetch_eastmoney(session: requests.Session, code: str) -> dict[str, Any]:
    source = request(session, f"https://fund.eastmoney.com/pingzhongdata/{code}.js").text
    # BeautifulSoup normalizes an HTML-wrapped or malformed provider payload before regex extraction.
    text = BeautifulSoup(source, "html.parser").get_text("", strip=False)
    matched = re.search(r"var\s+Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);", text)
    if not matched:
        return provider_result("eastmoney", code, kind="official_nav", error="net worth series missing")
    points = json.loads(matched.group(1))
    def value(item: Any) -> Any:
        return item[1] if isinstance(item, list) and len(item) > 1 else item.get("y") or item.get("value") if isinstance(item, dict) else None

    point = next((item for item in reversed(points) if value(item) is not None), None)
    if not point:
        return provider_result("eastmoney", code, kind="official_nav", error="net worth series empty")
    timestamp = point[0] if isinstance(point, list) else point.get("x")
    date = (point[3] if isinstance(point, list) and len(point) > 3 else point.get("date") if isinstance(point, dict) else None)
    date = date or datetime.fromtimestamp(float(timestamp) / 1000, tz=timezone.utc).date().isoformat()
    change = point[2] if isinstance(point, list) and len(point) > 2 else point.get("equityReturn") or point.get("change") if isinstance(point, dict) else None
    return provider_result("eastmoney", code, available=True, value=value(point), change=change, time=date, kind="official_nav")


def dynamic_fetcher(kind: str) -> Callable[..., Any] | None:
    """Extension hook: wire Selenium or Playwright here only for blocked dynamic pages."""
    if kind in {"selenium", "playwright"}:
        return None
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("code")
    parser.add_argument("--dynamic", choices=["none", "selenium", "playwright"], default="none")
    args = parser.parse_args()
    if not re.fullmatch(r"\d{6}", args.code):
        print(json.dumps({"error": "fund code must be six digits"}, ensure_ascii=False))
        return 2
    session = requests.Session()
    results: dict[str, Any] = {}
    for name, fetcher in (("tiantian", fetch_tiantian), ("sina", fetch_sina), ("eastmoney", fetch_eastmoney)):
        try:
            results[name] = fetcher(session, args.code)
        except (requests.RequestException, ValueError, KeyError, IndexError) as exc:
            results[name] = provider_result(name, args.code, error=str(exc))
    print(json.dumps({"code": args.code, "sources": results, "dynamicExtension": bool(dynamic_fetcher(args.dynamic))}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
