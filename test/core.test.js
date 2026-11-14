// 카품 코어 도메인 테스트 — node test/core.test.js
const assert = require('assert');
const C = require('../carpoom-core.js');
const { CarpoomCore, PermissionError, ValidationError, ROLE, BOOKING, APPLY, VEHICLE_EVENT, OUTBOUND } = C;

let passed = 0,
  failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✔ ' + name);
  } catch (e) {
    failed++;
    console.log('  ✘ ' + name + '\n      ' + (e.stack || e).toString().split('\n').slice(0, 3).join('\n      '));
  }
}
function fresh(opts) {
  let t = 1_000_000;
  const core = new CarpoomCore(Object.assign({ now: () => t }, opts || {}));
  core.tick = (ms) => {
    t += ms;
  };
  core.seedDemo();
  return core;
}
const PT = { x: 120, y: 200, label: '학교 정문' };

console.log('\n[1] 성인만 운전자 역할 선택');
test('성인 가입 → 운전자·동승자 모두 선택 가능', () => {
  const c = fresh();
  const u = c.signUp({ name: '성인', isAdult: true });
  assert.deepStrictEqual(c.availableRoles(u.id), [ROLE.DRIVER, ROLE.PASSENGER]);
  c.setRole(u.id, ROLE.DRIVER);
  assert.strictEqual(c.state.users[u.id].role, ROLE.DRIVER);
});
test('비성인 가입 → 운전자 선택 시 PermissionError', () => {
  const c = fresh();
  const u = c.signUp({ name: '아이', isAdult: false });
  assert.deepStrictEqual(c.availableRoles(u.id), [ROLE.PASSENGER]);
  assert.throws(() => c.setRole(u.id, ROLE.DRIVER), PermissionError);
  c.setRole(u.id, ROLE.PASSENGER);
  assert.strictEqual(c.state.users[u.id].role, ROLE.PASSENGER);
});
test('성인 여부는 실제 인증이 아님 (DEMO_SELF_DECLARED)', () => {
  const c = fresh();
  const u = c.signUp({ name: '성인', isAdult: true });
  assert.strictEqual(u.ageVerification.status, 'DEMO_SELF_DECLARED');
});
test('빈 이름 가입 거부', () => {
  const c = fresh();
  assert.throws(() => c.signUp({ name: '  ', isAdult: true }), ValidationError);
});

console.log('\n[2] 성인 동승자와 아이 모두 동일한 초대·권한 규칙');
test('초대 없음 → 성인도 아이도 저장 불가', () => {
  const c = fresh();
  const adult = c.signUp({ name: '손님', isAdult: true });
  c.setRole(adult.id, ROLE.PASSENGER);
  const kid = c.signUp({ name: '꼬마', isAdult: false });
  c.setRole(kid.id, ROLE.PASSENGER);
  for (const u of [adult, kid]) {
    assert.strictEqual(c.canEditSettings(u.id, 'v_ioniq5'), false);
    assert.throws(() => c.saveProfile(u.id, 'v_ioniq5', { recline: 50 }), PermissionError);
  }
});
test('초대만 있고 권한 없음 → 둘 다 저장 불가 / 권한 부여 후 둘 다 저장 가능', () => {
  const c = fresh();
  const adult = c.signUp({ name: '손님', isAdult: true });
  c.setRole(adult.id, ROLE.PASSENGER);
  const kid = c.signUp({ name: '꼬마', isAdult: false });
  c.setRole(kid.id, ROLE.PASSENGER);
  c.invite('u_jimin', 'v_ioniq5', adult.id);
  c.invite('u_jimin', 'v_ioniq5', kid.id);
  for (const u of [adult, kid]) {
    assert.strictEqual(c.membership(u.id, 'v_ioniq5').invited, true);
    assert.throws(() => c.saveProfile(u.id, 'v_ioniq5', { recline: 50 }), PermissionError);
  }
  c.setPermission('u_jimin', 'v_ioniq5', adult.id, true);
  c.setPermission('u_jimin', 'v_ioniq5', kid.id, true);
  for (const u of [adult, kid]) {
    const saved = c.saveProfile(u.id, 'v_ioniq5', { recline: 50 });
    assert.strictEqual(saved.recline, 50);
  }
});
test('운전자(소유자)가 아니면 초대·권한 관리 불가', () => {
  const c = fresh();
  assert.throws(() => c.invite('u_youngsoo', 'v_ioniq5', 'u_haneul'), PermissionError);
  assert.throws(() => c.setPermission('u_youngsoo', 'v_ioniq5', 'u_haneul', true), PermissionError);
});
test('초대와 권한은 차량별로 관리 (하늘: 12가 3456 권한 없음, 34나 7890 권한 있음)', () => {
  const c = fresh();
  assert.strictEqual(c.canEditSettings('u_haneul', 'v_ioniq5'), false);
  assert.strictEqual(c.canEditSettings('u_haneul', 'v_ioniq5b'), true);
});

