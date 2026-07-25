package com.fundapp.realtime;

import android.os.Bundle;
import android.content.pm.ApplicationInfo;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        registerPlugin(InAppUpdatePlugin.class);
        registerPlugin(AlipayFundPlugin.class);
        registerPlugin(JdFundPlugin.class);
        registerPlugin(JdHoldingsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
