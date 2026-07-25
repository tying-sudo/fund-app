"""
app.py - API入口：/state + /valuation + /fund/name + /position + /strategy
"""
import os
import re
import math
import threading
import time
from contextlib import asynccontextmanager
from datetime import date, datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from typing import List, Optional
import uvicorn

from valuation.core import (
    load_state, save_state, validate_state,
    calculate_valuation, calculate_valuation_batch, calculate_valuation_by_state,
    beijing_now, get_latest_settlement
)
from valuation.providers import (
    get_fund_name, set_etf_link_target, get_etf_link_target, clear_etf_link_target,
    refresh_stale_holdings
)
from positions import (
    add_batch, sell_batch, delete_batch, update_fund_config,
    get_fund_position, get_all_positions, remove_fund, update_sell_nav,
    delete_sell_record, update_fee_schedule, sell_fifo,
    get_groups, add_group, update_group, delete_group,
    make_fund_key, parse_fund_key, rename_fund_key,
    add_watch_fund,
    confirm_buy_nav,
    auto_fill_nav,
    import_jd_grid_transactions,
    PositionDataError,
)
from skills.export_image import export_all_sector_images

from grid import (
    generate_signal, generate_all_signals, get_signal_history,
    get_vol_sensitivity_info, update_vol_sensitivity, clear_vol_sensitivity,
    auto_calibrate_vol_sensitivity,
    backfill_signal_outcomes, calc_signal_win_rate,
    set_market_regime, get_market_regime_info,
    get_fitness_scores, get_fund_fitness
)

# ============================================================
# 启动时刷新持仓缓存（后台线程，不阻塞服务就绪）
# ============================================================

def _refresh_holdings_when_idle():
    """交易时段优先保障实时估值，持仓全量刷新延后到收盘后。"""
    now = beijing_now()
    hhmm = now.hour * 100 + now.minute
    if now.weekday() < 5 and 850 <= hhmm < 1520:
        refresh_at = now.replace(hour=15, minute=20, second=0, microsecond=0)
        delay = max(30, (refresh_at - now).total_seconds())
        print(f"[Startup] 交易时段不刷新全量持仓，将延后 {int(delay)} 秒")
    else:
        delay = 30

    time.sleep(delay)
    try:
        refresh_stale_holdings()
    except Exception as exc:
        print(f"[Startup] 后台持仓刷新异常: {exc}")


@asynccontextmanager
async def lifespan(app):
    # v5.19: 启动时自动补录缺失净值
    try:
        auto_fill_nav()
    except Exception as e:
        print(f"[Startup] 净值自动补录异常: {e}")
    t = threading.Thread(target=_refresh_holdings_when_idle, daemon=True)
    t.start()
    yield

app = FastAPI(
    title="Ease Grid",
    description="基金盘中估值 + 本地自选板块管理 + 低频网格交易策略",
    version="2.2.0",
    lifespan=lifespan,
)


@app.exception_handler(PositionDataError)
async def position_data_error_handler(_request, exc: PositionDataError):
    """持仓异常只让当前请求失败，不允许进程退出或把错误伪装成空数据。"""
    print(f"[Position] 请求已安全中止: {exc}")
    return JSONResponse(
        status_code=503,
        content={"detail": str(exc), "error": "position_data_unavailable"},
    )

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============================================================
# 数据模型
# ============================================================

class FundItem(BaseModel):
    code: str
    alias: Optional[str] = ""

class SectorItem(BaseModel):
    name: str
    funds: List[FundItem]

class StateModel(BaseModel):
    version: Optional[int] = 1
    updated_at: Optional[str] = None
    strategy_order: Optional[List[str]] = None
    sectors: List[SectorItem]

class BatchRequest(BaseModel):
    fund_codes: List[str]

# ============================================================
# State 管理 API
# ============================================================

@app.get("/v1/state")
def get_state():
    """读取全部状态（板块+基金列表）"""
    return load_state()

@app.post("/v1/state")
def post_state(state: StateModel):
    """覆盖保存状态"""
    state_dict = state.model_dump()
    valid, msg = validate_state(state_dict)
    if not valid:
        raise HTTPException(status_code=400, detail=msg)

    # The browser retains a dashboard cache. Requiring the revision returned
    # by GET /v1/state prevents a stale tab from replacing the whole board
    # catalogue after another device or a recovery operation has updated it.
    expected_updated_at = state_dict.get("updated_at")
    current_updated_at = load_state().get("updated_at")
    if not expected_updated_at or expected_updated_at != current_updated_at:
        raise HTTPException(status_code=409, detail="板块数据已更新，请刷新后重试")

    if not save_state(state_dict, expected_updated_at=expected_updated_at):
        raise HTTPException(status_code=409, detail="板块数据已更新，请刷新后重试")
    return {"success": True, "message": "保存成功", "state": state_dict}