console.log('\n[3] 권한 없는 사용자는 저장·차량 변경 요청·좌석 배정 변경 불가');
test('하늘(권한 없음) → saveProfile / requestApply / setSeatAssignment 모두 PermissionError', () => {
  const c = fresh();
  assert.throws(() => c.saveProfile('u_haneul', 'v_ioniq5', { recline: 80 }), PermissionError);
  assert.throws(() => c.requestApply('u_haneul', 'v_ioniq5'), PermissionError);
  assert.throws(() => c.setSeatAssignment('u_haneul', 'v_ioniq5', 'RL', true), PermissionError);
  assert.strictEqual(c.getProfile('u_haneul', 'v_ioniq5').saved.recline, 20, '저장값은 변하지 않아야 함');
});
test('권한 없는 사용자의 요청은 아웃바운드 메시지를 만들지 않음', () => {
  const c = fresh();
  const out = [];
  c.onOutbound((m) => out.push(m.type));
  try {
    c.requestApply('u_haneul', 'v_ioniq5');
  } catch (e) {
    /* expected */
  }
  assert.ok(!out.includes(OUTBOUND.APPLY_SETTINGS));
});
test('권한 있는 사용자 → 저장 후 적용 요청 → APPLY_SETTINGS 전송 → 응답으로 APPLIED/FAILED', () => {
  const c = fresh();
  const out = [];
  c.onOutbound((m) => out.push(m.type));
  c.saveProfile('u_youngsoo', 'v_ioniq5', { recline: 70, heater: { on: true, level: 3 } });
  const p = c.getProfile('u_youngsoo', 'v_ioniq5');
  assert.strictEqual(p.apply.status, APPLY.NONE, '저장만으로는 적용 완료가 아님');
  c.requestApply('u_youngsoo', 'v_ioniq5');
  assert.strictEqual(p.apply.status, APPLY.SENT);
  assert.ok(out.includes(OUTBOUND.APPLY_SETTINGS));
  c.handleVehicleEvent({
    type: VEHICLE_EVENT.APPLY_RESULT,
    userId: 'u_youngsoo',
    vehicleId: 'v_ioniq5',
    ok: false,
    message: '차량 오프라인',
  });
  assert.strictEqual(p.apply.status, APPLY.FAILED);
  c.requestApply('u_youngsoo', 'v_ioniq5');
  c.handleVehicleEvent({ type: VEHICLE_EVENT.APPLY_RESULT, userId: 'u_youngsoo', vehicleId: 'v_ioniq5', ok: true });
  assert.strictEqual(p.apply.status, APPLY.APPLIED);
});
test('차량 미지원 항목은 저장 시 기본값으로 정리 (34나 7890: 열선, 공조 없음)', () => {
  const c = fresh();
  const saved = c.saveProfile('u_haneul', 'v_ioniq5b', {
    heater: { on: true, level: 3 },
    climate: { on: true, temp: 18, fan: 5 },
    recline: 60,
  });
  assert.strictEqual(saved.heater.on, false);
  assert.strictEqual(saved.climate.on, false);
  assert.strictEqual(saved.recline, 60);
});
test('몸무게는 선택 입력, 범위 밖이면 null', () => {
  const c = fresh();
  assert.strictEqual(c.saveProfile('u_youngsoo', 'v_ioniq5', { weightKg: 62 }).weightKg, 62);
  assert.strictEqual(c.saveProfile('u_youngsoo', 'v_ioniq5', { weightKg: 0 }).weightKg, null);
  assert.strictEqual(c.saveProfile('u_youngsoo', 'v_ioniq5', { weightKg: '' }).weightKg, null);
});

