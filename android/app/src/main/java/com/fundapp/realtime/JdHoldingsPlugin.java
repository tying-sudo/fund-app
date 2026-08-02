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
    // This page owns the decryption and pagination contract for the account
    // timeline. queryTradeOrderList is encrypted in transit and must not be
    // replayed or parsed directly by the importer.
    private static final String ACCOUNT_TRADE_PAGE_URL = "https://roma.jd.com/wealth/tradeorder/list?pageShowType=1&businessCode=FUND&pageShowTitle=%E5%9F%BA%E9%87%91%E4%BA%A4%E6%98%93";
    private static final int MATCH_PARENT = ViewGroup.LayoutParams.MATCH_PARENT;
    private static final int WRAP_CONTENT = ViewGroup.LayoutParams.WRAP_CONTENT;
    private static final int DETAIL_TIMEOUT_SECONDS = 35;
    private static final int HOLDING_DETAIL_CONCURRENCY = 12;
    private static final int HOLDING_TRADE_CONCURRENCY = 4;
    private static final int HOLDING_TRADE_MAX_ATTEMPTS = 2;
    private static final int TRADE_HISTORY_YEARS = 10;
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
    private String requestUserAgent = "Mozilla/5.0";

    @PluginMethod
    public void importHoldings(PluginCall call) {
        if (pendingCall != null || importInFlight) {
            call.reject("已有京东读取任务正在进行");
            return;
        }
        call.setKeepAlive(true);
        pendingCall = call;
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
        clearWebSession();
        loginWebView = createWebView(activity);
        loginWebView.setWebViewClient(new SecureJdWebViewClient());
        seedWebSession(sessionCookie);
        beginPortfolioRead(sessionCookie);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void showCookieImportDialog(String sessionCookie) {
        Activity activity = getActivity();
        if (activity == null || activity.isFinishing()) {
            finishWithError("无法打开京东持仓读取");
            return;
        }
        clearWebSession();
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
        return readPortfolioWithAccountTrades(sessionCookie, readHoldingDetails(sessionCookie));
    }

    private JSObject readHoldingCookiePortfolio(String sessionCookie) throws Exception {
        // The newna endpoints must run in JD's actual Roma holding document
        // with a registered browser bridge.  If JD temporarily rejects that
        // modern page transport, use the same h5 snapshot reader that the
        // grid importer already supports before failing the Cookie import.
        try {
            prepareHoldingCookieBrowser(sessionCookie);
            return readPortfolioWithAccountTrades(sessionCookie, readHoldingCookieDetails(sessionCookie));
        } catch (LoginRequiredException error) {
            throw error;
        } catch (Exception browserFailure) {
            reportProgress("reading_holdings", "新版京东持仓页读取未完成，正在使用兼容读取...", 0, 0);
            try {
                return readPortfolioWithAccountTrades(sessionCookie, readHoldingDetails(sessionCookie));
            } catch (Exception fallbackFailure) {
                fallbackFailure.addSuppressed(browserFailure);
                throw fallbackFailure;
            }
        }
    }

    /** The current-holding source varies by session type; transaction records never do. */
    private JSObject readPortfolioWithAccountTrades(String sessionCookie, JSArray rawHoldings) throws Exception {
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
        ExecutorService timelineReaders = Executors.newFixedThreadPool(2);
        Future<AccountTradeResult> accountRead = timelineReaders.submit(() -> readHoldingCookieAccountTrades(sessionCookie, holdings));
        Future<CurrentHoldingTradeResult> detailRead = timelineReaders.submit(() -> readCurrentHoldingTrades(sessionCookie, holdings));
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
            try {
                detailResult = detailRead.get();
            } catch (ExecutionException ignored) {
                detailResult = CurrentHoldingTradeResult.failed("基金详情交易记录补全失败");
            }
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("京东交易记录读取已中断", error);
        } finally {
            timelineReaders.shutdownNow();
        }
        if (accountResult == null) {
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
                + detailResult.diagnostic();
            result.put("adjustments", merged);
            result.put("tradeDiagnostic", diagnostic);
            if (!detailResult.warning.isEmpty()) result.put("tradeWarning", detailResult.warning);
        }
        reportProgress("normalizing", "京东持仓数据读取完成", 0, 0);
        return result;
    }

    /**
     * The holdings Cookie route owns this bounded fan-out.  Grid imports keep
     * their serialized snapshot read so a grid run cannot change its existing
     * request order or timing contract.
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
            if (groupProducts == null) continue;
            for (int index = 0; index < groupProducts.length(); index++) {
                JSONObject product = groupProducts.optJSONObject(index);
                if (product != null) products.add(product);
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
                        return readHoldingCookieDetail(product, sessionCookie);
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
                if (holding != null) holdings.put(holding);
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
            if (groupProducts == null) continue;
            for (int index = 0; index < groupProducts.length(); index++) {
                JSONObject product = groupProducts.optJSONObject(index);
                if (product != null) products.add(product);
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
                        return readHoldingDetail(product, sessionCookie);
                    } finally {
                        int current = completed.incrementAndGet();
                        reportProgress("reading_holdings", "正在读取京东持仓（" + current + "/" + total + "）...", current, total);
                    }
                }));
            }
            // Futures are consumed in JD list order, independent of completion order.
            for (Future<JSObject> read : reads) {
                JSObject holding = read.get();
                if (holding != null) holdings.put(holding);
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

    /** Keep the account page as the timeline authority and use detail rows only to fill missing fields. */
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
        String detailId = firstText(detail, "id");
        for (int index = 0; index < rows.length(); index++) {
            JSONObject candidate = rows.optJSONObject(index);
            if (candidate != null && !detailId.isEmpty() && detailId.equals(firstText(candidate, "id"))) return index;
        }

        int match = -1;
        for (int index = 0; index < rows.length(); index++) {
            JSONObject candidate = rows.optJSONObject(index);
            if (candidate == null || !sameTradeIdentity(candidate, detail)) continue;
            if (match >= 0) return -1;
            match = index;
        }
        return match;
    }

    private boolean sameTradeIdentity(JSONObject left, JSONObject right) {
        for (String key : new String[] { "code", "type", "tradeDate" }) {
            String leftValue = firstText(left, key);
            String rightValue = firstText(right, key);
            if (leftValue.isEmpty() || !leftValue.equals(rightValue)) return false;
        }
        for (String key : new String[] { "tradeTime", "targetCode", "amount" }) {
            String leftValue = firstText(left, key);
            String rightValue = firstText(right, key);
            if (!leftValue.isEmpty() && !rightValue.isEmpty() && !leftValue.equals(rightValue)) return false;
        }
        return true;
    }

    private void enrichTradeRow(JSONObject target, JSONObject detail) {
        if (target == null) return;
        for (String key : new String[] { "shares", "targetShares", "status", "statusCode", "confirmTime" }) {
            String current = firstText(target, key);
            String replacement = firstText(detail, key);
            if (current.isEmpty() && !replacement.isEmpty()) {
                try {
                    target.put(key, replacement);
                } catch (Exception ignored) {
                    // One malformed optional field must not discard the timeline.
                }
            }
        }
    }

    /**
     * Read the account-wide timeline once through JD's own browser runtime.
     * This is the same page opened by "昨日收益 -> 交易记录", so a 12-fund
     * portfolio no longer requires 12 serial detail-page navigations.
     */
    @SuppressLint("SetJavaScriptEnabled")
    private AccountTradeResult readHoldingCookieAccountTrades(String sessionCookie, JSArray holdings) throws Exception {
        Set<String> currentCodes = new HashSet<>();
        for (int index = 0; index < holdings.length(); index++) {
            JSONObject holding = holdings.optJSONObject(index);
            String code = holding == null ? "" : holding.optString("code", "").trim();
            if (code.matches("\\d{6}")) currentCodes.add(code);
        }
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
                            webView.evaluateJavascript(accountTradeBootstrap(getTradeHistoryStartDate()), null);
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
    private String accountTradeBootstrap(String earliestDate) {
        return "(function(){if(window.__fundAppAccountTradeHook)return;window.__fundAppAccountTradeHook=true;var cutoff=" + JSONObject.quote(earliestDate) + ",sent={},pages={},started=Date.now(),lastPageAt=started,pageCount=0,totalRows=0,allCount=0,hasRows=false,terminal=false,requestedFirst=false,lastVmPage=-1,lastVmRows=-1,parse0=JSON.parse;"
            + "function emit(x){try{window.FundAppAccountTrade&&window.FundAppAccountTrade.receive(JSON.stringify(x))}catch(e){}}"
            + "function progress(page,rows,totalRows,allCount){emit({progress:true,page:page,rows:rows,totalRows:totalRows,allCount:allCount})}"
            + "function isTradeRow(x){return !!(x&&typeof x==='object'&&(x.bizTime||x.tradeTime||x.confirmTime||x.orderCreateTime||x.tradeDate)&&(x.tradeTypeCode||x.tradeTypeName||x.tradeName||x.operationName||x.businessName||x.businessType||x.orderType)&&(x.productId||x.fundCode||x.sellProductId||x.sourceFundCode||x.fromFundCode)&&(x.unit||x.confirmUnit||x.tradeUnit||x.confirmShare||x.tradeShare||x.fundShare||x.applyShare||x.share||x.shares||x.allAmount||x.confirmAmount||x.tradeAmount||x.applyAmount||x.amount||x.money))}"
            + "function rows(v,out){if(Array.isArray(v)){var matched=v.filter(isTradeRow);if(matched.length){out.push.apply(out,matched);return}v.forEach(function(x){rows(x,out)});return}if(v&&typeof v==='object')Object.keys(v).forEach(function(k){rows(v[k],out)})}"
            + "function day(x){var t=x&&(x.bizTime||x.tradeTime||x.orderCreateTime||x.orderCreateDate||x.createTime||x.confirmTime||x.tradeDate);if(typeof t==='number'||/^\\d{10,13}$/.test(String(t||''))){var n=Number(t);if(String(Math.trunc(n)).length===10)n*=1000;var d=new Date(n+28800000);return isNaN(d.getTime())?'':d.toISOString().slice(0,10)}var m=/(\\d{4})[-/.]?(\\d{1,2})[-/.]?(\\d{1,2})/.exec(String(t||''));return m?m[1]+'-'+('0'+m[2]).slice(-2)+'-'+('0'+m[3]).slice(-2):''}"
            + "function payload(v,depth){if(!v||typeof v!=='object'||depth>8)return null;if(v.data&&Array.isArray(v.data.tradeOrderVoList))return {list:v.data.tradeOrderVoList,page:Number(v.data.pageNo||0),all:Number(v.allCount||v.data.allCount||0)};var keys=Object.keys(v);for(var i=0;i<keys.length;i++){var found=payload(v[keys[i]],depth+1);if(found)return found}return null}"
            + "function emitRows(a){if(!a||!a.length)return;var k=JSON.stringify(a);if(sent[k])return;sent[k]=1;hasRows=true;a=a.filter(function(x){var d=day(x);return d&&d>=cutoff});if(a.length)emit({rows:a})}"
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
            if (row == null || !isEffectiveTrade(row)) continue;
            String type = resolveTradeType(row);
            if (type == null) continue;
            boolean capturedTransform = "TRANSFORM".equalsIgnoreCase(firstText(row, "tradeTypeCode"));
            String code = capturedTransform
                ? normalizeFundCode(firstText(row, "sellProductId", "sourceProductId", "fromProductId"))
                : resolveAccountTradeFundCode(row, currentCodes);
            if (!code.matches("\\d{6}")) code = resolveAccountTradeFundCode(row, currentCodes);
            String targetCode = capturedTransform
                ? normalizeFundCode(firstText(row, "productId", "targetProductId", "targetFundCode", "toFundCode"))
                : normalizeFundCode(firstText(row, "targetProductId", "targetFundCode", "toFundCode"));
            String rawTime = firstText(row, "bizTime", "tradeTime", "orderCreateTime", "orderCreateDate", "createTime", "confirmTime", "tradeDate");
            String tradeDate = normalizeTradeDate(rawTime);
            boolean todayInbound = isTodayTradeDate(tradeDate)
                && ("add".equals(type) || ("convert".equals(type) && targetCode.matches("\\d{6}")));
            if (!currentCodes.contains(code)
                && !("convert".equals(type) && currentCodes.contains(targetCode))
                && !todayInbound) continue;
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
        for (String key : new String[] { "fundCode", "sellProductId", "sourceFundCode", "fromFundCode", "sourceProductId", "fromProductId", "productId", "productCode", "fundId" }) {
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
            if (row == null || !isEffectiveTrade(row)) continue;
            String type = resolveTradeType(row);
            if (type == null) continue;
            boolean capturedTransform = "convert".equals(type) && !firstText(row, "sellProductId").isEmpty();
            String code = normalizeFundCode(capturedTransform
                ? firstText(row, "sellProductId", "sourceProductId", "fromProductId")
                : firstText(row, "fundCode", "productId", "sourceFundCode", "fromFundCode"));
            if (!code.matches("\\d{6}")) code = fundCode;
            // Use the order/business time first. The grid resolves its
            // confirmation NAV from this timestamp and the fund cut-off rule.
            String rawTime = firstText(row, "bizTime", "tradeTime", "orderCreateTime", "orderCreateDate", "createTime", "confirmTime", "tradeDate");
            String date = normalizeTradeDate(rawTime);
            if (date == null) continue;
            if (!isWithinTradeHistory(date)) continue;
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
            item.put("code", code);
            item.put("name", capturedTransform
                ? firstText(row, "sellProductName", "sourceFundName", "fromFundName")
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
                    ? firstText(row, "productId", "targetProductId", "targetFundCode", "toFundCode")
                    : firstText(row, "targetProductId", "targetFundCode", "toFundCode")));
                item.put("targetName", capturedTransform
                    ? firstText(row, "productName", "targetProductName", "targetFundName", "toFundName")
                    : firstText(row, "targetProductName", "targetFundName", "toFundName"));
                item.put("targetShares", firstText(row, "targetUnit", "targetShare", "targetShares", "targetFundShare", "toFundShare", "convertShare"));
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
        CountDownLatch created = new CountDownLatch(1);
        CountDownLatch ready = new CountDownLatch(1);
        String[] startupError = new String[1];
        activity.runOnUiThread(() -> {
            try {
                clearWebSession();
                WebView reader = loginWebView == null ? createWebView(activity) : loginWebView;
                reader.addJavascriptInterface(new HoldingCookieBrowserBridge(), "FundAppHoldingCookie");
                reader.setWebViewClient(new SecureJdWebViewClient() {
                    @Override
                    public void onPageFinished(WebView view, String url) {
                        super.onPageFinished(view, url);
                        if (isJdUrl(Uri.parse(url))) ready.countDown();
                    }
                });
                seedWebSession(sessionCookie);
                loginWebView = reader;
                reader.loadUrl(HOLDING_PAGE_URL);
            } catch (Exception error) {
                startupError[0] = error.getMessage();
            } finally {
                created.countDown();
            }
        });
        if (!created.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("京东持仓读取启动超时");
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
            + "fetch(o.url,{method:'POST',credentials:'include',headers:{'Accept':'application/json, text/plain, */*','Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','Accept-Language':'zh-CN,zh;q=0.9'},body:o.body})"
            + ".then(function(r){return r.text().then(function(t){window.FundAppHoldingCookie.receive(JSON.stringify({id:o.id,status:r.status,body:t}))})})"
            + ".catch(function(e){window.FundAppHoldingCookie.receive(JSON.stringify({id:o.id,error:String((e&&e.message)||e)}))});})();";
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
        if (capture.status == HttpURLConnection.HTTP_UNAUTHORIZED || capture.status == HttpURLConnection.HTTP_FORBIDDEN) {
            throw new LoginRequiredException();
        }
        if (capture.status < 200 || capture.status >= 300) {
            throw new IllegalStateException("京东持仓接口返回状态 " + capture.status);
        }
        if (capture.body.isEmpty()) throw new IllegalStateException("京东未返回有效持仓数据");
        if (containsLoginMessage(capture.body)) throw new LoginRequiredException();
        JSONObject payload;
        try {
            payload = new JSONObject(capture.body);
        } catch (Exception error) {
            throw new IllegalStateException("京东持仓接口返回格式异常");
        }
        String message = payload.optString("resultMsg", payload.optString("message", ""));
        if (!payload.optBoolean("success", true) && (payload.optInt("resultCode") == 3 || containsLoginMessage(message))) {
            throw new LoginRequiredException();
        }
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
            if (status == HttpURLConnection.HTTP_UNAUTHORIZED || status == HttpURLConnection.HTTP_FORBIDDEN || status >= 300) throw new LoginRequiredException();
            if (response.isEmpty()) throw new IllegalStateException("京东未返回有效数据");
            JSONObject payload = new JSONObject(response);
            String message = payload.optString("resultMsg", payload.optString("message", ""));
            if (!payload.optBoolean("success", true) && (payload.optInt("resultCode") == 3 || containsLoginMessage(message))) throw new LoginRequiredException();
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

    /** Match JD's transaction page: today through the preceding ten years. */
    private String getTradeHistoryStartDate() {
        Calendar calendar = Calendar.getInstance(TimeZone.getTimeZone("Asia/Shanghai"));
        calendar.set(Calendar.HOUR_OF_DAY, 0);
        calendar.set(Calendar.MINUTE, 0);
        calendar.set(Calendar.SECOND, 0);
        calendar.set(Calendar.MILLISECOND, 0);
        calendar.add(Calendar.YEAR, -TRADE_HISTORY_YEARS);
        return String.format(Locale.ROOT, "%04d-%02d-%02d", calendar.get(Calendar.YEAR), calendar.get(Calendar.MONTH) + 1, calendar.get(Calendar.DAY_OF_MONTH));
    }

    private boolean isWithinTradeHistory(String date) {
        if (date == null || !date.matches("\\d{4}-\\d{2}-\\d{2}")) return false;
        Calendar today = Calendar.getInstance(TimeZone.getTimeZone("Asia/Shanghai"));
        String currentDate = String.format(Locale.ROOT, "%04d-%02d-%02d", today.get(Calendar.YEAR), today.get(Calendar.MONTH) + 1, today.get(Calendar.DAY_OF_MONTH));
        return date.compareTo(getTradeHistoryStartDate()) >= 0 && date.compareTo(currentDate) <= 0;
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

    private boolean containsLoginMessage(String value) {
        String normalized = value == null ? "" : value.toLowerCase(Locale.ROOT);
        return normalized.contains("登录") || normalized.contains("login");
    }

    private boolean isJdUrl(Uri uri) {
        if (uri == null || !"https".equalsIgnoreCase(uri.getScheme())) return false;
        String host = uri.getHost();
        if (host == null) return false;
        String normalized = host.toLowerCase(Locale.ROOT);
        return normalized.equals("jd.com") || normalized.endsWith(".jd.com") || normalized.equals("jd.com.cn") || normalized.endsWith(".jd.com.cn");
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

        synchronized void receive(JSONObject response) {
            status = response.optInt("status", -1);
            body = response.optString("body", "");
            error = response.optString("error", "").trim();
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

    private static class LoginRequiredException extends Exception {}
}