# ============================================================
# 基金信息 API
# ============================================================

@app.get("/v1/fund/{fund_code}/name")
def get_fund_name_api(fund_code: str):
    """获取基金名称"""
    name = get_fund_name(fund_code)
    if name:
        return {"fund_code": fund_code, "name": name}
    else:
        return {"fund_code": fund_code, "name": None, "error": "无法获取基金名称"}

@app.get("/v1/fund/{fund_code}/nav-history")
def get_nav_history(fund_code: str, days: int = 15):
    """获取基金最近N日真实净值涨跌"""
    from valuation.providers import get_fund_nav_history
    data = get_fund_nav_history(fund_code, days)
    return {"fund_code": fund_code, "days": len(data), "history": data}


@app.get("/v1/fund/{fund_code}/settlement")
def get_fund_settlement(fund_code: str):
    """Return the newest official NAV and same-day estimate pair."""
    return get_latest_settlement(fund_code)

# ============================================================
# ETF联接基金映射 API
# ============================================================

class ETFLinkRequest(BaseModel):
    link_code: str
    etf_code: str

@app.post("/v1/etf-link")
def set_etf_link(req: ETFLinkRequest):
    """设置ETF联接基金的目标ETF映射"""
    if not req.link_code or not req.etf_code:
        raise HTTPException(status_code=400, detail="link_code和etf_code不能为空")
    if len(req.link_code) != 6 or len(req.etf_code) != 6:
        raise HTTPException(status_code=400, detail="基金代码必须是6位")

    set_etf_link_target(req.link_code, req.etf_code)

    # 清除该基金的持仓缓存，以便重新获取
    from pathlib import Path
    cache_path = Path(__file__).parent / "cache" / f"holdings_{req.link_code}.json"
    if cache_path.exists():
        cache_path.unlink()

    return {"success": True, "message": f"已设置 {req.link_code} -> {req.etf_code}"}

@app.delete("/v1/etf-link/{link_code}")
def delete_etf_link(link_code: str):
    """删除ETF联接基金映射"""
    clear_etf_link_target(link_code)
    return {"success": True, "message": f"已清除 {link_code} 的映射"}


# ============================================================
# 估值 API
# ============================================================

@app.get("/v1/valuation/{fund_code}")
def get_valuation(fund_code: str):
    """单基金估值"""
    return calculate_valuation(fund_code)

@app.post("/v1/valuation/batch")
def post_valuation_batch(req: BatchRequest):
    """批量估值"""
    if not req.fund_codes:
        return {"items": []}
    if len(req.fund_codes) > 2000:
        raise HTTPException(status_code=400, detail="单次最多2000只基金")
    return {"items": calculate_valuation_batch(req.fund_codes)}

@app.get("/v1/valuation/state")
def get_valuation_state():
    """按当前state返回所有基金估值（板块分组）"""
    return calculate_valuation_by_state()

# ============================================================
# 持仓缓存刷新 API
# ============================================================

@app.post("/v1/holdings/refresh")
def post_holdings_refresh():
    """手动触发持仓缓存刷新（刷新所有即将过期的基金）"""
    summary = refresh_stale_holdings()
    return summary

# ============================================================
# 导出估值图片 API（供 OpenClaw 定时任务调用）
# ============================================================

@app.get("/v1/export/images")
def export_images(mode: str = "valuation"):
    """批量导出所有板块估值图片（等同于前端"批量导出"按钮）。
    返回 [{sector, filename, image_base64}, ...]
    OpenClaw agent 可直接使用 image_base64 发送图片消息。
    
    Query params:
        mode: "valuation" (盘中估值，默认) 或 "nav" (收盘净值，无置信度过滤)
    """
    results = export_all_sector_images(mode=mode)
    if not results:
        return {"images": [], "message": "没有可导出的板块"}
    return {"images": results, "count": len(results)}


# ============================================================
# 健康检查
# ============================================================

@app.get("/health")
@app.get("/v1/health")
def health():
    return {"status": "ok"}