console.log('\n[4] 권한 회수가 즉시 반영 (구독자에게 통지, 이후 저장 거부)');
test('권한 회수 → subscribe 콜백 호출 + canEditSettings false + 저장 거부', () => {
  const c = fresh();
  let notified = 0;
  c.subscribe((s, reason) => {
    if (reason === 'permission') notified++;
  });
  assert.strictEqual(c.canEditSettings('u_youngsoo', 'v_ioniq5'), true);
  c.setPermission('u_jimin', 'v_ioniq5', 'u_youngsoo', false);
  assert.strictEqual(notified, 1);
  assert.strictEqual(c.canEditSettings('u_youngsoo', 'v_ioniq5'), false);
  assert.throws(() => c.saveProfile('u_youngsoo', 'v_ioniq5', { recline: 10 }), PermissionError);
  assert.ok(c.state.notifications.some((n) => n.userId === 'u_youngsoo' && n.kind === 'permission'));
});

console.log('\n[5] 저장값 영속 (persist 어댑터로 저장 → 새 코어에 복원)');
test('persist.save 호출 후 상태 복원', () => {
  let stored = null;
  const c = fresh({
    persist: {
      save: (s) => {
        stored = JSON.stringify(s);
      },
    },
  });
  c.saveProfile('u_youngsoo', 'v_ioniq5', { recline: 77 });
  const c2 = new CarpoomCore({ state: JSON.parse(stored) });
  assert.strictEqual(c2.getProfile('u_youngsoo', 'v_ioniq5').saved.recline, 77);
});

console.log('\n[7] 핀 지정 → 예약 요청 → 수락 → 대기 흐름');
test('예약 생성 → REQUESTED, 운전자 알림, PICKUP_REQUEST 전송 → 수락 → ACCEPTED', () => {
  const c = fresh();
  const out = [];
  c.onOutbound((m) => out.push(m.type));
  const { booking, created } = c.createBooking('u_youngsoo', 'v_ioniq5', PT);
  assert.ok(created);
  assert.strictEqual(booking.status, BOOKING.REQUESTED);
  assert.strictEqual(booking.seatId, 'FR', '기억한 좌석 사용');
  assert.strictEqual(booking.seatFromMemory, true);
  assert.ok(out.includes(OUTBOUND.PICKUP_REQUEST));
  assert.ok(c.pendingRequestsForDriver('u_jimin').some((b) => b.id === booking.id));
  const r = c.driverDecide('u_jimin', booking.id, true);
  assert.ok(r.applied);
  assert.strictEqual(booking.status, BOOKING.ACCEPTED);
});
test('좌석 기억 안 함(하늘) → 예약 시 좌석을 선택', () => {
  const c = fresh();
  const { booking } = c.createBooking('u_haneul', 'v_ioniq5', PT, { seatId: 'RL' });
  assert.strictEqual(booking.seatId, 'RL');
  assert.strictEqual(booking.seatFromMemory, false);
});
test('중복 생성 방지: 진행 중 예약이 있으면 기존 예약 반환', () => {
  const c = fresh();
  const a = c.createBooking('u_youngsoo', 'v_ioniq5', PT);
  const b = c.createBooking('u_youngsoo', 'v_ioniq5', { x: 1, y: 1, label: '다른 곳' });
  assert.strictEqual(b.created, false);
  assert.strictEqual(b.booking.id, a.booking.id);
  assert.strictEqual(Object.keys(c.state.bookings).length, 1);
});
test('초대받지 않은 차량에는 예약 불가 / 위치 없으면 거부', () => {
  const c = fresh();
  assert.throws(() => c.createBooking('u_youngsoo', 'v_ioniq5b', PT), PermissionError);
  assert.throws(() => c.createBooking('u_youngsoo', 'v_ioniq5', null), ValidationError);
});

