package com.user.booktower;

import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.content.Intent;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        if (bridge != null && bridge.getWebView() != null) {
            bridge.getWebView().addJavascriptInterface(new Object() {
                @JavascriptInterface
                public void startPinning() {
                    runOnUiThread(() -> {
                        try {
                            startLockTask();
                        } catch (Exception e) {
                            e.printStackTrace();
                        }
                    });
                }

                @JavascriptInterface
                public void stopPinning() {
                    runOnUiThread(() -> {
                        try {
                            stopLockTask();
                        } catch (Exception e) {
                            e.printStackTrace();
                        }
                    });
                }
            }, "AndroidPinning");
        }
    }
}
