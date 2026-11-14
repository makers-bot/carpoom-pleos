package com.tikitacar.carpoom;

import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.os.Build;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;

/** 카품 Pleos 차량 앱 (dist/pleos-standalone.html). 가로 화면, Pleos의 밝게/어둡게 설정을 따른다. */
public class CarActivity extends WebAppActivity {
    private static boolean isNight(Configuration c) {
        return (c.uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }

    private static String themeOf(Configuration c) {
        return isNight(c) ? "dark" : "light";
    }

    @Override
    protected String page() {
        return "pleos-standalone.html?app=1&sys=" + themeOf(getResources().getConfiguration());
    }

    @Override
    protected int initialBackground() {
        return isNight(getResources().getConfiguration()) ? 0xFF17181B : 0xFFEDEEF2; // 차량 화면 배경색(어둡게/밝게)
    }

    /** 앱을 띄운 채 설정이 바뀌면(매니페스트의 configChanges에 uiMode가 있어 화면을 다시 만들지 않는다) 페이지에 알린다. */
    @Override
    public void onConfigurationChanged(Configuration c) {
        super.onConfigurationChanged(c);
        if (web == null) return;
        web.setBackgroundColor(isNight(c) ? 0xFF17181B : 0xFFEDEEF2);
        web.evaluateJavascript("window.__setSysTheme && window.__setSysTheme('" + themeOf(c) + "')", null);
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