console.log('\n[8] 거절·취소 뒤에도 다음 행동 가능');
test('거절 → REJECTED, 활성 예약 없음 → 새 예약 가능', () => {
  const c = fresh();
  const { booking } = c.createBooking('u_youngsoo', 'v_ioniq5', PT);
  c.driverDecide('u_jimin', booking.id, false);
  assert.strictEqual(booking.status, BOOKING.REJECTED);
  assert.strictEqual(c.getActiveBooking('u_youngsoo'), null);
  const again = c.createBooking('u_youngsoo', 'v_ioniq5', PT);
  assert.ok(again.created);
});
test('사용자 취소 → CANCELLED + PICKUP_CANCEL 전송, 남의 예약은 취소 불가', () => {
  const c = fresh();
  const out = [];
  c.onOutbound((m) => out.push(m.type));
  const { booking } = c.createBooking('u_youngsoo', 'v_ioniq5', PT);
  assert.throws(() => c.cancelBooking('u_haneul', booking.id), PermissionError);
  c.cancelBooking('u_youngsoo', booking.id);
  assert.strictEqual(booking.status, BOOKING.CANCELLED);
  assert.ok(out.includes(OUTBOUND.PICKUP_CANCEL));
});

console.log('\n[9] 장애물 안내 → 새 탑승 위치가 예약 상태에 반영');
test('수락 후 장애물 → relocation 제안 → 확인 시 pickupPoint 갱신 + 이전 위치 보존 + 차량 전달', () => {
  const c = fresh();
  const out = [];
  c.onOutbound((m) => out.push(m));
  const { booking } = c.createBooking('u_youngsoo', 'v_ioniq5', PT);
  c.driverDecide('u_jimin', booking.id, true);
  const NEW = { x: 160, y: 200, label: '앞쪽 20m' };
  c.handleVehicleEvent({
    type: VEHICLE_EVENT.OBSTACLE_REPORTED,
    bookingId: booking.id,
    point: NEW,
    message: '앞쪽 지정된 탑승 장소로 조금 이동해 주세요.',
  });
  assert.ok(booking.relocation && !booking.relocation.confirmed);
  assert.deepStrictEqual(booking.pickupPoint, PT, '확인 전에는 기존 위치 유지');
  c.confirmRelocation('u_youngsoo', booking.id);
  assert.deepStrictEqual(booking.pickupPoint, NEW);
  assert.deepStrictEqual(booking.previousPoint, PT);
  assert.ok(booking.relocation.confirmed);
  const msg = out.find((m) => m.type === OUTBOUND.PICKUP_POINT_UPDATED);
  assert.ok(msg && msg.payload.point.x === 160);
});
test('요청 대기(REQUESTED) 상태의 장애물 이벤트는 무시', () => {
  const c = fresh();
  const { booking } = c.createBooking('u_youngsoo', 'v_ioniq5', PT);
  const r = c.handleVehicleEvent({
    type: VEHICLE_EVENT.OBSTACLE_REPORTED,
    bookingId: booking.id,
    point: { x: 1, y: 1 },
  });
  assert.strictEqual(r.applied, false);
  assert.strictEqual(booking.relocation, null);
});

