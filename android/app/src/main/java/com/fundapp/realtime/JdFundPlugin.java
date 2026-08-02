package com.fundapp.realtime;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Opens a fund detail in the official JD Finance app without handling account data. */
@CapacitorPlugin(name = "JdFund")
public class JdFundPlugin extends Plugin {
    private static final String JD_FINANCE_PACKAGE = "com.jd.jrapp";
    private static final String BUY_RESOLVER_URL = "https://ms.jr.jd.com/gw2/generic/life/h5/m/getFundDetailPageInfoWithNoPin";
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void openFundDetail(PluginCall call) {
        String code = call.getString("code", "").trim();
        if (!code.matches("\\d{6}")) {
            call.reject("Fund code must be six digits");
            return;
        }

        openJdUri(call, buildFundDetailUri(code));
    }

    @PluginMethod
    public void openFundTrade(PluginCall call) {
        String code = call.getString("code", "").trim();
        String action = call.getString("action", "").trim();
        if (!code.matches("\\d{6}") || !(action.equals("buy") || action.equals("sell") || action.equals("convert"))) {
            call.reject("Invalid JD fund trade request");
            return;
        }

        if (action.equals("buy")) {
            openResolvedBuy(call, code);
            return;
        }

        Uri.Builder builder = new Uri.Builder()
            .scheme("https")
            .authority("lc.jr.jd.com")
            .appendPath("fund")
            .appendPath("newfundtrade")
            .appendPath("redeem")
            .appendQueryParameter("fundCode", code)
            .appendQueryParameter("distinctCode", "1")
            .appendQueryParameter("fromJumpType", "2")
            .appendQueryParameter("createOrdermaket", "310");
        if (action.equals("convert")) {
            builder.appendQueryParameter("curType", "transfer")
                .appendQueryParameter("hideTabFlag", "1");
        }
        Uri tradeUri = builder.build();
        openJdUri(call, tradeUri);
    }

    private void openResolvedBuy(PluginCall call, String code) {
        executor.execute(() -> {
            Uri targetUri;
            try {
                targetUri = requestCanonicalBuyUri(code);
            } catch (Exception error) {
                String capturedItemId = resolveCapturedBuyItemId(code);
                targetUri = capturedItemId.isEmpty() ? buildFundDetailUri(code) : buildBuyUri(capturedItemId);
            }
            Uri resolvedUri = targetUri;
            if (getActivity() == null) {
                call.reject("Unable to open JD Finance fund page");
                return;
            }
            getActivity().runOnUiThread(() -> openJdUri(call, resolvedUri));
        });
    }

    private Uri requestCanonicalBuyUri(String code) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(BUY_RESOLVER_URL).openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setConnectTimeout(12_000);
            connection.setReadTimeout(15_000);
            connection.setRequestProperty("Accept", "application/json, text/plain, */*");
            connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
            connection.setRequestProperty("Referer", buildFundDetailUri(code).toString());
            JSONObject request = new JSONObject()
                .put("itemId", "")
                .put("fundCode", code)
                .put("clientVersion", "8.2.30")
                .put("channel", "2");
            byte[] body = ("reqData=" + URLEncoder.encode(request.toString(), "UTF-8")).getBytes(StandardCharsets.UTF_8);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body);
            }
            int status = connection.getResponseCode();
            String response = readBody(status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream());
            if (status < 200 || status >= 300 || response.isEmpty()) throw new IllegalStateException("JD product lookup failed");

            JSONObject payload = new JSONObject(response);
            JSONObject resultData = payload.optJSONObject("resultData");
            JSONObject data = resultData == null ? null : resultData.optJSONObject("datas");
            JSONObject header = data == null ? null : data.optJSONObject("headerOfItem");
            String resolvedCode = header == null ? "" : header.optString("fundCode", "");
            if (!resolvedCode.isEmpty() && !code.equals(resolvedCode)) throw new IllegalStateException("JD product code mismatch");
            String resolvedItemId = header == null ? "" : header.optString("itemId", "");
            if (!resolvedItemId.matches("\\d{1,12}")) throw new IllegalStateException("JD product ID missing");
            JSONObject bottomButtons = data == null ? null : data.optJSONObject("bottomButtonOfItem");
            JSONObject purchaseButton = bottomButtons == null ? null : bottomButtons.optJSONObject("purchaseButton");
            JSONObject jumpData = purchaseButton == null ? null : purchaseButton.optJSONObject("jumpData");
            String jumpUrl = jumpData == null ? "" : jumpData.optString("jumpUrl", "");
            return validateBuyUri(jumpUrl, resolvedItemId);
        } finally {
            connection.disconnect();
        }
    }

    private Uri validateBuyUri(String jumpUrl, String resolvedItemId) {
        Uri uri = Uri.parse(jumpUrl);
        String path = uri.getPath() == null ? "" : uri.getPath();
        String itemId = uri.getQueryParameter("itemId");
        if (!"https".equals(uri.getScheme())
            || !"lc.jr.jd.com".equals(uri.getHost())
            || !("/finance/fund/fundtrade/index".equals(path) || "/finance/fund/fundtrade/index/".equals(path))
            || !"app".equals(uri.getQueryParameter("source"))
            || itemId == null
            || !itemId.matches("\\d{1,12}")
            || !resolvedItemId.equals(itemId)
            || !"3".equals(uri.getQueryParameter("version"))) {
            throw new IllegalStateException("Invalid JD purchase URL");
        }
        return uri;
    }

    private String resolveCapturedBuyItemId(String code) {
        if (code.equals("001470")) return "105457";
        if (code.equals("002112")) return "105109";
        if (code.equals("010524")) return "113000";
        if (code.equals("100055")) return "107138";
        return "";
    }

    private Uri buildBuyUri(String itemId) {
        return new Uri.Builder()
            .scheme("https")
            .authority("lc.jr.jd.com")
            .appendPath("finance")
            .appendPath("fund")
            .appendPath("fundtrade")
            .appendPath("index")
            .appendQueryParameter("source", "app")
            .appendQueryParameter("itemId", itemId)
            .appendQueryParameter("version", "3")
            .build();
    }

    private Uri buildFundDetailUri(String code) {
        return new Uri.Builder()
            .scheme("https")
            .authority("lc.jr.jd.com")
            .appendPath("finance")
            .appendPath("funddetail")
            .appendPath("home")
            .appendQueryParameter("fundCode", code)
            .appendQueryParameter("fundUtmSource", "340")
            .appendQueryParameter("fundUtmParam", "AppShare")
            .build();
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

    private void openJdUri(PluginCall call, Uri targetUri) {
        Uri schemeUri = new Uri.Builder()
            .scheme("jdmobile")
            .authority("share")
            .appendQueryParameter("jumpType", "7")
            .appendQueryParameter("jumpUrl", targetUri.toString())
            .build();

        Intent intent = new Intent(Intent.ACTION_VIEW, schemeUri)
            .addCategory(Intent.CATEGORY_BROWSABLE)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .setPackage(JD_FINANCE_PACKAGE);
        try {
            getActivity().startActivity(intent);
            JSObject result = new JSObject();
            result.put("opened", "jd-finance");
            call.resolve(result);
        } catch (ActivityNotFoundException error) {
            call.reject("未检测到京东金融客户端", error);
        } catch (Exception error) {
            call.reject("无法打开京东金融基金页", error);
        }
    }
}
