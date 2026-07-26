package com.fundapp.realtime;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Opens a fund detail in the official JD Finance app without handling account data. */
@CapacitorPlugin(name = "JdFund")
public class JdFundPlugin extends Plugin {
    private static final String JD_FINANCE_PACKAGE = "com.jd.jrapp";

    @PluginMethod
    public void openFundDetail(PluginCall call) {
        String code = call.getString("code", "").trim();
        if (!code.matches("\\d{6}")) {
            call.reject("Fund code must be six digits");
            return;
        }

        Uri detailUri = new Uri.Builder()
            .scheme("https")
            .authority("lc.jr.jd.com")
            .appendPath("finance")
            .appendPath("funddetail")
            .appendPath("home")
            .appendQueryParameter("fundCode", code)
            .appendQueryParameter("fundUtmSource", "340")
            .appendQueryParameter("fundUtmParam", "AppShare")
            .build();
        openJdUri(call, detailUri);
    }

    @PluginMethod
    public void openFundTrade(PluginCall call) {
        String code = call.getString("code", "").trim();
        String action = call.getString("action", "").trim();
        String requestedItemId = call.getString("itemId", "").trim();
        if (!code.matches("\\d{6}") || !(action.equals("buy") || action.equals("sell") || action.equals("convert"))) {
            call.reject("Invalid JD fund trade request");
            return;
        }

        Uri tradeUri;
        if (action.equals("buy")) {
            String itemId = requestedItemId.isEmpty() ? resolveBuyItemId(code) : requestedItemId;
            if (!itemId.matches("\\d{1,12}")) {
                call.reject("Invalid JD fund trade product ID");
                return;
            }
            tradeUri = new Uri.Builder()
                .scheme("https")
                .authority("lc.jr.jd.com")
                .appendPath("finance")
                .appendPath("fund")
                .appendPath("fundtrade")
                .appendPath("index")
                .appendQueryParameter("source", "app")
                .appendQueryParameter("itemId", itemId)
                .appendQueryParameter("version", "3")
                .appendQueryParameter("fundUtmSource", "310")
                .appendQueryParameter("fundUtmParam", "add_jjccxq")
                .appendQueryParameter("fromJumpType", "2")
                .appendQueryParameter("createOrdermaket", "310")
                .build();
        } else {
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
            tradeUri = builder.build();
        }
        openJdUri(call, tradeUri);
    }

    private String resolveBuyItemId(String code) {
        if (code.equals("100055")) return "107138";
        return "1" + code;
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