console.log('\n[10] 50m 접근 → 도착 → 탑승 완료, 늦은 이벤트 무시');
test('ACCEPTED → 50m → APPROACHING(알림 "곧 도착해요") → 도착 → 완료', () => {
  const c = fresh();
  const { booking } = c.createBooking('u_youngsoo', 'v_ioniq5', PT);
  c.driverDecide('u_jimin', booking.id, true);
  c.handleVehicleEvent({ type: VEHICLE_EVENT.VEHICLE_NEAR_50M, bookingId: booking.id });
  assert.strictEqual(booking.status, BOOKING.APPROACHING);
  assert.ok(c.state.notifications.some((n) => n.title === '곧 도착해요' && n.body === '탑승을 준비해 주세요.'));
  c.handleVehicleEvent({ type: VEHICLE_EVENT.DRIVER_REMIND, bookingId: booking.id });
  c.handleVehicleEvent({ type: VEHICLE_EVENT.DRIVER_CALL_REQUEST, bookingId: booking.id });
  assert.ok(c.state.notifications.some((n) => n.kind === 'call'));
  c.handleVehicleEvent({ type: VEHICLE_EVENT.VEHICLE_ARRIVED, bookingId: booking.id });
  assert.strictEqual(booking.status, BOOKING.ARRIVED);
  c.handleVehicleEvent({ type: VEHICLE_EVENT.BOARDING_COMPLETE, bookingId: booking.id });
  assert.strictEqual(booking.status, BOOKING.COMPLETED);
});
test('50m 접근 없이 바로 도착해도 ARRIVED', () => {
  const c = fresh();
  const { booking } = c.createBooking('u_youngsoo', 'v_ioniq5', PT);
  c.driverDecide('u_jimin', booking.id, true);
  c.handleVehicleEvent({ type: VEHICLE_EVENT.VEHICLE_ARRIVED, bookingId: booking.id });
  assert.strictEqual(booking.status, BOOKING.ARRIVED);
});
test('취소·완료된 예약에 늦게 온 이벤트는 상태를 되돌리지 않음', () => {
  const c = fresh();
  const { booking } = c.createBooking('u_youngsoo', 'v_ioniq5', PT);
  c.driverDecide('u_jimin', booking.id, true);
  c.cancelBooking('u_youngsoo', booking.id);
  for (const t of [
    VEHICLE_EVENT.VEHICLE_NEAR_50M,
    VEHICLE_EVENT.VEHICLE_ARRIVED,
    VEHICLE_EVENT.DRIVER_ACCEPT,
    VEHICLE_EVENT.OBSTACLE_REPORTED,
    VEHICLE_EVENT.BOARDING_COMPLETE,
  ]) {
    const r = c.handleVehicleEvent({ type: t, bookingId: booking.id, point: { x: 1, y: 1 } });
    assert.strictEqual(r.applied, false, t);
    assert.strictEqual(booking.status, BOOKING.CANCELLED, t);
  }
  assert.strictEqual(booking.ignoredEvents.length, 5);
  const c2 = fresh();
  const b2 = c2.createBooking('u_youngsoo', 'v_ioniq5', PT).booking;
  c2.driverDecide('u_jimin', b2.id, true);
  c2.handleVehicleEvent({ type: VEHICLE_EVENT.VEHICLE_ARRIVED, bookingId: b2.id });
  c2.handleVehicleEvent({ type: VEHICLE_EVENT.BOARDING_COMPLETE, bookingId: b2.id });
  c2.handleVehicleEvent({ type: VEHICLE_EVENT.DRIVER_CANCEL, bookingId: b2.id });
  assert.strictEqual(b2.status, BOOKING.COMPLETED);
});
test('REQUESTED 상태에서 운전자 취소 → CANCELLED, 수락 전 50m 이벤트는 무시', () => {
  const c = fresh();
  const { booking } = c.createBooking('u_youngsoo', 'v_ioniq5', PT);
  assert.strictEqual(
    c.handleVehicleEvent({ type: VEHICLE_EVENT.VEHICLE_NEAR_50M, bookingId: booking.id }).applied,
    false,
  );
  c.handleVehicleEvent({ type: VEHICLE_EVENT.DRIVER_CANCEL, bookingId: booking.id });
  assert.strictEqual(booking.status, BOOKING.CANCELLED);
});

