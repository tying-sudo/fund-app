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
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Reads a JD account through an interactive JD WebView. There is intentionally
 * no Cookie input API: session state stays inside Android's CookieManager.
 */
@CapacitorPlugin(name = "JdHoldings")
public class JdHoldingsPlugin extends Plugin {
    private static final String LOGIN_URL = "https://jdjr.jd.com/";
    private static final String HOLDINGS_URL = "https://ms.jr.jd.com/gw/generic/base/h5/m/fundHoldGroup";
    private static final String HOLDING_DETAIL_URL = "https://ms.jr.jd.com/gw/generic/jj/h5/m/getNewFundPositionDetail";
    private static final String FUND_DETAIL_PAGE_URL = "https://roma.jd.com/fund/hold/detail/?extJson=%s";
    private static final int MATCH_PARENT = ViewGroup.LayoutParams.MATCH_PARENT;
    private static final int WRAP_CONTENT = ViewGroup.LayoutParams.WRAP_CONTENT;
    private static final int DETAIL_TIMEOUT_SECONDS = 18;

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private PluginCall pendingCall;
    private Dialog loginDialog;
    private WebView loginWebView;
    private WebView detailWebView;
    private TextView statusView;
    private Button importButton;
    private boolean importInFlight;
    private String requestUserAgent = "Mozilla/5.0";

    @PluginMethod
    public void importHoldings(PluginCall call) {
        if (pendingCall != null || importInFlight) {
            call.reject("A JD import is already in progress");
            return;
        }
        call.setKeepAlive(true);
        pendingCall = call;
        reportProgress("login", "Open JD Finance and sign in", 0, 0);
        Activity activity = getActivity();
        if (activity == null) {
            finishWithError("Unable to open JD sign-in");
            return;
        }
        activity.runOnUiThread(this::showLoginDialog);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void showLoginDialog() {
        Activity activity = getActivity();
        if (activity == null || activity.isFinishing()) {
            finishWithError("Unable to open JD sign-in");
            return;
        }

        clearWebSession();
        loginDialog = new Dialog(activity, android.R.style.Theme_DeviceDefault_Light_NoActionBar);
        loginDialog.setCanceledOnTouchOutside(false);
        loginDialog.setOnCancelListener(ignored -> finishWithError("JD sign-in cancelled"));

        LinearLayout root = new LinearLayout(activity);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);

        LinearLayout header = new LinearLayout(activity);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(16), dp(10), dp(10), dp(8));
        header.setBackgroundColor(Color.rgb(250, 250, 250));

