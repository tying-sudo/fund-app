"""Optional market-data adapters exposed by the valuation-grid API."""

from __future__ import annotations

import json
import math
import re
from datetime import datetime
from typing import Any

import requests


class DataSourceError(RuntimeError):
    """Raised when an upstream market-data provider cannot serve a request."""


_FUND_CODE_RE = re.compile(r"^\d{6}$")
_EASTMONEY_HEADERS = {
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Referer": "https://fundf10.eastmoney.com/",
    "User-Agent": "Mozilla/5.0 (compatible; FundApp/1.0)",
}
_SESSION = requests.Session()


def validate_fund_code(fund_code: str) -> str:
    code = str(fund_code or "").strip()
    if not _FUND_CODE_RE.fullmatch(code):
        raise DataSourceError("基金代码必须是6位数字")
    return code


def _number(value: Any) -> float | None:
    if value in (None, "", "--"):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _date_string(value: Any) -> str:
    if value is None:
        return ""
    if hasattr(value, "strftime"):
        return value.strftime("%Y-%m-%d")
    return str(value)[:10]


def _limit(limit: int, maximum: int = 500) -> int:
    return max(1, min(int(limit), maximum))


def get_eastmoney_fund_nav_history(fund_code: str, limit: int = 30) -> dict[str, Any]:
    """Read open-end fund NAV history from Eastmoney's public F10 endpoint."""
    code = validate_fund_code(fund_code)
    page_size = _limit(limit)
    try:
        response = _SESSION.get(
            "https://api.fund.eastmoney.com/f10/lsjz",
            params={
                "fundCode": code,
                "pageIndex": 1,
                "pageSize": page_size,
                "startDate": "",
                "endDate": "",
            },
            headers=_EASTMONEY_HEADERS,
            timeout=12,
        )
        response.raise_for_status()
        payload = response.json()
    except (requests.RequestException, ValueError) as exc:
        raise DataSourceError(f"东方财富净值请求失败: {exc}") from exc

    records = (payload.get("Data") or {}).get("LSJZList") or []
    items = [
        {
            "date": entry.get("FSRQ") or "",
            "nav": _number(entry.get("DWJZ")),
            "accumulated_nav": _number(entry.get("LJJZ")),
            "change_pct": _number(entry.get("JZZZL")),
            "purchase_status": entry.get("SGZT") or "",
            "redemption_status": entry.get("SHZT") or "",
        }
        for entry in records
    ]
    return {
        "source": "eastmoney",
        "fund_code": code,
        "updated_at": datetime.now().isoformat(timespec="seconds"),
        "items": items,
        "count": len(items),
    }


def get_eastmoney_fund_estimate(fund_code: str) -> dict[str, Any]:
    """Read the public Eastmoney intraday fund estimate JSONP endpoint."""
    code = validate_fund_code(fund_code)
    try:
        response = _SESSION.get(
            f"https://fundgz.1234567.com.cn/js/{code}.js",
            headers={**_EASTMONEY_HEADERS, "Referer": "https://fund.eastmoney.com/"},
            timeout=12,
        )
        response.raise_for_status()
        match = re.search(r"jsonpgz\((\{.*\})\)", response.text, re.DOTALL)
        if not match:
            raise ValueError("响应不是预期的 JSONP 格式")
        payload = json.loads(match.group(1))
    except (requests.RequestException, ValueError, json.JSONDecodeError) as exc:
        raise DataSourceError(f"东方财富估值请求失败: {exc}") from exc

    return {
        "source": "eastmoney",
        "fund_code": payload.get("fundcode") or code,
        "name": payload.get("name") or "",
        "nav_date": payload.get("jzrq") or "",
        "nav": _number(payload.get("dwjz")),
        "estimate_time": payload.get("gztime") or "",
        "estimated_nav": _number(payload.get("gsz")),
        "estimated_change_pct": _number(payload.get("gszzl")),
    }


def get_akshare_fund_nav_history(fund_code: str, limit: int = 30) -> dict[str, Any]:
    """Read open-end fund NAV history through AKShare on demand."""
    code = validate_fund_code(fund_code)
    try:
        import akshare as ak
    except ImportError as exc:
        raise DataSourceError("AKShare 未安装") from exc

    try:
        frame = ak.fund_open_fund_info_em(symbol=code, indicator="单位净值走势")
        records = frame.to_dict("records")
    except Exception as exc:
        raise DataSourceError(f"AKShare 净值请求失败: {exc}") from exc

    items = [
        {
            "date": _date_string(entry.get("净值日期")),
            "nav": _number(entry.get("单位净值")),
            "accumulated_nav": _number(entry.get("累计净值")),
            "change_pct": _number(entry.get("日增长率")),
            "purchase_status": str(entry.get("申购状态") or ""),
            "redemption_status": str(entry.get("赎回状态") or ""),
        }
        for entry in records
    ]
    items.sort(key=lambda item: item["date"], reverse=True)
    items = items[:_limit(limit)]
    return {
        "source": "akshare",
        "fund_code": code,
        "updated_at": datetime.now().isoformat(timespec="seconds"),
        "items": items,
        "count": len(items),
    }


def get_data_source_status() -> dict[str, Any]:
    """Expose availability without making an upstream market-data request."""
    try:
        import akshare  # noqa: F401
        akshare_available = True
    except ImportError:
        akshare_available = False
    return {
        "eastmoney": {"available": True},
        "akshare": {"available": akshare_available},
    }