console.log('\n[11] 만료된 QR 인증은 실패하고 재시도 가능');
test('유효 토큰 → 승인 대기 → 승인 시 연결 / 만료 토큰 → EXPIRED / 새 토큰으로 재시도 성공', () => {
  const c = fresh();
  const tok = { code: 'ABC123', vehicleId: 'v_ioniq5', issuedAt: c.now(), ttlSec: 60 };
  const r1 = c.validatePleosToken('u_jimin', tok);
  assert.ok(r1.ok);
  assert.strictEqual(c.state.pleosLinks['v_ioniq5'], undefined, '읽기만으로 연결되지 않음');
  c.tick(61_000);
  const r2 = c.validatePleosToken('u_jimin', tok);
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, 'EXPIRED');
  const r2b = c.confirmPleosLink('u_jimin', tok);
  assert.strictEqual(r2b.ok, false, '승인 시점에도 만료 재검증');
  const tok2 = { code: 'NEW456', vehicleId: 'v_ioniq5', issuedAt: c.now(), ttlSec: 60 };
  const r3 = c.confirmPleosLink('u_jimin', tok2);
  assert.ok(r3.ok);
  assert.strictEqual(c.state.pleosLinks['v_ioniq5'].tokenCode, 'NEW456');
});
test('동승자 계정·남의 차량·알 수 없는 QR은 실패', () => {
  const c = fresh();
  const tok = { code: 'X', vehicleId: 'v_ioniq5', issuedAt: c.now(), ttlSec: 60 };
  assert.strictEqual(c.validatePleosToken('u_youngsoo', tok).reason, 'NOT_DRIVER');
  assert.strictEqual(
    c.validatePleosToken('u_jimin', { code: 'X', vehicleId: 'v_nope', issuedAt: c.now(), ttlSec: 60 }).reason,
    'UNKNOWN_VEHICLE',
  );
  assert.strictEqual(c.validatePleosToken('u_jimin', null).reason, 'INVALID');
});

// ---------- 시나리오 기능 (희망 시간 · 좌석 중복 · 픽업 순서 · 차량 화면 탑승 확인 · 화면 동기화) ----------
const GEO = require('../carpoom-geo.js');
const P = GEO.PLACES;
const MIN = 60 * 1000;

console.log('\n[12] 탑승 희망 시간');
test('시간을 안 고르면 지금 바로, 미래 시각은 저장, 지난 시각·24시간 넘는 시각은 거부', () => {
  const c = fresh();
  const b1 = c.createBooking('u_youngsoo', 'v_ioniq5', P.daycare).booking;
  assert.strictEqual(b1.pickupTime.mode, 'asap');
  assert.strictEqual(c.pickupTimeLabel(b1.pickupTime), '지금 바로');
  assert.throws(
    () => c.createBooking('u_haneul', 'v_ioniq5', P.school, { pickupTime: { mode: 'at', at: c.now() - 10 * MIN } }),
    ValidationError,
  );
  assert.throws(
    () =>
      c.createBooking('u_haneul', 'v_ioniq5', P.school, { pickupTime: { mode: 'at', at: c.now() + 25 * 60 * MIN } }),
    ValidationError,
  );
  const b2 = c.createBooking('u_haneul', 'v_ioniq5', P.school, {
    seatId: 'RR',
    pickupTime: { mode: 'at', at: c.now() + 15 * MIN },
  }).booking;
  assert.strictEqual(b2.pickupTime.mode, 'at');
  assert.ok(/희망$/.test(c.pickupTimeLabel(b2.pickupTime)));
  const out = c.state.log.find((l) => l.label === 'OUT PICKUP_REQUEST');
  assert.ok(out && out.data.pickupTime, '차량으로 보내는 요청에 희망 시간 포함');
});