        TextView title = new TextView(activity);
        title.setText("JD Finance");
        title.setTextColor(Color.rgb(30, 30, 30));
        title.setTextSize(18);
        header.addView(title, new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1));

        Button cancel = new Button(activity);
        cancel.setText("Cancel");
        cancel.setOnClickListener(view -> finishWithError("JD sign-in cancelled"));
        header.addView(cancel, new LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT));
        root.addView(header, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        statusView = new TextView(activity);
        statusView.setText("Sign in, then select Read holdings.");
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
        importButton.setText("Read holdings");
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
            setStatus("Complete JD sign-in before reading holdings.");
            return;
        }

        importInFlight = true;
        if (importButton != null) importButton.setEnabled(false);
        setStatus("Reading current holdings...");
        reportProgress("reading_holdings", "Reading current JD holdings", 0, 0);
        PluginCall call = pendingCall;
        executor.execute(() -> {
            try {
                JSObject result = readPortfolio(sessionCookie);
                Activity activity = getActivity();
                if (activity != null) activity.runOnUiThread(() -> {
                    if (call == pendingCall) finishWithResult(result);
                });
            } catch (LoginRequiredException error) {
                Activity activity = getActivity();
                if (activity != null) activity.runOnUiThread(() -> resetImportState("JD session expired. Sign in again."));
            } catch (Exception error) {
                String message = error.getMessage();
                if (message == null || message.trim().isEmpty()) message = "Unable to read JD holdings.";
                String finalMessage = message;
                Activity activity = getActivity();
                if (activity != null) activity.runOnUiThread(() -> resetImportState(finalMessage));
            }
        });
    }

    private JSObject readPortfolio(String sessionCookie) throws Exception {
        JSArray holdings = readHoldingDetails(sessionCookie);
        JSObject result = new JSObject();
        result.put("items", holdings);
        result.put("adjustments", readCurrentHoldingTrades(sessionCookie, holdings));
        reportProgress("normalizing", "JD data is ready", 0, 0);
        return result;
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
        if (groups == null) throw new IllegalStateException("JD did not return current holdings");

        int total = 0;
        for (int groupIndex = 0; groupIndex < groups.length(); groupIndex++) {
            JSONObject group = groups.optJSONObject(groupIndex);
            JSONArray products = group == null ? null : group.optJSONArray("productList");
            total += products == null ? 0 : products.length();
        }

        JSArray holdings = new JSArray();
        int current = 0;
        for (int groupIndex = 0; groupIndex < groups.length(); groupIndex++) {
            JSONObject group = groups.optJSONObject(groupIndex);
            JSONArray products = group == null ? null : group.optJSONArray("productList");
            if (products == null) continue;
            for (int index = 0; index < products.length(); index++) {
                current++;
                reportProgress("reading_holdings", "Reading JD holding " + current + "/" + total, current, total);
                JSObject holding = readHoldingDetail(products.optJSONObject(index), sessionCookie);
                if (holding != null) holdings.put(holding);
            }
        }
        return holdings;
    }

    private JSObject readHoldingDetail(JSONObject product, String sessionCookie) throws Exception {
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
        JSONObject payload = requestJdPost(HOLDING_DETAIL_URL, request, sessionCookie);
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
        holding.put("detailExtJson", extJson);
        return holding;
    }

    private JSArray readCurrentHoldingTrades(String sessionCookie, JSArray holdings) throws Exception {
        JSArray adjustments = new JSArray();
        Set<String> seen = new HashSet<>();
        int total = holdings.length();
        for (int index = 0; index < total; index++) {
            JSONObject holding = holdings.optJSONObject(index);
            String code = holding == null ? "" : holding.optString("code", "").trim();
            String extJson = holding == null ? "" : holding.optString("detailExtJson", "").trim();
            if (!code.matches("\\d{6}") || extJson.isEmpty()) continue;
            reportProgress("reading_trades", "Reading JD records " + (index + 1) + "/" + total, index + 1, total);
            appendTradeRows(readFundTradeRows(sessionCookie, code, extJson), code, adjustments, seen);
        }
        return adjustments;
    }

    @SuppressLint("SetJavaScriptEnabled")
    private JSONArray readFundTradeRows(String sessionCookie, String fundCode, String extJson) throws Exception {
        DetailTradeCapture capture = new DetailTradeCapture(fundCode);
        CountDownLatch started = new CountDownLatch(1);
        Activity activity = getActivity();
        if (activity == null || activity.isFinishing()) throw new IllegalStateException("Activity is unavailable");

        activity.runOnUiThread(() -> {
            try {
                destroyDetailWebView();
                seedWebSession(sessionCookie);
                WebView view = createWebView(activity);
                view.addJavascriptInterface(new DetailTradeBridge(capture), "FundAppDetailTrade");
                view.setWebViewClient(new SecureJdWebViewClient() {
                    @Override
                    public void onPageFinished(WebView webView, String url) {
                        Uri uri = Uri.parse(url == null ? "" : url);
                        if (isJdUrl(uri) && (uri.getPath().contains("/fund/hold/detail") || uri.getPath().contains("/wealth/tradeorder/list"))) {
                            webView.evaluateJavascript(detailTradeBootstrap(fundCode), null);
                        }
                    }
                });
                detailWebView = view;
                view.loadUrl(String.format(Locale.ROOT, FUND_DETAIL_PAGE_URL, URLEncoder.encode(extJson, "UTF-8")));
            } catch (Exception error) {
                capture.fail("Unable to open the fund detail page");
            } finally {
                started.countDown();
            }
        });

        if (!started.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("Fund detail did not start");
        boolean completed = capture.done.await(DETAIL_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        activity.runOnUiThread(this::destroyDetailWebView);
        if (!completed || capture.failed || !capture.complete) {
            String reason = capture.failureReason();
            throw new IllegalStateException("JD fund " + fundCode + " transaction records were incomplete" + (reason.isEmpty() ? "" : ": " + reason));
        }
        return capture.rows();
    }

    /** The selectors below are bound to JD's confirmed holding-detail controls. */
    private String detailTradeBootstrap(String fundCode) {
        return "(function(){if(window.__fundAppDetailTradeHook)return;window.__fundAppDetailTradeHook=true;var c='" + fundCode + "',sent={},started=Date.now(),last=Date.now(),opened=false;"
            + "function emit(x){try{window.FundAppDetailTrade&&window.FundAppDetailTrade.receive(JSON.stringify(x))}catch(e){}}"
            + "function rows(v,out){if(Array.isArray(v)){if(v.length&&v.some(function(x){return x&&typeof x==='object'&&(x.bizTime||x.tradeTime||x.confirmTime||x.orderCreateTime||x.tradeDate)}))out.push.apply(out,v);else v.forEach(function(x){rows(x,out)});return}if(v&&typeof v==='object')Object.keys(v).forEach(function(k){rows(v[k],out)})}"
            + "function take(u,t){try{if(!/(trade|record|order)/i.test(u))return;var v=JSON.parse(t),a=[];rows(v,a);if(!a.length)return;var k=JSON.stringify(a);if(sent[k])return;sent[k]=1;last=Date.now();emit({code:c,rows:a})}catch(e){}}"
            + "var open=XMLHttpRequest.prototype.open,send=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.open=function(){this.__fundAppUrl=String(arguments[1]||'');return open.apply(this,arguments)};XMLHttpRequest.prototype.send=function(){this.addEventListener('load',function(){take(this.__fundAppUrl||'',this.responseText||'')});return send.apply(this,arguments)};"
            + "if(window.fetch){var fetch0=window.fetch;window.fetch=function(){var u=String(arguments[0]||'');return fetch0.apply(this,arguments).then(function(r){r.clone().text().then(function(t){take(u,t)});return r})}}"
            + "function click(e){if(!e)return false;['pointerdown','mousedown','mouseup','click'].forEach(function(t){e.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}))});return true}"
            + "function textButton(text){return [].slice.call(document.querySelectorAll('a,button,[role=button],div,span,p')).find(function(e){return (e.innerText||e.textContent||'').trim()===text})}"
            + "var timer=setInterval(function(){var path=location.pathname||'';if(path.indexOf('/fund/hold/detail')>=0){var card=document.querySelector('.template-container[data-jue-name=\"fundTemplate1001Amount.jue\"]');if(!card)return;if(!window.__fundAppExpanded){var expand=card.querySelector('.arrow-container-down');if(expand){click(expand);window.__fundAppExpanded=true;return}}var minor=card.querySelector('.minor');if(!minor||!/持有份额|持仓成本价/.test(minor.innerText||''))return;if(!opened){var record=textButton('交易记录');if(record){opened=true;click(record);return}}if(Date.now()-started>12000){clearInterval(timer);emit({code:c,ready:false,reason:'Transaction record control was unavailable'});}return}if(path.indexOf('/wealth/tradeorder/list')>=0){var body=(document.body&&document.body.innerText)||'',more=textButton('加载更多');if(more){click(more);last=Date.now();return}if(/没有更多|已全部加载|暂无交易记录/.test(body)||Date.now()-last>1800){clearInterval(timer);emit({code:c,ready:true,done:true});return}}if(Date.now()-started>12000){clearInterval(timer);emit({code:c,ready:false,reason:'Transaction page did not respond'});}},300)})();";
    }

    private void appendTradeRows(JSONArray rows, String fundCode, JSArray target, Set<String> seen) {
        for (int index = 0; index < rows.length(); index++) {
            JSONObject row = rows.optJSONObject(index);
            if (row == null || !isEffectiveTrade(row)) continue;
            String type = resolveTradeType(row);
            if (type == null) continue;
            String code = normalizeFundCode(firstText(row, "fundCode", "productId", "sourceFundCode", "fromFundCode"));
            if (!code.matches("\\d{6}")) code = fundCode;
            String rawTime = firstText(row, "confirmTime", "tradeTime", "bizTime", "orderCreateTime", "orderCreateDate", "createTime", "tradeDate");
            String date = normalizeTradeDate(rawTime);
            if (date == null) continue;
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

    private JSONObject requestJdPost(String endpoint, JSONObject request, String sessionCookie) throws Exception {
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
            connection.setRequestProperty("Referer", "https://roma.jd.com/");
            connection.setRequestProperty("User-Agent", requestUserAgent);
            byte[] body = ("reqData=" + URLEncoder.encode(request.toString(), "UTF-8")).getBytes(StandardCharsets.UTF_8);
            try (OutputStream output = connection.getOutputStream()) { output.write(body); }
            int status = connection.getResponseCode();
            String response = readBody(status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream());
            if (status == HttpURLConnection.HTTP_UNAUTHORIZED || status == HttpURLConnection.HTTP_FORBIDDEN || status >= 300) throw new LoginRequiredException();
            if (response.isEmpty()) throw new IllegalStateException("JD returned an empty response");
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
        String text = textValue(value);
        if (text.matches("\\d{4}-\\d{2}-\\d{2}.*")) return text.substring(0, 10);
        if (text.matches("\\d{8}.*")) return text.substring(0, 4) + "-" + text.substring(4, 6) + "-" + text.substring(6, 8);
        return null;
    }

    private String normalizeTradeTimestamp(String value) {
        String text = textValue(value).replace('T', ' ');
        String date = normalizeTradeDate(text);
        if (date == null) return null;
        java.util.regex.Matcher matcher = java.util.regex.Pattern.compile(".*?(\\d{2}:\\d{2})(?::(\\d{2}))?.*").matcher(text);
        return matcher.matches() ? date + " " + matcher.group(1) + (matcher.group(2) == null ? "" : ":" + matcher.group(2)) : null;
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
                cookies.setCookie("https://roma.jd.com", pair);
                cookies.setCookie("https://ms.jr.jd.com", pair);
            }
        }
        cookies.flush();
    }

    private void destroyDetailWebView() {
        if (detailWebView == null) return;
        detailWebView.stopLoading();
        detailWebView.removeAllViews();
        detailWebView.destroy();
        detailWebView = null;
    }

    private void resetImportState(String message) {
        importInFlight = false;
        if (importButton != null) importButton.setEnabled(true);
        setStatus(message);
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
        destroyDetailWebView();
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
            setStatus("JD certificate validation failed.");
        }
    }

    private static class DetailTradeCapture {
        private final String fundCode;
        private final CountDownLatch done = new CountDownLatch(1);
        private final JSArray rows = new JSArray();
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
                    fail(response.optString("reason", "JD transaction record is unavailable"));
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
                fail("Malformed JD transaction response");
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

    private static class LoginRequiredException extends Exception {}
}