# ============================================================
# 持仓管理 API（新增）
# ============================================================

class BuyRequest(BaseModel):
    amount: float
    nav: Optional[float] = None   # 确认净值（选填，T+1确认后补录）
    note: Optional[str] = ""
    buy_date: Optional[str] = None  # 格式 YYYY-MM-DD，默认今天
    is_supplement: Optional[bool] = False  # 是否为补仓买入
    owner: Optional[str] = ""  # 持仓所有者标签（多人模式）
    # v5.X: 延迟回补标记
    is_rebuy: Optional[bool] = False  # 是否为延迟回补触发的买入
    pending_rebuy_id: Optional[str] = None  # 关联的挂单 ID（用于自动消费）

class SellRequest(BaseModel):
    batch_id: str
    sell_shares: float              # 卖出份额（必填）
    sell_nav: Optional[float] = None  # 确认净值（选填，待确认时不填）
    sell_date: Optional[str] = None   # 卖出日期 YYYY-MM-DD

class FundConfigRequest(BaseModel):
    max_position: Optional[int] = None
    fund_name: Optional[str] = None

class FeeScheduleItem(BaseModel):
    days: Optional[int] = None  # None = 兜底档
    rate: float                 # 费率%

class FeeScheduleRequest(BaseModel):
    schedule: List[FeeScheduleItem]


def _strategy_snapshot(fund_code: str) -> dict:
    """Return the post-mutation strategy state without making a trade fail."""
    snapshot = {"position": get_fund_position(fund_code)}
    try:
        snapshot["signal"] = generate_signal(fund_code)
    except Exception as exc:
        # The write already succeeded. Keep the response useful and let the
        # next normal strategy refresh retry signal generation.
        snapshot["signal_error"] = str(exc)
    return snapshot


@app.get("/v1/positions")
def get_positions():
    """获取全部持仓"""
    return get_all_positions()


@app.get("/v1/position/{fund_code}")
def get_position(fund_code: str):
    """获取单基金持仓汇总"""
    return get_fund_position(fund_code)


@app.post("/v1/position/{fund_code}/buy")
def buy_fund(fund_code: str, req: BuyRequest):
    """新增买入批次（支持 owner 参数实现同基金多人持仓）"""
    if req.amount <= 0:
        raise HTTPException(status_code=400, detail="amount必须大于0")
    if req.nav is not None and req.nav <= 0:
        raise HTTPException(status_code=400, detail="nav必须大于0或留空")
    fund_key = make_fund_key(fund_code, req.owner or "")
    batch = add_batch(fund_key, req.amount, req.nav, req.note or "",
                      req.buy_date, req.is_supplement,
                      is_rebuy=bool(req.is_rebuy),
                      pending_rebuy_id=req.pending_rebuy_id)
    return {"success": True, "batch": batch, "fund_key": fund_key, **_strategy_snapshot(fund_key)}


class WatchFundRequest(BaseModel):
    max_position: Optional[float] = 5000
    note: Optional[str] = ""
    owner: Optional[str] = ""


@app.post("/v1/position/{fund_code}/watch")
def watch_fund(fund_code: str, req: WatchFundRequest):
    """添加空仓观察基金（不创建batch，仅创建fund entry，用于空仓待建仓）"""
    fund_key = make_fund_key(fund_code, req.owner or "")
    result = add_watch_fund(fund_key, req.max_position, req.note or "")
    return {"success": True, **result, "fund_key": fund_key, **_strategy_snapshot(fund_key)}


@app.post("/v1/position/{fund_code}/sell")
def sell_fund(fund_code: str, req: SellRequest):
    """卖出批次（按份额）"""
    if req.sell_shares <= 0:
        raise HTTPException(status_code=400, detail="卖出份额必须大于0")
    try:
        result = sell_batch(fund_code, req.batch_id, req.sell_shares,
                            req.sell_nav, req.sell_date)
        return {"success": True, **result, "fund_key": fund_code, **_strategy_snapshot(fund_code)}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/v1/position/{fund_code}/batch/{batch_id}")
def delete_fund_batch(fund_code: str, batch_id: str):
    """删除错误录入的批次"""
    if delete_batch(fund_code, batch_id):
        return {"success": True, "message": f"已删除 {batch_id}", "fund_key": fund_code, **_strategy_snapshot(fund_code)}
    else:
        raise HTTPException(status_code=404, detail=f"批次 {batch_id} 不存在")


