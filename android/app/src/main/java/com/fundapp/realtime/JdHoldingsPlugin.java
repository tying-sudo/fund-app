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
    // This is the same account-wide fund transaction page reached from the
    // holding header's "昨日收益 -> 交易记录" entry.
    private static final String ACCOUNT_TRADE_PAGE_URL = "https://roma.jd.com/wealth/tradeorder/list?pageShowType=1&businessCode=FUND&pageShowTitle=%E5%9F%BA%E9%87%91%E4%BA%A4%E6%98%93";
    private static final int MATCH_PARENT = ViewGroup.LayoutParams.MATCH_PARENT;
    private static final int WRAP_CONTENT = ViewGroup.LayoutParams.WRAP_CONTENT;
    private static final int DETAIL_TIMEOUT_SECONDS = 18;
    private static final int HOLDING_DETAIL_CONCURRENCY = 12;
    private static final int HOLDING_TRADE_CONCURRENCY = 12;
    private static final int TRADE_HISTORY_DAYS = 30;
    private static final int ACCOUNT_TRADE_TIMEOUT_SECONDS = 35;

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
    private JSObject readPortfolioWithAccountTrades(String sessionCookie, JSArray holdings) throws Exception {
        JSObject result = new JSObject();
        result.put("items", holdings);
        try {
            result.put("adjustments", readHoldingCookieAccountTrades(sessionCookie, holdings));
        } catch (Exception error) {
            // A valid current-holding snapshot must still reach the holding
            // list when JD's optional transaction page is temporarily slow.
            result.put("adjustments", new JSArray());
            result.put("tradeWarning", "交易记录未完整读取，请稍后重新同步");
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
        if (!hasCurrentPosition(amount, shares) || shares.isEmpty()) return null;

        JSObject holding = new JSObject();
        holding.put("code", code);
        holding.put("name", introduction == null ? product.optString("productName", "") : introduction.optString("fundName", product.optString("productName", "")));
        holding.put("amount", amount);
        holding.put("yesterdayIncome", findLabeledValue(major == null ? null : major.optJSONArray("yieldList"), "昨日收益"));
        holding.put("profit", findLabeledValue(major == null ? null : major.optJSONArray("yieldList"), "持有收益"));
        holding.put("rate", findLabeledValue(major == null ? null : major.optJSONArray("yieldList"), "持有收益率"));
        holding.put("shares", shares);
        if (!costAmount.isEmpty()) holding.put("costAmount", costAmount);
        if (!costPrice.isEmpty()) holding.put("costPrice", costPrice);
        return holding;
    }

    private JSArray readCurrentHoldingTrades(String sessionCookie, JSArray holdings) throws Exception {
        JSArray adjustments = new JSArray();
        List<FundTradeRequest> requests = new ArrayList<>();
        for (int index = 0; index < holdings.length(); index++) {
            JSONObject holding = holdings.optJSONObject(index);
            String code = holding == null ? "" : holding.optString("code", "").trim();
            String extJson = holding == null ? "" : holding.optString("detailExtJson", "").trim();
            if (!code.matches("\\d{6}") || extJson.isEmpty()) continue;
            requests.add(new FundTradeRequest(code, extJson));
        }
        if (requests.isEmpty()) return adjustments;

        int total = requests.size();
        ExecutorService tradeReaders = Executors.newFixedThreadPool(Math.min(HOLDING_TRADE_CONCURRENCY, total));
        AtomicInteger completed = new AtomicInteger();
        List<Future<FundTradeRows>> reads = new ArrayList<>();
        try {
            for (FundTradeRequest request : requests) {
                reads.add(tradeReaders.submit(() -> {
                    try {
                        return new FundTradeRows(
                            request.code,
                            readFundTradeRowsInIsolatedWebView(sessionCookie, request.code, request.extJson)
                        );
                    } finally {
                        int current = completed.incrementAndGet();
                        reportProgress("reading_trades", "正在并发读取京东交易记录（" + current + "/" + total + "）...", current, total);
                    }
                }));
            }

            Set<String> seen = new HashSet<>();
            // Merge in holdings order so concurrent page completion does not
            // change the local audit record order or deduplication winner.
            for (Future<FundTradeRows> read : reads) {
                FundTradeRows result = read.get();
                appendTradeRows(result.rows, result.code, adjustments, seen);
            }
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
        return adjustments;
    }

    /**
     * Read the account-wide timeline once through JD's own browser runtime.
     * This is the same page opened by "昨日收益 -> 交易记录", so a 12-fund
     * portfolio no longer requires 12 serial detail-page navigations.
     */
    @SuppressLint("SetJavaScriptEnabled")
    private JSArray readHoldingCookieAccountTrades(String sessionCookie, JSArray holdings) throws Exception {
        Set<String> currentCodes = new HashSet<>();
        for (int index = 0; index < holdings.length(); index++) {
            JSONObject holding = holdings.optJSONObject(index);
            String code = holding == null ? "" : holding.optString("code", "").trim();
            if (code.matches("\\d{6}")) currentCodes.add(code);
        }
        if (currentCodes.isEmpty()) return new JSArray();

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
        reportProgress("reading_trades", "正在读取近30天京东交易记录...", 0, 0);
        try {
            boolean completed = capture.done.await(ACCOUNT_TRADE_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (!completed || capture.failed || !capture.complete) {
                String reason = capture.failureReason();
                throw new IllegalStateException(reason.isEmpty() ? "京东交易记录读取超时" : reason);
            }
            JSArray adjustments = new JSArray();
            appendAccountTradeRows(capture.rows(), currentCodes, adjustments, new HashSet<>());
            reportProgress("reading_trades", "近30天京东交易记录读取完成", 1, 1);
            return adjustments;
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
        return "(function(){if(window.__fundAppDetailTradeHook)return;window.__fundAppDetailTradeHook=true;var c='" + fundCode + "',sent={},started=Date.now(),last=Date.now(),opened=false;"
            + "function emit(x){try{window.FundAppDetailTrade&&window.FundAppDetailTrade.receive(JSON.stringify(x))}catch(e){}}"
            + "function isTradeRow(x){return !!(x&&typeof x==='object'&&(x.bizTime||x.tradeTime||x.confirmTime||x.orderCreateTime||x.tradeDate)&&(x.tradeTypeCode||x.tradeTypeName||x.tradeName||x.operationName||x.businessName||x.businessType||x.orderType)&&(x.unit||x.confirmUnit||x.tradeUnit||x.confirmShare||x.tradeShare||x.fundShare||x.applyShare||x.share||x.shares||x.allAmount||x.confirmAmount||x.tradeAmount||x.applyAmount||x.amount||x.money))}"
            + "function rows(v,out){if(Array.isArray(v)){var matched=v.filter(isTradeRow);if(matched.length){out.push.apply(out,matched);return}v.forEach(function(x){rows(x,out)});return}if(v&&typeof v==='object')Object.keys(v).forEach(function(k){rows(v[k],out)})}"
            // JD has changed the decoded transaction endpoint name repeatedly.
            // Do not guess from the URL. Only actual order-shaped rows cross the
            // bridge; this avoids sending unrelated page JSON to the grid API.
            + "function take(u,t){try{var v=JSON.parse(t),a=[];rows(v,a);if(!a.length)return;var k=JSON.stringify(a);if(sent[k])return;sent[k]=1;last=Date.now();emit({code:c,rows:a})}catch(e){}}"
            + "var open=XMLHttpRequest.prototype.open,send=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.open=function(){this.__fundAppUrl=String(arguments[1]||'');return open.apply(this,arguments)};XMLHttpRequest.prototype.send=function(){this.addEventListener('load',function(){take(this.__fundAppUrl||'',this.responseText||'')});return send.apply(this,arguments)};"
            + "if(window.fetch){var fetch0=window.fetch;window.fetch=function(){var u=String(arguments[0]||'');return fetch0.apply(this,arguments).then(function(r){r.clone().text().then(function(t){take(u,t)});return r})}}"
            + "function click(e){if(!e)return false;['pointerdown','mousedown','mouseup','click'].forEach(function(t){e.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}))});return true}"
            + "function textButton(text){return [].slice.call(document.querySelectorAll('a,button,[role=button],div,span,p')).find(function(e){return (e.innerText||e.textContent||'').trim()===text})}"
            + "var timer=setInterval(function(){var path=location.pathname||'',body=(document.body&&document.body.innerText)||'',more=textButton('加载更多'),tradePage=/交易类型|没有更多记录|暂无交易记录/.test(body)||!!more;if(tradePage){if(more){click(more);last=Date.now();return}if(/没有更多|已全部加载|暂无交易记录/.test(body)||Date.now()-last>1800){clearInterval(timer);emit({code:c,ready:true,done:true});return}}if(path.indexOf('/fund/hold/detail')>=0){var card=document.querySelector('.template-container[data-jue-name=\"fundTemplate1001Amount.jue\"]');if(!card)return;if(!window.__fundAppExpanded){var expand=card.querySelector('.arrow-container-down');if(expand){click(expand);window.__fundAppExpanded=true;return}}var minor=card.querySelector('.minor');if(!minor||!/持有份额|持仓成本价/.test(minor.innerText||''))return;if(!opened){var record=textButton('交易记录');if(record){opened=true;click(record);return}}if(Date.now()-started>12000){clearInterval(timer);emit({code:c,ready:false,reason:'Transaction record control was unavailable'});return}}if(Date.now()-started>12000){clearInterval(timer);emit({code:c,ready:false,reason:'Transaction page did not respond'});}},300)})();";
    }

    /** Hooks the decoded browser payload rather than replaying JD's encrypted trade API. */
    private String accountTradeBootstrap(String earliestDate) {
        return "(function(){if(window.__fundAppAccountTradeHook)return;window.__fundAppAccountTradeHook=true;var cutoff=" + JSONObject.quote(earliestDate) + ",sent={},started=Date.now(),last=started,hasRows=false,reached=false,parse0=JSON.parse;"
            + "function emit(x){try{window.FundAppAccountTrade&&window.FundAppAccountTrade.receive(JSON.stringify(x))}catch(e){}}"
            + "function isTradeRow(x){return !!(x&&typeof x==='object'&&(x.bizTime||x.tradeTime||x.confirmTime||x.orderCreateTime||x.tradeDate)&&(x.tradeTypeCode||x.tradeTypeName||x.tradeName||x.operationName||x.businessName||x.businessType||x.orderType)&&(x.productId||x.fundCode||x.sourceFundCode||x.fromFundCode)&&(x.unit||x.confirmUnit||x.tradeUnit||x.confirmShare||x.tradeShare||x.fundShare||x.applyShare||x.share||x.shares||x.allAmount||x.confirmAmount||x.tradeAmount||x.applyAmount||x.amount||x.money))}"
            + "function rows(v,out){if(Array.isArray(v)){var matched=v.filter(isTradeRow);if(matched.length){out.push.apply(out,matched);return}v.forEach(function(x){rows(x,out)});return}if(v&&typeof v==='object')Object.keys(v).forEach(function(k){rows(v[k],out)})}"
            + "function day(x){var t=String(x&&(x.bizTime||x.tradeTime||x.orderCreateTime||x.orderCreateDate||x.createTime||x.confirmTime||x.tradeDate)||'');var m=/(\\d{4})[-/.]?(\\d{1,2})[-/.]?(\\d{1,2})/.exec(t);return m?m[1]+'-'+('0'+m[2]).slice(-2)+'-'+('0'+m[3]).slice(-2):''}"
            + "function take(v){try{var a=[];rows(v,a);if(!a.length)return;var k=JSON.stringify(a);if(sent[k])return;sent[k]=1;var old=false;a.forEach(function(x){var d=day(x);if(d&&d<cutoff)old=true});if(old)reached=true;a=a.filter(function(x){var d=day(x);return d&&d>=cutoff});if(!a.length){last=Date.now();return}hasRows=true;last=Date.now();emit({rows:a})}catch(e){}}"
            + "JSON.parse=function(){var v=parse0.apply(this,arguments);take(v);return v};"
            + "var open=XMLHttpRequest.prototype.open,send=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.open=function(){this.__fundAppUrl=String(arguments[1]||'');return open.apply(this,arguments)};XMLHttpRequest.prototype.send=function(){this.addEventListener('load',function(){try{take(parse0(this.responseText||''))}catch(e){}});return send.apply(this,arguments)};"
            + "if(window.fetch){var fetch0=window.fetch;window.fetch=function(){return fetch0.apply(this,arguments).then(function(r){r.clone().text().then(function(t){try{take(parse0(t))}catch(e){}});return r})}}"
            + "function click(e){if(!e)return false;['pointerdown','mousedown','mouseup','click'].forEach(function(t){e.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}))});return true}"
            + "function textButton(text){return [].slice.call(document.querySelectorAll('a,button,[role=button],div,span,p')).find(function(e){return (e.innerText||e.textContent||'').trim()===text})}"
            + "var timer=setInterval(function(){if(reached){clearInterval(timer);emit({done:true});return}var body=(document.body&&document.body.innerText)||'',more=textButton('加载更多');if(more){click(more);last=Date.now();return}if(/没有更多|已全部加载|暂无交易记录/.test(body)||(hasRows&&Date.now()-last>2200)){clearInterval(timer);emit({done:true});return}if(Date.now()-started>32000){clearInterval(timer);emit({ready:false,reason:'京东交易记录读取超时'});return}try{window.scrollBy(0,window.innerHeight||600)}catch(e){}},350)})();";
    }

    private void appendAccountTradeRows(JSONArray rows, Set<String> currentCodes, JSArray target, Set<String> seen) {
        for (int index = 0; index < rows.length(); index++) {
            JSONObject row = rows.optJSONObject(index);
            if (row == null || !isEffectiveTrade(row)) continue;
            String type = resolveTradeType(row);
            if (type == null) continue;
            String code = resolveAccountTradeFundCode(row, currentCodes);
            String targetCode = normalizeFundCode(firstText(row, "targetProductId", "targetFundCode", "toFundCode"));
            if (!currentCodes.contains(code) && !("convert".equals(type) && currentCodes.contains(targetCode))) continue;
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
        for (String key : new String[] { "fundCode", "productId", "productCode", "fundId", "sourceFundCode", "fromFundCode", "sourceProductId", "fromProductId" }) {
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
            String code = normalizeFundCode(firstText(row, "fundCode", "productId", "sourceFundCode", "fromFundCode"));
            if (!code.matches("\\d{6}")) code = fundCode;
            // Use the order/business time first. The grid resolves its
            // confirmation NAV from this timestamp and the fund cut-off rule.
            String rawTime = firstText(row, "bizTime", "tradeTime", "orderCreateTime", "orderCreateDate", "createTime", "confirmTime", "tradeDate");
            String date = normalizeTradeDate(rawTime);
            if (date == null) continue;
            if (!isWithinTradeHistory(date)) continue;
            String shares = firstText(row, "unit", "confirmUnit", "tradeUnit", "confirmShare", "tradeShare", "fundShare", "applyShare", "share", "shares");
            String amount = firstText(row, "allAmount", "confirmAmount", "tradeAmount", "applyAmount", "amount", "money");
            String tradeTime = normalizeTradeTimestamp(rawTime);
            String id = firstText(row, "orderId", "bizOrderId", "tradeOrderId", "orderNo", "subOrderId", "id");
            if (id.isEmpty()) id = code + ":" + type + ":" + (tradeTime == null ? date : tradeTime) + ":" + shares + ":" + amount;
            if (!seen.add(id)) continue;
            JSObject item = new JSObject();
            item.put("id", id);
            item.put("code", code);
            item.put("name", firstText(row, "productName", "fundName", "sourceFundName", "fromFundName"));
            item.put("type", type);
            item.put("tradeDate", date);
            if (tradeTime != null) item.put("tradeTime", tradeTime);
            item.put("shares", shares);
            item.put("amount", amount);
            item.put("status", firstText(row, "orderStatusDesc", "orderStatusName", "statusName", "tradeStatus", "status", "orderStatus"));
            if ("convert".equals(type)) {
                item.put("targetCode", normalizeFundCode(firstText(row, "targetProductId", "targetFundCode", "toFundCode")));
                item.put("targetName", firstText(row, "targetProductName", "targetFundName", "toFundName"));
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
        String descriptor = (firstText(row, "tradeTypeCode") + " " + firstText(row, "tradeTypeName", "tradeName", "operationName", "businessName", "businessType", "orderType")).toLowerCase(Locale.ROOT);
        if (descriptor.contains("transform") || descriptor.contains("convert") || descriptor.contains("adjust_position") || descriptor.contains("转换") || descriptor.contains("调仓")) return "convert";
        if (descriptor.contains("sell") || descriptor.contains("redeem") || descriptor.contains("redemption") || descriptor.contains("赎回") || descriptor.contains("卖出") || descriptor.contains("转出")) return "reduce";
        if (descriptor.contains("buy") || descriptor.contains("purchase") || descriptor.contains("subscribe") || descriptor.contains("定投") || descriptor.contains("申购") || descriptor.contains("买入") || descriptor.contains("转入")) return "add";
        return null;
    }

    private boolean isEffectiveTrade(JSONObject row) {
        String status = firstText(row, "orderStatusDesc", "orderStatusName", "statusName", "tradeStatus", "status", "orderStatus").toLowerCase(Locale.ROOT);
        return !(status.contains("cancel") || status.contains("fail") || status.contains("refund") || status.contains("关闭") || status.contains("取消") || status.contains("失败") || status.contains("退款"));
    }

    private String normalizeTradeDate(String value) {
        String text = textValue(value).replace('T', ' ');
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
        String date = normalizeTradeDate(text);
        if (date == null) return null;
        java.util.regex.Matcher matcher = java.util.regex.Pattern.compile(".*?(\\d{2}:\\d{2})(?::(\\d{2}))?.*").matcher(text);
        return matcher.matches() ? date + " " + matcher.group(1) + (matcher.group(2) == null ? "" : ":" + matcher.group(2)) : null;
    }

    /** Include today and the preceding 29 Beijing calendar days. */
    private String getTradeHistoryStartDate() {
        Calendar calendar = Calendar.getInstance(TimeZone.getTimeZone("Asia/Shanghai"));
        calendar.set(Calendar.HOUR_OF_DAY, 0);
        calendar.set(Calendar.MINUTE, 0);
        calendar.set(Calendar.SECOND, 0);
        calendar.set(Calendar.MILLISECOND, 0);
        calendar.add(Calendar.DAY_OF_YEAR, -(TRADE_HISTORY_DAYS - 1));
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

    private boolean positiveNumber(String value) {
        try {
            return Double.parseDouble(textValue(value).replaceAll("[^0-9.\\-]", "")) > 0;
        } catch (Exception ignored) {
            return false;
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

        synchronized void receive(String value) {
            try {
                JSONObject response = new JSONObject(value);
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

    private static class AccountTradeBridge {
        private final AccountTradeCapture capture;

        AccountTradeBridge(AccountTradeCapture capture) {
            this.capture = capture;
        }

        @JavascriptInterface
        public void receive(String value) {
            capture.receive(value);
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

        FundTradeRows(String code, JSONArray rows) {
            this.code = code;
            this.rows = rows;
        }
    }

    private static class LoginRequiredException extends Exception {}
}
