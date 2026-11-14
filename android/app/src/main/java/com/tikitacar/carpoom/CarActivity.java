package com.tikitacar.carpoom;

import android.content.pm.PackageManager;
import android.os.Build;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;

/** 카품 Pleos 차량 앱 (dist/pleos-standalone.html). 가로 화면. */
public class CarActivity extends WebAppActivity {
    @Override
    protected String page() {
        return "pleos-standalone.html?app=1";
    }

    @Override
    protected int initialBackground() {
        return 0xFF17181B; // 차량 화면 어두운 테마 배경색
    }

    /** 휴대폰과 태블릿에서는 전체 화면으로 띄운다. 차량(Android Automotive)에서는 시스템 막대를 그대로 둔다. */
    @SuppressWarnings("deprecation") // Android 9, 10은 setSystemUiVisibility만 지원한다
    private void hideSystemBars() {
        if (getPackageManager().hasSystemFeature(PackageManager.FEATURE_AUTOMOTIVE)) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            View d = getWindow().getDecorView();
            d.setSystemUiVisibility(d.getSystemUiVisibility()
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }
}