@app.delete("/v1/position/{fund_code}")
def remove_fund_position(fund_code: str):
    """从策略面板完全移除一只基金"""
    if remove_fund(fund_code):
        return {"success": True, "message": f"已移除 {fund_code}"}
    else:
        raise HTTPException(status_code=404, detail=f"基金 {fund_code} 不存在")


class RenameFundKeyRequest(BaseModel):
    new_owner: str  # 新标签（空字符串表示去除标签）

@app.post("/v1/position/{fund_code}/rename")
def rename_fund_key_api(fund_code: str, req: RenameFundKeyRequest):
    """给已有持仓设置/修改标签（重命名存储键）"""
    real_code, _ = parse_fund_key(fund_code)
    new_key = make_fund_key(real_code, req.new_owner.strip())
    if fund_code == new_key:
        return {"success": True, "message": "标签未变化", "new_key": new_key}
    if rename_fund_key(fund_code, new_key):
        return {"success": True, "message": f"已重命名 {fund_code} → {new_key}", "new_key": new_key}
    else:
        raise HTTPException(status_code=400, detail="重命名失败（目标键可能已存在）")


@app.put("/v1/position/{fund_code}/config")
def update_config(fund_code: str, req: FundConfigRequest):
    """更新基金配置"""
    if update_fund_config(fund_code, req.max_position, req.fund_name):
        return {"success": True, "fund_key": fund_code, **_strategy_snapshot(fund_code)}
    else:
        raise HTTPException(status_code=500, detail="更新失败")


@app.put("/v1/position/{fund_code}/fee-schedule")
def update_fee_schedule_api(fund_code: str, req: FeeScheduleRequest):
    """更新基金卖出费率表"""
    schedule = [{"days": s.days, "rate": s.rate} for s in req.schedule]
    if update_fee_schedule(fund_code, schedule):
        return {"success": True, "schedule": schedule, "fund_key": fund_code, **_strategy_snapshot(fund_code)}
    else:
        raise HTTPException(status_code=500, detail="更新失败")


class UpdateSellNavRequest(BaseModel):
    sell_record_id: str
    sell_nav: float


class SellFifoRequest(BaseModel):
    total_sell_shares: float
    sell_nav: Optional[float] = None
    sell_date: Optional[str] = None


class JdGridAdjustment(BaseModel):
    id: str
    code: str
    name: Optional[str] = None
    type: str
    tradeDate: str
    tradeTime: Optional[str] = None
    shares: Optional[str] = None
    amount: Optional[str] = None
    targetCode: Optional[str] = None
    targetName: Optional[str] = None
    targetShares: Optional[str] = None


class JdGridHolding(BaseModel):
    code: str
    name: str = ""
    amount: Optional[str] = None
    shares: Optional[str] = None
    costPrice: Optional[str] = None
    costAmount: Optional[str] = None
    profit: Optional[str] = None
    profitDate: Optional[str] = None
    acquiredDate: Optional[str] = None


class JdGridImportRequest(BaseModel):
    current_holding_codes: List[str]
    current_holdings: List[JdGridHolding] = []
    adjustments: List[JdGridAdjustment]


def _jd_positive_number(value) -> Optional[float]:
    """Extract JD numeric strings such as `1,234.56元` and `800份`."""
    text = str(value or "").replace(",", "").replace("，", "").strip()
    matched = re.search(r"[+-]?(?:\d+(?:\.\d+)?|\.\d+)", text)
    if not matched:
        return None
    try:
        number = float(matched.group(0))
    except ValueError:
        return None
    return number if number > 0 else None


