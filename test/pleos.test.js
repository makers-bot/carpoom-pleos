// 카품 Pleos 차량 앱 + 시연 무대 흐름 테스트 (headless Chromium) — node test/pleos.test.js
// 다이어그램 03(로그인·픽업 시작)·04(탑승 확인·좌석 수정)와 데모 시나리오를 그대로 따라간다. 지도 타일은 인터넷이 필요하다.
const path = require('path');
const fs = require('fs');
const { launch } = require('./browser');

const DIST = path.join(__dirname, '..', 'dist');
const url = (f, q) => 'file:///' + path.join(DIST, f).split(path.sep).join('/') + (q || '');
const SHOTS = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
let passed = 0,
  failed = 0;
const ok = (cond, msg) => {
  if (cond) {
    passed++;
    console.log('  ✔ ' + msg);
  } else {
    failed++;
    console.log('  ✘ ' + msg);
  }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await launch();
  const errors = [];
  const watch = (p) => {
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
  };

  console.log('\n[P1] 로그인 QR → 운전자 휴대폰 인증 → 3분할 화면');
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, locale: 'ko-KR' });
  const page = await ctx.newPage();
  watch(page);
  await page.goto(url('pleos-standalone.html', '?theme=dark'));
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await wait(1500);
  const text = () => page.locator('#display').innerText();
  const pl = (fn) => page.evaluate(fn);
  ok((await text()).includes('카품을 시작할게요') && (await page.locator('svg.qr').count()) === 1, 'QR 로그인 화면');
  ok(await pl(() => !!window.__pleos.core.state.pleosQr.v_ioniq5), 'Pleos가 띄운 QR을 공유 상태에 올림(모바일 스캔용)');
  await page.screenshot({ path: path.join(SHOTS, 'p01-login.png') });
  await page.click('[data-act="demoScan"]');
  await wait(1200);
  ok(
    (await page.locator('.alert').count()) === 1 &&
      (await page.locator('.mapp').count()) === 1 &&
      (await page.locator('.car').count()) === 1,
    '인증 후 알림·지도·좌석 3분할',
  );
  ok(
    (await page.locator('.rail button').count()) === 6 && (await page.locator('.rail').innerText()).includes('설정'),
    '왼쪽 앱 레일(운행·좌석·지도·전화·음악·설정)',
  );
  await page.waitForFunction(() => window.__pleos.map.ready || window.__pleos.map.failed, null, { timeout: 15000 });
  ok(await pl(() => window.__pleos.map.ready), '실제 지도(OpenFreeMap) 로드');

  console.log('\n[P2] 가족 픽업 요청 → 수락 → 좌석 배정');
  await page.click('[data-act="openDemo"]');
  await wait(200);
  await page.click('.modal [data-act="demoRequests"]');
  await wait(2200);
  ok(
    (await text()).includes('영수님이') &&
      (await text()).includes('탑승을 요청했어요') &&
      (await text()).includes('대기 2건'),
    '요청 배너(대기 2건)',
  );
  await page.click('[data-act="accept"]');
  await wait(300);
  ok((await text()).includes('기억한 조수석을 이번에도 쓸까요'), '기억한 좌석 사용 여부 질문');
  await page.click('[data-act="memYes"]');
  await wait(200);
  await page.click('[data-act="accept"]');
  await wait(600);
  ok((await text()).includes('픽업 순서') && (await text()).includes('안내 시작'), '두 요청 수락 → 픽업 순서 카드');
  const order = await pl(() => {
    const c = window.__pleos.core;
    const p = c.planPickups('v_ioniq5', { start: window.__pleos.ui.car, travel: window.CarpoomGeo.estRoadDistance });
    return p.order.map((id) => c.state.bookings[id].userId);
  });
  ok(order.join() === 'u_youngsoo,u_haneul', '아버지(지금 바로) → 딸(15분 뒤) 순서');
  ok(/거리만 보면 서초초등학교가 가깝지만/.test(await text()), '순서 이유 표시(거리 vs 희망 시간)');
  await page.screenshot({ path: path.join(SHOTS, 'p02-plan.png') });

  console.log('\n[P3] 안내 시작 → 50m 알림 → 도착 → 본인 선택 → 설정 적용');
  await page.click('[data-act="startDrive"]');
  await wait(1500);
  ok(await pl(() => !!window.__pleos.drive && window.__pleos.drive.d > 0), '운행 시작(차량 이동)');
  ok((await page.locator('.navcard').count()) === 1, '턴 안내 카드');
  ok(
    await pl(() => Object.values(window.__pleos.core.state.bookings).every((b) => b.plan)),
    '경로 확정 → 동승자에게 순서·도착 예정 전달',
  );
  await page.screenshot({ path: path.join(SHOTS, 'p03-driving.png') });
  await pl(() => window.__pleos.finish());
  await wait(1200);
  const st1 = await pl(() => window.__pleos.core.getActiveBooking('u_youngsoo').status);
  ok(st1 === 'ARRIVED', '도착 이벤트(ARRIVED)');
  ok(
    await pl(() =>
      window.__pleos.core.state.notifications.some((n) => n.userId === 'u_youngsoo' && n.title === '곧 도착해요'),
    ),
    '50m 전 탑승 준비 알림',
  );
  await wait(1700);
  ok((await text()).includes('탑승하신 분은 본인을 눌러 주세요'), '좌석 점유 감지 → 본인 선택 안내');
  await page.click('[data-act="iam"]');
  await wait(200);
  await page.click('[data-act="seatYes"]');
  await wait(600);
  ok((await text()).includes('설정 적용') && (await text()).includes('열선'), '좌석 설정 적용 내역 표시');
  ok(
    await pl(() => {
      const b = Object.values(window.__pleos.core.state.bookings).find((x) => x.userId === 'u_youngsoo');
      return b.status === 'COMPLETED' && b.settingsApplied && b.boardedSeatId === 'FR';
    }),
    '아버지 조수석 탑승·설정 적용',
  );
  await page.screenshot({ path: path.join(SHOTS, 'p04-applied.png') });

  console.log('\n[P4] 딸: 다른 자리에 앉음 → 수정할까요? → 실제 좌석으로 적용');
  await wait(4200);
  console.log('  · 장애물 → 동승자 확인 → 경로 다시 계산');
  await page.waitForFunction(
    () => window.__pleos.drive && !window.__pleos.drive.paused && window.__pleos.drive.idx === 1,
    null,
    { timeout: 15000 },
  );
  await pl(() => window.__pleos.act.demoObstacle());
  await wait(300);
  ok(
    await pl(() => {
      const b = window.__pleos.core.getActiveBooking('u_haneul');
      return !!(b.relocation && !b.relocation.confirmed);
    }),
    '주정차 차량 → 딸에게 새 탑승 위치 안내',
  );
  ok((await text()).includes('새 탑승 위치 안내'), 'Pleos 운행 카드에 확인 대기 표시');
  const oldKey = await pl(() => window.__pleos.drive.key);
  await pl(() => {
    const c = window.__pleos.core;
    c.confirmRelocation('u_haneul', c.getActiveBooking('u_haneul').id);
  });
  await page.waitForFunction(
    (k) => window.__pleos.drive && window.__pleos.drive.key !== k && !window.__pleos.drive.replanning,
    oldKey,
    { timeout: 15000 },
  );
  const rr = await pl(() => {
    const dv = window.__pleos.drive,
      b = window.__pleos.core.getActiveBooking('u_haneul');
    const e = dv.route.legEnds[dv.idx] != null ? dv.route.legEnds[dv.idx] : dv.route.length;
    const p = window.CarpoomGeo.pointAlong(dv.route, e);
    return window.CarpoomGeo.haversine(p, b.pickupPoint);
  });
  ok(rr < 30, `위치 확인 → 경로 다시 계산, 새 경로 끝↔새 탑승 위치 ${rr.toFixed(0)}m`);
  await page.screenshot({ path: path.join(SHOTS, 'p04b-obstacle.png') });
  await pl(() => {
    window.__pleos.ui.mismatchDemo = true;
    window.__pleos.finish();
  });
  await wait(3200);
  await page.click('[data-act="iam"]');
  await wait(200);
  const det = await pl(() => window.__pleos.ui.board.detected);
  ok(det === 'RL', '이미 앉은 조수석은 피하고 다른 빈자리 감지');
  await page.click('[data-act="seatYes"]');
  await wait(300);
  ok((await text()).includes('좌석 배정과 설정값을 바꿀까요'), '예정 좌석과 다름 → 수정 여부 질문');
  await page.screenshot({ path: path.join(SHOTS, 'p05-mismatch.png') });
  await page.click('[data-act="mismatchFix"]');
  await wait(500);
  ok(
    await pl(() => {
      const b = Object.values(window.__pleos.core.state.bookings).find((x) => x.userId === 'u_haneul');
      return b.seatId === 'RL' && b.settingsApplied;
    }),
    '실제 좌석(뒷좌석 왼쪽)으로 배정·적용',
  );
  await wait(4200);
  ok((await text()).includes('2명 모두 탔어요'), '픽업 완료');
  await page.click('[data-act="goHome"]');
  await wait(1500);
  ok(await pl(() => window.__pleos.drive && window.__pleos.drive.home), '집으로 안내');
  await page.screenshot({ path: path.join(SHOTS, 'p06-home.png') });

  console.log('\n[P5] 밝은 테마 · 좌석 대신 조정');
  await page.click('[data-act="openDemo"]');
  await wait(200);
  ok((await text()).includes('화면 색'), '설정(레일) → 화면 색 선택');
  await page.click('[data-act="setTheme"][data-v="light"]');
  await wait(300);
  await page.click('[data-act="closeModal"]');
  await wait(600);
  ok((await pl(() => document.documentElement.dataset.theme)) === 'light', '밝게 전환');
  await page.screenshot({ path: path.join(SHOTS, 'p07-light.png') });
  // APK: Pleos의 밝게/어둡게 설정(sys)을 앱 안 설정보다 먼저 따르고, 실행 중에 바뀌면 함께 바뀐다
  await page.goto(url('pleos-standalone.html', '?app=1&sys=dark'));
  await wait(1200);
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  ok((await theme()) === 'dark', 'APK: Pleos 어둡게 설정을 따라 시작(앱 안 설정은 밝게)');
  await page.evaluate(() => window.__setSysTheme('light'));
  await wait(500);
  ok((await theme()) === 'light', 'APK: 실행 중 Pleos를 밝게 바꾸면 함께 바뀜');
  await ctx.close();

  console.log('\n[P6] 시연 무대: 휴대폰 2대 ↔ Pleos 실시간 연동');
  const sctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: 'ko-KR' });
  const sp = await sctx.newPage();
  watch(sp);
  await sp.goto(url('stage.html'));
  await sp.evaluate(() => localStorage.clear());
  await sp.reload();
  await wait(3500);
  const dad = sp.frameLocator('#f-dad'),
    kid = sp.frameLocator('#f-kid'),
    car = sp.frameLocator('#f-car');
  const fr = (k) => sp.frames().find((f) => f.url().includes(k));
  await car.locator('[data-act="demoScan"]').click();
  await wait(1000);
  ok(
    await fr('user=u_youngsoo').evaluate(() => !!window.__carpoom.core.state.pleosLinks.v_ioniq5),
    'Pleos 로그인 → 휴대폰 상태에도 반영',
  );
  await dad.locator('.nav [data-view="booking"]').click();
  await dad.getByText('네, 예약할게요').click();
  await wait(1200);
  await dad.getByText('내 위치 사용').click();
  await dad.locator('[data-action="locDecide"][data-v="1"]').click();
  await wait(500);
  await dad.locator('[data-action="confirmBooking"]').click();
  await wait(1200);
  ok((await car.locator('#display').innerText()).includes('영수님이'), '아버지 휴대폰 요청 → Pleos 배너');
  await car.locator('[data-act="accept"]').click();
  await wait(300);
  await car.locator('[data-act="memYes"]').click();
  await wait(1000);
  ok((await dad.locator('#app').innerText()).includes('운전자가 수락했어요'), 'Pleos 수락 → 아버지 휴대폰 반영');
  await car.locator('[data-act="startDrive"]').click();
  await wait(3000);
  const liveOk = await fr('user=u_youngsoo').evaluate(() => {
    const l = window.__carpoom.map.liveData;
    return !!(l && l.pos && l.legs && Object.keys(l.legs).length);
  });
  ok(liveOk, 'Pleos 실시간 차량 위치·남은 경로 → 휴대폰 지도');
  await sp.screenshot({ path: path.join(SHOTS, 'p08-stage.png') });
  await sctx.close();

  await browser.close();
  console.log('\n콘솔/페이지 오류: ' + (errors.length ? errors.join('\n') : '없음'));
  ok(errors.length === 0, '브라우저 오류 없음');
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
