// 카품 UI 흐름 테스트 (headless Chromium) — node test/ui.test.js
// 브라우저는 test/browser.js가 찾는다(PLAYWRIGHT_PATH, CHROME_PATH 환경변수로 지정 가능). 지도 타일·경로는 인터넷이 필요하다.
const path = require('path');
const fs = require('fs');
const { launch } = require('./browser');

const FILE_BASE = 'file:///' + path.join(__dirname, '..', 'dist', 'carpoom-standalone.html').split(path.sep).join('/');
const FILE = FILE_BASE + '?nosplash=1&theme=light';
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
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 640 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'ko-KR',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const text = async () => await page.locator('#app').innerText();
  const click = async (sel) => {
    await page.locator(sel).first().click();
    await wait(80);
  };
  const clickText = async (t) => {
    await page.getByText(t, { exact: false }).first().click();
    await wait(80);
  };
  const noOverflow = async (label) => {
    const r = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
    }));
    ok(r.sw <= r.cw, `가로 스크롤 없음 (${label}) ${r.sw}/${r.cw}`);
  };
  const core = (fn, ...args) =>
    page.evaluate(
      ({ fn, args }) => {
        const c = window.__carpoom.core;
        return new Function('core', 'args', 'return (' + fn + ')(core, ...args)')(c, args);
      },
      { fn: fn.toString(), args },
    );

  console.log('\n[0] 첫 실행: 두 예시를 보고 화면 색 고르기');
  await page.goto(FILE_BASE + '?nosplash=1');
  await wait(300);
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch (e) {}
  });
  await page.reload();
  await wait(300);
  ok(
    (await text()).includes('화면을 어떻게 볼까요') && (await page.locator('[data-action="pickTheme"]').count()) === 2,
    '테마 고르기 화면 + 예시 2개',
  );
  await page.screenshot({ path: path.join(SHOTS, '00-theme-pick.png') });
  await click('[data-action="pickTheme"][data-v="light"]');
  await wait(150);
  ok(
    (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light' &&
      (await text()).includes('카품 Car Poom'),
    '밝게 선택 → 시작 화면',
  );
  await page.goto(FILE);
  await wait(300);
  ok((await text()).includes('카품 Car Poom'), '시작 화면 표시');
  await page.screenshot({ path: path.join(SHOTS, '01-welcome.png') });

  console.log('\n[1] 성인만 운전자 선택');
  await clickText('처음 시작하기');
  await page.fill('#f-name', '테스트아이');
  await clickText('아직 성인이 아니에요');
  await clickText('다음');
  await wait(150);
  ok((await text()).includes('어떤 역할로 시작할까요'), '역할 선택 화면');
  ok(await page.locator('[data-role="driver"]').isDisabled(), '어린이: 운전자 버튼 비활성');
  ok(!(await page.locator('[data-role="passenger"]').isDisabled()), '어린이: 동승자 선택 가능');
  await page.screenshot({ path: path.join(SHOTS, '02-role-child.png') });
  await click('[data-role="passenger"]');
  ok((await text()).includes('테스트아이님, 안녕하세요'), '동승자 홈 진입 + 인사');
  ok((await text()).includes('아직 초대받은 차량이 없어요'), '초대 없음 안내');
  await page.screenshot({ path: path.join(SHOTS, '03-home-noinvite.png') });
  await clickText('프로필');
  await clickText('계정 전환');
  await clickText('처음 시작하기');
  await page.fill('#f-name', '테스트성인');
  await clickText('네, 성인이에요');
  await clickText('다음');
  await wait(150);
  ok(!(await page.locator('[data-role="driver"]').isDisabled()), '성인: 운전자 선택 가능');
  await click('[data-role="driver"]');
  ok((await text()).includes('테스트성인님, 안녕하세요') && (await text()).includes('Pleos'), '운전자 홈 진입');

  console.log('\n[2][3] 권한 규칙: 하늘(12가 3456 권한 없음, 34나 7890 권한 있음)');
  await clickText('프로필');
  await clickText('계정 전환');
  await clickText('하늘');
  await wait(150);
  await clickText('내 자리 설정');
  await wait(150);
  ok((await text()).includes('확인만 가능'), '하늘, 12가 3456: 확인만 가능 표시');
  ok(await page.locator('#f-recline').isDisabled(), '등받이 슬라이더 비활성');
  ok(await page.locator('[data-action="saveProfile"]').isDisabled(), '저장 버튼 비활성');
  ok(await page.locator('[data-action="requestApply"]').isDisabled(), '차량 적용 요청 비활성');
  await page.screenshot({ path: path.join(SHOTS, '04-settings-locked.png'), fullPage: false });
  // 화면 우회 시도: 코어 직접 호출도 거부되어야 함
  const denied = await core((c) => {
    try {
      c.saveProfile('u_haneul', 'v_ioniq5', { recline: 90 });
      return 'saved';
    } catch (e) {
      return e.name;
    }
  });
  ok(denied === 'PermissionError', '화면 우회 저장 시도도 PermissionError');
  await page.selectOption('#f-vehicle', 'v_ioniq5b');
  await wait(150);
  ok(!(await page.locator('#f-recline').isDisabled()), '하늘, 34나 7890: 등받이 조작 가능 (차량별 권한)');
  ok(
    (await page.locator('#f-heat').isDisabled()) && (await text()).includes('이 차량 미지원'),
    '34나 7890 열선 미지원 → 토글 비활성 + 표시',
  );
  await page.screenshot({ path: path.join(SHOTS, '05-settings-casper.png') });

  console.log('\n[5] 설정 변경 ↔ 좌석 비주얼, 저장 후 재시작 유지');
  await clickText('프로필');
  await clickText('계정 전환');
  await clickText('영수');
  await wait(150);
  await clickText('내 자리 설정');
  await wait(200);
  await page.selectOption('#f-vehicle', 'v_ioniq5');
  await wait(150);
  const seatMode = await page.evaluate(() => document.getElementById('set-seat').dataset.mode);
  const probe = await page.evaluate(() => window.__carpoom.seat3d.probe());
  ok(
    seatMode === '3d' && probe.ok && probe.filled > 20,
    `3D 좌석 장면이 실제로 그려짐 (모드 ${seatMode}, 그려진 표본 ${probe.filled}/${probe.of})`,
  );
  const deg = () =>
    page.evaluate(() => ({
      shown: Number(document.getElementById('set-seat').dataset.recline),
      target: (window.__carpoom.seat3d.probe().target.recline * 180) / Math.PI,
    }));
  const before = await deg();
  await page.locator('#f-recline').fill('90');
  await page.locator('#f-recline').dispatchEvent('input');
  await wait(100);
  const after = await deg();
  ok(
    after.shown > before.shown && Math.abs(after.target - after.shown) < 0.1,
    `등받이 슬라이더 → 3D 등받이 각도 (${before.shown}° → ${after.shown}°)`,
  );
  await page.locator('#f-heat').check();
  await wait(200);
  const warm = await page.evaluate(() => ({
    flag: document.getElementById('set-seat').dataset.warm,
    heat: window.__carpoom.seat3d.probe().target.heat,
  }));
  ok(warm.flag === '1' && warm.heat > 0, `열선 켬 → 3D 좌석 패널이 따뜻한 색으로 (발광 목표 ${warm.heat.toFixed(2)})`);
  await click('[data-action="setRecline"][data-v="10"]');
  await wait(150);
  const preset = await page.evaluate(() => ({
    v: document.querySelector('#f-recline').value,
    d: document.getElementById('set-seat').dataset.recline,
  }));
  ok(preset.v === '10' && preset.d === '9.4', `쉬운 선택지 "곧게 앉기" → 슬라이더·3D 반영 (${preset.v}, ${preset.d}°)`);
  await page.locator('#f-recline').fill('90');
  await page.locator('#f-recline').dispatchEvent('input');
  await page.locator('#f-recline').dispatchEvent('change');
  await wait(150);
  ok((await text()).includes('저장하지 않은 변경'), '초안 상태 표시');
  await page.screenshot({ path: path.join(SHOTS, '06-settings-draft.png') });
  await click('[data-action="saveProfile"]');
  await wait(200);
  ok(
    (await text()).includes('저장된 값') && (await text()).includes('차량 적용 전'),
    '저장 완료 + 적용 상태 분리 표시',
  );
  await click('[data-action="requestApply"]');
  await wait(100);
  ok((await text()).includes('차량 응답 대기'), '적용 요청 → 응답 대기');
  await core((c) =>
    c.handleVehicleEvent({ type: 'APPLY_RESULT', userId: 'u_youngsoo', vehicleId: 'v_ioniq5', ok: true }),
  );
  await wait(150);
  ok((await text()).includes('차량 적용 완료'), '적용 성공 응답 반영');
  await page.reload();
  await wait(400);
  await clickText('내 자리 설정');
  await wait(200);
  const persisted = await page.evaluate(() => document.querySelector('#f-recline').value);
  const heat = await page.evaluate(() => document.querySelector('#f-heat').checked);
  ok(persisted === '90' && heat === true, `재시작 후 저장값 유지 (recline=${persisted}, heater=${heat})`);

  console.log('\n[4] 권한 회수 즉시 반영');
  await page.locator('#f-recline').fill('40');
  await page.locator('#f-recline').dispatchEvent('input');
  await wait(100);
  await core((c) => c.setPermission('u_jimin', 'v_ioniq5', 'u_youngsoo', false));
  await wait(250);
  ok((await text()).includes('설정 변경 권한이 없어요'), '회수 안내 배너 즉시 표시');
  ok(
    (await page.locator('[data-action="saveProfile"]').isDisabled()) && (await page.locator('#f-recline').isDisabled()),
    '저장·조작 즉시 잠김',
  );
  ok(
    (await page.evaluate(() => document.querySelector('#f-recline').value)) === '90',
    '권한 없어진 초안은 버리고 저장값 표시',
  );
  await page.screenshot({ path: path.join(SHOTS, '07-permission-revoked.png') });
  await core((c) => c.setPermission('u_jimin', 'v_ioniq5', 'u_youngsoo', true));
  await wait(250);
  ok(!(await page.locator('#f-recline').isDisabled()), '권한 재부여 즉시 반영');

  console.log('\n[6] 예약하지 않을 때 이동');
  await clickText('탑승 예약');
  await wait(150);
  ok((await text()).includes('차량 탑승을 예약할까요'), '예약 여부 질문');
  await clickText('아니요, 메인으로');
  await wait(100);
  ok((await text()).includes('영수님, 안녕하세요'), '메인으로 이동');
  await clickText('탑승 예약');
  await wait(100);
  await clickText('이전 단계로');
  await wait(100);
  ok((await text()).includes('영수님, 안녕하세요'), '이전 단계(홈)로 이동');

  console.log('\n[8-a] 위치 권한 거부 후에도 지도로 지정');
  await clickText('탑승 예약');
  await clickText('네, 예약할게요');
  await wait(200);
  ok(await page.locator('#map-pick').isVisible(), '지도 화면');
  await noOverflow('지도');
  await clickText('내 위치 사용');
  await wait(100);
  ok((await text()).includes('내 위치를 사용할까요'), '위치 권한 시트');
  await click('[data-action="locDecide"][data-v="0"]');
  await wait(150);
  ok((await text()).includes('위치 권한 거부됨'), '거부 상태 표시');
  ok(await page.locator('[data-action="confirmBooking"]').isDisabled(), '핀 없으면 요청 비활성');
  const box = await page.locator('#map-pick').boundingBox();
  await page.mouse.click(box.x + box.width * 0.33, box.y + box.height * 0.25);
  await wait(200);
  ok(
    /37\.\d{5}, 127\.\d{5}/.test(await text()) && !(await page.locator('[data-action="confirmBooking"]').isDisabled()),
    '실제 지도 탭 → 핀 좌표 + 요청 가능',
  );
  await page.screenshot({ path: path.join(SHOTS, '08-map-pin.png') });

  console.log('\n[7] 핀 → 희망 시간 → 요청 → 수락 → 대기');
  await page.fill('#f-note', '정문 벤치');
  await click('[data-action="setBookingTime"][data-min="20"]');
  await wait(120);
  ok(/\d{2}:\d{2}쯤 탈게요/.test(await text()), '희망 시간 20분 뒤 선택 → 시각 표시');
  await click('[data-action="confirmBooking"]');
  await wait(250);
  ok(
    (await text()).includes('운전자 확인을 기다리고 있어요') && /\d{2}:\d{2} 희망/.test(await text()),
    '요청 전송 → 대기 화면 + 희망 시간',
  );
  const bid = await core((c) => c.getActiveBooking('u_youngsoo').id);
  await page.reload();
  await wait(400);
  ok((await text()).includes('운전자 확인을 기다리고 있어요'), '재시작 후 대기 화면 복원');
  await clickText('탑승 예약');
  await wait(150);
  const cnt = await core((c) => Object.keys(c.state.bookings).length);
  const bid2 = await core((c) => c.getActiveBooking('u_youngsoo').id);
  ok(cnt === 1 && bid === bid2, '다시 열어도 예약 중복 생성 없음');
  await page.screenshot({ path: path.join(SHOTS, '09-waiting-requested.png') });
  // 운전자 화면에서 수락
  await clickText('프로필');
  await clickText('계정 전환');
  await clickText('지민');
  await wait(200);
  ok((await text()).includes('영수') && (await text()).includes('정문 벤치'), '운전자 홈에 픽업 요청 표시');
  await page.screenshot({ path: path.join(SHOTS, '10-driver-home-request.png') });
  await click('[data-action="decide"][data-v="1"]');
  await wait(200);
  await clickText('프로필');
  await clickText('계정 전환');
  await clickText('영수');
  await wait(300);
  ok((await text()).includes('운전자가 수락했어요') && (await text()).includes('기다려 주세요'), '수락 → 대기 화면');
  // 차량이 움직이는 동안 매 프레임 위치를 모아 모두 도로 위인지 확인
  // 차량이 움직이는 동안 매 프레임 위치를 모아, 모두 경로 선(도로) 위인지 확인한다
  const carTrack = () =>
    page.evaluate(
      () =>
        new Promise((res) => {
          const m = window.__carpoom.map,
            pts = [];
          const t0 = performance.now();
          const offRoute = (p, coords) => {
            let best = Infinity;
            const kx = 111320 * Math.cos((p.lat * Math.PI) / 180),
              ky = 110540;
            for (let i = 1; i < coords.length; i++) {
              const ax = (coords[i - 1][0] - p.lng) * kx,
                ay = (coords[i - 1][1] - p.lat) * ky,
                bx = (coords[i][0] - p.lng) * kx,
                by = (coords[i][1] - p.lat) * ky;
              const dx = bx - ax,
                dy = by - ay,
                L = dx * dx + dy * dy;
              const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
              best = Math.min(best, Math.hypot(ax + dx * t, ay + dy * t));
            }
            return best;
          };
          const tick = () => {
            const c = m.car,
              r = m.route;
            if (c && r && c.pos) pts.push({ d: c.d, target: c.target, len: c.len, off: offRoute(c.pos, r.coords) });
            if (performance.now() - t0 < 2600) requestAnimationFrame(tick);
            else res({ pts, source: r && r.source });
          };
          tick();
        }),
    );
  await page.evaluate(() => {
    window.__carpoom.map.reset();
    window.__carpoom.render();
  }); // 회사에서 다시 출발시켜 이동 전체를 관찰
  await page.waitForFunction(() => window.__carpoom.map.car && window.__carpoom.map.car.len > 0, null, {
    timeout: 10000,
  });
  const tr1 = await carTrack();
  const off1 = tr1.pts.filter((p) => p.off > 3);
  const moved1 = tr1.pts.length > 5 && Math.abs(tr1.pts[0].d - tr1.pts[tr1.pts.length - 1].d) > 50;
  ok(
    moved1 && off1.length === 0,
    `수락 후 차량이 도로 경로를 따라 이동 (${tr1.source}, 표본 ${tr1.pts.length}개, 경로 밖 ${off1.length}개)`,
  );
  await page.screenshot({ path: path.join(SHOTS, '11-waiting-accepted.png') });

  console.log('\n[9] 장애물 → 새 탑승 위치 반영');
  await clickText('프로필');
  await clickText('개발 메뉴 열기');
  await wait(150);
  await clickText('장애물 발생');
  await wait(150);
  await clickText('프로필로');
  await clickText('탑승 예약');
  await wait(300);
  ok(
    (await text()).includes('탑승 위치를 옮겨 주세요') && (await text()).includes('새 위치'),
    '장애물 안내 카드 + 새 위치 표시',
  );
  await page.screenshot({ path: path.join(SHOTS, '12-obstacle.png') });
  const oldLabel = await core((c) => c.getActiveBooking('u_youngsoo').pickupPoint.label);
  await clickText('새 위치로 이동할게요');
  await wait(250);
  const nb = await core((c) => {
    const b = c.getActiveBooking('u_youngsoo');
    return {
      label: b.pickupPoint.label,
      prev: b.previousPoint && b.previousPoint.label,
      sent: window.__carpoom.DemoGateway.sent.some((m) => m.type === 'PICKUP_POINT_UPDATED'),
    };
  });
  ok(
    nb.label !== oldLabel && nb.prev === oldLabel && nb.sent,
    `예약 위치 갱신 + 차량 전달 (${oldLabel} → ${nb.label})`,
  );
  ok((await text()).includes('탑승 위치가 변경되었어요'), '변경 완료 안내');

  console.log('\n[10] 50m 접근 → 도착 → 탑승 완료, 늦은 이벤트 무시');
  await core((c, id) => c.handleVehicleEvent({ type: 'VEHICLE_NEAR_50M', bookingId: id }), bid);
  const tr2 = await carTrack();
  await page
    .waitForFunction(
      () => {
        const c = window.__carpoom.map.car;
        return c && c.target > 0 && Math.abs(c.d - c.target) < 1;
      },
      null,
      { timeout: 10000 },
    )
    .catch(() => {});
  const off2 = tr2.pts.filter((p) => p.off > 3);
  const route2 = await page.evaluate(() => {
    const m = window.__carpoom.map,
      G = window.__carpoom.geo,
      r = m.route,
      c = m.car;
    const b = window.__carpoom.core.getActiveBooking('u_youngsoo');
    const e = r.coords[r.coords.length - 1];
    return { end: G.haversine({ lat: e[1], lng: e[0] }, b.pickupPoint), left: c.len - c.d };
  });
  ok(
    off2.length === 0 && route2.end < 40 && Math.abs(route2.left - 40) < 1,
    `위치 변경 후 새 경로도 도로 위, 새 탑승 위치까지 남은 거리 ${route2.left.toFixed(0)}m (경로 끝↔탑승 위치 ${route2.end.toFixed(0)}m, 경로 밖 ${off2.length}개)`,
  );
  ok((await text()).includes('곧 도착해요') && (await text()).includes('탑승을 준비해 주세요'), '50m 접근 알림');
  await page.screenshot({ path: path.join(SHOTS, '13-approaching.png') });
  await core((c, id) => c.handleVehicleEvent({ type: 'DRIVER_CALL_REQUEST', bookingId: id }), bid);
  await wait(300);
  ok((await text()).includes('운전자가 통화를 요청했어요'), '통화 요청 수신');
  await clickText('통화 테스트 화면');
  await wait(100);
  ok((await text()).includes('실제 통화가 연결되지 않아요'), '통화 테스트 화면은 연결됨으로 표시하지 않음');
  await click('.sheet [data-action="closeSheet"]');
  await wait(100);
  await core((c, id) => c.handleVehicleEvent({ type: 'VEHICLE_ARRIVED', bookingId: id }), bid);
  await wait(300);
  ok((await text()).includes('차량이 도착했어요'), '도착 상태');
  await core((c, id) => c.handleVehicleEvent({ type: 'BOARDING_COMPLETE', bookingId: id }), bid);
  await wait(300);
  ok((await text()).includes('탑승 완료'), '탑승 완료 상태');
  await page.screenshot({ path: path.join(SHOTS, '14-completed.png') });
  const late = await core((c, id) => {
    const r = c.handleVehicleEvent({ type: 'DRIVER_CANCEL', bookingId: id });
    return { applied: r.applied, status: c.state.bookings[id].status };
  }, bid);
  ok(!late.applied && late.status === 'COMPLETED', '완료 후 늦은 취소 이벤트 무시');
  ok((await text()).includes('다시 요청하기') && (await text()).includes('메인으로'), '완료 후 다음 행동 선택 가능');

  console.log('\n[8-b] 거절·취소 뒤 다음 행동');
  await clickText('다시 요청하기');
  await wait(200);
  const box2 = await page.locator('#map-pick').boundingBox();
  await page.mouse.click(box2.x + box2.width * 0.66, box2.y + box2.height * 0.5);
  await wait(150);
  await click('[data-action="confirmBooking"]');
  await wait(200);
  const bid3 = await core((c) => c.getActiveBooking('u_youngsoo').id);
  await core(
    (c, id) => c.handleVehicleEvent({ type: 'DRIVER_REJECT', bookingId: id, reason: '지금은 어려워요.' }),
    bid3,
  );
  await wait(300);
  ok(
    (await text()).includes('운전자가 거절했어요') && (await text()).includes('다시 요청하기'),
    '거절 결과 + 다음 행동',
  );
  await page.screenshot({ path: path.join(SHOTS, '15-rejected.png') });
  await clickText('다시 요청하기');
  await wait(200);
  const box3 = await page.locator('#map-pick').boundingBox();
  await page.mouse.click(box3.x + box3.width * 0.66, box3.y + box3.height * 0.5);
  await wait(150);
  await click('[data-action="confirmBooking"]');
  await wait(200);
  await clickText('픽업 취소');
  await wait(100);
  await clickText('취소할게요');
  await wait(250);
  ok(
    (await text()).includes('픽업이 취소되었어요') && (await text()).includes('메인으로'),
    '사용자 취소 → 결과 + 다음 행동',
  );

  console.log('\n[11] QR 만료 실패 → 재시도');
  await clickText('메인으로');
  await clickText('프로필');
  await clickText('계정 전환');
  await clickText('지민');
  await wait(200);
  await clickText('Pleos 연결');
  await wait(150);
  await clickText('QR 표시');
  await wait(100);
  ok((await text()).includes('남은 시간'), 'QR 발급 + 남은 시간');
  await page.screenshot({ path: path.join(SHOTS, '16-qr.png') });
  await clickText('만료시키기');
  await wait(100);
  await click('[data-action="scanQr"]');
  await wait(150);
  ok(
    (await text()).includes('QR이 만료되었어요') && (await text()).includes('다시 스캔'),
    '만료 QR → 실패 + 재스캔 안내',
  );
  await page.screenshot({ path: path.join(SHOTS, '17-qr-expired.png') });
  await clickText('새 QR 발급 후 다시 스캔');
  await wait(100);
  await click('[data-action="scanQr"]');
  await wait(150);
  ok((await text()).includes('이 차량에 연결할까요'), '유효 QR → 승인 대기 (읽기만으로 연결 안 됨)');
  const notYet = await core((c) => !c.state.pleosLinks['v_ioniq5']);
  ok(notYet, '승인 전 미연결');
  await clickText('승인하고 연결');
  await wait(200);
  ok((await text()).includes('연결됨'), '승인 후 연결 완료');

  console.log('\n[운전자] 초대·권한 관리');
  await click('.nav [data-view="dvehicles"]');
  await wait(150);
  ok((await text()).includes('초대한 동승자'), '차량·동승자 화면');
  const inviteBtn = page.locator('[data-action="invite"]').first();
  if (await inviteBtn.count()) {
    await inviteBtn.click();
    await wait(200);
    ok((await text()).includes('초대한 동승자'), '초대 실행');
  }
  await page.screenshot({ path: path.join(SHOTS, '18-driver-vehicles.png') });

  console.log('\n[12] 작은 화면·큰 글자·키보드');
  await ctx.close();
  const ctx2 = await browser.newContext({
    viewport: { width: 320, height: 480 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => errors.push(e.message));
  await p2.goto(FILE);
  await wait(300);
  await p2.evaluate(() => {
    try {
      localStorage.clear();
    } catch (e) {}
  });
  await p2.reload();
  await wait(300);
  const t2 = async () => p2.locator('#app').innerText();
  await p2.getByText('영수').first().click();
  await wait(200);
  await p2.evaluate(() => {
    const r = document.documentElement.scrollWidth <= document.documentElement.clientWidth;
    window.__ov = r;
  });
  ok(await p2.evaluate(() => window.__ov), '320px 홈: 가로 스크롤 없음');
  await p2.screenshot({ path: path.join(SHOTS, '19-small-home.png') });
  await p2.locator('.nav [data-view="profile"]').click();
  await wait(100);
  await p2.locator('#f-bigtext').check();
  await wait(200);
  await p2.locator('.nav [data-view="settings"]').click();
  await wait(200);
  ok(
    await p2.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
    '320px + 큰 글씨 설정 화면: 가로 스크롤 없음',
  );
  const saveVisible = await p2.evaluate(async () => {
    const b = document.querySelector('[data-action="saveProfile"]');
    b.scrollIntoView({ block: 'end' });
    await new Promise((r) => setTimeout(r, 100));
    const r = b.getBoundingClientRect();
    return r.bottom <= innerHeight + 1 && r.top >= 0 && r.height >= 52;
  });
  ok(saveVisible, '큰 글씨 + 작은 화면에서 저장 버튼 도달 가능, 높이 ≥52px');
  await p2.screenshot({ path: path.join(SHOTS, '20-small-bigtext-settings.png') });
  // 키보드가 열린 상황 모사: 가시 높이 260px
  await p2.setViewportSize({ width: 320, height: 260 });
  await wait(100);
  await p2.locator('#f-weight').focus();
  await wait(400);
  const weightVisible = await p2.evaluate(() => {
    const r = document.getElementById('f-weight').getBoundingClientRect();
    return r.top >= 0 && r.bottom <= innerHeight;
  });
  ok(weightVisible, '키보드 높이만큼 줄어든 화면에서 포커스한 입력란이 보임');
  const btnReach = await p2.evaluate(async () => {
    const b = document.querySelector('[data-action="saveProfile"]');
    b.scrollIntoView({ block: 'nearest' });
    await new Promise((r) => setTimeout(r, 100));
    const r = b.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= innerHeight + 1;
  });
  ok(btnReach, '키보드 열린 높이에서도 저장 버튼에 스크롤로 도달');
  await p2.screenshot({ path: path.join(SHOTS, '21-keyboard-height.png') });
  // 다크 테마
  await p2.setViewportSize({ width: 360, height: 640 });
  await wait(100);
  await p2.locator('.nav [data-view="profile"]').click();
  await wait(150);
  await p2.locator('[data-action="pickTheme"][data-v="dark"]').click();
  await wait(150);
  ok((await p2.evaluate(() => document.documentElement.dataset.theme)) === 'dark', '프로필에서 어둡게로 바꾸기');
  await p2.locator('.nav [data-view="home"]').click();
  await wait(400);
  await p2.screenshot({ path: path.join(SHOTS, '22-dark-home.png') });
  await p2.evaluate(() => {
    window.__carpoom.ui.theme = 'light';
    document.documentElement.dataset.theme = 'light';
    window.__carpoom.render();
  });

  console.log('\n[13] 모든 화면에서 글자가 세로로 쌓이지 않음 (320px·280px + 큰 글씨)');
  await p2.setViewportSize({ width: 320, height: 640 });
  await wait(100);
  // 텍스트 조각마다 줄 수와 줄 폭을 재서, 3줄 이상인데 한 줄 폭이 글자 3개 남짓이면 "세로 쌓임"으로 본다
  const squeezed = () =>
    p2.evaluate(() => {
      const bad = [];
      const app = document.getElementById('app');
      const w = document.createTreeWalker(app, NodeFilter.SHOW_TEXT);
      while (w.nextNode()) {
        const t = w.currentNode;
        const s = t.textContent.trim();
        if (s.length < 3) continue;
        const el = t.parentElement;
        if (!el || !el.getClientRects().length) continue;
        const r = document.createRange();
        r.selectNodeContents(t);
        const rects = [...r.getClientRects()].filter((x) => x.width > 0);
        if (!rects.length) continue;
        const fs = parseFloat(getComputedStyle(el).fontSize);
        const maxW = Math.max(...rects.map((x) => x.width));
        if (rects.length >= 3 && maxW < fs * 3.4)
          bad.push(`"${s.slice(0, 16)}" ${rects.length}줄·폭${Math.round(maxW)}`);
      }
      const ov = document.documentElement.scrollWidth > document.documentElement.clientWidth;
      return { bad, ov };
    });
  const p2core = (fn, ...args) =>
    p2.evaluate(
      ({ fn, args }) => new Function('core', 'args', 'return (' + fn + ')(core, ...args)')(window.__carpoom.core, args),
      { fn: fn.toString(), args },
    );
  const visit = async (label) => {
    await wait(200);
    const r = await squeezed();
    ok(
      !r.bad.length && !r.ov,
      `${label}: 세로 쌓임 ${r.bad.length ? r.bad.join(', ') : '없음'}${r.ov ? ' · 가로 넘침' : ''}`,
    );
  };
  const goView = (v) =>
    p2.evaluate((v) => {
      window.__carpoom.ui.view = v;
      window.__carpoom.render();
    }, v);
  const as = async (uid) => {
    await p2core((c, id) => c.switchUser(id), uid);
    await p2.evaluate(() => {
      window.__carpoom.ui.view = null;
      window.__carpoom.render();
    });
  };
  for (const W of [320, 280]) {
    // 280px: 갤럭시 Z 폴드 커버 화면 수준
    await p2.setViewportSize({ width: W, height: 640 });
    await wait(150);
    await p2core((c) => c.signOut());
    await p2.evaluate(() => {
      window.__carpoom.ui.view = 'welcome';
      window.__carpoom.render();
    });
    await visit(W + 'px 시작');
    await goView('signup');
    await visit(W + 'px 회원가입');
    await as('u_youngsoo');
    for (const v of ['home', 'settings', 'booking', 'map', 'profile', 'notifications', 'dev']) {
      await goView(v);
      await visit(W + 'px 영수 · ' + v);
    }
    await p2core((c) => {
      const b = c.createBooking('u_youngsoo', 'v_ioniq5', {
        lat: 37.498642,
        lng: 127.023415,
        label: '서초초등학교 앞',
      }).booking;
      if (b.status === 'REQUESTED') c.driverDecide('u_jimin', b.id, true);
      c.handleVehicleEvent({
        type: 'OBSTACLE_REPORTED',
        bookingId: b.id,
        point: { lat: 37.49905, lng: 127.02342, label: '서초초등학교에서 40m (앞쪽 약 45m)' },
        message: '앞쪽 지정된 탑승 장소로 조금 이동해 주세요.',
      });
      c.handleVehicleEvent({ type: 'DRIVER_CALL_REQUEST', bookingId: b.id });
    });
    await goView('waiting');
    await visit(W + 'px 영수 · 대기(장애물·통화 요청)');
    await p2.screenshot({ path: path.join(SHOTS, W + '-small-waiting.png') });
    await as('u_haneul');
    for (const v of ['home', 'settings']) {
      await goView(v);
      await visit(W + 'px 하늘 · ' + v);
    }
    await as('u_jimin');
    for (const v of ['dhome', 'dvehicles', 'dqr', 'profile']) {
      await goView(v);
      await visit(W + 'px 지민 · ' + v);
    }
    await goView('dvehicles');
    await p2.screenshot({ path: path.join(SHOTS, W + '-small-driver-vehicles.png') });
  }
  await ctx2.close();

  console.log('\n[14] 3D를 못 쓰는 기기에서는 2D 좌석으로 대체 (얼굴 없음)');
  const ctx3 = await browser.newContext({ viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true });
  await ctx3.addInitScript(() => {
    window.__CARPOOM_FORCE_2D = true;
  });
  const p3 = await ctx3.newPage();
  p3.on('pageerror', (e) => errors.push(e.message));
  await p3.goto(FILE);
  await wait(300);
  await p3.evaluate(() => {
    try {
      localStorage.clear();
    } catch (e) {}
  });
  await p3.reload();
  await wait(300);
  await p3.evaluate(() => {
    window.__carpoom.core.switchUser('u_youngsoo');
    window.__carpoom.ui.view = 'home';
    window.__carpoom.render();
  });
  await wait(300);
  const fb = await p3.evaluate(() => {
    const w = document.getElementById('home-seat');
    const svg = w.querySelector('svg.seatvis');
    return {
      mode: w.dataset.mode,
      svg: !!svg,
      face: svg ? /seat-face|class="mouth"/.test(svg.innerHTML) : null,
      canvas: !!w.querySelector('canvas'),
    };
  });
  ok(fb.mode === '2d' && fb.svg && !fb.canvas, `2D 대체 좌석 표시 (모드 ${fb.mode})`);
  ok(fb.face === false, '2D 좌석에 얼굴 없음');
  await p3.screenshot({ path: path.join(SHOTS, '25-fallback-2d.png') });
  await ctx3.close();
  await browser.close();

  console.log('\n콘솔/페이지 오류: ' + (errors.length ? errors.join('\n') : '없음'));
  ok(errors.length === 0, '브라우저 오류 없음');
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