def _jd_nav_on_date(code: str, trade_date: str, cache: dict) -> Optional[float]:
    cache_key = (code, trade_date)
    if cache_key in cache:
        return cache[cache_key]
    try:
        from valuation.providers import get_fund_nav_history
        trade_day = datetime.strptime(trade_date, "%Y-%m-%d").date()
        calendar_days = max(0, (date.today() - trade_day).days)
        # Estimate trading days, add a margin for holidays, and cap the request
        # at a decade of published history used by the JD transaction reader.
        history_days = min(3000, max(90, calendar_days * 5 // 7 + 90))
        history = get_fund_nav_history(code, history_days)
        nav = next((
            _jd_positive_number(item.get("nav"))
            for item in history
            if item.get("date") == trade_date and _jd_positive_number(item.get("nav"))
        ), None)
    except Exception:
        nav = None
    cache[cache_key] = nav
    return nav


def _jd_import_leg(ledger_id: str, code: str, action: str, trade_date: str,
                   trade_time: Optional[str], shares_value, amount_value: Optional[float],
                   nav_cache: dict, note: str, name: str = "") -> Optional[dict]:
    shares = _jd_positive_number(shares_value)
    amount = _jd_positive_number(amount_value)
    nav = amount / shares if amount and shares else _jd_nav_on_date(code, trade_date, nav_cache)
    if action == "buy":
        if not amount and shares and nav:
            amount = shares * nav
        if not amount or not nav:
            return None
    elif not shares:
        if amount and nav:
            shares = amount / nav
        if not shares:
            return None
    return {
        "ledger_id": ledger_id,
        "code": code,
        "action": action,
        "trade_date": trade_date,
        "trade_time": trade_time or "",
        "shares": round(shares, 4) if shares else None,
        "amount": round(amount, 4) if amount else None,
        "nav": round(nav, 6) if nav else None,
        "note": note,
        "name": name.strip(),
    }


def _jd_timeline_matches_current_holding(legs: list, expected_shares: Optional[float]) -> bool:
    """Accept a JD fund only when its real timeline reconciles to the cookie snapshot."""
    if not expected_shares or expected_shares <= 0:
        return False
    balance = 0.0
    has_buy = False
    for leg in legs:
        shares = _jd_positive_number(leg.get("shares"))
        if not shares:
            return False
        if leg.get("action") == "buy":
            balance += shares
            has_buy = True
        elif leg.get("action") == "sell":
            balance -= shares
    tolerance = max(0.02, expected_shares * 0.001)
    return has_buy and balance > 0 and abs(balance - expected_shares) <= tolerance


@app.post("/v1/positions/jd-import")
def import_jd_positions(req: JdGridImportRequest):
    """Import the JD audit stream as idempotent grid batches for current holdings only."""
    current_codes = {code.strip() for code in req.current_holding_codes if isinstance(code, str) and code.strip().isdigit() and len(code.strip()) == 6}
    if not current_codes:
        raise HTTPException(status_code=400, detail="当前京东持仓不能为空")

    nav_cache = {}
    legs = []
    rejected = []
    candidate_codes = set()
    invalid_candidate_codes = set()
    for adjustment in req.adjustments:
        code = adjustment.code.strip()
        trade_date = adjustment.tradeDate.strip()
        if not code.isdigit() or len(code) != 6 or adjustment.type not in {"add", "reduce", "convert"}:
            rejected.append({"id": adjustment.id, "status": "skipped", "reason": "invalid_adjustment"})
            continue
        try:
            datetime.strptime(trade_date, "%Y-%m-%d")
        except ValueError:
            rejected.append({"id": adjustment.id, "status": "skipped", "reason": "invalid_trade_date"})
            continue

        if adjustment.type == "add":
            if code not in current_codes:
                rejected.append({"id": adjustment.id, "code": code, "status": "skipped", "reason": "not_current_holding"})
                continue
            candidate_codes.add(code)
            leg = _jd_import_leg(f"jd:{adjustment.id}:source", code, "buy", trade_date, adjustment.tradeTime,
                                 adjustment.shares, adjustment.amount, nav_cache, "京东导入·买入")
            if leg:
                legs.append(leg)
            else:
                rejected.append({"id": adjustment.id, "code": code, "status": "skipped", "reason": "missing_buy_value"})
                invalid_candidate_codes.add(code)
            continue

        if adjustment.type == "reduce":
            if code not in current_codes:
                rejected.append({"id": adjustment.id, "code": code, "status": "skipped", "reason": "not_current_holding"})
                continue
            candidate_codes.add(code)
            leg = _jd_import_leg(f"jd:{adjustment.id}:source", code, "sell", trade_date, adjustment.tradeTime,
                                 adjustment.shares, adjustment.amount, nav_cache, "京东导入·卖出")
            if leg:
                legs.append(leg)
            else:
                rejected.append({"id": adjustment.id, "code": code, "status": "skipped", "reason": "missing_sell_shares"})
                invalid_candidate_codes.add(code)
            continue

        if code in current_codes:
            candidate_codes.add(code)
            source_leg = _jd_import_leg(f"jd:{adjustment.id}:source", code, "sell", trade_date, adjustment.tradeTime,
                                        adjustment.shares, adjustment.amount, nav_cache, "京东导入·转换转出")
            if source_leg:
                legs.append(source_leg)
            else:
                rejected.append({"id": adjustment.id, "code": code, "status": "skipped", "reason": "missing_conversion_source"})
                invalid_candidate_codes.add(code)
        target_code = (adjustment.targetCode or "").strip()
        if target_code in current_codes:
            candidate_codes.add(target_code)
            source_amount = _jd_positive_number(adjustment.amount)
            if not source_amount:
                source_shares = _jd_positive_number(adjustment.shares)
                source_nav = _jd_nav_on_date(code, trade_date, nav_cache)
                source_amount = source_shares * source_nav if source_shares and source_nav else None
            target_leg = _jd_import_leg(f"jd:{adjustment.id}:target", target_code, "buy", trade_date, adjustment.tradeTime,
                                        adjustment.targetShares, source_amount, nav_cache, "京东导入·转换转入")
            if target_leg:
                legs.append(target_leg)
            else:
                rejected.append({"id": adjustment.id, "code": target_code, "status": "skipped", "reason": "missing_conversion_target"})
                invalid_candidate_codes.add(target_code)
        elif code not in current_codes:
            rejected.append({"id": adjustment.id, "status": "skipped", "reason": "not_current_holding"})

    expected_shares = {
        holding.code.strip(): _jd_positive_number(holding.shares)
        for holding in req.current_holdings
        if holding.code and holding.code.strip() in current_codes
    }
    verified_legs = []
    for code in sorted(current_codes):
        fund_legs = [leg for leg in legs if leg["code"] == code]
        # A snapshot-only fund has no actual timeline to validate. Preserve the
        # concise missing-cycle result below. A candidate with a missing value
        # or an unreconciled share balance is unsafe as a whole and must never
        # leave its otherwise-valid legs in the grid.
        if not fund_legs and code not in candidate_codes:
            continue
        if code in invalid_candidate_codes or not _jd_timeline_matches_current_holding(fund_legs, expected_shares.get(code)):
            rejected.append({"id": f"jd:timeline:{code}", "code": code, "status": "skipped", "reason": "unverified_current_timeline"})
            continue
        for leg in fund_legs:
            leg["timeline_verified"] = True
            verified_legs.append(leg)
    legs = verified_legs
    holding_names = {holding.code.strip(): holding.name.strip() for holding in req.current_holdings}
    for leg in legs:
        if not leg.get("name"):
            leg["name"] = holding_names.get(leg["code"], "")

    # The grid is an auditable reconstruction of the current holding cycle.
    # Never synthesize a batch from a cost snapshot when JD did not return the
    # actual opening transaction and its date.
    covered_codes = {leg["code"] for leg in legs if leg["action"] == "buy"}
    for code in sorted(current_codes - covered_codes):
        if code in candidate_codes:
            continue
        rejected.append({"id": f"jd:cycle:{code}", "code": code, "status": "skipped", "reason": "missing_current_cycle_transaction"})

    result = import_jd_grid_transactions(legs)
    result["results"] = rejected + result["results"]
    result["skipped"] += len(rejected)
    return result


@app.post("/v1/position/{fund_code}/sell-fifo")
def sell_fund_fifo(fund_code: str, req: SellFifoRequest):
    """按FIFO顺序卖出指定总份额（模拟支付宝先进先出行为）"""
    if req.total_sell_shares <= 0:
        raise HTTPException(status_code=400, detail="卖出份额必须大于0")
    try:
        result = sell_fifo(fund_code, req.total_sell_shares,
                           req.sell_nav, req.sell_date)
        return {"success": True, **result, "fund_key": fund_code, **_strategy_snapshot(fund_code)}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.put("/v1/position/{fund_code}/sell-nav")
def update_sell_nav_api(fund_code: str, req: UpdateSellNavRequest):
    """补录卖出确认净值"""
    if req.sell_nav <= 0:
        raise HTTPException(status_code=400, detail="净值必须大于0")
    try:
        result = update_sell_nav(fund_code, req.sell_record_id, req.sell_nav)
        return {"success": True, "record": result, "fund_key": fund_code, **_strategy_snapshot(fund_code)}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))




