package com.fundapp.realtime;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.Dialog;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TimeZone;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** Reads a JD account using either the interactive WebView session or a user-supplied Cookie. */
@CapacitorPlugin(name = "JdHoldings")
public class JdHoldingsPlugin extends Plugin {
    private static final String LOGIN_URL = "https://jdjr.jd.com/";
    private static final String HOLDINGS_URL = "https://ms.jr.jd.com/gw/generic/base/h5/m/fundHoldGroup";
    private static final String HOLDING_DETAIL_URL = "https://ms.jr.jd.com/gw/generic/jj/h5/m/getNewFundPositionDetail";
    // The holdings-page Cookie import has a separate, browser-originated API
    // contract. Keep the grid's legacy WebView endpoints untouched.
    private static final String HOLDING_COOKIE_GROUP_URL = "https://ms.jr.jd.com/gw/generic/base/newna/m/fundHoldGroup";
    private static final String HOLDING_COOKIE_DETAIL_URL = "https://ms.jr.jd.com/gw/generic/jj/newna/m/getNewFundPositionDetail";
    // JD renders the current-holding panel from this Roma document.  Loading
    // the finance homepage instead changes the browser origin and can make
    // the newna fund endpoints fail their CORS/origin validation.
    private static final String HOLDING_PAGE_URL = "https://roma.jd.com/fund/hold/list/pc/?channelfrom=grouppc&showPCfund=1&ua=jdjr-app";
    private static final String FUND_DETAIL_PAGE_URL = "https://roma.jd.com/fund/hold/detail/?extJson=%s";
    // The page remains the compatibility fallback.  The captured JD Android
    // client uses the newna transport for the same account-level pagination.
    private static final String ACCOUNT_TRADE_PAGE_URL = "https://roma.jd.com/wealth/tradeorder/list?pageShowType=1&businessCode=FUND&pageShowTitle=%E5%9F%BA%E9%87%91%E4%BA%A4%E6%98%93";
    private static final String ACCOUNT_TRADE_DIRECT_URL = "https://ms.jr.jd.com/gw2/generic/cfGateway/newna/m/queryTradeOrderList";
    // The earliest actual buy establishes a fund's true acquisition date, so
    // the account reader must not truncate its history to a recent window.
    private static final String ACCOUNT_TRADE_HISTORY_START_DATE = "2000-01-01";
    private static final int ACCOUNT_TRADE_PAGE_SIZE = 20;
    private static final int ACCOUNT_TRADE_MAX_PAGES = 200;
    private static final int MATCH_PARENT = ViewGroup.LayoutParams.MATCH_PARENT;
    private static final int WRAP_CONTENT = ViewGroup.LayoutParams.WRAP_CONTENT;
    private static final int DETAIL_TIMEOUT_SECONDS = 35;
    private static final int HOLDING_DETAIL_CONCURRENCY = 2;
    private static final int HOLDING_DETAIL_MAX_ATTEMPTS = 2;
    private static final long HOLDING_DETAIL_RETRY_BASE_MILLIS = 750L;
    private static final int HOLDING_TRADE_CONCURRENCY = 2;
    private static final int HOLDING_TRADE_MAX_ATTEMPTS = 2;
    private static final int ACCOUNT_TRADE_TIMEOUT_SECONDS = 120;
    private static final int ACCOUNT_TRADE_FIRST_PAGE_TIMEOUT_MILLIS = 20_000;
    private static final int ACCOUNT_TRADE_STALL_TIMEOUT_MILLIS = 12_000;

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private PluginCall pendingCall;
    private Dialog loginDialog;
    private WebView loginWebView;
    private final ConcurrentHashMap<String, BrowserCookieRequest> cookieBrowserRequests = new ConcurrentHashMap<>();
    private TextView statusView;
    private Button importButton;
    private boolean importInFlight;
    private boolean cookieImport;
    /** Grid imports merge the complete account timeline with detail confirmations. */
    private boolean gridImport;
    private String requestUserAgent = "Mozilla/5.0";

    @PluginMethod
    public void importHoldings(PluginCall call) {
        if (pendingCall != null || importInFlight) {
            call.reject("已有京东读取任务正在进行");
            return;
        }
        call.setKeepAlive(true);
        pendingCall = call;
        gridImport = false;
        reportProgress("login", "正在打开京东金融登录页...", 0, 0);
        Activity activity = getActivity();
        if (activity == null) {
            finishWithError("无法打开京东金融登录页");
            return;
        }
        activity.runOnUiThread(this::showLoginDialog);
    }

    @PluginMethod
    public void importHoldingsWithCookie(PluginCall call) {
        if (pendingCall != null || importInFlight) {
            call.reject("已有京东读取任务正在进行");
            return;
        }
        String sessionCookie = normalizeCookie(call.getString("cookie", ""));
        if (sessionCookie == null) {
            call.reject("请输入有效的京东 Cookie");
            return;
        }
        call.setKeepAlive(true);
        pendingCall = call;
        cookieImport = true;
        gridImport = call.getBoolean("grid", false);
        reportProgress("reading_holdings", "正在读取京东当前持仓...", 0, 0);
        Activity activity = getActivity();
        if (activity == null) {
            finishWithError("无法打开京东持仓读取");
            return;
        }
        boolean background = call.getBoolean("background", false);
        activity.runOnUiThread(() -> {
            if (background) startBackgroundCookieImport(sessionCookie);
            else showCookieImportDialog(sessionCookie);
        });
    }

    /** Kept only so an already-cached web bundle uses the shared grid importer. */
    @PluginMethod
    public void importHoldingCookieLegacy(PluginCall call) {
        importHoldingsWithCookie(call);
    }

    private String normalizeCookie(String value) {
        if (value == null) return null;
        String cookie = value.trim().replaceFirst("(?i)^cookie\\s*:\\s*", "");
        if (cookie.length() < 3 || cookie.length() > 16_384 || cookie.contains("\r") || cookie.contains("\n") || !cookie.contains("=")) {
            return null;
        }
        return cookie;
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void showLoginDialog() {
        Activity activity = getActivity();
        if (activity == null || activity.isFinishing()) {
            finishWithError("无法打开京东金融登录页");
            return;
        }

        clearWebSession();
        loginDialog = new Dialog(activity, android.R.style.Theme_DeviceDefault_Light_NoActionBar);
        loginDialog.setCanceledOnTouchOutside(false);
        loginDialog.setOnCancelListener(ignored -> finishWithError("已取消京东登录"));

        LinearLayout root = new LinearLayout(activity);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);

        LinearLayout header = new LinearLayout(activity);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(16), dp(10), dp(10), dp(8));
        header.setBackgroundColor(Color.rgb(250, 250, 250));

