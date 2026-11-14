/*
 * 카품(Car Poom) 코어 도메인 모듈
 * - 화면(UI)과 외부 연동(지도, QR, 알림, 차량 게이트웨이)에 의존하지 않는다.
 * - 권한 검사, 좌석 설정 저장, 예약 상태 기계, 초대/권한 관리, QR 인증 검증을 담당한다.
 * - 브라우저(window.CarpoomCore)와 Node(module.exports) 양쪽에서 동일하게 동작한다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CarpoomCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ROLE = { DRIVER: 'driver', PASSENGER: 'passenger' };

  // 예약 상태. ACTIVE 집합에 속한 상태에서만 차량 이벤트가 반영된다.
  const BOOKING = {
    REQUESTED: 'REQUESTED', // 운전자 확인 대기
    ACCEPTED: 'ACCEPTED', // 수락됨, 지정 장소에서 대기
    APPROACHING: 'APPROACHING', // 차량이 50m 이내로 접근
    ARRIVED: 'ARRIVED', // 차량 도착
    REJECTED: 'REJECTED',
    CANCELLED: 'CANCELLED',
    COMPLETED: 'COMPLETED',
  };
  const ACTIVE_STATES = [BOOKING.REQUESTED, BOOKING.ACCEPTED, BOOKING.APPROACHING, BOOKING.ARRIVED];
  const TERMINAL_STATES = [BOOKING.REJECTED, BOOKING.CANCELLED, BOOKING.COMPLETED];

  // 차량 적용 응답 상태. "저장됨"과 "차량에 적용됨"을 분리한다.
  const APPLY = { NONE: 'NONE', SENT: 'SENT', PENDING: 'PENDING', APPLIED: 'APPLIED', FAILED: 'FAILED' };

  // 차량에서 들어오는 이벤트 종류 (Pleos/서버 → 모바일)
  const VEHICLE_EVENT = {
    DRIVER_ACCEPT: 'DRIVER_ACCEPT',
    DRIVER_REJECT: 'DRIVER_REJECT',
    OBSTACLE_REPORTED: 'OBSTACLE_REPORTED',
    VEHICLE_NEAR_50M: 'VEHICLE_NEAR_50M',
    VEHICLE_ARRIVED: 'VEHICLE_ARRIVED',
    DRIVER_REMIND: 'DRIVER_REMIND',
    DRIVER_CALL_REQUEST: 'DRIVER_CALL_REQUEST',
    DRIVER_CANCEL: 'DRIVER_CANCEL',
    BOARDING_COMPLETE: 'BOARDING_COMPLETE',
    APPLY_RESULT: 'APPLY_RESULT',
  };

  // 모바일에서 나가는 메시지 종류 (모바일 → 서버/Pleos). 게이트웨이 어댑터가 전송한다.
  const OUTBOUND = {
    PICKUP_REQUEST: 'PICKUP_REQUEST',
    PICKUP_CANCEL: 'PICKUP_CANCEL',
    PICKUP_POINT_UPDATED: 'PICKUP_POINT_UPDATED',
    SEAT_ASSIGNMENT: 'SEAT_ASSIGNMENT',
    APPLY_SETTINGS: 'APPLY_SETTINGS',
    PERMISSION_CHANGED: 'PERMISSION_CHANGED',
    INVITE_SENT: 'INVITE_SENT',
  };

  class PermissionError extends Error {
    constructor(msg) {
      super(msg);
      this.name = 'PermissionError';
    }
  }
  class ValidationError extends Error {
    constructor(msg) {
      super(msg);
      this.name = 'ValidationError';
    }
  }

  const DEFAULT_PROFILE = () => ({
    seatPosition: 50, // 0 앞 ~ 100 뒤
    recline: 30, // 0 곧게 ~ 100 많이 눕힘
    heater: { on: false, level: 2 }, // 1~3
    climate: { on: false, temp: 22, fan: 2 },
    window: { open: 0 }, // 0 닫힘 ~ 100 전부 열림
    weightKg: null, // 선택 입력. 신원 확인, 탑승 판정에 쓰지 않는다.
    seatId: null, // 탑승 예정 좌석
    rememberSeat: false, // 이 좌석 기억하기
  });

  const CAPABILITY_FIELDS = {
    seatPosition: 'seatPosition',
    recline: 'recline',
    heater: 'heater',
    climate: 'climate',
    window: 'window',
  };

  const uid = (p) => p + '_' + Math.random().toString(36).slice(2, 9);
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const pad2 = (n) => String(n).padStart(2, '0');
  /** 시:분 표기(기기 현지 시각) */
  const fmtHM = (t) => {
    const d = new Date(t);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  };

  // 탑승 희망 시간: 지금 바로(asap) 또는 시각 지정(at)
  const PICKUP_TIME = { ASAP: 'asap', AT: 'at' };
  const MAX_PICKUP_AHEAD_MS = 24 * 3600 * 1000;

  function emptyState() {
    return {
      version: 4,
      rev: 0, // 상태 변경 번호. 모바일, Pleos 화면 사이 동기화에서 더 최신 상태를 고르는 기준
      demoMode: true,
      users: {},
      vehicles: {},
      profiles: {}, // key: userId|vehicleId
      bookings: {},
      sessionUserId: null, // 기기별 값(동기화하지 않음)
      notifications: [], // 최신이 앞
      log: [], // 개발 메뉴용 이벤트 로그
      pleosLinks: {}, // vehicleId -> { userId, linkedAt, tokenCode }
      pleosQr: {}, // vehicleId -> Pleos 화면에 지금 떠 있는 로그인 QR 토큰
      routePlans: {}, // vehicleId -> { order:[bookingId], stops:[...], at }
    };
  }

  function profileKey(userId, vehicleId) {
    return userId + '|' + vehicleId;
  }

  class CarpoomCore {
    constructor(opts) {
      opts = opts || {};
      this.state = opts.state || emptyState();
      this.now = opts.now || (() => Date.now());
      this.listeners = new Set();
      this.outboundHandlers = new Set();
      this.persist = opts.persist || null; // { save(state) }
    }

    // ---------- 구독 / 저장 ----------
    subscribe(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }
    onOutbound(fn) {
      this.outboundHandlers.add(fn);
      return () => this.outboundHandlers.delete(fn);
    }
    emit(reason) {
      this.state.rev = (this.state.rev || 0) + 1;
      if (this.persist) {
        try {
          this.persist.save(this.state);
        } catch (e) {
          /* 저장 실패는 화면 동작을 막지 않는다 */
        }
      }
      this.listeners.forEach((fn) => {
        try {
          fn(this.state, reason);
        } catch (e) {
          /* noop */
        }
      });
    }
    /**
     * 다른 화면(모바일 ↔ Pleos)에서 온 더 최신 상태로 바꾼다. rev가 같거나 낮으면 무시한다.
     * keepLocal: 기기마다 다른 값(로그인한 사용자 등)은 그대로 둔다.
     */
    adopt(incoming, keepLocal) {
      if (!incoming || (incoming.rev || 0) <= (this.state.rev || 0)) return false;
      const next = clone(incoming);
      (keepLocal || ['sessionUserId']).forEach((k) => {
        next[k] = this.state[k];
      });
      ['pleosQr', 'routePlans'].forEach((k) => {
        if (!next[k]) next[k] = {};
      });
      this.state = next;
      if (this.persist) {
        try {
          this.persist.save(this.state);
        } catch (e) {
          /* noop */
        }
      }
      this.listeners.forEach((fn) => {
        try {
          fn(this.state, 'sync');
        } catch (e) {
          /* noop */
        }
      });
      return true;
    }
    send(type, payload) {
      const msg = { id: uid('out'), type, payload: clone(payload || {}), at: this.now() };
      this.log('OUT ' + type, payload);
      this.outboundHandlers.forEach((fn) => {
        try {
          fn(msg);
        } catch (e) {
          /* noop */
        }
      });
      return msg;
    }
    log(label, data) {
      this.state.log.unshift({ at: this.now(), label, data: data ? clone(data) : null });
      if (this.state.log.length > 200) this.state.log.length = 200;
    }
    notify(userId, title, body, kind, extra) {
      const n = Object.assign(
        { id: uid('n'), userId, title, body, kind: kind || 'info', at: this.now(), read: false },
        extra || {},
      );
      this.state.notifications.unshift(n);
      if (this.state.notifications.length > 100) this.state.notifications.length = 100;
      return n;
    }
    markNotificationsRead(userId) {
      this.state.notifications.forEach((n) => {
        if (n.userId === userId) n.read = true;
      });
      this.emit('notifications');
    }

    // ---------- 사용자 / 가입 / 역할 ----------
    signUp({ name, isAdult }) {
      name = (name || '').trim();
      if (!name) throw new ValidationError('이름을 입력해 주세요.');
      if (name.length > 12) throw new ValidationError('이름은 12자 이내로 입력해 주세요.');
      const user = {
        id: uid('u'),
        name,
        isAdult: !!isAdult,
        // 데모의 성인 선택은 실제 인증이 아니다. 실제 본인, 연령 인증은 provider를 붙여 VERIFIED로 바꾼다.
        ageVerification: { status: 'DEMO_SELF_DECLARED', provider: null, verifiedAt: null },
        role: null,
        createdAt: this.now(),
      };
      this.state.users[user.id] = user;
      this.state.sessionUserId = user.id;
      this.log('가입', { name, isAdult });
      this.emit('signup');
      return user;
    }

    availableRoles(userId) {
      const u = this.state.users[userId];
      if (!u) return [];
      return u.isAdult ? [ROLE.DRIVER, ROLE.PASSENGER] : [ROLE.PASSENGER];
    }

    setRole(userId, role) {
      const u = this.state.users[userId];
      if (!u) throw new ValidationError('사용자를 찾을 수 없어요.');
      if (!this.availableRoles(userId).includes(role)) {
        throw new PermissionError('성인만 운전자 역할을 선택할 수 있어요.');
      }
      u.role = role;
      this.log('역할 선택', { userId, role });
      this.emit('role');
      return u;
    }

    switchUser(userId) {
      if (!this.state.users[userId]) throw new ValidationError('사용자를 찾을 수 없어요.');
      this.state.sessionUserId = userId;
      this.emit('session');
    }
    signOut() {
      this.state.sessionUserId = null;
      this.emit('session');
    }
    currentUser() {
      return this.state.users[this.state.sessionUserId] || null;
    }

    // ---------- 차량 / 초대 / 권한 ----------
    addVehicle({ ownerId, name, plate, capabilities, seats }) {
      const v = {
        id: uid('v'),
        ownerId,
        name,
        plate,
        capabilities: Object.assign(
          { seatPosition: true, recline: true, heater: true, climate: true, window: true },
          capabilities || {},
        ),
        seats: seats || [
          { id: 'FR', label: '조수석', row: 1 },
          { id: 'RL', label: '뒷좌석 왼쪽', row: 2 },
          { id: 'RR', label: '뒷좌석 오른쪽', row: 2 },
        ],
        members: {}, // userId -> { invited, canEdit, invitedAt, updatedAt }
      };
      this.state.vehicles[v.id] = v;
      this.emit('vehicle');
      return v;
    }

    isOwner(userId, vehicleId) {
      const v = this.state.vehicles[vehicleId];
      return !!v && v.ownerId === userId;
    }
    requireOwner(userId, vehicleId) {
      if (!this.isOwner(userId, vehicleId))
        throw new PermissionError('이 차량의 운전자만 초대와 권한을 관리할 수 있어요.');
    }

    invite(driverId, vehicleId, userId) {
      this.requireOwner(driverId, vehicleId);
      if (!this.state.users[userId]) throw new ValidationError('초대할 사용자를 찾을 수 없어요.');
      if (userId === driverId) throw new ValidationError('자기 자신은 초대할 수 없어요.');
      const v = this.state.vehicles[vehicleId];
      v.members[userId] = Object.assign(
        { invited: true, canEdit: false, invitedAt: this.now(), updatedAt: this.now() },
        v.members[userId] || {},
        { invited: true },
      );
      this.log('초대', { vehicleId, userId });
      this.notify(userId, '차량에 초대되었어요', `${v.name} 운전자가 초대했어요. 좌석 설정을 확인해 보세요.`, 'invite');
      this.send(OUTBOUND.INVITE_SENT, { vehicleId, userId });
      this.emit('members');
    }

    removeMember(driverId, vehicleId, userId) {
      this.requireOwner(driverId, vehicleId);
      const v = this.state.vehicles[vehicleId];
      delete v.members[userId];
      this.log('초대 해제', { vehicleId, userId });
      this.emit('members');
    }

    setPermission(driverId, vehicleId, userId, canEdit) {
      this.requireOwner(driverId, vehicleId);
      const v = this.state.vehicles[vehicleId];
      const m = v.members[userId];
      if (!m || !m.invited) throw new ValidationError('먼저 초대한 동승자에게만 권한을 줄 수 있어요.');
      m.canEdit = !!canEdit;
      m.updatedAt = this.now();
      this.log(canEdit ? '권한 부여' : '권한 회수', { vehicleId, userId });
      this.notify(
        userId,
        canEdit ? '설정 변경 권한을 받았어요' : '설정 변경 권한이 회수되었어요',
        canEdit
          ? `${v.name}에서 내 자리 설정을 직접 바꿀 수 있어요.`
          : `${v.name} 설정은 이제 확인만 할 수 있어요. 변경은 운전자가 도와드려요.`,
        'permission',
      );
      this.send(OUTBOUND.PERMISSION_CHANGED, { vehicleId, userId, canEdit: !!canEdit });
      this.emit('permission');
    }

    membership(userId, vehicleId) {
      const v = this.state.vehicles[vehicleId];
      if (!v) return { invited: false, canEdit: false };
      const m = v.members[userId];
      return { invited: !!(m && m.invited), canEdit: !!(m && m.invited && m.canEdit) };
    }

    /** 설정 변경 조건: 해당 차량 운전자의 초대 + 변경 권한. 성인 여부와 무관하게 동일 규칙. */
    canEditSettings(userId, vehicleId) {
      const m = this.membership(userId, vehicleId);
      return m.invited && m.canEdit;
    }
    requireEdit(userId, vehicleId) {
      const m = this.membership(userId, vehicleId);
      if (!m.invited) throw new PermissionError('이 차량의 운전자에게 초대를 받아야 해요.');
      if (!m.canEdit) throw new PermissionError('설정 변경 권한이 없어요. 변경은 운전자가 도와드려요.');
    }

    vehiclesFor(userId) {
      return Object.values(this.state.vehicles).filter(
        (v) => v.ownerId === userId || (v.members[userId] && v.members[userId].invited),
      );
    }
    invitedVehiclesFor(userId) {
      return Object.values(this.state.vehicles).filter((v) => v.members[userId] && v.members[userId].invited);
    }

    // ---------- 내 자리 설정 ----------
    getProfile(userId, vehicleId) {
      const k = profileKey(userId, vehicleId);
      if (!this.state.profiles[k]) {
        this.state.profiles[k] = {
          saved: DEFAULT_PROFILE(),
          savedAt: null,
          apply: { status: APPLY.NONE, at: null, message: null },
        };
      }
      return this.state.profiles[k];
    }

    /** 차량에서 지원하지 않는 항목은 저장값에서 기본값으로 되돌린다(조작 자체를 막는 것은 UI가 담당, 저장에서도 재검증). */
    sanitizeForVehicle(vehicleId, draft) {
      const v = this.state.vehicles[vehicleId];
      const d = DEFAULT_PROFILE();
      const src = clone(draft || {});
      const out = DEFAULT_PROFILE();
      // 알려진 항목만 받는다(화면 전용 키나 임의 필드는 저장하지 않는다)
      Object.keys(d).forEach((k) => {
        if (src[k] === undefined) return;
        out[k] = d[k] && typeof d[k] === 'object' ? Object.assign({}, d[k], src[k] || {}) : src[k];
      });
      if (!v) return out;
      Object.keys(CAPABILITY_FIELDS).forEach((cap) => {
        if (!v.capabilities[cap]) out[cap] = d[cap];
      });
      out.seatPosition = clamp(out.seatPosition, 0, 100);
      out.recline = clamp(out.recline, 0, 100);
      out.heater.level = clamp(out.heater.level, 1, 3);
      out.climate.temp = clamp(out.climate.temp, 16, 30);
      out.climate.fan = clamp(out.climate.fan, 1, 5);
      out.window.open = clamp(out.window.open, 0, 100);
      if (out.weightKg != null) {
        const w = Number(out.weightKg);
        out.weightKg = isFinite(w) && w > 0 && w < 300 ? Math.round(w) : null;
      }
      if (out.seatId && !v.seats.some((s) => s.id === out.seatId)) out.seatId = null;
      if (!out.seatId) out.rememberSeat = false;
      return out;
    }

    /** 저장: 권한 검사 → 차량 지원 범위로 정리 → 저장. 저장은 "차량 적용 완료"가 아니다. */
    saveProfile(userId, vehicleId, draft) {
      this.requireEdit(userId, vehicleId);
      const p = this.getProfile(userId, vehicleId);
      p.saved = this.sanitizeForVehicle(vehicleId, draft);
      p.savedAt = this.now();
      p.apply = { status: APPLY.NONE, at: null, message: null };
      this.log('설정 저장', { userId, vehicleId });
      this.emit('profile');
      return clone(p.saved);
    }

    /** 좌석 배정과 기억 여부 변경에도 같은 권한 규칙을 적용한다. */
    setSeatAssignment(userId, vehicleId, seatId, rememberSeat) {
      this.requireEdit(userId, vehicleId);
      const v = this.state.vehicles[vehicleId];
      if (seatId && !v.seats.some((s) => s.id === seatId)) throw new ValidationError('이 차량에 없는 좌석이에요.');
      const p = this.getProfile(userId, vehicleId);
      p.saved.seatId = seatId || null;
      p.saved.rememberSeat = !!(seatId && rememberSeat);
      p.savedAt = this.now();
      this.log('좌석 배정 변경', { userId, vehicleId, seatId, rememberSeat: p.saved.rememberSeat });
      this.send(OUTBOUND.SEAT_ASSIGNMENT, {
        userId,
        vehicleId,
        seatId: p.saved.seatId,
        rememberSeat: p.saved.rememberSeat,
      });
      this.emit('profile');
      return clone(p.saved);
    }

    /** 저장된 값을 차량에 적용 요청. 응답은 APPLY_RESULT 이벤트로 돌아온다. */
    requestApply(userId, vehicleId) {
      this.requireEdit(userId, vehicleId);
      const p = this.getProfile(userId, vehicleId);
      if (!p.savedAt) throw new ValidationError('먼저 설정을 저장해 주세요.');
      p.apply = { status: APPLY.SENT, at: this.now(), message: null };
      this.send(OUTBOUND.APPLY_SETTINGS, { userId, vehicleId, settings: clone(p.saved) });
      this.log('차량 적용 요청', { userId, vehicleId });
      this.emit('apply');
      return p.apply;
    }

    // ---------- 예약 ----------
    getActiveBooking(userId) {
      return (
        Object.values(this.state.bookings).find((b) => b.userId === userId && ACTIVE_STATES.includes(b.status)) || null
      );
    }
    bookingsFor(userId) {
      return Object.values(this.state.bookings)
        .filter((b) => b.userId === userId)
        .sort((a, b) => b.createdAt - a.createdAt);
    }
    pendingRequestsForDriver(driverId) {
      const myVehicles = Object.values(this.state.vehicles)
        .filter((v) => v.ownerId === driverId)
        .map((v) => v.id);
      return Object.values(this.state.bookings)
        .filter((b) => myVehicles.includes(b.vehicleId) && ACTIVE_STATES.includes(b.status))
        .sort((a, b) => b.createdAt - a.createdAt);
    }

    /** 같은 차량의 진행 중 예약이 이미 쓰는 좌석 { seatId: bookingId } */
    takenSeats(vehicleId, exceptBookingId) {
      const out = {};
      Object.values(this.state.bookings).forEach((b) => {
        if (b.vehicleId === vehicleId && b.id !== exceptBookingId && b.seatId && ACTIVE_STATES.includes(b.status))
          out[b.seatId] = b.id;
      });
      return out;
    }
    seatLabel(vehicleId, seatId) {
      const v = this.state.vehicles[vehicleId];
      const s = v && v.seats.find((x) => x.id === seatId);
      return s ? s.label : seatId || '좌석 미정';
    }

    /** 탑승 희망 시간 검증. 없거나 'asap'이면 지금 바로. */
    normalizePickupTime(pt) {
      const now = this.now();
      if (!pt || pt.mode === PICKUP_TIME.ASAP) return { mode: PICKUP_TIME.ASAP, at: now };
      const at = Number(pt.at);
      if (pt.mode !== PICKUP_TIME.AT || !isFinite(at)) throw new ValidationError('탑승 희망 시간을 다시 골라 주세요.');
      if (at < now - 60 * 1000) throw new ValidationError('이미 지난 시간은 고를 수 없어요.');
      if (at > now + MAX_PICKUP_AHEAD_MS) throw new ValidationError('24시간 안의 시간만 고를 수 있어요.');
      return { mode: PICKUP_TIME.AT, at };
    }
    pickupTimeLabel(pt) {
      if (!pt) return '지금 바로';
      return pt.mode === PICKUP_TIME.ASAP ? '지금 바로' : fmtHM(pt.at) + ' 희망';
    }

    /**
     * 예약 생성. 이미 진행 중인 예약이 있으면 새로 만들지 않고 기존 예약을 돌려준다(중복 생성 방지).
     * point: { x, y, label } (가상 지도 좌표) 또는 { lat, lng, label } (실제 지도)
     * opts: { seatId, note, pickupTime: { mode:'asap' } | { mode:'at', at: ms } }
     */
    createBooking(userId, vehicleId, point, opts) {
      opts = opts || {};
      const existing = this.getActiveBooking(userId);
      if (existing) return { booking: existing, created: false };
      const v = this.state.vehicles[vehicleId];
      if (!v) throw new ValidationError('차량을 선택해 주세요.');
      if (!this.membership(userId, vehicleId).invited)
        throw new PermissionError('초대받은 차량에만 탑승을 예약할 수 있어요.');
      if (!point || (point.x == null && point.lat == null))
        throw new ValidationError('지도에서 탑승 위치를 지정해 주세요.');
      const pickupTime = this.normalizePickupTime(opts.pickupTime);
      const p = this.getProfile(userId, vehicleId);
      const taken = this.takenSeats(vehicleId);
      let seatId = null,
        seatFromMemory = false,
        seatConflict = false;
      if (p.saved.rememberSeat && p.saved.seatId) {
        // 기억한 좌석을 다른 분이 먼저 예약했다면 비워 두고, 운전자가 Pleos에서 배정한다
        if (taken[p.saved.seatId]) seatConflict = true;
        else {
          seatId = p.saved.seatId;
          seatFromMemory = true;
        }
      } else if (opts.seatId) {
        if (!v.seats.some((s) => s.id === opts.seatId)) throw new ValidationError('이 차량에 없는 좌석이에요.');
        if (taken[opts.seatId]) throw new ValidationError('다른 분이 먼저 예약한 좌석이에요. 다른 자리를 골라 주세요.');
        seatId = opts.seatId;
      }
      const b = {
        id: uid('b'),
        userId,
        vehicleId,
        status: BOOKING.REQUESTED,
        pickupPoint: clone(point),
        pickupTime,
        previousPoint: null,
        relocation: null, // { proposed: point, message, at, confirmed }
        seatId,
        seatFromMemory,
        seatConflict,
        seatSource: seatId ? (seatFromMemory ? 'memory' : 'passenger') : null,
        plan: null, // Pleos 경로 계획: { order, eta }
        boardedSeatId: null,
        settingsApplied: null,
        note: opts.note || '',
        createdAt: this.now(),
        updatedAt: this.now(),
        history: [{ status: BOOKING.REQUESTED, at: this.now() }],
        ignoredEvents: [],
      };
      this.state.bookings[b.id] = b;
      this.send(OUTBOUND.PICKUP_REQUEST, {
        bookingId: b.id,
        userId,
        vehicleId,
        point: b.pickupPoint,
        seatId,
        pickupTime,
      });
      this.log('픽업 요청', { bookingId: b.id });
      this.notify(
        v.ownerId,
        '픽업 요청이 도착했어요',
        `${this.state.users[userId].name}님이 ${point.label || '지정한 위치'}에서 탑승을 요청했어요 (${this.pickupTimeLabel(pickupTime)}).`,
        'pickup',
        { bookingId: b.id },
      );
      this.emit('booking');
      return { booking: b, created: true };
    }

    // ---------- Pleos(차량) 쪽 동작: 운전자만 ----------
    /**
     * 수락된 픽업들의 방문 순서를 정한다. 모든 순서를 비교해(최대 6명) 끝나는 시각 + 늦게 도착한 시간(가중) 이 가장 작은 순서를 고른다.
     * opts: { start: 지금 차량 위치, travel(a,b)→m (도로 거리), speedMpm: 분당 m, now }
     * 반환: { order:[bookingId], stops:[{ bookingId, userId, point, distance, eta, desiredAt, wait, late }], totalDistance, finishAt }
     */
    planPickups(vehicleId, opts) {
      opts = opts || {};
      const now = opts.now || this.now();
      const speed = opts.speedMpm || 400; // 도심 약 24km/h
      const travel = opts.travel || defaultTravel;
      const start = opts.start;
      const list = Object.values(this.state.bookings).filter(
        (b) => b.vehicleId === vehicleId && [BOOKING.ACCEPTED, BOOKING.APPROACHING, BOOKING.ARRIVED].includes(b.status),
      );
      if (!list.length) return { order: [], stops: [], totalDistance: 0, finishAt: now };
      // 이미 도착했거나 접근 중인 곳은 순서를 바꾸지 않고 맨 앞에 둔다
      const fixed = list
        .filter((b) => b.status !== BOOKING.ACCEPTED)
        .sort((a, b) => (a.status === BOOKING.ARRIVED ? -1 : 0) - (b.status === BOOKING.ARRIVED ? -1 : 0));
      const free = list.filter((b) => b.status === BOOKING.ACCEPTED);
      const perms = (arr) =>
        arr.length <= 1
          ? [arr.slice()]
          : arr.flatMap((x, i) => perms(arr.slice(0, i).concat(arr.slice(i + 1))).map((p) => [x].concat(p)));
      const candidates =
        free.length <= 6 ? perms(free) : [free.slice().sort((a, b) => a.pickupTime.at - b.pickupTime.at)];
      let best = null;
      for (const tail of candidates) {
        const seq = fixed.concat(tail);
        let t = now,
          pos = start || seq[0].pickupPoint,
          dist = 0,
          late = 0;
        const stops = [];
        for (const b of seq) {
          const d = travel(pos, b.pickupPoint);
          dist += d;
          t += (d / speed) * 60000;
          const desiredAt = b.pickupTime ? b.pickupTime.at : now;
          const lateMs = Math.max(0, t - desiredAt),
            waitMs = Math.max(0, desiredAt - t);
          stops.push({
            bookingId: b.id,
            userId: b.userId,
            point: clone(b.pickupPoint),
            distance: Math.round(d),
            eta: Math.round(t),
            desiredAt,
            wait: Math.round(waitMs),
            late: Math.round(lateMs),
          });
          late += lateMs;
          t = Math.max(t, desiredAt);
          pos = b.pickupPoint;
        }
        const cost = t + late * 3;
        if (!best || cost < best.cost)
          best = { cost, order: seq.map((b) => b.id), stops, totalDistance: Math.round(dist), finishAt: Math.round(t) };
      }
      delete best.cost;
      return best;
    }

    /** 계산한 순서를 확정하고(내비게이션 경유지 설정) 동승자에게 도착 예정 시각을 알린다. */
    setRoutePlan(driverId, vehicleId, plan) {
      this.requireOwner(driverId, vehicleId);
      this.state.routePlans[vehicleId] = { order: plan.order.slice(), stops: clone(plan.stops), at: this.now() };
      plan.stops.forEach((s, i) => {
        const b = this.state.bookings[s.bookingId];
        if (!b) return;
        const changed = !b.plan || b.plan.order !== i + 1 || Math.abs((b.plan.eta || 0) - s.eta) > 60000;
        b.plan = { order: i + 1, of: plan.stops.length, eta: s.eta };
        if (changed && b.status === BOOKING.ACCEPTED)
          this.notify(b.userId, `${i + 1}번째로 모시러 가요`, `${fmtHM(s.eta)}쯤 도착할 예정이에요.`, 'info', {
            bookingId: b.id,
          });
      });
      this.log('NaviHelper 경유지 설정', { vehicleId, order: plan.order });
      this.emit('route');
    }

    /** 운전자가 Pleos에서 이번 픽업의 좌석을 정한다. remember를 주면 동승자의 '이 좌석 기억하기'도 바꾼다(운전자는 동승자 설정 담당). */
    driverAssignSeat(driverId, bookingId, seatId, remember) {
      const b = this.state.bookings[bookingId];
      if (!b) throw new ValidationError('예약을 찾을 수 없어요.');
      this.requireOwner(driverId, b.vehicleId);
      if (!ACTIVE_STATES.includes(b.status)) throw new ValidationError('끝난 예약이에요.');
      const v = this.state.vehicles[b.vehicleId];
      if (!v.seats.some((s) => s.id === seatId)) throw new ValidationError('이 차량에 없는 좌석이에요.');
      if (this.takenSeats(b.vehicleId, b.id)[seatId]) throw new ValidationError('다른 분에게 배정된 좌석이에요.');
      b.seatId = seatId;
      b.seatSource = 'driver';
      b.seatConflict = false;
      b.updatedAt = this.now();
      if (remember !== undefined) {
        const p = this.getProfile(b.userId, b.vehicleId);
        p.saved.seatId = seatId;
        p.saved.rememberSeat = !!remember;
        p.savedAt = this.now();
      }
      this.notify(
        b.userId,
        '좌석이 정해졌어요',
        `이번에는 ${this.seatLabel(b.vehicleId, seatId)}에 앉아 주세요.`,
        'info',
        { bookingId: b.id },
      );
      this.log('운전자 좌석 배정', { bookingId, seatId, remember });
      this.emit('booking');
      return b;
    }

    /** 운전자가 Pleos에서 동승자 설정을 대신 바꾼다(변경 권한이 없는 동승자 포함). */
    driverSaveProfile(driverId, userId, vehicleId, draft) {
      this.requireOwner(driverId, vehicleId);
      if (!this.membership(userId, vehicleId).invited) throw new ValidationError('초대한 동승자만 설정할 수 있어요.');
      const p = this.getProfile(userId, vehicleId);
      const keep = { seatId: p.saved.seatId, rememberSeat: p.saved.rememberSeat, weightKg: p.saved.weightKg };
      p.saved = Object.assign(this.sanitizeForVehicle(vehicleId, Object.assign({}, p.saved, draft)), keep);
      p.savedAt = this.now();
      this.notify(
        userId,
        '운전자가 내 자리 설정을 바꿨어요',
        `${this.state.vehicles[vehicleId].name} 차량 화면에서 조정했어요.`,
        'info',
      );
      this.log('운전자 설정 변경(Pleos)', { userId, vehicleId });
      this.emit('profile');
      return clone(p.saved);
    }

    /**
     * 차량 화면에서 탑승자가 본인을 고르고 실제로 앉은 좌석을 확인한다(시나리오: "조수석에 탄 아버지가 화면을 선택").
     * - 예정 좌석과 같으면 개인 설정을 그 좌석에 적용
     * - 다르면 reassign=true일 때 실제 좌석으로 배정을 고치고 적용, false면 배정, 설정을 바꾸지 않음
     * 반환: { mismatch, applied, seatId }
     */
    boardPassenger(driverId, bookingId, actualSeatId, opts) {
      opts = opts || {};
      const b = this.state.bookings[bookingId];
      if (!b) throw new ValidationError('예약을 찾을 수 없어요.');
      this.requireOwner(driverId, b.vehicleId);
      if (![BOOKING.APPROACHING, BOOKING.ARRIVED].includes(b.status))
        throw new ValidationError('차량이 도착한 뒤에 탑승을 확인할 수 있어요.');
      const v = this.state.vehicles[b.vehicleId];
      if (!v.seats.some((s) => s.id === actualSeatId)) throw new ValidationError('이 차량에 없는 좌석이에요.');
      const mismatch = !!(b.seatId && b.seatId !== actualSeatId);
      const reassign = opts.reassign !== false;
      const label = this.seatLabel(b.vehicleId, actualSeatId);
      let applied = false;
      if (!mismatch || reassign) {
        // 다른 분에게 배정돼 있던 좌석이면 그 배정은 비운다(그분은 도착 후 다시 확인)
        const other = this.takenSeats(b.vehicleId, b.id)[actualSeatId];
        if (other) {
          this.state.bookings[other].seatId = null;
          this.log('좌석 배정 해제(자리 이동)', { bookingId: other });
        }
        b.seatId = actualSeatId;
        if (opts.remember !== undefined) {
          const p0 = this.getProfile(b.userId, b.vehicleId);
          p0.saved.seatId = actualSeatId;
          p0.saved.rememberSeat = !!opts.remember;
          p0.savedAt = this.now();
        }
        const p = this.getProfile(b.userId, b.vehicleId);
        p.apply = { status: APPLY.APPLIED, at: this.now(), message: `${label}에 적용 (Pleos Vehicle SDK)` };
        applied = true;
      }
      b.boardedSeatId = actualSeatId;
      b.seatMismatch = mismatch;
      b.settingsApplied = applied;
      this._transition(b, BOOKING.COMPLETED, applied ? `${label} 탑승, 설정 적용` : `${label} 탑승, 설정 유지`);
      this.notify(
        b.userId,
        '탑승 완료',
        applied
          ? `${label}에 저장한 자리 설정을 적용했어요. 편안한 이동 되세요.`
          : `${label}에 탑승했어요. 좌석 설정은 바꾸지 않았어요.`,
        'success',
        { bookingId: b.id },
      );
      this.log(applied ? 'Vehicle SDK 좌석 설정 적용' : '탑승 확인(설정 미적용)', {
        bookingId,
        seatId: actualSeatId,
        mismatch,
      });
      this.emit('booking');
      return { mismatch, applied, seatId: actualSeatId };
    }

    /** Pleos 화면이 지금 띄운 로그인 QR을 공유 상태에 올린다(모바일 운전자 앱이 스캔). */
    publishPleosQr(token) {
      if (!token || !token.vehicleId) return;
      this.state.pleosQr[token.vehicleId] = clone(token);
      this.emit('pleosQr');
    }

    _transition(b, status, note) {
      b.status = status;
      b.updatedAt = this.now();
      b.history.push({ status, at: this.now(), note: note || null });
    }

    cancelBooking(userId, bookingId, reason) {
      const b = this.state.bookings[bookingId];
      if (!b) throw new ValidationError('예약을 찾을 수 없어요.');
      if (b.userId !== userId) throw new PermissionError('내 예약만 취소할 수 있어요.');
      if (!ACTIVE_STATES.includes(b.status)) return b;
      this._transition(b, BOOKING.CANCELLED, reason || '사용자 취소');
      this.send(OUTBOUND.PICKUP_CANCEL, { bookingId, by: 'passenger' });
      const v = this.state.vehicles[b.vehicleId];
      if (v)
        this.notify(
          v.ownerId,
          '픽업이 취소되었어요',
          `${this.state.users[userId].name}님이 예약을 취소했어요.`,
          'pickup',
          { bookingId },
        );
      this.log('사용자 취소', { bookingId });
      this.emit('booking');
      return b;
    }

    /** 장애물 안내를 사용자가 확인 → 예약 위치 갱신 + 차량 측 전달 */
    confirmRelocation(userId, bookingId) {
      const b = this.state.bookings[bookingId];
      if (!b) throw new ValidationError('예약을 찾을 수 없어요.');
      if (b.userId !== userId) throw new PermissionError('내 예약만 변경할 수 있어요.');
      if (!b.relocation || b.relocation.confirmed) return b;
      if (!ACTIVE_STATES.includes(b.status)) return b;
      b.previousPoint = clone(b.pickupPoint);
      b.pickupPoint = clone(b.relocation.proposed);
      b.relocation.confirmed = true;
      b.relocation.confirmedAt = this.now();
      b.updatedAt = this.now();
      this.send(OUTBOUND.PICKUP_POINT_UPDATED, { bookingId, point: b.pickupPoint, previous: b.previousPoint });
      this.log('탑승 위치 변경 확인', { bookingId });
      this.emit('booking');
      return b;
    }

    /** 운전자 측 수락/거절 (모바일 운전자 화면 또는 Pleos에서 들어온 이벤트) */
    driverDecide(driverId, bookingId, accept) {
      const b = this.state.bookings[bookingId];
      if (!b) throw new ValidationError('예약을 찾을 수 없어요.');
      this.requireOwner(driverId, b.vehicleId);
      return this.handleVehicleEvent({
        type: accept ? VEHICLE_EVENT.DRIVER_ACCEPT : VEHICLE_EVENT.DRIVER_REJECT,
        bookingId,
      });
    }

    /**
     * 차량/서버에서 들어온 이벤트를 예약 상태에 반영한다.
     * 종료된 예약(거절, 취소, 완료)에 늦게 도착한 이벤트는 무시하고 기록만 남긴다.
     * 반환: { applied: boolean, booking, reason }
     */
    handleVehicleEvent(evt) {
      const type = evt.type;
      // 설정 적용 응답은 예약과 무관
      if (type === VEHICLE_EVENT.APPLY_RESULT) {
        const p = this.getProfile(evt.userId, evt.vehicleId);
        if (p.apply.status !== APPLY.SENT && p.apply.status !== APPLY.PENDING) {
          this.log('적용 응답 무시(요청 없음)', evt);
          return { applied: false, reason: 'no-pending-apply' };
        }
        p.apply = { status: evt.ok ? APPLY.APPLIED : APPLY.FAILED, at: this.now(), message: evt.message || null };
        this.notify(
          evt.userId,
          evt.ok ? '차량에 설정이 적용되었어요' : '차량 적용에 실패했어요',
          evt.message ||
            (evt.ok ? '탑승하면 저장한 자리 환경이 준비돼요.' : '다시 시도하거나 운전자에게 요청해 주세요.'),
          evt.ok ? 'success' : 'error',
        );
        this.log('적용 응답', evt);
        this.emit('apply');
        return { applied: true };
      }

      const b = this.state.bookings[evt.bookingId];
      if (!b) {
        this.log('이벤트 무시(예약 없음)', evt);
        return { applied: false, reason: 'no-booking' };
      }
      if (TERMINAL_STATES.includes(b.status)) {
        b.ignoredEvents.push({ type, at: this.now(), statusAtArrival: b.status });
        this.log('늦은 이벤트 무시: ' + type, { bookingId: b.id, status: b.status });
        this.emit('booking');
        return { applied: false, booking: b, reason: 'terminal' };
      }
      const u = this.state.users[b.userId];
      const v = this.state.vehicles[b.vehicleId];
      const vname = v ? v.name : '차량';
      let applied = true;
      switch (type) {
        case VEHICLE_EVENT.DRIVER_ACCEPT:
          if (b.status !== BOOKING.REQUESTED) {
            applied = false;
            break;
          }
          this._transition(b, BOOKING.ACCEPTED);
          this.notify(
            b.userId,
            '운전자가 수락했어요',
            `${vname}이(가) 출발해요. 지정한 장소에서 기다려 주세요.`,
            'success',
            { bookingId: b.id },
          );
          break;
        case VEHICLE_EVENT.DRIVER_REJECT:
          if (b.status !== BOOKING.REQUESTED) {
            applied = false;
            break;
          }
          this._transition(b, BOOKING.REJECTED, evt.reason || null);
          this.notify(
            b.userId,
            '운전자가 거절했어요',
            evt.reason || '지금은 픽업이 어려워요. 다시 요청하거나 메인으로 돌아갈 수 있어요.',
            'error',
            { bookingId: b.id },
          );
          break;
        case VEHICLE_EVENT.OBSTACLE_REPORTED:
          if (![BOOKING.ACCEPTED, BOOKING.APPROACHING].includes(b.status)) {
            applied = false;
            break;
          }
          if (!evt.point) {
            applied = false;
            break;
          }
          b.relocation = {
            proposed: clone(evt.point),
            message: evt.message || '앞쪽 지정된 탑승 장소로 조금 이동해 주세요.',
            at: this.now(),
            confirmed: false,
            confirmedAt: null,
          };
          b.updatedAt = this.now();
          this.notify(b.userId, '탑승 위치를 옮겨 주세요', b.relocation.message, 'warning', { bookingId: b.id });
          break;
        case VEHICLE_EVENT.VEHICLE_NEAR_50M:
          if (b.status === BOOKING.APPROACHING) {
            applied = false;
            break;
          }
          if (b.status !== BOOKING.ACCEPTED) {
            applied = false;
            break;
          }
          this._transition(b, BOOKING.APPROACHING);
          this.notify(b.userId, '곧 도착해요', '탑승을 준비해 주세요.', 'info', { bookingId: b.id });
          break;
        case VEHICLE_EVENT.VEHICLE_ARRIVED:
          if (![BOOKING.ACCEPTED, BOOKING.APPROACHING].includes(b.status)) {
            applied = false;
            break;
          }
          this._transition(b, BOOKING.ARRIVED);
          this.notify(b.userId, '차량이 도착했어요', `${vname}이(가) 탑승 위치에 있어요.`, 'success', {
            bookingId: b.id,
          });
          break;
        case VEHICLE_EVENT.DRIVER_REMIND:
          this.notify(
            b.userId,
            '운전자가 기다리고 있어요',
            evt.message || '차량이 도착했어요. 탑승 위치로 와 주세요.',
            'warning',
            { bookingId: b.id },
          );
          b.updatedAt = this.now();
          break;
        case VEHICLE_EVENT.DRIVER_CALL_REQUEST:
          this.notify(
            b.userId,
            '운전자가 통화를 요청했어요',
            '앱 통화는 체험 모드에서 실제로 연결되지 않아요.',
            'call',
            { bookingId: b.id, callRequest: true },
          );
          b.updatedAt = this.now();
          break;
        case VEHICLE_EVENT.DRIVER_CANCEL:
          this._transition(b, BOOKING.CANCELLED, evt.reason || '운전자 취소');
          this.notify(
            b.userId,
            '픽업이 취소되었어요',
            evt.reason || '운전자가 픽업을 취소했어요. 다시 요청할 수 있어요.',
            'error',
            { bookingId: b.id },
          );
          break;
        case VEHICLE_EVENT.BOARDING_COMPLETE:
          if (![BOOKING.APPROACHING, BOOKING.ARRIVED].includes(b.status)) {
            applied = false;
            break;
          }
          this._transition(b, BOOKING.COMPLETED);
          this.notify(b.userId, '탑승 완료', `${u ? u.name : ''}님, 편안한 이동 되세요.`, 'success', {
            bookingId: b.id,
          });
          break;
        default:
          applied = false;
      }
      if (!applied) {
        b.ignoredEvents.push({ type, at: this.now(), statusAtArrival: b.status });
        this.log('이벤트 무시(상태 불일치): ' + type, { bookingId: b.id, status: b.status });
      } else {
        this.log('차량 이벤트 반영: ' + type, { bookingId: b.id, status: b.status });
      }
      this.emit('booking');
      return { applied, booking: b };
    }

    // ---------- Pleos QR 인증 ----------
    /**
     * QR 토큰 검증. 읽기만으로 성공 처리하지 않는다 → 유효성 검사 후 '승인 대기' 결과를 돌려주고,
     * 사용자가 승인(confirmPleosLink)해야 연결된다.
     * token: { code, vehicleId, issuedAt, ttlSec }
     */
    validatePleosToken(userId, token) {
      const u = this.state.users[userId];
      if (!u || u.role !== ROLE.DRIVER)
        return { ok: false, reason: 'NOT_DRIVER', message: '운전자 계정에서만 Pleos를 연결할 수 있어요.' };
      if (!token || !token.code || !token.vehicleId)
        return { ok: false, reason: 'INVALID', message: '읽을 수 없는 QR이에요. 다시 스캔해 주세요.' };
      const v = this.state.vehicles[token.vehicleId];
      if (!v) return { ok: false, reason: 'UNKNOWN_VEHICLE', message: '등록되지 않은 차량의 QR이에요.' };
      if (v.ownerId !== userId) return { ok: false, reason: 'NOT_OWNER', message: '내 차량의 QR이 아니에요.' };
      const age = (this.now() - token.issuedAt) / 1000;
      if (age > token.ttlSec || age < 0)
        return { ok: false, reason: 'EXPIRED', message: 'QR이 만료되었어요. Pleos 화면의 새 QR을 다시 스캔해 주세요.' };
      return { ok: true, vehicle: v, token, message: '유효한 QR이에요. 연결을 승인해 주세요.' };
    }
    confirmPleosLink(userId, token) {
      const r = this.validatePleosToken(userId, token); // 승인 시점에 다시 검증(만료 가능)
      if (!r.ok) return r;
      this.state.pleosLinks[token.vehicleId] = { userId, linkedAt: this.now(), tokenCode: token.code };
      this.log('Pleos 연결 완료', { vehicleId: token.vehicleId });
      this.notify(userId, 'Pleos 연결 완료', `${r.vehicle.name} 차량 앱과 계정이 연결되었어요.`, 'success');
      this.emit('pleos');
      return { ok: true, vehicle: r.vehicle };
    }
    unlinkPleos(userId, vehicleId) {
      this.requireOwner(userId, vehicleId);
      delete this.state.pleosLinks[vehicleId];
      this.emit('pleos');
    }

    // ---------- 데모 데이터 ----------
    reset() {
      this.state = emptyState();
      this.emit('reset');
    }

    /**
     * 데모 데이터 — 시나리오 속 가족.
     * 지민 = 워킹맘 A씨(운전자), 영수 = 아버지(데이케어센터, 조수석 기억), 하늘 = 초등학생 딸(학교, 픽업마다 좌석 선택)
     * 차량은 Pleos 개발자 사이트(document.pleos.ai) 공식 디자인 가이드의 기준 차량인 아이오닉 5로 통일한다.
     * 화면의 차 이미지도 같은 가이드에서 가져온다. 두 대는 번호판으로 구분한다.
     * 차량별 지원 항목은 체험용 가정이며 실제 트림과 다를 수 있다(실제 앱은 Vehicle SDK의 지원 여부 확인 결과를 쓴다).
     */
    seedDemo() {
      this.state = emptyState();
      const now = this.now();
      const mk = (id, name, isAdult, role, extra) => {
        this.state.users[id] = Object.assign(
          {
            id,
            name,
            isAdult,
            role,
            ageVerification: { status: 'DEMO_SELF_DECLARED', provider: null, verifiedAt: null },
            createdAt: now,
          },
          extra || {},
        );
      };
      mk('u_jimin', '지민', true, ROLE.DRIVER, { persona: '워킹맘' });
      mk('u_youngsoo', '영수', true, ROLE.PASSENGER, { persona: '아버지', senior: true });
      mk('u_haneul', '하늘', false, ROLE.PASSENGER, { persona: '딸' });

      const seats = () => [
        { id: 'FR', label: '조수석', row: 1 },
        { id: 'RL', label: '뒷좌석 왼쪽', row: 2 },
        { id: 'RR', label: '뒷좌석 오른쪽', row: 2 },
      ];
      const v1 = {
        id: 'v_ioniq5',
        ownerId: 'u_jimin',
        name: '아이오닉 5',
        model: '',
        plate: '12가 3456',
        body: 'ioniq5',
        capabilities: { seatPosition: true, recline: true, heater: true, climate: true, window: true },
        seats: seats(),
        members: {
          u_youngsoo: { invited: true, canEdit: true, invitedAt: now, updatedAt: now, relation: '아버지' },
          u_haneul: { invited: true, canEdit: false, invitedAt: now, updatedAt: now, relation: '딸' },
        },
      };
      const v2 = {
        id: 'v_ioniq5b',
        ownerId: 'u_jimin',
        name: '아이오닉 5',
        model: '',
        plate: '34나 7890',
        body: 'ioniq5',
        capabilities: { seatPosition: true, recline: true, heater: false, climate: false, window: true },
        seats: seats(),
        members: {
          u_haneul: { invited: true, canEdit: true, invitedAt: now, updatedAt: now, relation: '딸' },
        },
      };
      this.state.vehicles[v1.id] = v1;
      this.state.vehicles[v2.id] = v2;

      const ys = this.getProfile('u_youngsoo', 'v_ioniq5');
      ys.saved = Object.assign(DEFAULT_PROFILE(), {
        seatPosition: 65,
        recline: 45,
        heater: { on: true, level: 2 },
        climate: { on: true, temp: 24, fan: 2 },
        seatId: 'FR',
        rememberSeat: true,
      });
      ys.savedAt = now;
      const hn = this.getProfile('u_haneul', 'v_ioniq5');
      hn.saved = Object.assign(DEFAULT_PROFILE(), {
        seatPosition: 30,
        recline: 20,
        climate: { on: true, temp: 23, fan: 3 },
        window: { open: 20 },
        seatId: 'RR',
        rememberSeat: false,
      });
      hn.savedAt = now;

      this.state.sessionUserId = null;
      this.log('데모 데이터 생성');
      this.emit('seed');
    }
  }

  function clamp(v, lo, hi) {
    v = Number(v);
    if (!isFinite(v)) return lo;
    return Math.min(hi, Math.max(lo, v));
  }
  /** 기본 이동 거리(m): 실제 좌표면 직선거리 × 1.35(도로 우회), 가상 좌표면 맨해튼 거리 */
  function defaultTravel(a, b) {
    if (a.lat != null && b.lat != null) {
      const r = Math.PI / 180,
        dLat = (b.lat - a.lat) * r,
        dLng = (b.lng - a.lng) * r;
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
      return 2 * 6371008.8 * Math.asin(Math.sqrt(h)) * 1.35;
    }
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }

  return {
    CarpoomCore,
    PermissionError,
    ValidationError,
    ROLE,
    BOOKING,
    ACTIVE_STATES,
    TERMINAL_STATES,
    APPLY,
    VEHICLE_EVENT,
    OUTBOUND,
    PICKUP_TIME,
    DEFAULT_PROFILE,
    emptyState,
    profileKey,
    clone,
    fmtHM,
  };
});