class UpdateBuyNavRequest(BaseModel):
    batch_id: str
    nav: float

@app.put("/v1/position/{fund_code}/buy-nav")
def update_buy_nav_api(fund_code: str, req: UpdateBuyNavRequest):
    """补录买入确认净值"""
    if req.nav <= 0:
        raise HTTPException(status_code=400, detail="净值必须大于0")
    try:
        batch = confirm_buy_nav(fund_code, req.batch_id, req.nav)
        return {"success": True, "batch": batch, "fund_key": fund_code, **_strategy_snapshot(fund_code)}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

@app.delete("/v1/position/{fund_code}/sell-record/{sell_record_id}")
def delete_sell_record_api(fund_code: str, sell_record_id: str):
    """删除卖出记录"""
    if delete_sell_record(fund_code, sell_record_id):
        return {"success": True, "message": f"已删除卖出记录 {sell_record_id}", "fund_key": fund_code, **_strategy_snapshot(fund_code)}
    else:
        raise HTTPException(status_code=404, detail=f"卖出记录 {sell_record_id} 不存在")


# ============================================================
# 策略信号 API（新增）
# ============================================================

@app.get("/v1/strategy/signals")
def get_all_strategy_signals():
    """获取全部基金策略信号"""
    return generate_all_signals()


@app.get("/v1/strategy/signal/{fund_code}")
def get_strategy_signal(fund_code: str):
    """获取单基金策略信号"""
    return generate_signal(fund_code)