        TextView title = new TextView(activity);
        title.setText("京东金融登录");
        title.setTextColor(Color.rgb(30, 30, 30));
        title.setTextSize(18);
        header.addView(title, new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1));

        Button cancel = new Button(activity);
        cancel.setText("取消");
        cancel.setOnClickListener(view -> finishWithError("已取消京东登录"));
        header.addView(cancel, new LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT));
        root.addView(header, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        statusView = new TextView(activity);
        statusView.setText("完成登录后点击读取持仓");
        statusView.setTextColor(Color.rgb(95, 95, 95));
        statusView.setTextSize(13);
        statusView.setPadding(dp(16), dp(8), dp(16), dp(8));
        root.addView(statusView, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        loginWebView = createWebView(activity);
        loginWebView.setWebViewClient(new SecureJdWebViewClient());
        root.addView(loginWebView, new LinearLayout.LayoutParams(MATCH_PARENT, 0, 1));

        LinearLayout footer = new LinearLayout(activity);
        footer.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
        footer.setPadding(dp(12), dp(8), dp(12), dp(12));
        importButton = new Button(activity);
        importButton.setText("读取持仓");
        importButton.setOnClickListener(view -> startImport());
        footer.addView(importButton, new LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT));
        root.addView(footer, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        loginDialog.setContentView(root);
        if (loginDialog.getWindow() != null) {
            loginDialog.getWindow().setLayout(MATCH_PARENT, MATCH_PARENT);
            loginDialog.getWindow().setBackgroundDrawable(new ColorDrawable(Color.WHITE));
        }
        loginDialog.show();
        if (loginDialog.getWindow() != null) loginDialog.getWindow().setLayout(MATCH_PARENT, MATCH_PARENT);
        loginWebView.loadUrl(LOGIN_URL);
    }

    private void startImport() {
        if (pendingCall == null || importInFlight) return;
        String sessionCookie = CookieManager.getInstance().getCookie(HOLDINGS_URL);
        if (sessionCookie == null || sessionCookie.trim().isEmpty()) {
            setStatus("请先完成京东金融登录");
            return;
        }

        beginPortfolioRead(sessionCookie);
    }

    private void beginPortfolioRead(String sessionCookie) {
        if (pendingCall == null || importInFlight) return;
        importInFlight = true;
        if (importButton != null) importButton.setEnabled(false);
        setStatus("正在读取京东当前持仓...");
        reportProgress("reading_holdings", "正在读取京东当前持仓...", 0, 0);
        PluginCall call = pendingCall;
        executor.execute(() -> {
            try {
                // Cookie imports must use JD's browser-originated newna holdings
                // APIs and the account-wide transaction page, never one detail
                // page per fund.
                JSObject result = cookieImport
                    ? readHoldingCookiePortfolio(sessionCookie)
                    : readPortfolio(sessionCookie);
                Activity activity = getActivity();
                if (activity != null) activity.runOnUiThread(() -> {
                    if (call == pendingCall) finishWithResult(result);
                });
            } catch (LoginRequiredException error) {
                Activity activity = getActivity();
                String visibleMessage = cookieImport ? "京东 Cookie 已过期或无效，请更新后重试" : "京东登录已失效，请重新登录";
                if (activity != null) activity.runOnUiThread(() -> finishWithError(visibleMessage));
                else finishWithError(visibleMessage);
            } catch (Exception error) {
                String message = error.getMessage();
                if (message == null || message.trim().isEmpty()) message = "京东持仓读取失败，请检查网络后重试";
                String finalMessage = message;
                Activity activity = getActivity();
                if (activity != null) activity.runOnUiThread(() -> finishWithError(finalMessage));
                else finishWithError(finalMessage);
            }
        });
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void startBackgroundCookieImport(String sessionCookie) {
        Activity activity = getActivity();
        if (activity == null || activity.isFinishing()) {
            finishWithError("无法打开京东持仓读取");
            return;
        }
        loginWebView = createWebView(activity);
        loginWebView.setWebViewClient(new SecureJdWebViewClient());
        beginPortfolioRead(sessionCookie);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void showCookieImportDialog(String sessionCookie) {
        Activity activity = getActivity();
        if (activity == null || activity.isFinishing()) {
            finishWithError("无法打开京东持仓读取");
            return;
        }
        loginDialog = new Dialog(activity, android.R.style.Theme_DeviceDefault_Light_NoActionBar);
        loginDialog.setCanceledOnTouchOutside(false);
        loginDialog.setOnCancelListener(ignored -> finishWithError("已取消京东持仓读取"));

        LinearLayout root = new LinearLayout(activity);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);
        LinearLayout header = new LinearLayout(activity);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(16), dp(10), dp(10), dp(8));
        header.setBackgroundColor(Color.rgb(250, 250, 250));
        TextView title = new TextView(activity);
        title.setText("京东金融");
        title.setTextColor(Color.rgb(30, 30, 30));
        title.setTextSize(18);
        header.addView(title, new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1));
        Button cancel = new Button(activity);
        cancel.setText("取消");
        cancel.setOnClickListener(view -> finishWithError("已取消京东持仓读取"));
        header.addView(cancel, new LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT));
        root.addView(header, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        statusView = new TextView(activity);
        statusView.setText("正在使用 Cookie 读取京东持仓...");
        statusView.setTextColor(Color.rgb(95, 95, 95));
        statusView.setTextSize(13);
        statusView.setPadding(dp(16), dp(8), dp(16), dp(8));
        root.addView(statusView, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        loginWebView = createWebView(activity);
        loginWebView.setWebViewClient(new SecureJdWebViewClient());
        root.addView(loginWebView, new LinearLayout.LayoutParams(MATCH_PARENT, 0, 1));

        LinearLayout footer = new LinearLayout(activity);
        footer.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
        footer.setPadding(dp(12), dp(8), dp(12), dp(12));
        importButton = new Button(activity);
        importButton.setText("读取持仓");
        importButton.setOnClickListener(view -> beginPortfolioRead(sessionCookie));
        footer.addView(importButton, new LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT));
        root.addView(footer, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        loginDialog.setContentView(root);
        if (loginDialog.getWindow() != null) {
            loginDialog.getWindow().setLayout(MATCH_PARENT, MATCH_PARENT);
            loginDialog.getWindow().setBackgroundDrawable(new ColorDrawable(Color.WHITE));
        }
        loginDialog.show();
        if (loginDialog.getWindow() != null) loginDialog.getWindow().setLayout(MATCH_PARENT, MATCH_PARENT);
        beginPortfolioRead(sessionCookie);
    }

    private JSObject readPortfolio(String sessionCookie) throws Exception {
        return readPortfolioWithAccountTrades(sessionCookie, readHoldingDetails(sessionCookie), false);
    }

    private JSObject readHoldingCookiePortfolio(String sessionCookie) throws Exception {
        // The newna endpoints must run in JD's actual Roma holding document
        // with a registered browser bridge.  If JD temporarily rejects that
        // modern page transport, use the same h5 snapshot reader that the
        // grid importer already supports before failing the Cookie import.
        try {
            prepareHoldingCookieBrowser(sessionCookie);
            return readPortfolioWithAccountTrades(sessionCookie, readHoldingCookieDetails(sessionCookie), gridImport);
        } catch (HoldingSnapshotIncompleteException error) {
            // Each newna detail already tried the compatible h5 transport.
            // Replaying the entire account would only increase throttling and
            // could turn the incomplete snapshot into destructive deletions.
            throw error;
        } catch (Exception browserFailure) {
            reportProgress("reading_holdings", "京东新版接口暂时未完成，正在降速兼容读取...", 1, 2);
            try {
                return readPortfolioWithAccountTrades(sessionCookie, readHoldingDetails(sessionCookie), gridImport);
            } catch (Exception fallbackFailure) {
                fallbackFailure.addSuppressed(browserFailure);
                throw fallbackFailure;
            }
        }
    }

    /** Merge complete account pagination with the latest per-fund confirmation fields. */
    private JSObject readPortfolioWithAccountTrades(String sessionCookie, JSArray rawHoldings, boolean gridTimelineOnly) throws Exception {
        JSArray holdings = new JSArray();
        JSArray closedItems = new JSArray();
        for (int index = 0; index < rawHoldings.length(); index++) {
            JSONObject holding = rawHoldings.optJSONObject(index);
            if (holding == null) continue;
            if (holding.optBoolean("zeroPosition", false)) closedItems.put(holding);
            else holdings.put(holding);
        }
        JSObject result = new JSObject();
        result.put("items", holdings);
        if (closedItems.length() > 0) result.put("closedItems", closedItems);
        // The account list owns complete pagination; current-fund detail pages
        // supply the latest confirmation status/shares that may not yet be
        // reflected in that list. Grid imports need both sources as well.
        ExecutorService timelineReaders = Executors.newFixedThreadPool(2);
        Future<AccountTradeResult> accountRead = timelineReaders.submit(() -> readHoldingCookieAccountTrades(sessionCookie, holdings));
        // Account pagination is the authoritative three-month timeline. Opening
        // one WebView per fund merely to enrich it is expensive and commonly
        // returns the same amount-only rows, so grid imports use it only as a
        // fallback when the account reader itself fails.
        Future<CurrentHoldingTradeResult> detailRead = gridTimelineOnly
            ? null
            : timelineReaders.submit(() -> readCurrentHoldingTrades(sessionCookie, holdings));
        AccountTradeResult accountResult = null;
        String accountFailure = "";
        CurrentHoldingTradeResult detailResult = CurrentHoldingTradeResult.empty();
        try {
            try {
                accountResult = accountRead.get();
            } catch (ExecutionException error) {
                // The account-wide page owns completeness. Its failure keeps
                // the current holding snapshot but disables timeline replace.
                Throwable cause = error.getCause();
                accountFailure = cause == null ? "京东交易记录读取失败" : textValue(cause.getMessage());
            }
            if (detailRead != null) {
                try {
                    detailResult = detailRead.get();
                } catch (ExecutionException ignored) {
                    detailResult = CurrentHoldingTradeResult.failed("基金详情交易记录补全失败");
                }
            }
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("京东交易记录读取已中断", error);
        } finally {
            timelineReaders.shutdownNow();
        }
        if (accountResult == null) {
            if (gridTimelineOnly) {
                // The account page owns pagination. Detail rows may still keep
                // a grid import usable when that authoritative reader fails.
                if (detailRead == null) detailResult = readCurrentHoldingTrades(sessionCookie, holdings);
                if (detailResult.rows.length() > 0) {
                    result.put("adjustments", detailResult.rows);
                    result.put("tradeDiagnostic", "交易记录诊断：账号页失败，已由详情页补全；" + detailResult.diagnostic());
                    result.put("tradeWarning", (accountFailure.isEmpty() ? "账号交易记录读取失败" : accountFailure) + "；已使用基金详情页补全，请复核缺失基金");
                    reportProgress("normalizing", "京东持仓数据读取完成", 0, 0);
                    return result;
                }
            }
            // A valid current-holding snapshot must still reach the holding
            // list when JD's optional transaction page is temporarily slow.
            result.put("adjustments", new JSArray());
            String reason = accountFailure.isEmpty() ? "账号交易记录未完整读取" : accountFailure;
            result.put(
                "tradeWarning",
                reason + "；" + detailResult.diagnostic() + "；为避免错误覆盖，已保留现有批次"
            );
        } else {
            JSArray merged = mergeAccountAndDetailTrades(accountResult.rows, detailResult.rows);
            String diagnostic = "交易记录诊断：账号 " + accountResult.pageCount + " 页、原始 "
                + accountResult.rawRows + " 条"
                + (accountResult.allCount > 0 ? "（接口总数 " + accountResult.allCount + " 条）" : "")
                + "、有效 " + accountResult.rows.length() + " 条；"
                + (gridTimelineOnly ? "网格已合并账号完整分页与详情确认字段；" : "")
                + detailResult.diagnostic();
            result.put("adjustments", merged);
            result.put("tradeDiagnostic", diagnostic);
            if (!detailResult.warning.isEmpty()) result.put("tradeWarning", detailResult.warning);
        }
        reportProgress("normalizing", "京东持仓数据读取完成", 0, 0);
        return result;
    }

    /**
     * The holdings Cookie route owns this bounded fan-out. Grid imports merge
     * the account-wide history with current-fund detail confirmation fields.
     */
    private JSArray readHoldingCookieDetails(String sessionCookie) throws Exception {
        JSONObject request = new JSONObject();
        request.put("clientVersion", "9.9.9");
        request.put("clientType", "android");
        request.put("apiVersion", 1);
        request.put("sortKey", "1");
        request.put("sortDirection", "DESC");
        request.put("viewType", "1");
        request.put("appChannel", "fund_jjcc");
        request.put("extParams", new JSONObject().put("channelCode", "outside"));
        JSONObject payload = requestHoldingCookieBrowserPost(HOLDING_COOKIE_GROUP_URL, request);
        JSONObject fundData = payload.optJSONObject("resultData");
        fundData = fundData == null ? null : fundData.optJSONObject("resultData");
        fundData = fundData == null ? null : fundData.optJSONObject("fundData");
        JSONArray groups = fundData == null ? null : fundData.optJSONArray("fundList");
        if (groups == null) throw new IllegalStateException("京东未返回当前持仓数据");

        List<JSONObject> products = new ArrayList<>();
        for (int groupIndex = 0; groupIndex < groups.length(); groupIndex++) {
            JSONObject group = groups.optJSONObject(groupIndex);
            JSONArray groupProducts = group == null ? null : group.optJSONArray("productList");
            if (groupProducts == null) throw incompleteHoldingSnapshot(null);
            for (int index = 0; index < groupProducts.length(); index++) {
                JSONObject product = groupProducts.optJSONObject(index);
                if (product == null) throw incompleteHoldingSnapshot(null);
                products.add(product);
            }
        }

        int total = products.size();
        JSArray holdings = new JSArray();
        if (total == 0) return holdings;
        ExecutorService detailReaders = Executors.newFixedThreadPool(Math.min(HOLDING_DETAIL_CONCURRENCY, total));
        AtomicInteger completed = new AtomicInteger();
        List<Future<JSObject>> reads = new ArrayList<>();
        try {
            for (JSONObject product : products) {
                reads.add(detailReaders.submit(() -> {
                    try {
                        return readHoldingCookieDetailWithRetry(product, sessionCookie);
                    } finally {
                        int current = completed.incrementAndGet();
                        reportProgress("reading_holdings", "正在读取京东持仓（" + current + "/" + total + "）...", current, total);
                    }
                }));
            }
            // Preserve JD's list order in the result even though the network
            // reads finish out of order.
            for (Future<JSObject> read : reads) {
                JSObject holding = read.get();
                if (holding == null) throw incompleteHoldingSnapshot(null);
                holdings.put(holding);
            }
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("京东持仓读取已中断", error);
        } catch (ExecutionException error) {
            Throwable cause = error.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            throw new IllegalStateException("京东持仓详情读取失败", cause);
        } finally {
            detailReaders.shutdownNow();
        }
        return holdings;
    }

    private JSArray readHoldingDetails(String sessionCookie) throws Exception {
        JSONObject request = new JSONObject();
        request.put("clientVersion", "9.9.9");
        request.put("clientType", "android");
        request.put("apiVersion", 1);
        request.put("sortKey", "1");
        request.put("sortDirection", "DESC");
        request.put("viewType", "1");
        request.put("appChannel", "fund_jjcc");
        request.put("extParams", new JSONObject().put("channelCode", "outside"));
        JSONObject payload = requestJdPost(HOLDINGS_URL, request, sessionCookie);
        JSONObject fundData = payload.optJSONObject("resultData");
        fundData = fundData == null ? null : fundData.optJSONObject("resultData");
        fundData = fundData == null ? null : fundData.optJSONObject("fundData");
        JSONArray groups = fundData == null ? null : fundData.optJSONArray("fundList");
        if (groups == null) throw new IllegalStateException("京东未返回当前持仓数据");

        List<JSONObject> products = new ArrayList<>();
        for (int groupIndex = 0; groupIndex < groups.length(); groupIndex++) {
            JSONObject group = groups.optJSONObject(groupIndex);
            JSONArray groupProducts = group == null ? null : group.optJSONArray("productList");
            if (groupProducts == null) throw incompleteHoldingSnapshot(null);
            for (int index = 0; index < groupProducts.length(); index++) {
                JSONObject product = groupProducts.optJSONObject(index);
                if (product == null) throw incompleteHoldingSnapshot(null);
                products.add(product);
            }
        }

        int total = products.size();
        JSArray holdings = new JSArray();
        if (total == 0) return holdings;

        ExecutorService detailReaders = Executors.newFixedThreadPool(Math.min(HOLDING_DETAIL_CONCURRENCY, total));
        AtomicInteger completed = new AtomicInteger();
        List<Future<JSObject>> reads = new ArrayList<>();
        try {
            for (JSONObject product : products) {
                reads.add(detailReaders.submit(() -> {
                    try {
                        return readHoldingDetailWithRetry(product, sessionCookie);
                    } finally {
                        int current = completed.incrementAndGet();
                        reportProgress("reading_holdings", "正在读取京东持仓（" + current + "/" + total + "）...", current, total);
                    }
                }));
            }
            // Futures are consumed in JD list order, independent of completion order.
            for (Future<JSObject> read : reads) {
                JSObject holding = read.get();
                if (holding == null) throw incompleteHoldingSnapshot(null);
                holdings.put(holding);
            }
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("京东持仓读取已中断", error);
        } catch (ExecutionException error) {
            Throwable cause = error.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            throw new IllegalStateException("京东持仓详情读取失败", cause);
        } finally {
            detailReaders.shutdownNow();
        }
        return holdings;
    }

    private JSObject readHoldingDetail(JSONObject product, String sessionCookie) throws Exception {
        return readHoldingDetail(product, sessionCookie, HOLDING_DETAIL_URL, "https://roma.jd.com/");
    }

    private JSObject readHoldingCookieDetail(JSONObject product, String sessionCookie) throws Exception {
        return readHoldingDetail(product, sessionCookie, HOLDING_COOKIE_DETAIL_URL, LOGIN_URL);
    }

    /**
     * Read one current position with a bounded retry.  A newna detail may be
     * temporarily throttled even though the Cookie is valid, so retry it at a
     * low concurrency and then try the matching h5 detail for this fund only.
     */
    private JSObject readHoldingCookieDetailWithRetry(JSONObject product, String sessionCookie) throws Exception {
        Exception browserFailure = null;
        for (int attempt = 1; attempt <= HOLDING_DETAIL_MAX_ATTEMPTS; attempt++) {
            try {
                JSObject holding = readHoldingCookieDetail(product, sessionCookie);
                if (holding != null) return holding;
                throw new IllegalStateException("京东基金详情字段不完整");
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw error;
            } catch (LoginRequiredException error) {
                browserFailure = error;
                break;
            } catch (Exception error) {
                browserFailure = error;
                if (attempt >= HOLDING_DETAIL_MAX_ATTEMPTS || !isRetryableHoldingDetailFailure(error)) break;
                waitBeforeHoldingDetailRetry(attempt);
            }
        }

        Exception fallbackFailure = null;
        for (int attempt = 1; attempt <= HOLDING_DETAIL_MAX_ATTEMPTS; attempt++) {
            try {
                JSObject holding = readHoldingDetail(product, sessionCookie);
                if (holding != null) return holding;
                throw new IllegalStateException("京东基金详情字段不完整");
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw error;
            } catch (LoginRequiredException error) {
                fallbackFailure = error;
                break;
            } catch (Exception error) {
                fallbackFailure = error;
                if (attempt >= HOLDING_DETAIL_MAX_ATTEMPTS || !isRetryableHoldingDetailFailure(error)) break;
                waitBeforeHoldingDetailRetry(attempt);
            }
        }

        // The account list already authenticated successfully.  A per-fund
        // endpoint can still reject its transport, so never reinterpret a
        // mid-batch detail failure as global Cookie expiry.
        HoldingSnapshotIncompleteException incomplete = incompleteHoldingSnapshot(fallbackFailure);
        if (browserFailure != null) incomplete.addSuppressed(browserFailure);
        throw incomplete;
    }

    private JSObject readHoldingDetailWithRetry(JSONObject product, String sessionCookie) throws Exception {
        Exception lastFailure = null;
        for (int attempt = 1; attempt <= HOLDING_DETAIL_MAX_ATTEMPTS; attempt++) {
            try {
                JSObject holding = readHoldingDetail(product, sessionCookie);
                if (holding != null) return holding;
                throw new IllegalStateException("京东基金详情字段不完整");
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw error;
            } catch (LoginRequiredException error) {
                lastFailure = error;
                break;
            } catch (Exception error) {
                lastFailure = error;
                if (attempt >= HOLDING_DETAIL_MAX_ATTEMPTS || !isRetryableHoldingDetailFailure(error)) break;
                waitBeforeHoldingDetailRetry(attempt);
            }
        }
        throw incompleteHoldingSnapshot(lastFailure);
    }

    private void waitBeforeHoldingDetailRetry(int attempt) throws InterruptedException {
        try {
            Thread.sleep(HOLDING_DETAIL_RETRY_BASE_MILLIS * Math.max(1, attempt));
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw error;
        }
    }

    private boolean isRetryableHoldingDetailFailure(Exception error) {
        if (error instanceof java.io.IOException) return true;
        String message = error.getMessage() == null ? "" : error.getMessage().toLowerCase(Locale.ROOT);
        return message.contains("超时")
            || message.contains("请求频繁")
            || message.contains("暂时繁忙")
            || message.contains("读取未完成")
            || message.contains("读取失败")
            || message.contains("返回格式异常")
            || message.contains("未返回有效")
            || message.contains("字段不完整")
            || message.contains("failed to fetch")
            || message.contains("network")
            || message.contains("connection")
            || message.contains("timed out");
    }

    private HoldingSnapshotIncompleteException incompleteHoldingSnapshot(Throwable cause) {
        return new HoldingSnapshotIncompleteException(
            "京东基金详情未完整读取，已取消本次导入并保留原有持仓，请稍后重试",
            cause
        );
    }

    private JSObject readHoldingDetail(JSONObject product, String sessionCookie, String detailEndpoint, String referer) throws Exception {
        if (product == null) return null;
        JSONObject jumpData = product.optJSONObject("jumpData");
        JSONObject parameter = jumpData == null ? null : jumpData.optJSONObject("param");
        String extJson = resolveDetailExtJson(parameter);
        if (extJson.isEmpty()) return null;

        JSONObject request = new JSONObject();
        request.put("extJson", extJson);
        request.put("version", 202);
        request.put("clientVersion", "9.9.9");
        request.put("clientType", "h5");
        JSONObject payload = HOLDING_COOKIE_DETAIL_URL.equals(detailEndpoint)
            ? requestHoldingCookieBrowserPost(detailEndpoint, request)
            : requestJdPost(detailEndpoint, request, sessionCookie, referer);
        JSONObject data = payload.optJSONObject("resultData");
        data = data == null ? null : data.optJSONObject("data");
        JSONObject pageInfo = data == null ? null : data.optJSONObject("pageInfo");
        String code = pageInfo == null ? "" : pageInfo.optString("fundCode", "").trim();
        if (!code.matches("\\d{6}")) return null;

        JSONObject amountTemplate = null;
        JSONObject introduction = null;
        JSONArray templates = data.optJSONArray("templateList");
        if (templates != null) {
            for (int index = 0; index < templates.length(); index++) {
                JSONObject template = templates.optJSONObject(index);
                JSONObject templateData = template == null ? null : template.optJSONObject("templateData");
                JSONObject candidate = templateData == null ? null : templateData.optJSONObject("fundAmount");
                if (candidate != null) {
                    amountTemplate = candidate;
                    introduction = templateData.optJSONObject("fundIntro");
                    break;
                }
            }
        }
        if (amountTemplate == null) return null;

        JSONObject minor = amountTemplate.optJSONObject("minorData");
        JSONObject major = amountTemplate.optJSONObject("majorData");
        String shares = findLabeledValue(minor == null ? null : minor.optJSONArray("dataList"), "持有份额");
        String costAmount = findLabeledValue(minor == null ? null : minor.optJSONArray("dataList"), "持仓成本价");
        String costPrice = findLabeledValue(minor == null ? null : minor.optJSONArray("dataList"), "持仓成本单价");
        String amount = findLabeledValue(minor == null ? null : minor.optJSONArray("dataList"), "持有金额");
        boolean zeroPosition = hasExplicitZeroPosition(amount, shares);
        if ((!hasCurrentPosition(amount, shares) || shares.isEmpty()) && !zeroPosition) return null;

        JSObject holding = new JSObject();
        holding.put("code", code);
        holding.put("name", introduction == null ? product.optString("productName", "") : introduction.optString("fundName", product.optString("productName", "")));
        holding.put("amount", amount);
        holding.put("yesterdayIncome", findLabeledValue(major == null ? null : major.optJSONArray("yieldList"), "昨日收益"));
        holding.put("profit", findLabeledValue(major == null ? null : major.optJSONArray("yieldList"), "持有收益"));
        holding.put("rate", findLabeledValue(major == null ? null : major.optJSONArray("yieldList"), "持有收益率"));
        holding.put("shares", shares);
        holding.put("detailExtJson", extJson);
        if (zeroPosition) holding.put("zeroPosition", true);
        if (!costAmount.isEmpty()) holding.put("costAmount", costAmount);
        if (!costPrice.isEmpty()) holding.put("costPrice", costPrice);
        String acquiredDate = findHoldingStartDate(product, pageInfo, amountTemplate, minor, data);
        if (acquiredDate != null) holding.put("acquiredDate", acquiredDate);
        return holding;
    }

    private CurrentHoldingTradeResult readCurrentHoldingTrades(String sessionCookie, JSArray holdings) throws Exception {
        JSArray adjustments = new JSArray();
        List<FundTradeRequest> requests = new ArrayList<>();
        for (int index = 0; index < holdings.length(); index++) {
            JSONObject holding = holdings.optJSONObject(index);
            String code = holding == null ? "" : holding.optString("code", "").trim();
            String extJson = holding == null ? "" : holding.optString("detailExtJson", "").trim();
            if (!code.matches("\\d{6}") || extJson.isEmpty()) continue;
            requests.add(new FundTradeRequest(code, extJson));
        }
        if (requests.isEmpty()) return CurrentHoldingTradeResult.failed("基金详情交易记录缺少可用入口");

        int total = requests.size();
        ExecutorService tradeReaders = Executors.newFixedThreadPool(Math.min(HOLDING_TRADE_CONCURRENCY, total));
        AtomicInteger completed = new AtomicInteger();
        List<Future<FundTradeRows>> reads = new ArrayList<>();
        try {
            for (FundTradeRequest request : requests) {
                reads.add(tradeReaders.submit(() -> {
                    String lastError = "";
                    try {
                        for (int attempt = 1; attempt <= HOLDING_TRADE_MAX_ATTEMPTS; attempt++) {
                            try {
                                return new FundTradeRows(
                                    request.code,
                                    readFundTradeRowsInIsolatedWebView(sessionCookie, request.code, request.extJson),
                                    "",
                                    attempt
                                );
                            } catch (Exception error) {
                                lastError = textValue(error.getMessage());
                            }
                        }
                        return new FundTradeRows(
                            request.code,
                            new JSONArray(),
                            lastError.isEmpty() ? "基金详情交易记录读取失败" : lastError,
                            HOLDING_TRADE_MAX_ATTEMPTS
                        );
                    } finally {
                        int current = completed.incrementAndGet();
                        reportProgress("reading_trades", "正在读取京东基金详情交易记录（" + current + "/" + total + "）...", current, total);
                    }
                }));
            }

            Set<String> seen = new HashSet<>();
            List<String> failedCodes = new ArrayList<>();
            int succeeded = 0;
            int rawRows = 0;
            int retried = 0;
            // Merge in holdings order so concurrent page completion does not
            // change the local audit record order or deduplication winner.
            for (Future<FundTradeRows> read : reads) {
                FundTradeRows result = read.get();
                if (!result.error.isEmpty()) {
                    failedCodes.add(result.code);
                    continue;
                }
                succeeded++;
                rawRows += result.rows.length();
                if (result.attempts > 1) retried++;
                appendTradeRows(result.rows, result.code, adjustments, seen);
            }
            String warning = failedCodes.isEmpty()
                ? ""
                : failedCodes.size() + " 只基金的详情交易记录补全失败，已保留账号完整流水";
            return new CurrentHoldingTradeResult(adjustments, warning, total, succeeded, failedCodes.size(), rawRows, retried);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("京东交易记录读取已中断", error);
        } catch (ExecutionException error) {
            Throwable cause = error.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            throw new IllegalStateException("京东交易记录读取失败", cause);
        } finally {
            tradeReaders.shutdownNow();
        }
    }

    /** Keep account pagination authoritative while letting newer detail confirmations win. */
    private JSArray mergeAccountAndDetailTrades(JSArray accountRows, JSArray detailRows) {
        JSArray merged = new JSArray();
        for (int index = 0; index < accountRows.length(); index++) {
            JSONObject row = accountRows.optJSONObject(index);
            if (row != null) merged.put(row);
        }
        for (int index = 0; index < detailRows.length(); index++) {
            JSONObject detail = detailRows.optJSONObject(index);
            if (detail == null) continue;
            int match = findMatchingTradeRow(merged, detail);
            if (match >= 0) {
                enrichTradeRow(merged.optJSONObject(match), detail);
            } else {
                merged.put(detail);
            }
        }
        return merged;
    }

    private int findMatchingTradeRow(JSArray rows, JSONObject detail) {
        Set<String> detailIds = tradeRowIdentifiers(detail);
        for (int index = 0; index < rows.length(); index++) {
            JSONObject candidate = rows.optJSONObject(index);
            if (candidate == null) continue;
            Set<String> candidateIds = tradeRowIdentifiers(candidate);
            for (String id : detailIds) {
                if (candidateIds.contains(id)) return index;
            }
        }

        int match = -1;
        for (int index = 0; index < rows.length(); index++) {
            JSONObject candidate = rows.optJSONObject(index);
            // Two different explicit JD IDs are different orders. Semantic
            // fallback is reserved for a source that genuinely lacks an ID.
            if (candidate != null && !detailIds.isEmpty() && !tradeRowIdentifiers(candidate).isEmpty()) continue;
            if (candidate == null || !sameTradeIdentity(candidate, detail)) continue;
            if (match >= 0) return -1;
            match = index;
        }
        return match;
    }

    private Set<String> tradeRowIdentifiers(JSONObject row) {
        Set<String> ids = new HashSet<>();
        if (row == null) return ids;
        for (String key : new String[] { "sourceId", "orderId", "bizOrderId", "tradeOrderId", "orderNo", "subOrderId" }) {
            String value = firstText(row, key);
            if (!value.isEmpty()) ids.add(value);
        }
        return ids;
    }

    private boolean sameTradeIdentity(JSONObject left, JSONObject right) {
        for (String key : new String[] { "code", "type", "tradeDate" }) {
            String leftValue = firstText(left, key);
            String rightValue = firstText(right, key);
            if (leftValue.isEmpty() || !leftValue.equals(rightValue)) return false;
        }
        String leftTarget = firstText(left, "targetCode");
        String rightTarget = firstText(right, "targetCode");
        if (!leftTarget.isEmpty() && !rightTarget.isEmpty() && !leftTarget.equals(rightTarget)) return false;
        String leftTime = firstText(left, "tradeTime");
        String rightTime = firstText(right, "tradeTime");
        if (!leftTime.isEmpty() && !rightTime.isEmpty()) return leftTime.equals(rightTime);
        for (String key : new String[] { "amount", "shares", "targetShares" }) {
            Double leftValue = parsedNumber(firstText(left, key));
            Double rightValue = parsedNumber(firstText(right, key));
            if (leftValue != null && rightValue != null && Math.abs(leftValue - rightValue) <= 0.005d) return true;
        }
        return false;
    }

    private void enrichTradeRow(JSONObject target, JSONObject detail) {
        if (target == null) return;
        int targetRank = tradeStatusRank(target);
        int detailRank = tradeStatusRank(detail);
        boolean detailStateWins = detailRank > targetRank;
        boolean detailConfirmedWins = detailRank == 2 && targetRank < 3;
        for (String key : new String[] { "shares", "targetShares", "amount" }) {
            String current = firstText(target, key);
            String replacement = firstText(detail, key);
            if (!replacement.isEmpty() && (current.isEmpty() || detailConfirmedWins)) {
                try {
                    target.put(key, replacement);
                } catch (Exception ignored) {
                    // One malformed optional field must not discard the timeline.
                }
            }
        }
        for (String key : new String[] { "status", "statusCode" }) {
            String current = firstText(target, key);
            String replacement = firstText(detail, key);
            if (detailStateWins && replacement.isEmpty()) {
                target.remove(key);
            } else if (!replacement.isEmpty() && (current.isEmpty() || detailStateWins)) {
                try {
                    target.put(key, replacement);
                } catch (Exception ignored) {
                    // One malformed optional field must not discard the timeline.
                }
            }
        }
        if (detailStateWins && detailRank == 3) target.remove("confirmTime");
        String confirmationTime = firstText(detail, "confirmTime");
        if (!confirmationTime.isEmpty() && (firstText(target, "confirmTime").isEmpty() || detailConfirmedWins)) {
            try {
                target.put("confirmTime", confirmationTime);
            } catch (Exception ignored) {
                // One malformed optional field must not discard the timeline.
            }
        }
    }

    /** inactive > confirmed > pending > unknown; a stale detail page can never revive a refund. */
    private int tradeStatusRank(JSONObject row) {
        String code = firstText(row, "statusCode").trim().toUpperCase(Locale.ROOT).replace('-', '_');
        if (code.matches("(?:CANCEL(?:ED|LED)?|REFUND(?:_SUCC)?|FAIL(?:ED)?|CLOSED|REJECT(?:ED)?)")) return 3;
        if (code.matches("COMPLETE(?:D)?|REDEEM_SUCC|CONFIRM_SUCC|TRANSFORM_SUCC|TRANSFER_SUCC|TRADE_SUCC")) return 2;
        if (code.matches("PAY_SUCC|REDEEM|PROCESS|PROCESSING|PENDING|WAIT_CONFIRM|CONFIRMING")) return 1;
        String status = firstText(row, "status").trim().toLowerCase(Locale.ROOT);
        if (status.contains("取消") || status.contains("撤单") || status.contains("退款") || status.contains("失败")
            || status.contains("关闭") || status.contains("作废") || status.contains("驳回")) return 3;
        if (status.contains("订单完成") || status.contains("转出完成") || status.contains("确认成功")
            || status.contains("份额确认") || status.contains("成交") || status.contains("到账")
            || status.contains("赎回成功") || status.contains("转换成功") || status.contains("交易成功")
            || status.contains("申购成功")) return 2;
        if (status.contains("支付成功") || status.contains("受理") || status.contains("确认中")
            || status.contains("处理中") || status.contains("待确认") || status.contains("申请中")
            || status.contains("已申请") || status.contains("转出中")) return 1;
        return 0;
    }

    /**
     * Read the account-wide timeline once through JD's own browser runtime.
     * This is the same page opened by "昨日收益 -> 交易记录", so a 12-fund
     * portfolio no longer requires 12 serial detail-page navigations.
     */
    private AccountTradeResult readHoldingCookieAccountTrades(String sessionCookie, JSArray holdings) throws Exception {
        try {
            return readHoldingCookieAccountTradesDirect(sessionCookie, holdings);
        } catch (LoginRequiredException error) {
            throw error;
        } catch (Exception directFailure) {
            reportProgress("reading_trades", "京东近三个月交易接口读取未完成，正在使用页面兼容读取...", 0, 0);
            try {
                return readHoldingCookieAccountTradesInWebView(sessionCookie, holdings);
            } catch (Exception browserFailure) {
                browserFailure.addSuppressed(directFailure);
                throw browserFailure;
            }
        }
    }

    /**
     * The captured Android client uses JD's newna account endpoint.  Run it in
     * the prepared JD WebView session so the browser transport supplies the
     * matching origin and session context without persisting account secrets.
     */
    private AccountTradeResult readHoldingCookieAccountTradesDirect(String sessionCookie, JSArray holdings) throws Exception {
        Set<String> currentCodes = currentHoldingCodes(holdings);
        String startDate = ACCOUNT_TRADE_HISTORY_START_DATE;
        String endDate = currentBeijingDate();
        JSONArray rawRows = new JSONArray();
        int pageCount = 0;
        int allCount = 0;
        reportProgress("reading_trades", "正在读取京东近三个月交易记录...", 0, 0);
        for (int page = 1; page <= ACCOUNT_TRADE_MAX_PAGES; page++) {
            JSONObject request = new JSONObject();
            request.put("businessCode", "FUND");
            request.put("tradeTypeCodeList", new JSONArray());
            request.put("pageNo", page);
            request.put("pageSize", String.valueOf(ACCOUNT_TRADE_PAGE_SIZE));
            request.put("pageType", "na");
            request.put("title", "基金交易");
            request.put("orderCreateStartDate", startDate + " 00:00:00");
            request.put("orderCreateEndDate", endDate + " 23:59:59");

            JSONObject payload = requestHoldingCookieBrowserPost(ACCOUNT_TRADE_DIRECT_URL, request);
            JSONObject resultData = payload.optJSONObject("resultData");
            JSONObject data = resultData == null ? null : resultData.optJSONObject("data");
            if (data == null) throw new IllegalStateException("京东近三个月交易接口返回格式异常");
            JSONArray pageRows = data.optJSONArray("tradeOrderVoList");
            if (pageRows == null) pageRows = new JSONArray();
            pageCount = page;
            allCount = Math.max(allCount, Math.max(
                payload.optInt("allCount", 0),
                Math.max(resultData.optInt("allCount", 0), data.optInt("allCount", 0))
            ));
            for (int index = 0; index < pageRows.length(); index++) rawRows.put(pageRows.opt(index));
            reportProgress(
                "reading_trades",
                "正在读取京东近三个月交易记录：第 " + page + " 页，本页 " + pageRows.length() + " 条",
                rawRows.length(),
                allCount
            );
            if (pageRows.length() < ACCOUNT_TRADE_PAGE_SIZE || (allCount > 0 && rawRows.length() >= allCount)) break;
            if (page == ACCOUNT_TRADE_MAX_PAGES) throw new IllegalStateException("京东近三个月交易记录分页超过安全上限");
        }

        JSArray adjustments = new JSArray();
        appendAccountTradeRows(rawRows, currentCodes, adjustments, new HashSet<>());
        reportProgress(
            "reading_trades",
            "京东近三个月交易记录读取完成：" + pageCount + " 页、" + rawRows.length() + " 条",
            rawRows.length(),
            allCount
        );
        return new AccountTradeResult(adjustments, pageCount, rawRows.length(), allCount);
    }

    private Set<String> currentHoldingCodes(JSArray holdings) {
        Set<String> currentCodes = new HashSet<>();
        for (int index = 0; index < holdings.length(); index++) {
            JSONObject holding = holdings.optJSONObject(index);
            String code = holding == null ? "" : holding.optString("code", "").trim();
            if (code.matches("\\d{6}")) currentCodes.add(code);
        }
        return currentCodes;
    }

    @SuppressLint("SetJavaScriptEnabled")
    private AccountTradeResult readHoldingCookieAccountTradesInWebView(String sessionCookie, JSArray holdings) throws Exception {
        Set<String> currentCodes = currentHoldingCodes(holdings);
        Activity activity = getActivity();
        if (activity == null || activity.isFinishing()) throw new IllegalStateException("无法打开京东交易记录页");
        AccountTradeCapture capture = new AccountTradeCapture();
        final WebView[] reader = new WebView[1];
        CountDownLatch started = new CountDownLatch(1);
        activity.runOnUiThread(() -> {
            try {
                reader[0] = createWebView(activity);
                seedWebSession(sessionCookie);
                reader[0].addJavascriptInterface(new AccountTradeBridge(capture), "FundAppAccountTrade");
                reader[0].setWebViewClient(new SecureJdWebViewClient() {
                    @Override
                    public void onPageFinished(WebView webView, String url) {
                        if (isJdUrl(Uri.parse(url == null ? "" : url))) {
                            webView.evaluateJavascript(accountTradeBootstrap(), null);
                        }
                    }
                });
                reader[0].loadUrl(ACCOUNT_TRADE_PAGE_URL);
            } catch (Exception error) {
                capture.fail("无法打开京东交易记录页");
            } finally {
                started.countDown();
            }
        });

        if (!started.await(10, TimeUnit.SECONDS) || reader[0] == null) {
            throw new IllegalStateException("京东交易记录页启动超时");
        }
        reportProgress("reading_trades", "正在分页读取京东完整交易记录...", 0, 0);
        try {
            boolean completed = capture.done.await(ACCOUNT_TRADE_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (!completed || capture.failed || !capture.complete) {
                String reason = capture.failureReason();
                String diagnostic = "（已读取 " + capture.pageCount() + " 页、原始 " + capture.rows().length() + " 条）";
                throw new IllegalStateException((reason.isEmpty() ? "京东交易记录读取超时" : reason) + diagnostic);
            }
            JSArray adjustments = new JSArray();
            appendAccountTradeRows(capture.rows(), currentCodes, adjustments, new HashSet<>());
            reportProgress(
                "reading_trades",
                "京东账号交易记录读取完成：" + capture.pageCount() + " 页、" + capture.rows().length() + " 条",
                capture.rows().length(),
                capture.allCount()
            );
            return new AccountTradeResult(adjustments, capture.pageCount(), capture.rows().length(), capture.allCount());
        } finally {
            activity.runOnUiThread(() -> {
                if (reader[0] != null) reader[0].removeJavascriptInterface("FundAppAccountTrade");
                destroyWebView(reader[0]);
            });
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private JSONArray readFundTradeRows(String sessionCookie, String fundCode, String extJson) throws Exception {
        return readFundTradeRows(sessionCookie, fundCode, extJson, loginWebView);
    }

    /** Each concurrent fund reader owns its WebView and JavaScript bridge. */
    @SuppressLint("SetJavaScriptEnabled")
    private JSONArray readFundTradeRowsInIsolatedWebView(String sessionCookie, String fundCode, String extJson) throws Exception {
        Activity activity = getActivity();
        if (activity == null || activity.isFinishing()) {
            throw new IllegalStateException("当前页面不可用，请返回持仓页后重试");
        }
        final WebView[] reader = new WebView[1];
        CountDownLatch created = new CountDownLatch(1);
        activity.runOnUiThread(() -> {
            try {
                reader[0] = createWebView(activity);
            } catch (Exception ignored) {
                // The caller turns a missing reader into a normal import error.
            } finally {
                created.countDown();
            }
        });
        if (!created.await(10, TimeUnit.SECONDS) || reader[0] == null) {
            throw new IllegalStateException("京东交易记录浏览器启动超时");
        }
        try {
            return readFundTradeRows(sessionCookie, fundCode, extJson, reader[0]);
        } finally {
            activity.runOnUiThread(() -> {
                if (reader[0] != null) reader[0].removeJavascriptInterface("FundAppDetailTrade");
                destroyWebView(reader[0]);
            });
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private JSONArray readFundTradeRows(String sessionCookie, String fundCode, String extJson, WebView detailWebView) throws Exception {
        DetailTradeCapture capture = new DetailTradeCapture(fundCode);
        CountDownLatch started = new CountDownLatch(1);
        Activity activity = getActivity();
        if (activity == null || activity.isFinishing()) throw new IllegalStateException("当前页面不可用，请返回持仓页后重试");

        activity.runOnUiThread(() -> {
            try {
                seedWebSession(sessionCookie);
                WebView view = detailWebView;
                if (view == null) {
                    capture.fail("京东登录页面不可用");
                    return;
                }
                view.addJavascriptInterface(new DetailTradeBridge(capture), "FundAppDetailTrade");
                view.setWebViewClient(new SecureJdWebViewClient() {
                    @Override
                    public void onPageFinished(WebView webView, String url) {
                        Uri uri = Uri.parse(url == null ? "" : url);
                        // A record transition can be a full navigation or an SPA
                        // update. Bootstrap every JD document while this fund's
                        // capture is active so neither case loses its bridge.
                        if (isJdUrl(uri)) {
                            webView.evaluateJavascript(detailTradeBootstrap(fundCode), null);
                        }
                    }
                });
                view.loadUrl(String.format(Locale.ROOT, FUND_DETAIL_PAGE_URL, URLEncoder.encode(extJson, "UTF-8")));
            } catch (Exception error) {
                capture.fail("无法打开基金持仓详情页");
            } finally {
                started.countDown();
            }
        });

        if (!started.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("基金持仓详情页启动超时");
        boolean completed = capture.done.await(DETAIL_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        activity.runOnUiThread(() -> resetDetailWebViewClient(detailWebView));
        if (!completed || capture.failed || !capture.complete) {
            String reason = capture.failureReason();
            throw new IllegalStateException("基金 " + fundCode + " 的交易记录读取不完整" + (reason.isEmpty() ? "" : "：" + reason));
        }
        return capture.rows();
    }

    /** The selectors below are bound to JD's confirmed holding-detail controls. */
    private String detailTradeBootstrap(String fundCode) {
        return "(function(){if(window.__fundAppDetailTradeHook)return;window.__fundAppDetailTradeHook=true;var c='" + fundCode + "',sent={},started=Date.now(),last=Date.now(),opened=false,hasRows=false;"
            + "function emit(x){try{window.FundAppDetailTrade&&window.FundAppDetailTrade.receive(JSON.stringify(x))}catch(e){}}"
            + "function isTradeRow(x){return !!(x&&typeof x==='object'&&(x.bizTime||x.tradeTime||x.confirmTime||x.orderCreateTime||x.tradeDate)&&(x.tradeTypeCode||x.tradeTypeName||x.tradeName||x.operationName||x.businessName||x.businessType||x.orderType)&&(x.unit||x.confirmUnit||x.tradeUnit||x.confirmShare||x.tradeShare||x.fundShare||x.applyShare||x.share||x.shares||x.allAmount||x.confirmAmount||x.tradeAmount||x.applyAmount||x.amount||x.money))}"
            + "function rows(v,out){if(Array.isArray(v)){var matched=v.filter(isTradeRow);if(matched.length){out.push.apply(out,matched);return}v.forEach(function(x){rows(x,out)});return}if(v&&typeof v==='object')Object.keys(v).forEach(function(k){rows(v[k],out)})}"
            // JD has changed the decoded transaction endpoint name repeatedly.
            // Do not guess from the URL. Only actual order-shaped rows cross the
            // bridge; this avoids sending unrelated page JSON to the grid API.
            + "function takeValue(v){try{var a=[];rows(v,a);if(!a.length)return;var k=JSON.stringify(a);if(sent[k])return;sent[k]=1;hasRows=true;last=Date.now();emit({code:c,rows:a})}catch(e){}}"
            + "function take(u,t){try{takeValue(JSON.parse(t))}catch(e){}}"
            + "var open=XMLHttpRequest.prototype.open,send=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.open=function(){this.__fundAppUrl=String(arguments[1]||'');return open.apply(this,arguments)};XMLHttpRequest.prototype.send=function(){this.addEventListener('load',function(){take(this.__fundAppUrl||'',this.responseText||'')});return send.apply(this,arguments)};"
            + "if(window.fetch){var fetch0=window.fetch;window.fetch=function(){var u=String(arguments[0]||'');return fetch0.apply(this,arguments).then(function(r){r.clone().text().then(function(t){take(u,t)});return r})}}"
            + "function click(e){if(!e)return false;['pointerdown','mousedown','mouseup','click'].forEach(function(t){e.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}))});return true}"
            + "function textButton(text){return [].slice.call(document.querySelectorAll('a,button,[role=button],div,span,p')).find(function(e){return (e.innerText||e.textContent||'').trim()===text})}"
            + "function captureExisting(){var keys=['allDataList','dataList','tradeOrderVoList','tradeList','transactionList','orderList'],all=document.querySelectorAll('*'),seenVm=[];for(var i=0;i<all.length;i++){for(var vm=all[i].__vue__,depth=0;vm&&depth<8;vm=vm.$parent,depth++){if(seenVm.indexOf(vm)>=0)continue;seenVm.push(vm);for(var j=0;j<keys.length;j++){var value=vm[keys[j]];if(Array.isArray(value))takeValue(value)}}}}"
            + "var timer=setInterval(function(){captureExisting();var path=location.pathname||'',body=(document.body&&document.body.innerText)||'',more=textButton('加载更多'),tradePage=/交易类型|没有更多记录|暂无交易记录/.test(body)||!!more;if(tradePage){if(more){click(more);last=Date.now();return}if(/没有更多|已全部加载|暂无交易记录/.test(body)||(hasRows&&Date.now()-last>1800)){clearInterval(timer);emit({code:c,ready:true,done:true});return}}if(path.indexOf('/fund/hold/detail')>=0){var card=document.querySelector('.template-container[data-jue-name=\"fundTemplate1001Amount.jue\"]');if(!card)return;if(!window.__fundAppExpanded){var expand=card.querySelector('.arrow-container-down');if(expand){click(expand);window.__fundAppExpanded=true;return}}var minor=card.querySelector('.minor');if(!minor||!/持有份额|持仓成本价/.test(minor.innerText||''))return;if(!opened){var record=textButton('交易记录');if(record){opened=true;click(record);return}}if(Date.now()-started>26000){clearInterval(timer);emit({code:c,ready:false,reason:'Transaction record control was unavailable'});return}}if(Date.now()-started>26000){clearInterval(timer);emit({code:c,ready:false,reason:'Transaction page did not return structured records'});}},300)})();";
    }

    /** Capture rows only after JD's own page has decoded the account timeline. */
    private String accountTradeBootstrap() {
        return "(function(){if(window.__fundAppAccountTradeHook)return;window.__fundAppAccountTradeHook=true;var sent={},pages={},started=Date.now(),lastPageAt=started,pageCount=0,totalRows=0,allCount=0,hasRows=false,terminal=false,requestedFirst=false,lastVmPage=-1,lastVmRows=-1,parse0=JSON.parse;"
            + "function emit(x){try{window.FundAppAccountTrade&&window.FundAppAccountTrade.receive(JSON.stringify(x))}catch(e){}}"
            + "function progress(page,rows,totalRows,allCount){emit({progress:true,page:page,rows:rows,totalRows:totalRows,allCount:allCount})}"
            + "function isTradeRow(x){return !!(x&&typeof x==='object'&&(x.bizTime||x.tradeTime||x.confirmTime||x.orderCreateTime||x.tradeDate)&&(x.tradeTypeCode||x.tradeTypeName||x.tradeName||x.operationName||x.businessName||x.businessType||x.orderType)&&(x.productId||x.fundCode||x.sellProductId||x.sourceFundCode||x.fromFundCode)&&(x.unit||x.confirmUnit||x.tradeUnit||x.confirmShare||x.tradeShare||x.fundShare||x.applyShare||x.share||x.shares||x.allAmount||x.confirmAmount||x.tradeAmount||x.applyAmount||x.amount||x.money))}"
            + "function rows(v,out){if(Array.isArray(v)){var matched=v.filter(isTradeRow);if(matched.length){out.push.apply(out,matched);return}v.forEach(function(x){rows(x,out)});return}if(v&&typeof v==='object')Object.keys(v).forEach(function(k){rows(v[k],out)})}"
            + "function day(x){var t=x&&(x.bizTime||x.tradeTime||x.orderCreateTime||x.orderCreateDate||x.createTime||x.confirmTime||x.tradeDate);if(typeof t==='number'||/^\\d{10,13}$/.test(String(t||''))){var n=Number(t);if(String(Math.trunc(n)).length===10)n*=1000;var d=new Date(n+28800000);return isNaN(d.getTime())?'':d.toISOString().slice(0,10)}var m=/(\\d{4})[-/.]?(\\d{1,2})[-/.]?(\\d{1,2})/.exec(String(t||''));return m?m[1]+'-'+('0'+m[2]).slice(-2)+'-'+('0'+m[3]).slice(-2):''}"
            + "function payload(v,depth){if(!v||typeof v!=='object'||depth>8)return null;if(v.data&&Array.isArray(v.data.tradeOrderVoList))return {list:v.data.tradeOrderVoList,page:Number(v.data.pageNo||0),all:Number(v.allCount||v.data.allCount||0)};var keys=Object.keys(v);for(var i=0;i<keys.length;i++){var found=payload(v[keys[i]],depth+1);if(found)return found}return null}"
            + "function emitRows(a){if(!a||!a.length)return;var k=JSON.stringify(a);if(sent[k])return;sent[k]=1;hasRows=true;a=a.filter(function(x){return !!day(x)});if(a.length)emit({rows:a})}"
            + "function take(v){try{var p=payload(v,0),a=[];if(p){a=p.list||[];var page=p.page||pageCount+1;if(pages[page])return;pages[page]=1;pageCount=Math.max(pageCount,page);lastPageAt=Date.now();var pageRows=a.length;totalRows+=pageRows;allCount=p.all||allCount;if(allCount?totalRows>=allCount:pageRows<20)terminal=true;progress(page,pageRows,totalRows,allCount)}else rows(v,a);emitRows(a)}catch(e){}}"
            + "JSON.parse=function(){var v=parse0.apply(this,arguments);take(v);return v};"
            + "var open=XMLHttpRequest.prototype.open,send=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.open=function(){this.__fundAppUrl=String(arguments[1]||'');return open.apply(this,arguments)};XMLHttpRequest.prototype.send=function(){this.addEventListener('load',function(){try{take(parse0(this.responseText||''))}catch(e){}});return send.apply(this,arguments)};"
            + "if(window.fetch){var fetch0=window.fetch;window.fetch=function(){return fetch0.apply(this,arguments).then(function(r){r.clone().text().then(function(t){try{take(parse0(t))}catch(e){}});return r})}}"
            + "function click(e){if(!e)return false;['pointerdown','mousedown','mouseup','click'].forEach(function(t){e.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}))});return true}"
            + "function textButton(text){return [].slice.call(document.querySelectorAll('a,button,[role=button],div,span,p')).find(function(e){return (e.innerText||e.textContent||'').trim()===text})}"
            + "function findVm(){var all=document.querySelectorAll('*');for(var i=0;i<all.length;i++){var vm=all[i].__vue__;for(var depth=0;vm&&depth<8;depth++,vm=vm.$parent){if(typeof vm.getTradeOrderData==='function')return vm}}return null}"
            + "function takeExisting(vm){var list=Array.isArray(vm.allDataList)?vm.allDataList:[],page=Math.max(0,Number(vm.pageNo||0)),count=list.length,total=Math.max(0,Number(vm.allCount||0));if(total>allCount)allCount=total;if(page>pageCount)pageCount=page;if(count>totalRows)totalRows=count;for(var n=1;n<=page;n++)pages[n]=1;if(page!==lastVmPage||count!==lastVmRows){var fresh=count>lastVmRows&&lastVmRows>=0?list.slice(lastVmRows):list;lastVmPage=page;lastVmRows=count;lastPageAt=Date.now();emitRows(fresh);if(page>0||count>0)progress(Math.max(1,page),count,totalRows,allCount)}}"
            + "function pump(){var vm=findVm();if(vm){takeExisting(vm);if(vm.isEnd){terminal=true;return}if(!vm.netWorkLoading){if(hasRows){try{vm.getTradeOrderData()}catch(e){}}else if(!requestedFirst){requestedFirst=true;try{vm.getTradeOrderData()}catch(e){}}}}var all=document.querySelectorAll('*');for(var i=0;i<all.length;i++){var el=all[i];if(el.scrollHeight>el.clientHeight+4){el.scrollTop=el.scrollHeight;try{el.dispatchEvent(new Event('scroll',{bubbles:true}))}catch(e){}}}try{window.scrollTo(0,Math.max(document.body.scrollHeight,document.documentElement.scrollHeight))}catch(e){}}"
            + "var timer=setInterval(function(){var now=Date.now(),body=(document.body&&document.body.innerText)||'',more=textButton('加载更多');if(terminal||(hasRows&&/没有更多|已全部加载/.test(body))){clearInterval(timer);emit({done:true});return}if(/暂无交易记录/.test(body)&&!hasRows){clearInterval(timer);emit({done:true});return}if(!pageCount&&now-started>" + ACCOUNT_TRADE_FIRST_PAGE_TIMEOUT_MILLIS + "){clearInterval(timer);emit({ready:false,reason:'京东交易记录首批分页数据读取超时'});return}if(pageCount&&!terminal&&now-lastPageAt>" + ACCOUNT_TRADE_STALL_TIMEOUT_MILLIS + "){clearInterval(timer);emit({ready:false,reason:'京东交易记录分页停滞：第 '+pageCount+' 页后未返回新数据'});return}if(more)click(more);pump();if(now-started>115000){clearInterval(timer);emit({ready:false,reason:'京东完整交易记录分页读取超时'});return}},500)})();";
    }

    private void appendAccountTradeRows(JSONArray rows, Set<String> currentCodes, JSArray target, Set<String> seen) {
        for (int index = 0; index < rows.length(); index++) {
            JSONObject row = rows.optJSONObject(index);
            if (row == null) continue;
            String type = resolveTradeType(row);
            if (type == null) continue;
            boolean capturedTransform = "TRANSFORM".equalsIgnoreCase(firstText(row, "tradeTypeCode"));
            String code = capturedTransform
                ? normalizeFundCode(firstText(row, "productId", "sourceProductId", "fromProductId"))
                : resolveAccountTradeFundCode(row, currentCodes);
            if (!code.matches("\\d{6}")) code = resolveAccountTradeFundCode(row, currentCodes);
            String targetCode = capturedTransform
                ? normalizeFundCode(firstText(row, "sellProductId", "targetProductId", "targetFundCode", "toFundCode"))
                : normalizeFundCode(firstText(row, "sellProductId", "targetProductId", "targetFundCode", "toFundCode"));
            String rawTime = firstText(row, "bizTime", "tradeTime", "orderCreateTime", "orderCreateDate", "createTime", "tradeDate");
            String tradeDate = normalizeTradeDate(rawTime);
            if (!currentCodes.contains(code)
                && !("convert".equals(type) && currentCodes.contains(targetCode))) continue;
            try {
                row.put("fundCode", code);
                appendTradeRows(new JSONArray().put(row), code, target, seen);
            } catch (Exception ignored) {
                // Ignore one malformed JD row while retaining the rest of the account timeline.
            }
        }
    }

    private String resolveAccountTradeFundCode(JSONObject row, Set<String> currentCodes) {
        String fallback = "";
        for (String key : new String[] { "fundCode", "productId", "productCode", "fundId", "sellProductId", "sourceFundCode", "fromFundCode", "sourceProductId", "fromProductId" }) {
            String value = firstText(row, key);
            String normalized = normalizeFundCode(value);
            if (currentCodes.contains(normalized)) return normalized;
            if (fallback.isEmpty() && normalized.matches("\\d{6}")) fallback = normalized;
            String digits = textValue(value).replaceAll("\\D", "");
            for (int index = 0; index <= digits.length() - 6; index++) {
                String candidate = digits.substring(index, index + 6);
                if (currentCodes.contains(candidate)) return candidate;
            }
        }
        return fallback;
    }

    private void appendTradeRows(JSONArray rows, String fundCode, JSArray target, Set<String> seen) {
        for (int index = 0; index < rows.length(); index++) {
            JSONObject row = rows.optJSONObject(index);
            // Preserve cancelled/refunded/failed rows in the audit stream. The
            // TypeScript and backend position builders explicitly exclude them,
            // while pending-refresh queues need their terminal ID to stop retrying.
            if (row == null) continue;
            String type = resolveTradeType(row);
            if (type == null) continue;
            boolean capturedTransform = "convert".equals(type) && !firstText(row, "productId").isEmpty();
            String code = normalizeFundCode(capturedTransform
                ? firstText(row, "productId", "sourceProductId", "fromProductId")
                : firstText(row, "fundCode", "productId", "sourceFundCode", "fromFundCode"));
            if (!code.matches("\\d{6}")) code = fundCode;
            // Use the order/business time first. The grid resolves its
            // confirmation NAV from this timestamp and the fund cut-off rule.
            String rawTime = firstText(row, "bizTime", "tradeTime", "orderCreateTime", "orderCreateDate", "createTime", "tradeDate");
            String date = normalizeTradeDate(rawTime);
            if (date == null) continue;
            if (!isValidCapturedTradeDate(date)) continue;
            String shares = firstText(row, "confirmUnit", "tradeUnit", "confirmShare", "tradeShare", "fundShare", "applyShare", "share", "shares");
            String amount = firstText(row, "confirmAmount", "tradeAmount", "applyAmount", "amount", "money");
            String allAmount = firstText(row, "allAmount");
            String unit = firstText(row, "unit");
            if (shares.isEmpty() && "份".equals(unit)) shares = allAmount;
            if (amount.isEmpty() && !"份".equals(unit)) amount = allAmount;
            String tradeTime = normalizeTradeTimestamp(rawTime);
            String id = firstText(row, "orderId", "bizOrderId", "tradeOrderId", "orderNo", "subOrderId", "id");
            if (id.isEmpty()) id = code + ":" + type + ":" + (tradeTime == null ? date : tradeTime) + ":" + shares + ":" + amount;
            if (!seen.add(id)) continue;
            JSObject item = new JSObject();
            item.put("id", id);
            String sourceId = firstText(row, "id");
            if (!sourceId.isEmpty()) item.put("sourceId", sourceId);
            for (String key : new String[] { "orderId", "bizOrderId", "tradeOrderId", "orderNo", "subOrderId" }) {
                String identifier = firstText(row, key);
                if (!identifier.isEmpty()) item.put(key, identifier);
            }
            item.put("code", code);
            item.put("name", capturedTransform
                ? firstText(row, "productName", "sourceFundName", "fromFundName")
                : firstText(row, "productName", "fundName", "sourceFundName", "fromFundName"));
            item.put("type", type);
            item.put("tradeDate", date);
            if (tradeTime != null) item.put("tradeTime", tradeTime);
            item.put("shares", shares);
            item.put("amount", amount);
            String statusName = firstText(row, "orderStatusDesc", "orderStatusName", "statusName", "tradeStatus", "status", "orderStatus");
            String statusCode = firstText(row, "statusCode", "orderStatusCode", "tradeStatusCode");
            item.put("status", statusName);
            if (!statusName.isEmpty()) item.put("statusName", statusName);
            if (!statusCode.isEmpty()) item.put("statusCode", statusCode);
            String confirmationTime = firstText(row, "confirmationTime", "confirmTime", "confirmDate", "redeemTime", "expectedArrivalTime");
            if (!confirmationTime.isEmpty()) item.put("confirmTime", confirmationTime);
            String rawConfirmationTime = firstText(row, "confirmationTime");
            String redeemTime = firstText(row, "redeemTime");
            if (!rawConfirmationTime.isEmpty()) item.put("confirmationTime", rawConfirmationTime);
            if (!redeemTime.isEmpty()) item.put("redeemTime", redeemTime);
            if ("convert".equals(type)) {
                item.put("targetCode", normalizeFundCode(capturedTransform
                    ? firstText(row, "sellProductId", "targetProductId", "targetFundCode", "toFundCode")
                    : firstText(row, "sellProductId", "targetProductId", "targetFundCode", "toFundCode")));
                item.put("targetName", capturedTransform
                    ? firstText(row, "sellProductName", "targetProductName", "targetFundName", "toFundName")
                    : firstText(row, "sellProductName", "targetProductName", "targetFundName", "toFundName"));
                String targetShares = firstText(row, "targetUnit", "targetShare", "targetShares", "targetFundShare", "toFundShare", "convertShare");
                if (targetShares.isEmpty() && "份".equals(unit)) targetShares = allAmount;
                item.put("targetShares", targetShares);
            }
            target.put(item);
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private WebView createWebView(Activity activity) {
        WebView view = new WebView(activity);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        requestUserAgent = settings.getUserAgentString() + " FundApp";
        settings.setUserAgentString(requestUserAgent);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }
        return view;
    }

    /**
     * Cookie headers copied from JD's browser can be valid while a raw Java
     * POST is rejected for lacking the browser origin/session context.  Keep a
     * temporary WebView only for this import and let JD receive the request
     * through its own browser transport.  The WebView is destroyed with the
     * import and no Cookie value reaches our backend.
     */
    private void prepareHoldingCookieBrowser(String sessionCookie) throws Exception {
        Activity activity = getActivity();
        if (activity == null || activity.isFinishing()) throw new IllegalStateException("无法启动京东持仓读取");
        CountDownLatch sessionReady = new CountDownLatch(1);
        CountDownLatch ready = new CountDownLatch(1);
        String[] startupError = new String[1];
        activity.runOnUiThread(() -> {
            try {
                WebView reader = loginWebView == null ? createWebView(activity) : loginWebView;
                reader.removeJavascriptInterface("FundAppHoldingCookie");
                reader.addJavascriptInterface(new HoldingCookieBrowserBridge(), "FundAppHoldingCookie");
                reader.setWebViewClient(new SecureJdWebViewClient() {
                    @Override
                    public void onPageFinished(WebView view, String url) {
                        super.onPageFinished(view, url);
                        if (isJdUrl(Uri.parse(url))) ready.countDown();
                    }
                });
                loginWebView = reader;
                // CookieManager writes are asynchronous.  Clear once, wait for
                // every Cookie write, flush, and only then load the JD page.
                replaceWebSession(sessionCookie, () -> {
                    try {
                        if (reader == loginWebView) reader.loadUrl(HOLDING_PAGE_URL);
                        else startupError[0] = "京东持仓浏览器会话已关闭";
                    } catch (Exception error) {
                        startupError[0] = error.getMessage();
                    } finally {
                        sessionReady.countDown();
                    }
                });
            } catch (Exception error) {
                startupError[0] = error.getMessage();
                sessionReady.countDown();
            }
        });
        if (!sessionReady.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("京东 Cookie 初始化超时");
        if (startupError[0] != null) throw new IllegalStateException("无法启动京东持仓读取：" + startupError[0]);
        if (loginWebView == null || !ready.await(15, TimeUnit.SECONDS)) {
            throw new IllegalStateException("京东持仓页面启动超时");
        }
    }

    private JSONObject requestHoldingCookieBrowserPost(String endpoint, JSONObject request) throws Exception {
        WebView reader = loginWebView;
        Activity activity = getActivity();
        if (reader == null || activity == null || activity.isFinishing()) {
            throw new IllegalStateException("京东持仓浏览器会话不可用");
        }
        String requestId = "holding-" + System.nanoTime();
        BrowserCookieRequest capture = new BrowserCookieRequest();
        cookieBrowserRequests.put(requestId, capture);
        JSONObject options = new JSONObject();
        options.put("id", requestId);
        options.put("url", endpoint);
        options.put("body", "reqData=" + URLEncoder.encode(request.toString(), "UTF-8"));
        String script = "(function(){var o=JSON.parse(" + JSONObject.quote(options.toString()) + ");"
            + "var c=new AbortController(),timer=setTimeout(function(){c.abort()},18000);"
            + "fetch(o.url,{method:'POST',credentials:'include',signal:c.signal,headers:{'Accept':'application/json, text/plain, */*','Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','Accept-Language':'zh-CN,zh;q=0.9'},body:o.body})"
            + ".then(function(r){return r.text().then(function(t){clearTimeout(timer);window.FundAppHoldingCookie.receive(JSON.stringify({id:o.id,status:r.status,body:t,url:r.url,redirected:!!r.redirected,contentType:(r.headers.get('content-type')||'')}))})})"
            + ".catch(function(e){clearTimeout(timer);var m=(e&&e.name)==='AbortError'?'京东持仓接口响应超时':String((e&&e.message)||e);window.FundAppHoldingCookie.receive(JSON.stringify({id:o.id,error:m}))});})();";
        activity.runOnUiThread(() -> {
            if (reader == loginWebView) reader.evaluateJavascript(script, null);
            else capture.fail("京东持仓浏览器会话已关闭");
        });
        try {
            if (!capture.done.await(20, TimeUnit.SECONDS)) throw new IllegalStateException("京东持仓接口响应超时");
        } finally {
            cookieBrowserRequests.remove(requestId);
        }
        if (!capture.error.isEmpty()) throw new IllegalStateException("京东持仓接口读取失败：" + capture.error);
        if (isLoginRedirectUrl(capture.url)) throw new LoginRequiredException();
        validateJdHttpStatus(capture.status, capture.url, "京东持仓接口");
        if (capture.body.isEmpty()) throw new IllegalStateException("京东未返回有效持仓数据");
        JSONObject payload;
        try {
            payload = new JSONObject(capture.body);
        } catch (Exception error) {
            if (containsExplicitLoginResponse(capture.body, capture.contentType)) throw new LoginRequiredException();
            throw new IllegalStateException("京东持仓接口返回格式异常");
        }
        String message = payload.optString("resultMsg", payload.optString("message", ""));
        if (payload.optInt("resultCode") == 3
            || (!payload.optBoolean("success", true) && containsExplicitLoginMessage(message))) {
            throw new LoginRequiredException();
        }
        if (!payload.optBoolean("success", true)) throw jdServiceFailure("京东持仓接口读取未完成", message);
        return payload;
    }

    private JSONObject requestJdPost(String endpoint, JSONObject request, String sessionCookie) throws Exception {
        return requestJdPost(endpoint, request, sessionCookie, "https://roma.jd.com/");
    }

    private JSONObject requestJdPost(String endpoint, JSONObject request, String sessionCookie, String referer) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(endpoint).openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(15_000);
            connection.setRequestProperty("Accept", "application/json, text/plain, */*");
            connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
            connection.setRequestProperty("Cookie", sessionCookie);
            connection.setRequestProperty("Referer", referer);
            connection.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9");
            connection.setRequestProperty("User-Agent", requestUserAgent);
            byte[] body = ("reqData=" + URLEncoder.encode(request.toString(), "UTF-8")).getBytes(StandardCharsets.UTF_8);
            try (OutputStream output = connection.getOutputStream()) { output.write(body); }
            int status = connection.getResponseCode();
            String response = readBody(status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream());
            String redirectUrl = connection.getHeaderField("Location");
            validateJdHttpStatus(status, redirectUrl, "京东接口");
            if (response.isEmpty()) throw new IllegalStateException("京东未返回有效数据");
            JSONObject payload;
            try {
                payload = new JSONObject(response);
            } catch (Exception error) {
                if (containsExplicitLoginResponse(response, connection.getContentType())) throw new LoginRequiredException();
                throw new IllegalStateException("京东接口返回格式异常");
            }
            String message = payload.optString("resultMsg", payload.optString("message", ""));
            if (payload.optInt("resultCode") == 3
                || (!payload.optBoolean("success", true) && containsExplicitLoginMessage(message))) {
                throw new LoginRequiredException();
            }
            if (!payload.optBoolean("success", true)) throw jdServiceFailure("京东接口读取未完成", message);
            return payload;
        } finally {
            connection.disconnect();
        }
    }

    private String resolveDetailExtJson(JSONObject parameter) throws Exception {
        if (parameter == null) return "";
        Object raw = parameter.opt("extJson");
        if (raw instanceof JSONObject) return raw.toString();
        String extJson = textValue(raw);
        if (extJson.startsWith("{") && extJson.endsWith("}")) return extJson;
        JSONObject built = new JSONObject();
        for (String key : new String[] { "productId", "distinctCode", "orderId", "distinctCodes", "flowFlag", "type", "fromJumpType", "buSku", "buSkus" }) {
            if (parameter.has(key)) built.put(key, parameter.opt(key));
        }
        return built.length() > 0 ? built.toString() : "";
    }

    private String findLabeledValue(JSONArray values, String label) {
        if (values == null) return "";
        for (int index = 0; index < values.length(); index++) {
            JSONObject value = values.optJSONObject(index);
            if (value != null && label.equals(value.optString("title1"))) return textValue(value.opt("title2"));
        }
        return "";
    }

    /**
     * JD does not expose this field consistently.  Accept only explicit
     * acquisition-date keys or labels; never derive a date from a valuation,
     * fund-establishment date, or the import timestamp.
     */
    private String findHoldingStartDate(JSONObject... sources) {
        for (JSONObject source : sources) {
            String date = findHoldingStartDateInValue(source, 0);
            if (date != null) return date;
        }
        return null;
    }

    /** Walk JD's nested template payload, but only trust unambiguous acquisition fields. */
    private String findHoldingStartDateInValue(Object value, int depth) {
        if (value == null || JSONObject.NULL.equals(value) || depth > 10) return null;
        if (value instanceof JSONArray) {
            JSONArray values = (JSONArray) value;
            for (int index = 0; index < values.length(); index++) {
                String date = findHoldingStartDateInValue(values.opt(index), depth + 1);
                if (date != null) return date;
            }
            return null;
        }
        if (!(value instanceof JSONObject)) return null;
        JSONObject object = (JSONObject) value;
        String label = object.optString("title1", "").trim();
        for (String candidate : new String[] {
            "首次买入日期", "首次购买日期", "首次申购日期", "首购日期",
            "建仓日期", "持有起始日期", "持有开始日期"
        }) {
            if (candidate.equals(label)) {
                String date = normalizeHoldingStartDate(object.opt("title2"));
                if (date != null) return date;
            }
        }
        for (String key : new String[] {
            "acquiredDate", "acquiredTime", "holdingStartDate", "holdingStartTime",
            "holdStartDate", "holdStartTime", "firstBuyDate", "firstBuyTime",
            "firstPurchaseDate", "firstPurchaseTime", "firstSubscribeDate", "firstApplyDate"
        }) {
            String date = normalizeHoldingStartDate(object.opt(key));
            if (date != null) return date;
        }
        java.util.Iterator<String> keys = object.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            String date = findHoldingStartDateInValue(object.opt(key), depth + 1);
            if (date != null) return date;
        }
        return null;
    }

    private String normalizeHoldingStartDate(Object value) {
        String text = textValue(value).replace('T', ' ');
        Long epochMillis = parseTradeEpochMillis(text);
        if (epochMillis != null) {
            Calendar calendar = Calendar.getInstance(TimeZone.getTimeZone("Asia/Shanghai"));
            calendar.setTimeInMillis(epochMillis);
            String date = String.format(Locale.ROOT, "%04d-%02d-%02d",
                calendar.get(Calendar.YEAR), calendar.get(Calendar.MONTH) + 1, calendar.get(Calendar.DAY_OF_MONTH));
            return date.compareTo(currentBeijingDate()) <= 0 ? date : null;
        }
        java.util.regex.Matcher full = java.util.regex.Pattern.compile("^(\\d{4})[-/.](\\d{1,2})[-/.](\\d{1,2})(?:\\s|$).*").matcher(text);
        if (!full.matches()) {
            full = java.util.regex.Pattern.compile("^(\\d{4})(\\d{2})(\\d{2})(?:\\s|$).*").matcher(text);
        }
        if (!full.matches()) return null;
        String date = formatTradeDate(
            Integer.parseInt(full.group(1)), Integer.parseInt(full.group(2)), Integer.parseInt(full.group(3))
        );
        return date != null && date.compareTo(currentBeijingDate()) <= 0 ? date : null;
    }

    private String normalizeFundCode(String value) {
        String candidate = textValue(value).trim();
        if (candidate.matches("\\d{6}")) return candidate;
        String digits = candidate.replaceAll("\\D", "");
        return digits.matches("1\\d{6}") ? digits.substring(1) : "";
    }

    private String resolveTradeType(JSONObject row) {
        String typeCode = firstText(row, "tradeTypeCode").toUpperCase(Locale.ROOT);
        if ("TRANSFER_IN".equals(typeCode)) return "add";
        if ("TRANSFER_OUT".equals(typeCode)) return "reduce";
        if ("TRANSFORM".equals(typeCode)) return "convert";
        String descriptor = (firstText(row, "tradeTypeCode") + " " + firstText(row, "tradeTypeName", "tradeName", "operationName", "businessName", "businessType", "orderType")).toLowerCase(Locale.ROOT);
        if (descriptor.contains("transform") || descriptor.contains("convert") || descriptor.contains("adjust_position") || descriptor.contains("转换") || descriptor.contains("调仓")) return "convert";
        if (descriptor.contains("sell") || descriptor.contains("redeem") || descriptor.contains("redemption") || descriptor.contains("赎回") || descriptor.contains("卖出") || descriptor.contains("转出")) return "reduce";
        if (descriptor.contains("buy") || descriptor.contains("purchase") || descriptor.contains("subscribe") || descriptor.contains("定投") || descriptor.contains("申购") || descriptor.contains("买入") || descriptor.contains("转入")) return "add";
        return null;
    }

    private boolean isEffectiveTrade(JSONObject row) {
        String statusCode = firstText(row, "statusCode", "orderStatusCode", "tradeStatusCode").toUpperCase(Locale.ROOT);
        if (statusCode.startsWith("CANCEL") || statusCode.startsWith("FAIL") || statusCode.startsWith("REFUND") || statusCode.startsWith("CLOSE")) return false;
        String status = firstText(row, "orderStatusDesc", "orderStatusName", "statusName", "tradeStatus", "status", "orderStatus").toLowerCase(Locale.ROOT);
        return !(status.contains("cancel") || status.contains("fail") || status.contains("refund") || status.contains("关闭") || status.contains("取消") || status.contains("失败") || status.contains("退款"));
    }

    private String normalizeTradeDate(String value) {
        String text = textValue(value).replace('T', ' ');
        Long epochMillis = parseTradeEpochMillis(text);
        if (epochMillis != null) {
            Calendar calendar = Calendar.getInstance(TimeZone.getTimeZone("Asia/Shanghai"));
            calendar.setTimeInMillis(epochMillis);
            return String.format(Locale.ROOT, "%04d-%02d-%02d", calendar.get(Calendar.YEAR), calendar.get(Calendar.MONTH) + 1, calendar.get(Calendar.DAY_OF_MONTH));
        }
        java.util.regex.Matcher full = java.util.regex.Pattern.compile("^(\\d{4})[-/.](\\d{1,2})[-/.](\\d{1,2}).*").matcher(text);
        if (full.matches()) return formatTradeDate(Integer.parseInt(full.group(1)), Integer.parseInt(full.group(2)), Integer.parseInt(full.group(3)));
        java.util.regex.Matcher compact = java.util.regex.Pattern.compile("^(\\d{4})(\\d{2})(\\d{2}).*").matcher(text);
        if (compact.matches()) return formatTradeDate(Integer.parseInt(compact.group(1)), Integer.parseInt(compact.group(2)), Integer.parseInt(compact.group(3)));
        java.util.regex.Matcher monthDay = java.util.regex.Pattern.compile("^(\\d{1,2})[-/.](\\d{1,2})(?:\\s|$).*").matcher(text);
        if (monthDay.matches()) {
            Calendar now = Calendar.getInstance(TimeZone.getTimeZone("Asia/Shanghai"));
            int year = now.get(Calendar.YEAR);
            int month = Integer.parseInt(monthDay.group(1));
            int day = Integer.parseInt(monthDay.group(2));
            String normalized = formatTradeDate(year, month, day);
            if (normalized == null) return null;
            Calendar tradeDay = Calendar.getInstance(TimeZone.getTimeZone("Asia/Shanghai"));
            tradeDay.setLenient(false);
            tradeDay.clear();
            tradeDay.set(year, month - 1, day, 0, 0, 0);
            if (tradeDay.getTimeInMillis() > now.getTimeInMillis() + TimeUnit.DAYS.toMillis(1)) normalized = formatTradeDate(year - 1, month, day);
            return normalized;
        }
        return null;
    }

    private boolean isTodayTradeDate(String value) {
        if (value == null) return false;
        Calendar today = Calendar.getInstance(TimeZone.getTimeZone("Asia/Shanghai"));
        String todayText = String.format(Locale.ROOT, "%04d-%02d-%02d",
            today.get(Calendar.YEAR), today.get(Calendar.MONTH) + 1, today.get(Calendar.DAY_OF_MONTH));
        return todayText.equals(value);
    }

    private String formatTradeDate(int year, int month, int day) {
        Calendar calendar = Calendar.getInstance(TimeZone.getTimeZone("Asia/Shanghai"));
        calendar.setLenient(false);
        calendar.clear();
        try {
            calendar.set(year, month - 1, day, 0, 0, 0);
            calendar.getTimeInMillis();
            return String.format(Locale.ROOT, "%04d-%02d-%02d", year, month, day);
        } catch (IllegalArgumentException ignored) {
            return null;
        }
    }

    private String normalizeTradeTimestamp(String value) {
        String text = textValue(value).replace('T', ' ');
        Long epochMillis = parseTradeEpochMillis(text);
        if (epochMillis != null) {
            Calendar calendar = Calendar.getInstance(TimeZone.getTimeZone("Asia/Shanghai"));
            calendar.setTimeInMillis(epochMillis);
            return String.format(Locale.ROOT, "%04d-%02d-%02d %02d:%02d:%02d",
                calendar.get(Calendar.YEAR), calendar.get(Calendar.MONTH) + 1, calendar.get(Calendar.DAY_OF_MONTH),
                calendar.get(Calendar.HOUR_OF_DAY), calendar.get(Calendar.MINUTE), calendar.get(Calendar.SECOND));
        }
        String date = normalizeTradeDate(text);
        if (date == null) return null;
        java.util.regex.Matcher matcher = java.util.regex.Pattern.compile(".*?(\\d{2}:\\d{2})(?::(\\d{2}))?.*").matcher(text);
        return matcher.matches() ? date + " " + matcher.group(1) + (matcher.group(2) == null ? "" : ":" + matcher.group(2)) : null;
    }

    private Long parseTradeEpochMillis(String value) {
        String text = textValue(value);
        if (!text.matches("\\d{10}|\\d{13}")) return null;
        try {
            long timestamp = Long.parseLong(text);
            if (text.length() == 10) timestamp *= 1000L;
            Calendar calendar = Calendar.getInstance(TimeZone.getTimeZone("Asia/Shanghai"));
            calendar.setTimeInMillis(timestamp);
            int year = calendar.get(Calendar.YEAR);
            return year >= 2000 && year <= 2100 ? timestamp : null;
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    private String currentBeijingDate() {
        Calendar today = Calendar.getInstance(TimeZone.getTimeZone("Asia/Shanghai"));
        return String.format(Locale.ROOT, "%04d-%02d-%02d",
            today.get(Calendar.YEAR), today.get(Calendar.MONTH) + 1, today.get(Calendar.DAY_OF_MONTH));
    }

    /** Reject malformed or future rows while retaining the historical first-buy record. */
    private boolean isValidCapturedTradeDate(String date) {
        return date != null && date.matches("\\d{4}-\\d{2}-\\d{2}") && date.compareTo(currentBeijingDate()) <= 0;
    }

    private boolean hasCurrentPosition(String amount, String shares) {
        return positiveNumber(amount) || positiveNumber(shares);
    }

    /** Only a decoded JD detail with no positive value is eligible to close a local holding. */
    private boolean hasExplicitZeroPosition(String amount, String shares) {
        Double parsedAmount = parsedNumber(amount);
        Double parsedShares = parsedNumber(shares);
        if (parsedAmount == null && parsedShares == null) return false;
        return (parsedAmount == null || Math.abs(parsedAmount) < 0.000001d)
            && (parsedShares == null || Math.abs(parsedShares) < 0.000001d);
    }

    private boolean positiveNumber(String value) {
        Double parsed = parsedNumber(value);
        return parsed != null && parsed > 0;
    }

    private Double parsedNumber(String value) {
        try {
            String normalized = textValue(value).replaceAll("[^0-9.\\-]", "");
            if (normalized.isEmpty() || "-".equals(normalized) || ".".equals(normalized)) return null;
            double parsed = Double.parseDouble(normalized);
            return Double.isFinite(parsed) ? parsed : null;
        } catch (Exception ignored) {
            return null;
        }
    }

    private String firstText(JSONObject row, String... keys) {
        for (String key : keys) {
            String value = textValue(row.opt(key));
            if (!value.isEmpty()) return value;
        }
        return "";
    }

    private String textValue(Object value) {
        if (value == null || JSONObject.NULL.equals(value)) return "";
        return String.valueOf(value).trim();
    }

    private String readBody(InputStream stream) throws Exception {
        if (stream == null) return "";
        StringBuilder body = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) body.append(line);
        }
        return body.toString();
    }

    private void validateJdHttpStatus(int status, String redirectUrl, String label) throws Exception {
        if (status == HttpURLConnection.HTTP_UNAUTHORIZED || status == HttpURLConnection.HTTP_FORBIDDEN) {
            throw new LoginRequiredException();
        }
        if (status >= 300 && status < 400 && isLoginRedirectUrl(redirectUrl)) {
            throw new LoginRequiredException();
        }
        if (status == 429) throw new IllegalStateException("京东接口请求频繁，请稍后重试");
        if (status == HttpURLConnection.HTTP_CLIENT_TIMEOUT) {
            throw new IllegalStateException("京东接口请求超时，请稍后重试");
        }
        if (status >= 500 && status < 600) {
            throw new IllegalStateException("京东服务暂时繁忙，请稍后重试");
        }
        if (status < 200 || status >= 300) {
            throw new IllegalStateException(label + "返回状态 " + status);
        }
    }

    private IllegalStateException jdServiceFailure(String prefix, String message) {
        String detail = message == null ? "" : message.trim();
        if (detail.isEmpty() || detail.length() > 120 || detail.contains("<") || detail.contains("{")) {
            return new IllegalStateException(prefix + "，请稍后重试");
        }
        return new IllegalStateException(prefix + "：" + detail);
    }

    private boolean containsExplicitLoginMessage(String value) {
        String normalized = value == null ? "" : value.toLowerCase(Locale.ROOT);
        return normalized.contains("未登录")
            || normalized.contains("请先登录")
            || normalized.contains("登录已失效")
            || normalized.contains("登录失效")
            || normalized.contains("登录过期")
            || normalized.contains("重新登录")
            || normalized.contains("会话失效")
            || normalized.contains("unauthorized")
            || normalized.contains("forbidden")
            || normalized.contains("login required")
            || normalized.contains("not logged in")
            || normalized.contains("please login")
            || normalized.contains("please log in")
            || normalized.contains("session expired")
            || normalized.contains("authentication required");
    }

    private boolean containsExplicitLoginResponse(String body, String contentType) {
        if (containsExplicitLoginMessage(body)) return true;
        String normalized = body == null ? "" : body.toLowerCase(Locale.ROOT);
        String type = contentType == null ? "" : contentType.toLowerCase(Locale.ROOT);
        boolean html = type.contains("text/html") || normalized.contains("<html") || normalized.contains("<!doctype html");
        return html && (normalized.contains("passport.jd.com")
            || normalized.contains("plogin")
            || normalized.contains("login-form")
            || normalized.contains("loginname"));
    }

    private boolean isLoginRedirectUrl(String value) {
        if (value == null || value.trim().isEmpty()) return false;
        try {
            Uri uri = Uri.parse(value.trim());
            String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
            String path = uri.getPath() == null ? "" : uri.getPath().toLowerCase(Locale.ROOT);
            return host.equals("passport.jd.com")
                || host.endsWith(".passport.jd.com")
                || host.startsWith("plogin.")
                || path.equals("/login")
                || path.startsWith("/login/")
                || path.contains("login.html");
        } catch (Exception ignored) {
            return false;
        }
    }

    private boolean isJdUrl(Uri uri) {
        if (uri == null || !"https".equalsIgnoreCase(uri.getScheme())) return false;
        String host = uri.getHost();
        if (host == null) return false;
        String normalized = host.toLowerCase(Locale.ROOT);
        return normalized.equals("jd.com") || normalized.endsWith(".jd.com") || normalized.equals("jd.com.cn") || normalized.endsWith(".jd.com.cn");
    }

    /** Replace the temporary WebView Cookie jar in a deterministic order. */
    private void replaceWebSession(String sessionCookie, Runnable completion) {
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        List<String> pairs = new ArrayList<>();
        for (String pair : sessionCookie.split(";\\s*")) {
            if (pair.contains("=")) pairs.add(pair);
        }
        String[] origins = {
            LOGIN_URL,
            "https://roma.jd.com",
            "https://mix.jd.com",
            "https://ms.jr.jd.com"
        };
        cookies.removeAllCookies(ignored -> {
            if (pairs.isEmpty()) {
                cookies.flush();
                completion.run();
                return;
            }
            AtomicInteger remaining = new AtomicInteger(pairs.size() * origins.length);
            for (String pair : pairs) {
                for (String origin : origins) {
                    cookies.setCookie(origin, pair, accepted -> {
                        if (remaining.decrementAndGet() == 0) {
                            cookies.flush();
                            completion.run();
                        }
                    });
                }
            }
        });
    }

    private void seedWebSession(String sessionCookie) {
        CookieManager cookies = CookieManager.getInstance();
        for (String pair : sessionCookie.split(";\\s*")) {
            if (pair.contains("=")) {
                cookies.setCookie(LOGIN_URL, pair);
                cookies.setCookie("https://roma.jd.com", pair);
                cookies.setCookie("https://mix.jd.com", pair);
                cookies.setCookie("https://ms.jr.jd.com", pair);
            }
        }
        cookies.flush();
    }

    private void resetDetailWebViewClient(WebView view) {
        if (view == null) return;
        view.removeJavascriptInterface("FundAppDetailTrade");
        view.setWebViewClient(new SecureJdWebViewClient());
    }

    private void destroyWebView(WebView view) {
        if (view == null) return;
        view.stopLoading();
        view.removeAllViews();
        view.destroy();
    }

    private void finishWithResult(JSObject result) {
        PluginCall call = pendingCall;
        pendingCall = null;
        importInFlight = false;
        closeDialogAndClearSession();
        if (call != null) call.resolve(result);
    }

    private void finishWithError(String message) {
        PluginCall call = pendingCall;
        pendingCall = null;
        importInFlight = false;
        closeDialogAndClearSession();
        if (call != null) call.reject(message);
    }

    private void closeDialogAndClearSession() {
        if (loginWebView != null) {
            loginWebView.stopLoading();
            loginWebView.removeAllViews();
            loginWebView.destroy();
            loginWebView = null;
        }
        if (loginDialog != null && loginDialog.isShowing()) loginDialog.dismiss();
        loginDialog = null;
        statusView = null;
        importButton = null;
        cookieBrowserRequests.clear();
        cookieImport = false;
        gridImport = false;
        clearWebSession();
    }

    private void clearWebSession() {
        CookieManager cookies = CookieManager.getInstance();
        cookies.removeAllCookies(null);
        cookies.flush();
    }

    private void reportProgress(String stage, String message, int current, int total) {
        JSObject progress = new JSObject();
        progress.put("stage", stage);
        progress.put("message", message);
        if (current > 0) progress.put("current", current);
        if (total > 0) progress.put("total", total);
        notifyListeners("syncProgress", progress);
    }

    private void setStatus(String message) {
        if (statusView != null) statusView.setText(message);
    }

    private int dp(int value) {
        return Math.round(value * getContext().getResources().getDisplayMetrics().density);
    }

    private class SecureJdWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return request == null || !isJdUrl(request.getUrl());
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return !isJdUrl(Uri.parse(url));
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            handler.cancel();
            setStatus("京东页面证书校验失败，已停止读取");
        }
    }

    private class HoldingCookieBrowserBridge {
        @JavascriptInterface
        public void receive(String value) {
            try {
                JSONObject response = new JSONObject(value);
                String id = response.optString("id", "");
                BrowserCookieRequest capture = cookieBrowserRequests.get(id);
                if (capture != null) capture.receive(response);
            } catch (Exception ignored) {
                // A malformed page callback only fails its matching request.
            }
        }
    }

    private static class BrowserCookieRequest {
        private final CountDownLatch done = new CountDownLatch(1);
        private int status = -1;
        private String body = "";
        private String error = "";
        private String url = "";
        private String contentType = "";

        synchronized void receive(JSONObject response) {
            status = response.optInt("status", -1);
            body = response.optString("body", "");
            error = response.optString("error", "").trim();
            url = response.optString("url", "").trim();
            contentType = response.optString("contentType", "").trim();
            done.countDown();
        }

        synchronized void fail(String value) {
            error = value == null ? "京东持仓浏览器会话不可用" : value;
            done.countDown();
        }
    }

    private static class AccountTradeCapture {
        private final CountDownLatch done = new CountDownLatch(1);
        private final JSONArray rows = new JSONArray();
        private boolean complete;
        private boolean failed;
        private String reason = "";
        private int pageCount;
        private int allCount;

        synchronized void receive(JSONObject response) {
            if (response.has("ready") && !response.optBoolean("ready", false)) {
                fail(response.optString("reason", "京东交易记录不可用"));
                return;
            }
            JSONArray responseRows = response.optJSONArray("rows");
            if (responseRows != null) {
                for (int index = 0; index < responseRows.length(); index++) rows.put(responseRows.opt(index));
            }
            if (response.optBoolean("progress", false)) {
                pageCount = Math.max(pageCount, response.optInt("page", 0));
                allCount = Math.max(allCount, response.optInt("allCount", 0));
            }
            if (response.optBoolean("done", false)) {
                complete = true;
                done.countDown();
            }
        }

        synchronized JSONArray rows() {
            return rows;
        }

        synchronized int pageCount() {
            return pageCount;
        }

        synchronized int allCount() {
            return allCount;
        }

        synchronized void fail(String error) {
            failed = true;
            if (reason.isEmpty() && error != null) reason = error.trim();
            done.countDown();
        }

        synchronized String failureReason() {
            return reason;
        }
    }

    private class AccountTradeBridge {
        private final AccountTradeCapture capture;

        AccountTradeBridge(AccountTradeCapture capture) {
            this.capture = capture;
        }

        @JavascriptInterface
        public void receive(String value) {
            try {
                JSONObject response = new JSONObject(value);
                if (response.optBoolean("progress", false)) {
                    int page = Math.max(1, response.optInt("page", 1));
                    int pageRows = Math.max(0, response.optInt("rows", 0));
                    int totalRows = Math.max(0, response.optInt("totalRows", 0));
                    int allCount = Math.max(0, response.optInt("allCount", 0));
                    String totalText = allCount > 0 ? " / 共 " + allCount + " 条" : "";
                    reportProgress(
                        "reading_trades",
                        "正在读取京东交易记录：第 " + page + " 页，本页 " + pageRows + " 条，累计 " + totalRows + " 条" + totalText,
                        totalRows,
                        allCount
                    );
                }
                if (response.has("ready") && !response.optBoolean("ready", false)) {
                    reportProgress(
                        "reading_trades",
                        response.optString("reason", "京东交易记录分页读取失败"),
                        0,
                        0
                    );
                }
                capture.receive(response);
            } catch (Exception error) {
                capture.fail("京东交易记录分页进度格式异常");
            }
        }
    }

    private static class DetailTradeCapture {
        private final String fundCode;
        private final CountDownLatch done = new CountDownLatch(1);
        private final JSONArray rows = new JSONArray();
        private boolean complete;
        private boolean failed;
        private String reason = "";

        DetailTradeCapture(String fundCode) {
            this.fundCode = fundCode;
        }

        synchronized void receive(String value) {
            try {
                JSONObject response = new JSONObject(value);
                if (!fundCode.equals(response.optString("code", ""))) return;
                if (response.has("ready") && !response.optBoolean("ready", false)) {
                    fail(response.optString("reason", "京东交易记录不可用"));
                    return;
                }
                JSONArray responseRows = response.optJSONArray("rows");
                if (responseRows != null) {
                    for (int index = 0; index < responseRows.length(); index++) rows.put(responseRows.opt(index));
                }
                if (response.optBoolean("done", false)) {
                    complete = true;
                    done.countDown();
                }
            } catch (Exception error) {
                fail("京东交易记录响应格式异常");
            }
        }

        synchronized JSONArray rows() {
            return rows;
        }

        synchronized void fail(String error) {
            failed = true;
            if (reason.isEmpty() && error != null) reason = error.trim();
            done.countDown();
        }

        synchronized String failureReason() {
            return reason;
        }
    }

    private static class DetailTradeBridge {
        private final DetailTradeCapture capture;

        DetailTradeBridge(DetailTradeCapture capture) {
            this.capture = capture;
        }

        @JavascriptInterface
        public void receive(String value) {
            capture.receive(value);
        }
    }

    private static class FundTradeRequest {
        private final String code;
        private final String extJson;

        FundTradeRequest(String code, String extJson) {
            this.code = code;
            this.extJson = extJson;
        }
    }

    private static class FundTradeRows {
        private final String code;
        private final JSONArray rows;
        private final String error;
        private final int attempts;

        FundTradeRows(String code, JSONArray rows, String error, int attempts) {
            this.code = code;
            this.rows = rows;
            this.error = error == null ? "" : error;
            this.attempts = attempts;
        }
    }

    private static class AccountTradeResult {
        private final JSArray rows;
        private final int pageCount;
        private final int rawRows;
        private final int allCount;

        AccountTradeResult(JSArray rows, int pageCount, int rawRows, int allCount) {
            this.rows = rows;
            this.pageCount = pageCount;
            this.rawRows = rawRows;
            this.allCount = allCount;
        }
    }

    private static class CurrentHoldingTradeResult {
        private final JSArray rows;
        private final String warning;
        private final int attempted;
        private final int succeeded;
        private final int failed;
        private final int rawRows;
        private final int retried;

        CurrentHoldingTradeResult(
            JSArray rows,
            String warning,
            int attempted,
            int succeeded,
            int failed,
            int rawRows,
            int retried
        ) {
            this.rows = rows;
            this.warning = warning == null ? "" : warning;
            this.attempted = attempted;
            this.succeeded = succeeded;
            this.failed = failed;
            this.rawRows = rawRows;
            this.retried = retried;
        }

        String diagnostic() {
            String value = "详情 " + succeeded + "/" + attempted + " 只成功、失败 " + failed
                + " 只、原始 " + rawRows + " 条、有效 " + rows.length() + " 条";
            if (retried > 0) value += "、重试成功 " + retried + " 只";
            return value;
        }

        static CurrentHoldingTradeResult empty() {
            return new CurrentHoldingTradeResult(new JSArray(), "", 0, 0, 0, 0, 0);
        }

        static CurrentHoldingTradeResult failed(String warning) {
            return new CurrentHoldingTradeResult(new JSArray(), warning, 0, 0, 0, 0, 0);
        }
    }

    private static class HoldingSnapshotIncompleteException extends Exception {
        HoldingSnapshotIncompleteException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    private static class LoginRequiredException extends Exception {}
}
