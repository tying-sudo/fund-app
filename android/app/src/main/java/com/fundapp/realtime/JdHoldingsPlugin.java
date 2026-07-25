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
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
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
import org.json.JSONTokener;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.HashSet;
import java.util.Iterator;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TimeZone;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/** Reads JD data with a one-time user-supplied Cookie; it is never stored, logged, or forwarded to our backend. */
@CapacitorPlugin(name = "JdHoldings")
public class JdHoldingsPlugin extends Plugin {
    private static final String LOGIN_URL = "https://jdjr.jd.com/";
    private static final String HOLDINGS_URL = "https://ms.jr.jd.com/gw2/generic/CreatorSer/h5/m/queryUserFundHoldInfo";
    private static final String NEW_HOLDINGS_URL = "https://ms.jr.jd.com/gw/generic/base/h5/m/fundHoldGroup";
    private static final String NEW_HOLDING_DETAIL_URL = "https://ms.jr.jd.com/gw/generic/jj/h5/m/getNewFundPositionDetail";
    // Captured from the current web flow: the holding list supplies extJson
    // and opens this Roma detail page. A fund code alone is not a valid
    // detail-page identity and must never be used to construct this URL.
    private static final String FUND_DETAIL_PAGE_URL = "https://roma.jd.com/fund/hold/detail/?extJson=%s";
    // Kept only while the old helper methods are removed in a follow-up
    // cleanup. No active import path calls this encrypted account-wide route.
    @Deprecated private static final String TRADE_LIST_URL = "https://ms.jr.jd.com/gw2/generic/cfGateway/newna/m/queryTradeOrderList";
    @Deprecated private static final String LEGACY_TRADE_LIST_URL = "https://ms.jr.jd.com/gw2/generic/cfGateway/h5/m/queryTradeOrderList";
    private static final int RECENT_TRADE_DAYS = 30;
    // The current JD H5 trade-order endpoint returns 20 rows per page when
    // pageSize is omitted. Keep this in sync with its real pagination so a
    // full first page is never mistaken for the end of the history.
    private static final int DETAIL_TRADE_PAGE_TIMEOUT_SECONDS = 12;
    @Deprecated private static final int TRADE_PAGE_SIZE = 20;
    @Deprecated private static final int MAX_TRADE_PAGES = 100;
    @Deprecated private static final String TRADE_LIST_REFERER = "https://roma.jd.com/wealth/tradeorder/list?pageShowType=1&businessCode=";
    @Deprecated private static final String TRADE_PAGE_URL = "https://roma.jd.com/wealth/tradeorder/list?pageShowType=1&businessCode=FUND&pageShowTitle=%E5%9F%BA%E9%87%91%E4%BA%A4%E6%98%93";
    @Deprecated private static final int TRADE_PAGE_TIMEOUT_SECONDS = 45;
    private static final int MATCH_PARENT = ViewGroup.LayoutParams.MATCH_PARENT;
    private static final int WRAP_CONTENT = ViewGroup.LayoutParams.WRAP_CONTENT;

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private PluginCall pendingCall;
    private Dialog loginDialog;
    private WebView loginWebView;
    private WebView tradeWebView;
    private TextView statusView;
    private Button importButton;
    private boolean importInFlight;
    private String requestUserAgent = "Mozilla/5.0";

    @PluginMethod
    public void importHoldings(PluginCall call) {
        if (pendingCall != null) {
            call.reject("京东登录窗口已打开");
            return;
        }

        call.setKeepAlive(true);
        pendingCall = call;
        reportProgress("login", "请在京东金融完成登录", 0, 0);
        getActivity().runOnUiThread(this::showLoginDialog);
    }