@app.get("/v1/strategy/history")
def get_all_signal_history(limit: int = 30):
    """获取全部基金信号历史"""
    return get_signal_history(limit=limit)


@app.get("/v1/strategy/history/{fund_code}")
def get_fund_signal_history(fund_code: str, limit: int = 30):
    """获取单基金信号历史"""
    return get_signal_history(fund_code=fund_code, limit=limit)


@app.post("/v1/strategy/backfill")
def backfill_outcomes():
    """回填历史信号的 outcome 字段（建议收盘后调用）"""
    updated = backfill_signal_outcomes()
    return {"success": True, "updated": updated}


@app.get("/v1/strategy/win-rate")
def get_all_win_rate(lookback: int = 30):
    """获取全部基金信号胜率统计"""
    return calc_signal_win_rate(lookback=lookback)


@app.get("/v1/strategy/win-rate/{fund_code}")
def get_fund_win_rate(fund_code: str, lookback: int = 30):
    """获取单基金信号胜率统计"""
    return calc_signal_win_rate(fund_code=fund_code, lookback=lookback)


# ============================================================
# 波动率灵敏度 API
# ============================================================

@app.get("/v1/position/{fund_code}/vol-sensitivity")
def get_vol_sensitivity_api(fund_code: str):
    """获取基金波动率灵敏度信息"""
    return get_vol_sensitivity_info(fund_code)


class VolSensitivityRequest(BaseModel):
    sensitivity: float


@app.put("/v1/position/{fund_code}/vol-sensitivity")
def set_vol_sensitivity_api(fund_code: str, req: VolSensitivityRequest):
    """手动设置波动率灵敏度（覆盖自动校准）"""
    if req.sensitivity < 0.5 or req.sensitivity > 1.5:
        raise HTTPException(status_code=400, detail="灵敏度范围 0.5~1.5")
    if update_vol_sensitivity(fund_code, req.sensitivity):
        return {"success": True, "sensitivity": round(req.sensitivity, 2)}
    raise HTTPException(status_code=404, detail=f"基金 {fund_code} 不存在")


@app.delete("/v1/position/{fund_code}/vol-sensitivity")
def clear_vol_sensitivity_api(fund_code: str):
    """清除手动设置，恢复自动校准"""
    if clear_vol_sensitivity(fund_code):
        return {"success": True, "message": "已恢复自动校准"}
    raise HTTPException(status_code=404, detail=f"基金 {fund_code} 不存在")


@app.post("/v1/position/{fund_code}/vol-sensitivity/calibrate")
def recalibrate_vol_sensitivity_api(fund_code: str):
    """强制重新校准（清除缓存并立即计算）"""
    # 先清除缓存
    clear_vol_sensitivity(fund_code)
    # 触发重新计算
    info = get_vol_sensitivity_info(fund_code)
    return {"success": True, **info}


# ============================================================
# 分组管理 API
# ============================================================

class GroupCreateRequest(BaseModel):
    name: str

class GroupUpdateRequest(BaseModel):
    name: Optional[str] = None
    fund_codes: Optional[List[str]] = None

@app.get("/v1/groups")
def get_groups_api():
    """获取全部分组"""
    return {"groups": get_groups()}

