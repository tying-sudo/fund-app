# Holding Calculation Repair Tracker

| ID | Issue | Priority | Fix | Verification | Status |
| --- | --- | --- | --- | --- | --- |
| H-01 | Pending adjustments can be applied more than once by concurrent refresh callbacks. | P1 | Serialize settlement by pending-record ID and settle only the fund that supplied the official NAV. | Settlement locks prevent duplicate in-flight application. | Complete |
| H-02 | Adjustment shares use an estimate instead of the official settlement NAV. | P1 | Resolve the first published NAV on or after the effective trade date before updating shares and cost. | Settlement tests select the first official NAV. | Complete |
| H-03 | After-15:00, weekend, and holiday dates are handled as calendar dates. | P1 | Use the first available official NAV after the effective date; do not assume a calendar date is a trading day. | Friday after-close resolves on the next published NAV. | Complete |
| H-04 | A-share initial purchase ignores the fee-adjusted amount when persisting shares. | P1 | Persist net subscription shares while retaining the gross cash outflow as cost. | Fee-adjusted share calculation test passes. | Complete |
| H-05 | Beijing date, browser-local trading hours, and natural-day freshness checks disagree. | P2 | Centralize Beijing date/time handling and accept the latest official NAV while the market is closed. | Beijing rollover and long-gap date checks pass. | Complete |
| H-06 | C-share cumulative service-fee estimate is presented as an exact deduction. | P2 | Do not calculate or display it separately; NAV already includes the accrued fee. | Holding profit is derived from NAV with no second fee deduction or UI noise. | Complete |
| H-07 | No regression coverage for holding calculations. | P1 | Add deterministic tests for settlement, fees, dates, and concurrency guards. | `npm run test:holding` and production build pass. | Complete |