    @PluginMethod
    public void importHoldingsWithCookie(PluginCall call) {
        if (pendingCall != null || importInFlight) {
            call.reject("读取任务正在进行");
            return;
        }

        String sessionCookie = normalizeCookie(call.getString("cookie", ""));
        if (sessionCookie == null) {
            call.reject("请输入有效的京东 Cookie");
            return;
        }

        call.setKeepAlive(true);
        pendingCall = call;
        importInFlight = true;
        reportProgress("reading_holdings", "正在读取当前持仓...", 0, 0);
        executor.execute(() -> {
            try {
                JSObject result = requestPortfolio(sessionCookie);
                getActivity().runOnUiThread(() -> {
                    if (call == pendingCall) finishWithResult(result);
                });
            } catch (LoginRequiredException error) {
                getActivity().runOnUiThread(() -> finishWithError("京东交易时间线未能读取：当前持仓已验证，但该接口需要京东页面端加密调用"));
            } catch (Exception error) {
                String message = error.getMessage();
                if (message == null || message.trim().isEmpty()) message = "Unable to read JD holdings. Check Cookie and network.";
                final String visibleMessage = message;
                getActivity().runOnUiThread(() -> finishWithError(visibleMessage));
            }
        });
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
            finishWithError("无法打开京东登录页面");
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
        statusView.setText("完成登录后将自动读取基金持仓并关闭此页面");
        statusView.setTextColor(Color.rgb(95, 95, 95));
        statusView.setTextSize(13);
        statusView.setPadding(dp(16), dp(8), dp(16), dp(8));
        root.addView(statusView, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        loginWebView = new WebView(activity);
        WebSettings settings = loginWebView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        requestUserAgent = settings.getUserAgentString() + " FundApp";
        settings.setUserAgentString(requestUserAgent);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }

        loginWebView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !isJdUrl(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return !isJdUrl(Uri.parse(url));
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                setStatus("京东页面证书异常，已停止加载");
            }
        });
        root.addView(loginWebView, new LinearLayout.LayoutParams(MATCH_PARENT, 0, 1));

        LinearLayout footer = new LinearLayout(activity);
        footer.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
        footer.setPadding(dp(12), dp(8), dp(12), dp(12));

        importButton = new Button(activity);
        importButton.setText("读取持仓");
        importButton.setOnClickListener(view -> attemptImport(false));
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

    private void attemptImport(boolean automatic) {
        if (pendingCall == null || importInFlight) return;
        String cookie = CookieManager.getInstance().getCookie(HOLDINGS_URL);
        if (cookie == null || cookie.trim().isEmpty()) {
            if (!automatic) setStatus("请先在此页面完成京东登录");
            return;
        }

        importInFlight = true;
        reportProgress("reading_holdings", "正在读取当前持仓...", 0, 0);
        setStatus("正在读取当前持仓和本轮建仓交易记录...");
        if (importButton != null) importButton.setEnabled(false);
        final PluginCall call = pendingCall;
        final String sessionCookie = cookie;
        executor.execute(() -> {
            try {
                JSObject result = requestPortfolio(sessionCookie);
                getActivity().runOnUiThread(() -> {
                    if (call == pendingCall) finishWithResult(result);
                });
            } catch (LoginRequiredException error) {
                getActivity().runOnUiThread(() -> resetImportState("登录尚未完成，请继续登录后重试"));
            } catch (Exception error) {
                getActivity().runOnUiThread(() -> resetImportState("读取持仓失败，请检查网络后重试"));
            }
        });
    }

    private JSObject requestPortfolio(String sessionCookie) throws Exception {
        JSObject result = new JSObject();
        JSArray holdings = requestNewHoldingDetails(sessionCookie);
        result.put("items", holdings);
        setStatus("正在读取历史交易记录...");
        reportProgress("reading_trades", "正在读取历史交易记录...", 0, 0);
        result.put("adjustments", requestTradeListFromFundDetails(sessionCookie, holdings));
        reportProgress("normalizing", "正在整理交易记录...", 0, 0);
        return result;
    }

    /**
     * The legacy current-holding endpoint supplies market value and P/L only.
     * The new web holding page exposes the actual cost, unit cost, and shares
     * after following each fund's detail link, which is the only safe basis for
     * a grid import.
     */
    private JSArray requestNewHoldingDetails(String sessionCookie) throws Exception {
        JSONObject request = new JSONObject();
        request.put("clientVersion", "9.9.9");
        request.put("clientType", "android");
        request.put("apiVersion", 1);
        request.put("sortKey", "1");
        request.put("sortDirection", "DESC");
        request.put("viewType", "1");
        request.put("appChannel", "fund_jjcc");
        request.put("extParams", new JSONObject().put("channelCode", "outside"));
        JSONObject payload = requestJdPost(NEW_HOLDINGS_URL, request, sessionCookie, "https://roma.jd.com/");
        JSONObject fundData = payload.optJSONObject("resultData");
        fundData = fundData == null ? null : fundData.optJSONObject("resultData");
        fundData = fundData == null ? null : fundData.optJSONObject("fundData");
        JSONArray groups = fundData == null ? null : fundData.optJSONArray("fundList");
        if (groups == null) throw new IllegalStateException("missing new holdings");

        JSArray items = new JSArray();
        int total = 0;
        for (int groupIndex = 0; groupIndex < groups.length(); groupIndex++) {
            JSONObject group = groups.optJSONObject(groupIndex);
            JSONArray products = group == null ? null : group.optJSONArray("productList");
            total += products == null ? 0 : products.length();
        }
        int current = 0;
        for (int groupIndex = 0; groupIndex < groups.length(); groupIndex++) {
            JSONObject group = groups.optJSONObject(groupIndex);
            JSONArray products = group == null ? null : group.optJSONArray("productList");
            if (products == null) continue;
            for (int index = 0; index < products.length(); index++) {
                JSONObject product = products.optJSONObject(index);
                current++;
                reportProgress("reading_holdings", "正在读取京东持仓成本（" + current + "/" + total + "）...", current, total);
                JSObject item = requestNewHoldingDetail(product, sessionCookie);
                if (item != null) items.put(item);
            }
        }
        return items;
    }

    private JSObject requestNewHoldingDetail(JSONObject product, String sessionCookie) throws Exception {
        if (product == null) return null;
        JSONObject jumpData = product.optJSONObject("jumpData");
        JSONObject param = jumpData == null ? null : jumpData.optJSONObject("param");
        String extJson = resolveDetailExtJson(param);
        if (extJson.isEmpty()) return null;

        JSONObject request = new JSONObject();
        request.put("extJson", extJson);
        request.put("version", 202);
        request.put("clientVersion", "9.9.9");
        request.put("clientType", "h5");
        JSONObject payload = requestJdPost(NEW_HOLDING_DETAIL_URL, request, sessionCookie, "https://roma.jd.com/");
        JSONObject data = payload.optJSONObject("resultData");
        data = data == null ? null : data.optJSONObject("data");
        JSONObject pageInfo = data == null ? null : data.optJSONObject("pageInfo");
        String code = pageInfo == null ? "" : pageInfo.optString("fundCode", "").trim();
        if (!code.matches("\\d{6}")) return null;

        JSONArray templates = data.optJSONArray("templateList");
        JSONObject fundAmount = null;
        JSONObject fundIntro = null;
        if (templates != null) {
            for (int index = 0; index < templates.length(); index++) {
                JSONObject template = templates.optJSONObject(index);
                if (template == null) continue;
                JSONObject templateData = template.optJSONObject("templateData");
                JSONObject candidateAmount = templateData == null ? null : templateData.optJSONObject("fundAmount");
                if (candidateAmount != null) {
                    fundAmount = candidateAmount;
                    fundIntro = templateData.optJSONObject("fundIntro");
                    break;
                }
            }
        }
        if (fundAmount == null) return null;
        JSONObject minorData = fundAmount.optJSONObject("minorData");
        JSONObject majorData = fundAmount.optJSONObject("majorData");
        String shares = findLabeledValue(minorData == null ? null : minorData.optJSONArray("dataList"), "持有份额");
        String costAmount = findLabeledValue(minorData == null ? null : minorData.optJSONArray("dataList"), "持仓成本价");
        String costPrice = findLabeledValue(minorData == null ? null : minorData.optJSONArray("dataList"), "持仓成本单价");
        String amount = findLabeledValue(minorData == null ? null : minorData.optJSONArray("dataList"), "持有金额");
        // A few valid JD detail templates omit one display cost label. Shares
        // remain the authoritative current-holding anchor for the timeline
        // importer, so do not discard the fund for that missing display field.
        if (!hasCurrentPosition(amount, shares) || shares.isEmpty()) return null;

        JSObject item = new JSObject();
        item.put("code", code);
        item.put("name", fundIntro == null ? product.optString("productName", "") : fundIntro.optString("fundName", product.optString("productName", "")));
        item.put("amount", amount);
        item.put("yesterdayIncome", findLabeledValue(majorData == null ? null : majorData.optJSONArray("yieldList"), "昨日收益"));
        item.put("profit", findLabeledValue(majorData == null ? null : majorData.optJSONArray("yieldList"), "持有收益"));
        item.put("rate", findLabeledValue(majorData == null ? null : majorData.optJSONArray("yieldList"), "持有收益率"));
        item.put("shares", shares);
        if (!costAmount.isEmpty()) item.put("costAmount", costAmount);
        if (!costPrice.isEmpty()) item.put("costPrice", costPrice);
        item.put("detailExtJson", extJson);
        return item;
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
            connection.setRequestProperty("User-Agent", requestUserAgent);
            byte[] body = ("reqData=" + URLEncoder.encode(request.toString(), "UTF-8")).getBytes(StandardCharsets.UTF_8);
            try (OutputStream output = connection.getOutputStream()) { output.write(body); }
            int status = connection.getResponseCode();
            String response = readBody(status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream());
            if (status == HttpURLConnection.HTTP_UNAUTHORIZED || status == HttpURLConnection.HTTP_FORBIDDEN || status >= 300) throw new LoginRequiredException();
            if (response.isEmpty()) throw new IllegalStateException("empty response");
            JSONObject payload = new JSONObject(response);
            String message = payload.optString("resultMsg", payload.optString("message", ""));
            if (!payload.optBoolean("success", true) && (payload.optInt("resultCode") == 3 || containsLoginMessage(message))) throw new LoginRequiredException();
            return payload;
        } finally {
            connection.disconnect();
        }
    }

    private String resolveDetailExtJson(JSONObject param) throws Exception {
        if (param == null) return "";
        Object rawExtJson = param.opt("extJson");
        if (rawExtJson instanceof JSONObject) return rawExtJson.toString();
        String extJson = textValue(rawExtJson);
        if (extJson.startsWith("{") && extJson.endsWith("}")) return extJson;
        JSONObject built = new JSONObject();
        for (String key : new String[] { "productId", "distinctCode", "orderId", "distinctCodes", "flowFlag", "type", "fromJumpType", "buSku", "buSkus" }) {
            if (param.has(key)) built.put(key, param.opt(key));
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
     * The new JD web flow exposes a fund's transaction record from its own
     * holding-detail page. Read one current fund at a time so the response can
     * always be bound to that fund instead of guessing from an account-wide
     * encrypted order list.
     */
    private JSArray requestTradeListFromFundDetails(String sessionCookie, JSArray holdings) throws Exception {
        JSArray items = new JSArray();
        Set<String> seen = new HashSet<>();
        int total = holdings.length();
        for (int index = 0; index < total; index++) {
            JSONObject holding = holdings.optJSONObject(index);
            String code = holding == null ? "" : holding.optString("code", "").trim();
            if (!code.matches("\\d{6}")) continue;
            reportProgress("reading_trades", "Reading JD fund records " + (index + 1) + "/" + total, index + 1, total);
            String name = holding == null ? "" : holding.optString("name", "").trim();
            String extJson = holding == null ? "" : holding.optString("detailExtJson", "").trim();
            if (extJson.isEmpty()) throw new IllegalStateException("JD fund " + code + " is missing its web detail context");
            JSONArray rows = requestFundDetailTradeRows(sessionCookie, code, name, extJson);
            appendDetailTradeRows(rows, code, items, seen);
        }
        return items;
    }

    private JSONArray requestFundDetailTradeRows(String sessionCookie, String fundCode, String fundName, String extJson) throws Exception {
        DetailTradeCapture capture = new DetailTradeCapture(fundCode);
        CountDownLatch started = new CountDownLatch(1);
        Activity activity = getActivity();
        if (activity == null || activity.isFinishing()) throw new IllegalStateException("activity unavailable");

        activity.runOnUiThread(() -> {
            try {
                destroyTradeWebView();
                seedTradePageCookies(sessionCookie);
                WebView view = new WebView(activity);
                WebSettings settings = view.getSettings();
                settings.setJavaScriptEnabled(true);
                settings.setDomStorageEnabled(true);
                settings.setSupportMultipleWindows(false);
                settings.setJavaScriptCanOpenWindowsAutomatically(false);
                settings.setUserAgentString(settings.getUserAgentString() + " FundApp");
                view.addJavascriptInterface(new DetailTradeBridge(this, capture), "FundAppDetailTrade");
                view.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView webView, WebResourceRequest request) {
                        return request == null || !isJdUrl(request.getUrl());
                    }

                    @Override
                    public void onPageFinished(WebView webView, String url) {
                        Uri uri = Uri.parse(url == null ? "" : url);
                        // The only supported route is the detail page reached from
                        // the daily-income holding list and its own trade record.
                        // Do not fall back to the account-wide trade tab: JD does
                        // not show a complete per-fund timeline there.
                        // Roma is the actual host of the rendered fund detail
                        // page. It is a jd.com host, not a jr.jd.com host.
                        if (isJdUrl(uri) && (uri.getPath().contains("/fund/hold/detail")
                            || uri.getPath().contains("/wealth/tradeorder/list"))) {
                            webView.evaluateJavascript(detailTradeBootstrap(fundCode), null);
                        }
                    }
                });
                tradeWebView = view;
                view.loadUrl(String.format(Locale.ROOT, FUND_DETAIL_PAGE_URL, URLEncoder.encode(extJson, "UTF-8")));
            } catch (Exception error) {
                capture.fail();
            } finally {
                started.countDown();
            }
        });

        if (!started.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("fund detail did not start");
        boolean completed = capture.done.await(DETAIL_TRADE_PAGE_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        activity.runOnUiThread(this::destroyTradeWebView);
        if (!completed || capture.failed || !capture.complete) {
            String reason = capture.failureReason();
            throw new IllegalStateException("京东基金 " + fundCode + " 未能读取该基金的完整交易记录" + (reason.isEmpty() ? "" : "（" + reason + "）"));
        }
        return capture.rows();
    }

    private String detailTradeBootstrap(String fundCode) {
        return "(function(){if(window.__fundAppDetailTradeHook)return;window.__fundAppDetailTradeHook=true;var c='" + fundCode + "',sent={},started=Date.now(),last=Date.now(),opened=false;"
            + "function emit(x){try{if(window.FundAppDetailTrade)window.FundAppDetailTrade.receive(JSON.stringify(x))}catch(e){}}"
            + "function rows(v,out){if(Array.isArray(v)){if(v.length&&v.some(function(x){return x&&typeof x==='object'&&(x.bizTime||x.tradeTime||x.confirmTime||x.orderCreateTime||x.tradeDate)}))out.push.apply(out,v);else v.forEach(function(x){rows(x,out)});return}if(v&&typeof v==='object')Object.keys(v).forEach(function(k){rows(v[k],out)})}"
            + "function take(u,t){try{if(!/(trade|record|order)/i.test(u))return;var v=JSON.parse(t),a=[];rows(v,a);if(!a.length)return;var k=JSON.stringify(a);if(sent[k])return;sent[k]=1;last=Date.now();emit({code:c,rows:a})}catch(e){}}"
            + "var o=XMLHttpRequest.prototype.open,s=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.open=function(){this.__fundAppUrl=String(arguments[1]||'');return o.apply(this,arguments)};XMLHttpRequest.prototype.send=function(){this.addEventListener('load',function(){take(this.__fundAppUrl||'',this.responseText||'')});return s.apply(this,arguments)};"
            + "if(window.fetch){var f=window.fetch;window.fetch=function(){var u=String(arguments[0]||'');return f.apply(this,arguments).then(function(r){r.clone().text().then(function(t){take(u,t)});return r})}}"
            + "function click(e){if(!e)return false;['pointerdown','mousedown','mouseup','click'].forEach(function(type){e.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,view:window}))});return true}"
            + "function byText(text){return [].slice.call(document.querySelectorAll('a,button,[role=button],div,span,p')).filter(function(e){return (e.innerText||e.textContent||'').trim()===text})}"
            + "var t=setInterval(function(){var path=location.pathname||'';if(path.indexOf('/fund/hold/detail')>=0){var card=document.querySelector('.template-container[data-jue-name=\"fundTemplate1001Amount.jue\"]');if(!card)return;if(!window.__fundAppExpanded){var arrow=card.querySelector('.arrow-container-down');if(arrow){click(arrow);window.__fundAppExpanded=true;return}}var minor=card.querySelector('.minor');if(!minor||!/持有份额|持仓成本价/.test(minor.innerText||''))return;if(!opened){var record=byText('交易记录')[0];if(record){opened=true;click(record);return}}if(Date.now()-started>10500){clearInterval(t);emit({code:c,ready:false,reason:'未打开该基金交易记录'});}return}if(path.indexOf('/wealth/tradeorder/list')>=0){var body=(document.body&&document.body.innerText)||'';var more=byText('加载更多')[0];if(more){click(more);last=Date.now();return}if(/没有更多|已全部加载|暂无交易记录/.test(body)||Date.now()-last>2200){clearInterval(t);emit({code:c,ready:true,done:true});return}}if(Date.now()-started>10500){clearInterval(t);emit({code:c,ready:false,reason:'交易记录页面未返回'});}},360)})();";
    }

    private int appendDetailTradeRows(JSONArray rows, String fundCode, JSArray items, Set<String> seen) {
        int added = 0;
        for (int index = 0; index < rows.length(); index++) {
            JSONObject row = rows.optJSONObject(index);
            if (row == null || !isEffectiveTrade(row)) continue;
            String type = resolveTradeType(row);
            if (type == null) continue;
            String code = normalizeFundCode(firstText(row, "fundCode", "productId", "sourceFundCode", "fromFundCode"));
            if (!code.matches("\\d{6}")) code = fundCode;
            String rawTradeTime = firstText(row, "confirmTime", "tradeTime", "bizTime", "orderCreateTime", "orderCreateDate", "createTime", "tradeDate");
            String date = normalizeTradeDate(rawTradeTime);
            if (date == null) continue;
            String shares = firstText(row, "unit", "confirmUnit", "tradeUnit", "confirmShare", "tradeShare", "fundShare", "applyShare", "share", "shares");
            String amount = firstText(row, "allAmount", "confirmAmount", "tradeAmount", "applyAmount", "amount", "money");
            String id = firstText(row, "orderId", "bizOrderId", "tradeOrderId", "orderNo", "subOrderId", "id");
            String tradeTime = normalizeTradeTimestamp(rawTradeTime);
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
            items.put(item);
            added++;
        }
        return added;
    }

    /**
     * JD's live transaction route requires its own page-side encrypted request
     * contract. The WebView loads the exact transaction page and captures only
     * its already-decoded transaction rows; it never exposes Cookie or headers.
     */
    private JSArray requestTradeListFromJdPage(String sessionCookie, JSArray holdings) throws Exception {
        JSArray items = new JSArray();
        Set<String> seen = new HashSet<>();
        // A single authenticated page returns the complete cross-fund timeline.
        // Opening a page for every holding repeated the page bootstrap for each
        // fund; downstream reconciliation still retains only current positions.
        reportProgress("reading_trades", "正在通过京东交易页读取完整交易时间线...", 0, 0);
        JSONArray rows = requestTradePagesInJdPage(sessionCookie);
        appendTradeRows(rows, items, seen);
        return items;
    }

    private JSONArray requestTradePagesInJdPage(String sessionCookie) throws Exception {
        TradePageCapture capture = new TradePageCapture();
        CountDownLatch started = new CountDownLatch(1);
        Activity activity = getActivity();
        if (activity == null || activity.isFinishing()) throw new IllegalStateException("activity unavailable");

        activity.runOnUiThread(() -> {
            try {
                destroyTradeWebView();
                seedTradePageCookies(sessionCookie);
                WebView view = new WebView(activity);
                WebSettings settings = view.getSettings();
                settings.setJavaScriptEnabled(true);
                settings.setDomStorageEnabled(true);
                settings.setSupportMultipleWindows(false);
                settings.setJavaScriptCanOpenWindowsAutomatically(false);
                settings.setUserAgentString(settings.getUserAgentString() + " FundApp");
                view.addJavascriptInterface(new TradePageBridge(capture), "FundAppTrade");
                view.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView webView, WebResourceRequest request) {
                        return request == null || !isJdUrl(request.getUrl());
                    }

                    @Override
                    public WebResourceResponse shouldInterceptRequest(WebView webView, WebResourceRequest request) {
                        if (request != null && isTradePageScript(request.getUrl())) {
                            return injectTradeCaptureScript(request.getUrl());
                        }
                        return null;
                    }
                });
                tradeWebView = view;
                view.loadUrl(TRADE_PAGE_URL);
            } catch (Exception error) {
                capture.fail();
            } finally {
                started.countDown();
            }
        });

        if (!started.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("trade page did not start");
        boolean completed = capture.done.await(TRADE_PAGE_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        activity.runOnUiThread(this::destroyTradeWebView);
        if (!completed || capture.failed || !capture.complete) {
            throw new IllegalStateException("trade page did not return a complete timeline");
        }
        return capture.rows();
    }

    private void seedTradePageCookies(String sessionCookie) {
        CookieManager cookieManager = CookieManager.getInstance();
        for (String pair : sessionCookie.split(";\\s*")) {
            if (!pair.contains("=") || pair.startsWith("$")) continue;
            for (String origin : new String[] { "https://jdjr.jd.com", "https://lc.jr.jd.com", "https://dingpan.jd.com", "https://roma.jd.com", "https://ms.jr.jd.com", "https://jd.com" }) {
                cookieManager.setCookie(origin, pair);
            }
        }
        cookieManager.flush();
    }

    private boolean isTradePageScript(Uri uri) {
        String path = uri == null ? "" : uri.getPath();
        return path != null && path.contains("/wealth/tradeorder/js/page_tradeorder_") && path.endsWith(".js");
    }

    private WebResourceResponse injectTradeCaptureScript(Uri uri) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(uri.toString()).openConnection();
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(15_000);
            connection.setRequestProperty("Accept-Encoding", "identity");
            connection.setRequestProperty("User-Agent", requestUserAgent);
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) return null;
            String source = readBody(connection.getInputStream());
            // `queryTradeOrderList` is encrypted on the wire. Its own page
            // calls `converDataWith(p)` only after the page-side callback has
            // validated and decoded `e.data.tradeOrderVoList`; hook that
            // decoded handoff rather than XHR/fetch responseText.
            String methodMarker = "getTradeOrderData:function(){";
            String decodedRowsMarker = "t.converDataWith(p),t.updateInstance";
            if (!source.contains(methodMarker) || !source.contains(decodedRowsMarker)) return null;
            String patched = tradeCaptureBootstrap()
                + source.replace(methodMarker, "getTradeOrderData:function(){window.__fundAppTradePage=this;")
                    .replace(decodedRowsMarker,
                        "window.__fundAppTradeRows(p,t.pageNo,t.allCount),t.converDataWith(p),t.updateInstance");
            return new WebResourceResponse("application/javascript", "UTF-8", new ByteArrayInputStream(patched.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception ignored) {
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private String tradeCaptureBootstrap() {
        return "(function(){if(window.__fundAppTradeHook)return;window.__fundAppTradeHook=true;"
            + "window.__fundAppTradeRows=function(rows,page,allCount){try{if(!Array.isArray(rows)||!window.FundAppTrade)return;"
            + "var done=rows.length<20;window.FundAppTrade.receive(JSON.stringify({rows:rows,page:page,done:done,allCount:allCount||0}));"
            + "if(!done)setTimeout(function(){var q=window.__fundAppTradePage;if(q&&!q.netWorkLoading&&!q.isEnd)q.getTradeOrderData(true)},350)}catch(e){}}})();";
    }

    private void destroyTradeWebView() {
        if (tradeWebView == null) return;
        tradeWebView.stopLoading();
        tradeWebView.clearHistory();
        tradeWebView.loadUrl("about:blank");
        tradeWebView.destroy();
        tradeWebView = null;
    }

    private JSArray requestTradeList(String sessionCookie) throws Exception {
        JSArray items = new JSArray();
        Set<String> seen = new HashSet<>();
        for (int page = 1; page <= MAX_TRADE_PAGES; page++) {
            reportProgress("reading_trades", "正在读取历史交易记录（第 " + page + " 页）...", page, 0);
            JSONObject payload = requestTradePage(sessionCookie, page);
            JSONArray rows = findTradeRows(payload);
            if (rows == null || rows.length() == 0) break;

            appendTradeRows(rows, items, seen);
            if (!hasMoreTradePages(payload, rows.length(), page)) break;
        }
        return items;
    }

    private JSONObject requestTradePage(String sessionCookie, int page) throws Exception {
        Date end = new Date();
        Calendar start = Calendar.getInstance();
        start.add(Calendar.YEAR, -10);
        SimpleDateFormat formatter = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT);
        JSONObject request = new JSONObject();
        // Captured from the authenticated JD H5 trade-order page. The legacy
        // blank businessCode/H5 request returns no fund rows for current JD
        // accounts even though the page itself shows those transactions.
        request.put("businessCode", "FUND");
        request.put("tradeTypeCodeList", new JSONArray());
        request.put("pageNo", page);
        request.put("pageType", "na");
        request.put("title", "基金交易");
        request.put("orderCreateStartDate", formatter.format(start.getTime()));
        request.put("orderCreateEndDate", formatter.format(end));
        request.put("clientVersion", "999.999.999");
        request.put("clientType", "h5");

        JSONObject payload = requestTradePageFromEndpoint(TRADE_LIST_URL, request, sessionCookie);
        // Do not merge the two responses: one UI timeline must be the source
        // of truth. The legacy route is used only for JD clients where the
        // newna gateway is not yet available.
        return findTradeRows(payload) == null ? requestTradePageFromEndpoint(LEGACY_TRADE_LIST_URL, request, sessionCookie) : payload;
    }

    private JSONObject requestTradePageFromEndpoint(String endpoint, JSONObject request, String sessionCookie) throws Exception {
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
            connection.setRequestProperty("Referer", TRADE_LIST_REFERER);
            connection.setRequestProperty("User-Agent", requestUserAgent);
            byte[] body = ("reqData=" + URLEncoder.encode(request.toString(), "UTF-8")).getBytes(StandardCharsets.UTF_8);
            try (OutputStream output = connection.getOutputStream()) { output.write(body); }
            int status = connection.getResponseCode();
            String response = readBody(status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream());
            if (status == HttpURLConnection.HTTP_UNAUTHORIZED || status == HttpURLConnection.HTTP_FORBIDDEN || status >= 300) throw new LoginRequiredException();
            JSONObject payload = new JSONObject(response);
            String message = payload.optString("resultMsg", payload.optString("message", ""));
            if (!payload.optBoolean("success", true) && (payload.optInt("resultCode") == 3 || containsLoginMessage(message))) {
                throw new LoginRequiredException();
            }
            return payload;
        } finally {
            connection.disconnect();
        }
    }

    private JSONArray findTradeRows(JSONObject payload) {
        JSONObject resultData = payload.optJSONObject("resultData");
        JSONObject data = resultData == null ? null : resultData.optJSONObject("data");
        if (data == null) data = payload.optJSONObject("data");
        if (data == null) return null;
        for (String key : new String[] { "tradeOrderVoList", "tradeOrderList", "orderList", "list" }) {
            JSONArray rows = data.optJSONArray(key);
            if (rows != null) return rows;
        }
        return null;
    }

    private int appendTradeRows(JSONArray rows, JSArray items, Set<String> seen) {
        int added = 0;
        for (int index = 0; index < rows.length(); index++) {
            JSONObject row = rows.optJSONObject(index);
            if (row == null) continue;
            String type = resolveTradeType(row);
            if (type == null || !isEffectiveTrade(row)) continue;
            String sourceCode = normalizeFundCode(firstText(row, "sellProductId", "sourceProductId", "sourceFundCode", "fromFundCode", "fundCode"));
            String targetCode = normalizeFundCode(firstText(row, "productId", "targetProductId", "targetFundCode", "toFundCode", "fundCode"));
            String code = "convert".equals(type) ? sourceCode : targetCode;
            if ("convert".equals(type) && !code.matches("\\d{6}")) {
                code = normalizeFundCode(firstText(row, "productId", "fundCode"));
            }
            String rawTradeTime = firstText(row, "confirmTime", "tradeTime", "bizTime", "orderCreateTime", "orderCreateDate", "createTime");
            String date = normalizeTradeDate(rawTradeTime);
            if (!code.matches("\\d{6}") || date == null) continue;
            JSObject item = new JSObject();
            String shares = firstText(row, "unit", "confirmUnit", "tradeUnit", "confirmShare", "tradeShare", "fundShare", "applyShare", "share", "shares");
            String amount = firstText(row, "allAmount", "confirmAmount", "tradeAmount", "applyAmount", "amount", "money");
            String id = firstText(row, "orderId", "bizOrderId", "tradeOrderId", "orderNo", "subOrderId");
            String tradeTime = normalizeTradeTimestamp(rawTradeTime);
            if (id.isEmpty()) id = code + ":" + type + ":" + (tradeTime == null ? date : tradeTime) + ":" + shares + ":" + amount;
            if (!seen.add(id)) continue;
            item.put("id", id);
            item.put("code", code);
            item.put("name", "convert".equals(type)
                ? firstText(row, "sellProductName", "sourceProductName", "sourceFundName", "fromFundName", "fundName")
                : firstText(row, "productName", "fundName", "targetProductName", "targetFundName"));
            item.put("type", type);
            item.put("tradeDate", date);
            if (tradeTime != null) item.put("tradeTime", tradeTime);
            item.put("shares", shares);
            item.put("amount", amount);
            item.put("status", firstText(row, "orderStatusDesc", "orderStatusName", "statusName", "tradeStatus", "status", "orderStatus"));
            if ("convert".equals(type)) {
                item.put("targetCode", targetCode);
                item.put("targetName", firstText(row, "productName", "targetProductName", "targetFundName", "toFundName"));
                item.put("targetShares", firstText(row, "targetUnit", "targetShare", "targetShares", "targetFundShare", "toFundShare", "convertShare"));
            }
            items.put(item);
            added++;
        }
        return added;
    }

    /**
     * The JD trade list uses a product id, not a fund code. Fund products are
     * returned as `1` plus the six-digit fund code (for example 1026211 for
     * 026211); keeping the product id causes every transaction to be filtered
     * out before it reaches the grid importer.
     */
    private String normalizeFundCode(String value) {
        String candidate = textValue(value).trim();
        if (candidate.matches("\\d{6}")) return candidate;
        String digits = candidate.replaceAll("\\D", "");
        return digits.matches("1\\d{6}") ? digits.substring(1) : "";
    }

    private boolean hasMoreTradePages(JSONObject payload, int rowCount, int page) {
        JSONObject resultData = payload.optJSONObject("resultData");
        JSONObject data = resultData == null ? null : resultData.optJSONObject("data");
        if (data == null) data = payload.optJSONObject("data");
        if (data == null) return rowCount >= TRADE_PAGE_SIZE;
        for (String key : new String[] { "hasNext", "hasNextPage" }) {
            if (data.has(key)) return truthy(data.opt(key));
        }
        int totalPages = firstInt(data, "totalPage", "totalPages", "pageCount", "pages");
        if (totalPages > 0) return page < totalPages;
        int total = firstInt(data, "total", "totalCount", "recordCount");
        return total > 0 ? page * TRADE_PAGE_SIZE < total : rowCount >= TRADE_PAGE_SIZE;
    }

    private int firstInt(JSONObject row, String... keys) {
        for (String key : keys) {
            String value = textValue(row.opt(key));
            try {
                return Integer.parseInt(value);
            } catch (Exception ignored) {
                // Try the next known pagination field.
            }
        }
        return 0;
    }

    private boolean truthy(Object value) {
        if (value instanceof Boolean) return (Boolean) value;
        String text = textValue(value).toLowerCase(Locale.ROOT);
        return "true".equals(text) || "1".equals(text) || "yes".equals(text) || "y".equals(text);
    }

    private String resolveTradeType(JSONObject row) {
        String descriptor = (
            firstText(row, "tradeTypeCode") + " " +
            firstText(row, "tradeTypeName", "tradeName", "operationName", "businessName", "businessType", "orderType")
        ).toLowerCase(Locale.ROOT);
        if (descriptor.contains("transform") || descriptor.contains("convert") || descriptor.contains("adjust_position") || descriptor.contains("转换") || descriptor.contains("调仓")) return "convert";
        if (descriptor.contains("sell") || descriptor.contains("redeem") || descriptor.contains("redemption") || descriptor.contains("赎回") || descriptor.contains("卖出") || descriptor.contains("转出")) return "reduce";
        if (descriptor.contains("buy") || descriptor.contains("purchase") || descriptor.contains("subscribe") || descriptor.contains("定投") || descriptor.contains("申购") || descriptor.contains("买入") || descriptor.contains("转入")) return "add";
        return null;
    }

    private boolean isEffectiveTrade(JSONObject row) {
        String status = firstText(row, "orderStatusDesc", "orderStatusName", "statusName", "tradeStatus", "status", "orderStatus").toLowerCase(Locale.ROOT);
        return !(status.contains("cancel") || status.contains("fail") || status.contains("refund") || status.contains("关闭") || status.contains("取消") || status.contains("失败") || status.contains("退款"));
    }

    /**
     * The authenticated holdings endpoint accepts its request data as a JSON
     * query parameter. Asking for the recent window keeps the current holdings
     * snapshot authoritative while allowing newer responses to include the
     * user's latest buy, redemption, and conversion rows.
     */
    private String buildRecentPortfolioUrl() throws Exception {
        Calendar calendar = Calendar.getInstance();
        Date end = calendar.getTime();
        calendar.add(Calendar.DAY_OF_YEAR, -(RECENT_TRADE_DAYS - 1));
        SimpleDateFormat formatter = new SimpleDateFormat("yyyy-MM-dd", Locale.ROOT);
        JSONObject request = new JSONObject();
        request.put("startDate", formatter.format(calendar.getTime()));
        request.put("endDate", formatter.format(end));
        request.put("historyDays", RECENT_TRADE_DAYS);
        request.put("pageNo", 1);
        request.put("pageSize", 100);
        return HOLDINGS_URL + "?reqData=" + URLEncoder.encode(request.toString(), "UTF-8");
    }

    private JSArray parseHoldingPayload(JSONObject payload) throws Exception {
        String message = payload.optString("resultMsg", payload.optString("message", ""));
        if (!payload.optBoolean("success", true) && (payload.optInt("resultCode") == 3 || containsLoginMessage(message))) {
            throw new LoginRequiredException();
        }

        JSONObject data = findHoldingData(payload);
        if (data == null) throw new IllegalStateException("invalid holdings response");
        JSONArray holdings = data.optJSONArray("fundHoldingVOS");
        if (holdings == null) throw new IllegalStateException("missing holdings");

        JSArray items = new JSArray();
        for (int index = 0; index < holdings.length(); index++) {
            JSONObject row = holdings.optJSONObject(index);
            if (row == null) continue;
            String code = row.optString("fundCode", "").trim();
            String name = row.optString("fundName", "").trim();
            if (!code.matches("\\d{6}") || name.isEmpty()) continue;

            String amount = firstText(row, "amount", "marketValue", "marketAmount", "holdingAmount", "holdAmount", "holdAsset", "fundAsset", "fundMarketValue", "totalAsset", "totalAmount", "asset", "currentValue");
            String shares = firstText(row, "holdShare", "holdingShare", "fundShare", "shares", "share", "holdShares", "availableShare", "availableShares", "availableFundShare", "totalShare", "totalShares", "canRedeemShare");
            if (!hasCurrentPosition(amount, shares)) continue;

            JSObject item = new JSObject();
            item.put("code", code);
            item.put("name", name);
            item.put("amount", amount);
            item.put("yesterdayIncome", textValue(row.opt("yesterdayIncome")));
            String profitDate = normalizeTradeDate(firstText(row, "yesterdayIncomeDate", "incomeDate", "profitDate", "navDate", "netValueDate", "lastIncomeDate"));
            if (profitDate != null) item.put("profitDate", profitDate);
            item.put("profit", firstText(row, "holdIncome", "holdingIncome", "totalIncome", "profit", "holdingProfit", "totalProfit", "accumulatedIncome", "income", "incomeAmount"));
            item.put("rate", firstText(row, "holdRate", "holdingRate", "profitRate", "incomeRate", "totalRate"));
            item.put("shares", shares);
            item.put("costPrice", firstText(row, "costPrice", "holdCostPrice", "avgCost", "costNetValue", "costNetWorth", "costNav", "costUnitPrice"));
            item.put("costAmount", firstText(row, "costAmount", "holdCost", "holdCostAmount", "holdingCost", "totalCost", "costValue", "costAsset", "principal", "investedAmount"));
            String acquiredDate = normalizeTradeDate(firstText(row, "firstBuyDate", "buyDate", "purchaseDate", "holdingDate", "startDate", "costDate"));
            if (acquiredDate != null) item.put("acquiredDate", acquiredDate);
            items.put(item);
        }
        return items;
    }

    private JSArray parseRecentAdjustments(JSONObject payload) {
        JSArray items = new JSArray();
        collectTradeRows(payload, items, new HashSet<String>());
        return items;
    }

    private void collectTradeRows(Object value, JSArray items, Set<String> seen) {
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            for (int index = 0; index < array.length(); index++) {
                collectTradeRows(array.opt(index), items, seen);
            }
            return;
        }
        if (!(value instanceof JSONObject)) return;

        JSONObject row = (JSONObject) value;
        JSObject normalized = normalizeTradeRow(row);
        if (normalized != null) {
            String id = normalized.optString("id", "");
            if (seen.add(id)) items.put(normalized);
        }

        Iterator<String> keys = row.keys();
        while (keys.hasNext()) {
            Object child = row.opt(keys.next());
            if (child instanceof JSONObject || child instanceof JSONArray) collectTradeRows(child, items, seen);
        }
    }

    private JSObject normalizeTradeRow(JSONObject row) {
        String code = firstText(row, "fundCode", "sourceFundCode", "fromFundCode");
        String operation = firstText(row, "tradeType", "operationType", "businessType", "orderType", "tradeName", "operationName");
        String type = normalizeTradeType(operation);
        String rawTradeTime = firstText(row, "confirmTime", "tradeTime", "bizTime", "confirmDate", "applyTime", "tradeDate", "orderCreateTime", "createTime", "applyDate", "orderDate", "createDate", "date");
        String tradeDate = normalizeTradeDate(rawTradeTime);
        if (!code.matches("\\d{6}") || type == null || tradeDate == null) return null;

        JSObject item = new JSObject();
        String shares = firstText(row, "confirmShare", "tradeShare", "shares", "share", "fundShare");
        String amount = firstText(row, "confirmAmount", "tradeAmount", "amount", "applyAmount", "money");
        String id = firstText(row, "orderId", "tradeId", "serialNo", "requestNo", "id");
        String tradeTime = normalizeTradeTimestamp(rawTradeTime);
        item.put("id", id.isEmpty() ? code + ":" + type + ":" + (tradeTime == null ? tradeDate : tradeTime) + ":" + shares + ":" + amount : id);
        item.put("code", code);
        item.put("name", firstText(row, "fundName", "sourceFundName", "fromFundName"));
        item.put("type", type);
        item.put("tradeDate", tradeDate);
        if (tradeTime != null) item.put("tradeTime", tradeTime);
        item.put("shares", shares);
        item.put("amount", amount);
        if ("convert".equals(type)) {
            item.put("targetCode", firstText(row, "targetFundCode", "toFundCode", "convertFundCode"));
            item.put("targetName", firstText(row, "targetFundName", "toFundName", "convertFundName"));
            item.put("targetShares", firstText(row, "targetShare", "targetShares", "toFundShare", "convertShare"));
        }
        return item;
    }

    private String normalizeTradeType(String value) {
        String normalized = value == null ? "" : value.toLowerCase(Locale.ROOT);
        if (normalized.contains("转换") || normalized.contains("convert")) return "convert";
        if (normalized.contains("赎回") || normalized.contains("卖出") || normalized.contains("redemption") || normalized.contains("sell")) return "reduce";
        if (normalized.contains("申购") || normalized.contains("买入") || normalized.contains("定投") || normalized.contains("purchase") || normalized.contains("buy")) return "add";
        return null;
    }

    private String normalizeTradeDate(String value) {
        if (value == null) return null;
        String digits = value.replaceAll("[^0-9]", "");
        if (digits.length() < 8) return null;
        if ((digits.length() == 10 || digits.length() == 13) && !digits.startsWith("19") && !digits.startsWith("20")) {
            try {
                long epoch = Long.parseLong(digits.substring(0, Math.min(13, digits.length())));
                if (digits.length() == 10) epoch *= 1000;
                SimpleDateFormat formatter = new SimpleDateFormat("yyyy-MM-dd", Locale.ROOT);
                formatter.setTimeZone(TimeZone.getTimeZone("Asia/Shanghai"));
                return formatter.format(new Date(epoch));
            } catch (Exception ignored) {
                return null;
            }
        }
        return digits.substring(0, 4) + "-" + digits.substring(4, 6) + "-" + digits.substring(6, 8);
    }

    private String normalizeTradeTimestamp(String value) {
        if (value == null) return null;
        String digits = value.replaceAll("[^0-9]", "");
        if ((digits.length() == 10 || digits.length() == 13) && !digits.startsWith("19") && !digits.startsWith("20")) {
            try {
                long epoch = Long.parseLong(digits.substring(0, Math.min(13, digits.length())));
                if (digits.length() == 10) epoch *= 1000;
                SimpleDateFormat formatter = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT);
                formatter.setTimeZone(TimeZone.getTimeZone("Asia/Shanghai"));
                return formatter.format(new Date(epoch));
            } catch (Exception ignored) {
                return null;
            }
        }
        if (digits.length() < 12 || (!digits.startsWith("19") && !digits.startsWith("20"))) return null;
        String seconds = digits.length() >= 14 ? digits.substring(12, 14) : "00";
        return digits.substring(0, 4) + "-" + digits.substring(4, 6) + "-" + digits.substring(6, 8)
            + " " + digits.substring(8, 10) + ":" + digits.substring(10, 12) + ":" + seconds;
    }

    private boolean hasCurrentPosition(String amount, String shares) {
        boolean sawNumber = false;
        for (String value : new String[] { shares, amount }) {
            try {
                double parsed = Double.parseDouble(value.replaceAll("[,，￥¥$\\s]", ""));
                sawNumber = true;
                if (parsed > 0) return true;
            } catch (Exception ignored) {
                // Some JD fields are display objects or masked text; keep the row
                // unless both available numeric position fields explicitly equal zero.
            }
        }
        return !sawNumber;
    }

    private boolean isWithinRecentWindow(String date) {
        try {
            SimpleDateFormat formatter = new SimpleDateFormat("yyyy-MM-dd", Locale.ROOT);
            formatter.setLenient(false);
            Calendar start = Calendar.getInstance();
            start.add(Calendar.DAY_OF_YEAR, -(RECENT_TRADE_DAYS - 1));
            start.set(Calendar.HOUR_OF_DAY, 0);
            start.set(Calendar.MINUTE, 0);
            start.set(Calendar.SECOND, 0);
            start.set(Calendar.MILLISECOND, 0);
            return !formatter.parse(date).before(start.getTime());
        } catch (Exception ignored) {
            return false;
        }
    }

    private JSONObject findHoldingData(Object value) {
        if (value instanceof String) {
            try {
                return findHoldingData(new JSONTokener((String) value).nextValue());
            } catch (Exception ignored) {
                return null;
            }
        }
        if (value instanceof JSONArray) {
            JSONArray values = (JSONArray) value;
            for (int index = 0; index < values.length(); index++) {
                JSONObject found = findHoldingData(values.opt(index));
                if (found != null) return found;
            }
            return null;
        }
        if (!(value instanceof JSONObject)) return null;

        JSONObject object = (JSONObject) value;
        if (object.opt("fundHoldingVOS") instanceof JSONArray) return object;
        for (String key : new String[] { "resultData", "data", "datas" }) {
            JSONObject found = findHoldingData(object.opt(key));
            if (found != null) return found;
        }
        return null;
    }

    private String textValue(Object value) {
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            for (String key : new String[] { "text", "value", "amount", "number", "displayValue", "data" }) {
                String candidate = textValue(object.opt(key));
                if (!candidate.isEmpty()) return candidate;
            }
            return "";
        }
        return value == null || value == JSONObject.NULL ? "" : String.valueOf(value).trim();
    }

    private String firstText(JSONObject row, String... keys) {
        for (String key : keys) {
            String value = textValue(row.opt(key));
            if (!value.isEmpty()) return value;
        }
        return "";
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
        return normalized.equals("jd.com") || normalized.endsWith(".jd.com")
            || normalized.equals("jd.com.cn") || normalized.endsWith(".jd.com.cn");
    }

    private boolean isJdFinanceUrl(Uri uri) {
        String host = uri == null ? null : uri.getHost();
        return host != null && (host.equalsIgnoreCase("jdjr.jd.com") || host.endsWith(".jr.jd.com") || host.equalsIgnoreCase("dingpan.jd.com"));
    }

    private void receiveDetailTradeMessage(DetailTradeCapture capture, String value) {
        try {
            JSONObject message = new JSONObject(value);
            String detailUrl = message.optString("detailUrl", "").trim();
            Uri uri = Uri.parse(detailUrl);
            if (!detailUrl.isEmpty() && "dingpan.jd.com".equalsIgnoreCase(uri.getHost())
                && capture.fundCode.equals(uri.getQueryParameter("fundCode"))) {
                Activity activity = getActivity();
                if (activity != null && !activity.isFinishing()) {
                    activity.runOnUiThread(() -> {
                        if (tradeWebView != null) tradeWebView.loadUrl(detailUrl);
                    });
                }
            }
        } catch (Exception ignored) {
            // The capture class reports malformed terminal responses.
        }
        capture.receive(value);
    }

    private void resetImportState(String message) {
        importInFlight = false;
        if (importButton != null) importButton.setEnabled(true);
        setStatus(message);
    }

    private void finishWithResult(JSObject result) {
        PluginCall call = pendingCall;
        pendingCall = null;
        closeDialogAndClearSession();
        if (call != null) {
            call.resolve(result);
            bridge.releaseCall(call);
        }
    }

    private void finishWithError(String message) {
        PluginCall call = pendingCall;
        pendingCall = null;
        closeDialogAndClearSession();
        if (call != null) {
            call.reject(message);
            bridge.releaseCall(call);
        }
    }

    private void closeDialogAndClearSession() {
        importInFlight = false;
        if (loginDialog != null && loginDialog.isShowing()) loginDialog.dismiss();
        loginDialog = null;
        clearWebSession();
        loginWebView = null;
        statusView = null;
        importButton = null;
        requestUserAgent = "Mozilla/5.0";
    }

    private void clearWebSession() {
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.removeAllCookies(null);
        cookieManager.flush();
        destroyTradeWebView();
        if (loginWebView != null) {
            loginWebView.stopLoading();
            loginWebView.clearHistory();
            loginWebView.clearCache(true);
            loginWebView.loadUrl("about:blank");
            loginWebView.destroy();
        }
    }

    private void reportProgress(String stage, String message, int current, int total) {
        JSObject progress = new JSObject();
        progress.put("stage", stage);
        progress.put("message", message);
        progress.put("current", current);
        progress.put("total", total);
        notifyListeners("syncProgress", progress);
        setStatus(message);
    }

    private void setStatus(String message) {
        Activity activity = getActivity();
        if (activity == null) return;
        activity.runOnUiThread(() -> {
            if (statusView != null) statusView.setText(message);
        });
    }

    private int dp(int value) {
        return Math.round(value * getContext().getResources().getDisplayMetrics().density);
    }

    private static class TradePageCapture {
        private final CountDownLatch done = new CountDownLatch(1);
        private final java.util.Map<Integer, JSONArray> pages = new java.util.TreeMap<>();
        private boolean complete;
        private boolean failed;

        synchronized void receive(String value) {
            try {
                JSONObject response = new JSONObject(value);
                JSONArray rows = response.optJSONArray("rows");
                if (rows == null) return;
                int page = response.optInt("page", 0);
                if (page < 1) {
                    fail();
                    return;
                }
                // Loading events may fire twice while the list view updates.
                // Preserve the first decoded response for each JD page.
                if (!pages.containsKey(page)) pages.put(page, rows);
                if (response.optBoolean("done", false)) {
                    complete = true;
                    done.countDown();
                }
            } catch (Exception ignored) {
                fail();
            }
        }

        synchronized JSONArray rows() {
            JSONArray all = new JSONArray();
            for (JSONArray page : pages.values()) {
                for (int index = 0; index < page.length(); index++) all.put(page.opt(index));
            }
            return all;
        }

        synchronized void fail() {
            failed = true;
            done.countDown();
        }
    }

    private static class TradePageBridge {
        private final TradePageCapture capture;

        TradePageBridge(TradePageCapture capture) {
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
        private final List<JSONArray> responses = new ArrayList<>();
        private boolean complete;
        private boolean failed;
        private String failureReason = "";

        DetailTradeCapture(String fundCode) {
            this.fundCode = fundCode;
        }

        synchronized void receive(String value) {
            try {
                JSONObject response = new JSONObject(value);
                if (!fundCode.equals(response.optString("code", ""))) return;
                if (response.has("ready") && !response.optBoolean("ready", false)) {
                    fail(response.optString("reason", "transaction entry was unavailable"));
                    return;
                }
                JSONArray rows = response.optJSONArray("rows");
                if (rows != null) responses.add(rows);
                if (response.optBoolean("done", false)) {
                    complete = true;
                    done.countDown();
                }
            } catch (Exception ignored) {
                fail();
            }
        }

        synchronized JSONArray rows() {
            JSONArray all = new JSONArray();
            for (JSONArray response : responses) {
                for (int index = 0; index < response.length(); index++) all.put(response.opt(index));
            }
            return all;
        }

        synchronized void fail() {
            fail("");
        }

        synchronized void fail(String reason) {
            failed = true;
            if (failureReason.isEmpty() && reason != null) failureReason = reason.trim();
            done.countDown();
        }

        synchronized String failureReason() {
            return failureReason;
        }
    }

    private static class DetailTradeBridge {
        private final JdHoldingsPlugin plugin;
        private final DetailTradeCapture capture;

        DetailTradeBridge(JdHoldingsPlugin plugin, DetailTradeCapture capture) {
            this.plugin = plugin;
            this.capture = capture;
        }

        @JavascriptInterface
        public void receive(String value) {
            plugin.receiveDetailTradeMessage(capture, value);
        }
    }

    private static class LoginRequiredException extends Exception {}
}