@app.post("/v1/groups")
def create_group(req: GroupCreateRequest):
    """新建分组"""
    if not req.name.strip():
        raise HTTPException(status_code=400, detail="分组名称不能为空")
    group = add_group(req.name.strip())
    return {"success": True, "group": group}

@app.put("/v1/groups/{group_id}")
def update_group_api(group_id: str, req: GroupUpdateRequest):
    """更新分组"""
    if update_group(group_id, req.name, req.fund_codes):
        return {"success": True}
    raise HTTPException(status_code=404, detail="分组不存在")

@app.delete("/v1/groups/{group_id}")
def delete_group_api(group_id: str):
    """删除分组"""
    if delete_group(group_id):
        return {"success": True}
    raise HTTPException(status_code=404, detail="分组不存在")


# ============================================================
# 行情模式管理 API
# ============================================================

class RegimeRequest(BaseModel):
    regime: str = "neutral"  # "bull" | "neutral" | "bear"
    auto: bool = True
    manual_override: bool = False


@app.get("/v1/market-regime")
def get_regime():
    """获取当前行情模式及参数"""
    return get_market_regime_info()


@app.post("/v1/market-regime")
def set_regime(req: RegimeRequest):
    """设置行情模式。manual_override=True: 手动指定; False: 恢复自动"""
    result = set_market_regime(req.regime, req.auto, req.manual_override)
    return {"success": True, **result}


# ============================================================
# v5.13: 适配评分缓存 API
# ============================================================

@app.get("/v1/fund-fitness")
def get_all_fitness():
    """获取所有基金适配评分缓存"""
    return {"scores": get_fitness_scores()}


@app.get("/v1/fund-fitness/{fund_code}")
def get_single_fitness(fund_code: str):
    """获取单只基金适配评分"""
    info = get_fund_fitness(fund_code)
    if info:
        return {"fund_code": fund_code, **info}
    return {"fund_code": fund_code, "score": None, "grade": None}


# ============================================================
# v5.X: 延迟回补挂单查询/维护接口
# ============================================================

@app.get("/v1/position/{fund_code}/pending-rebuys")
def get_pending_rebuys_api(fund_code: str, include_history: bool = False):
    """查询某基金的延迟回补挂单（include_history=True 返回 triggered/expired 历史）"""
    from grid.pending_rebuy import get_pending_rebuys
    items = get_pending_rebuys(fund_code, include_history=include_history)
    return {"fund_code": fund_code, "pending_rebuys": items, "count": len(items)}


@app.get("/v1/pending-rebuys/summary")
def get_pending_rebuys_summary_api():
    """全量挂单概览：返回每只基金 {pending, triggered, expired, total} 计数"""
    from grid.pending_rebuy import get_all_pending_rebuys_summary
    return get_all_pending_rebuys_summary()


@app.post("/v1/pending-rebuys/cleanup")
def cleanup_pending_rebuys_api():
    """清理已过期但仍标记为 pending 的挂单（兜底维护接口）"""
    from grid.pending_rebuy import cleanup_expired_pending_rebuys
    n = cleanup_expired_pending_rebuys()
    return {"cleaned": n}


@app.get("/")
async def serve_index():
    return FileResponse(os.path.join(os.path.dirname(__file__), "demo.html"))


@app.get("/favicon.ico")
async def favicon():
    from fastapi.responses import Response
    return Response(content="", media_type="image/x-icon")


def _acquire_app_instance_lock():
    """阻止第二个 app.py 在端口绑定前执行启动任务。"""
    lock_dir = Path(__file__).parent / "logs"
    lock_dir.mkdir(parents=True, exist_ok=True)
    lock_path = lock_dir / "valuation-grid-app.lock"
    handle = open(lock_path, "a+b")
    handle.seek(0, 2)
    if handle.tell() == 0:
        handle.write(b"\0")
        handle.flush()
    handle.seek(0)

    try:
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return handle
    except OSError:
        handle.close()
        return None


def _release_app_instance_lock(handle):
    handle.seek(0)
    if os.name == "nt":
        import msvcrt
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        import fcntl
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    handle.close()


if __name__ == "__main__":
    _instance_lock = _acquire_app_instance_lock()
    if _instance_lock is None:
        print("[Startup] valuation-grid app.py 已在运行，拒绝启动第二个实例")
        raise SystemExit(2)
    try:
        uvicorn.run(app, host="0.0.0.0", port=8000)
    finally:
        _release_app_instance_lock(_instance_lock)