console.log('\n[13] 같은 차량에서 좌석이 겹치지 않음');
test('먼저 예약된 좌석은 고를 수 없고, 기억한 좌석이 이미 차 있으면 비워 두고 운전자가 배정', () => {
  const c = fresh();
  c.createBooking('u_youngsoo', 'v_ioniq5', P.daycare); // 조수석 기억
  assert.deepStrictEqual(Object.keys(c.takenSeats('v_ioniq5')), ['FR']);
  assert.throws(() => c.createBooking('u_haneul', 'v_ioniq5', P.school, { seatId: 'FR' }), ValidationError);
  const c2 = fresh();
  const kid = c2.createBooking('u_haneul', 'v_ioniq5', P.school, { seatId: 'FR' }).booking;
  const dad = c2.createBooking('u_youngsoo', 'v_ioniq5', P.daycare).booking;
  assert.strictEqual(kid.seatId, 'FR');
  assert.strictEqual(dad.seatId, null);
  assert.strictEqual(dad.seatConflict, true);
});

console.log('\n[14] 픽업 순서: 시간과 위치를 함께 비교 (데모 시나리오)');
test('아버지는 지금 바로, 딸은 15분 뒤 → 학교가 더 가까워도 데이케어센터 먼저', () => {
  const c = fresh();
  const dad = c.createBooking('u_youngsoo', 'v_ioniq5', P.daycare).booking;
  const kid = c.createBooking('u_haneul', 'v_ioniq5', P.school, {
    seatId: 'RR',
    pickupTime: { mode: 'at', at: c.now() + 15 * MIN },
  }).booking;
  c.driverDecide('u_jimin', dad.id, true);
  c.driverDecide('u_jimin', kid.id, true);
  assert.ok(
    GEO.estRoadDistance(P.office, P.school) < GEO.estRoadDistance(P.office, P.daycare),
    '전제: 회사에서는 학교가 더 가깝다',
  );
  const plan = c.planPickups('v_ioniq5', { start: P.office });
  assert.deepStrictEqual(plan.order, [dad.id, kid.id]);
  assert.strictEqual(plan.stops[0].late > 0 && plan.stops[0].late < 5 * MIN, true);
  assert.ok(plan.stops[1].wait > 0, '딸은 희망 시간 전에 도착해 기다림');
});
test('둘 다 지금 바로면 가까운 학교 먼저', () => {
  const c = fresh();
  const dad = c.createBooking('u_youngsoo', 'v_ioniq5', P.daycare).booking;
  const kid = c.createBooking('u_haneul', 'v_ioniq5', P.school, { seatId: 'RR' }).booking;
  c.driverDecide('u_jimin', dad.id, true);
  c.driverDecide('u_jimin', kid.id, true);
  assert.deepStrictEqual(c.planPickups('v_ioniq5', { start: P.office }).order, [kid.id, dad.id]);
});
test('경로 확정 → 동승자에게 순서·도착 예정 알림, 운전자만 가능, 수락 안 된 요청은 제외', () => {
  const c = fresh();
  const dad = c.createBooking('u_youngsoo', 'v_ioniq5', P.daycare).booking;
  c.createBooking('u_haneul', 'v_ioniq5', P.school, { seatId: 'RR' });
  c.driverDecide('u_jimin', dad.id, true);
  const plan = c.planPickups('v_ioniq5', { start: P.office });
  assert.deepStrictEqual(plan.order, [dad.id]);
  assert.throws(() => c.setRoutePlan('u_youngsoo', 'v_ioniq5', plan), PermissionError);
  c.setRoutePlan('u_jimin', 'v_ioniq5', plan);
  assert.strictEqual(c.state.bookings[dad.id].plan.order, 1);
  assert.ok(c.state.notifications.some((n) => n.userId === 'u_youngsoo' && /1번째/.test(n.title)));
});

console.log('\n[15] 차량 화면에서 좌석 배정·탑승 확인 (다이어그램 03·04)');
test('운전자만 좌석 배정, 기억 여부도 함께 저장', () => {
  const c = fresh();
  const kid = c.createBooking('u_haneul', 'v_ioniq5', P.school).booking;
  assert.throws(() => c.driverAssignSeat('u_youngsoo', kid.id, 'RL'), PermissionError);
  c.driverAssignSeat('u_jimin', kid.id, 'RL', true);
  assert.strictEqual(c.state.bookings[kid.id].seatId, 'RL');
  const p = c.getProfile('u_haneul', 'v_ioniq5').saved;
  assert.strictEqual(p.seatId, 'RL');
  assert.strictEqual(p.rememberSeat, true);
});
test('도착 전에는 탑승 확인 불가 / 예정 좌석에 앉으면 설정 적용 후 완료', () => {
  const c = fresh();
  const dad = c.createBooking('u_youngsoo', 'v_ioniq5', P.daycare).booking;
  c.driverDecide('u_jimin', dad.id, true);
  assert.throws(() => c.boardPassenger('u_jimin', dad.id, 'FR'), ValidationError);
  c.handleVehicleEvent({ type: VEHICLE_EVENT.VEHICLE_ARRIVED, bookingId: dad.id });
  const r = c.boardPassenger('u_jimin', dad.id, 'FR');
  assert.deepStrictEqual([r.mismatch, r.applied], [false, true]);
  assert.strictEqual(c.state.bookings[dad.id].status, BOOKING.COMPLETED);
  assert.strictEqual(c.getProfile('u_youngsoo', 'v_ioniq5').apply.status, APPLY.APPLIED);
});
test('다른 자리에 앉음 → 수정하면 배정 변경·적용, 수정 안 하면 설정 유지', () => {
  const c = fresh();
  const kid = c.createBooking('u_haneul', 'v_ioniq5', P.school, { seatId: 'RR' }).booking;
  c.driverDecide('u_jimin', kid.id, true);
  c.handleVehicleEvent({ type: VEHICLE_EVENT.VEHICLE_ARRIVED, bookingId: kid.id });
  const r = c.boardPassenger('u_jimin', kid.id, 'RL', { reassign: true, remember: false });
  assert.deepStrictEqual([r.mismatch, r.applied], [true, true]);
  assert.strictEqual(c.state.bookings[kid.id].seatId, 'RL');
  const c2 = fresh();
  const k2 = c2.createBooking('u_haneul', 'v_ioniq5', P.school, { seatId: 'RR' }).booking;
  c2.driverDecide('u_jimin', k2.id, true);
  c2.handleVehicleEvent({ type: VEHICLE_EVENT.VEHICLE_ARRIVED, bookingId: k2.id });
  const r2 = c2.boardPassenger('u_jimin', k2.id, 'RL', { reassign: false });
  assert.deepStrictEqual([r2.mismatch, r2.applied], [true, false]);
  assert.strictEqual(c2.state.bookings[k2.id].seatId, 'RR');
  assert.strictEqual(c2.state.bookings[k2.id].status, BOOKING.COMPLETED);
});
test('운전자는 변경 권한이 없는 동승자 설정도 Pleos에서 대신 바꿈(좌석 배정은 유지)', () => {
  const c = fresh();
  assert.strictEqual(c.canEditSettings('u_haneul', 'v_ioniq5'), false);
  assert.throws(() => c.driverSaveProfile('u_youngsoo', 'u_haneul', 'v_ioniq5', { recline: 70 }), PermissionError);
  const s = c.driverSaveProfile('u_jimin', 'u_haneul', 'v_ioniq5', { recline: 70, heater: { on: true, level: 3 } });
  assert.strictEqual(s.recline, 70);
  assert.strictEqual(s.heater.level, 3);
  assert.strictEqual(s.seatId, 'RR');
});

console.log('\n[16] 모바일 ↔ Pleos 화면 동기화');
test('변경할 때마다 rev 증가, 더 최신 상태만 받아들이고 로그인 사용자는 기기별로 유지', () => {
  const phone = fresh();
  const car = fresh();
  phone.switchUser('u_youngsoo');
  const r0 = phone.state.rev;
  car.createBooking('u_haneul', 'v_ioniq5', P.school, { seatId: 'RR' });
  car.state.rev = r0 + 5;
  assert.strictEqual(phone.adopt(C.clone(car.state)), true);
  assert.strictEqual(phone.state.sessionUserId, 'u_youngsoo');
  assert.ok(phone.getActiveBooking('u_haneul'));
  const old = C.clone(car.state);
  old.rev = 1;
  assert.strictEqual(phone.adopt(old), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
