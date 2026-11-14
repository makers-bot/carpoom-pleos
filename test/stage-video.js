// 카품 시연 영상 녹화 — node test/stage-video.js
// 시연 무대(휴대폰 2대 + Pleos 화면)를 데모 시나리오대로 조작하며 화면을 녹화한다.
//  - 브라우저 화면을 3840×2160으로 열고 1920×1080 무대를 2배로 키운다. 지도, 3D처럼 직접 그리는 화면도 2배 밀도로 그린다
//    (헤드리스 화면 스트리밍은 기기 픽셀 배율을 무시하고 CSS 크기로만 프레임을 보내므로, 화면 자체를 4K로 연다)
//  - 브라우저가 그린 프레임(CDP screencast)을 받은 시각과 함께 디스크에 저장한 뒤, 그 시각대로 60fps 영상을 만든다
//  - 결과: demo/카품_시연영상_4K.mp4 (3840×2160), demo/카품_시연영상_1080p.mp4 (4K에서 축소, 제출, 메일용)
// 필요: node build.js로 dist 생성, ffmpeg(PATH 또는 FFMPEG_PATH), 인터넷(지도 타일, 서체)
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { launch } = require('./browser');
const Brand = require('../carpoom-brand.js');

const OUT = path.join(__dirname, '..', 'demo');
fs.mkdirSync(OUT, { recursive: true });
const NAME = process.env.VIDEO_NAME || '카품_시연영상';
// demo/pleos-frame/에 에뮬레이터에서 캡처한 Pleos 화면(park.png, park_heat.png, park_heat_toast.png, drive.mp4)이 있으면,
// 차량 앱을 그 Pleos Connect 화면의 앱 창 자리에 띄워 녹화한다(PLEOS_FRAME=0이면 쓰지 않음)
const FRAME_DIR = path.join(__dirname, '..', 'demo', 'pleos-frame');
const USE_FRAME = process.env.PLEOS_FRAME !== '0' && fs.existsSync(path.join(FRAME_DIR, 'park.png'));
const STAGE =
  'file:///' +
  path.join(__dirname, '..', 'dist', 'stage.html').split(path.sep).join('/') +
  (USE_FRAME ? '?frame=../demo/pleos-frame/' : '');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const K = Number(process.env.SCALE || 2); // 무대 확대 배율(2 = 4K)
const FPS = 60;
// (실험 기능) TIME_SCALE을 1보다 작게 주면 화면 속 시간을 S배로 느리게 돌려 녹화하고, 영상으로 만들 때 1/S배로 되돌린다.
// 4K로 여러 화면을 함께 그리면 브라우저가 초당 그릴 수 있는 장면 수가 줄어드는데, 느리게 돌리면 장면 사이 움직임이 작아져 부드럽다
const S = Number(process.env.TIME_SCALE || 1); // 1 = 실제 속도
const FR = fs.mkdtempSync(path.join(os.tmpdir(), 'carpoom-frames-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms / S));

(async () => {
  const browser = await launch({ args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({
    viewport: { width: 1920 * K, height: 1080 * K },
    deviceScaleFactor: 1,
    locale: 'ko-KR',
  });
  // 지도(MapLibre), 3D 좌석(three.js)이 확대된 크기에 맞춰 촘촘히 그리도록 화면 밀도를 알려 준다
  await ctx.addInitScript((k) => {
    try {
      Object.defineProperty(window, 'devicePixelRatio', { get: () => k, configurable: true });
    } catch (e) {
      /* noop */
    }
  }, K);
  // 데모 시나리오(퇴근 후 오후 5시대)에 맞춰 화면 시계를 맞춘다. 시간은 그대로 흐른다. 예: DEMO_TIME=17:40
  const [hh, mm] = (process.env.DEMO_TIME || '17:37').split(':').map(Number);
  const demoNow = new Date();
  demoNow.setHours(hh, mm, 0, 0);
  // 모든 화면(iframe 포함)의 시계를 데모 시각으로 옮기고, 시간 흐름(Date, performance.now, 타이머, 애니메이션 프레임, 동영상)을 S배로 늦춘다.
  // 모든 화면이 같은 기준 시각(T0)을 써서 화면 사이 시각이 어긋나지 않는다
  await ctx.addInitScript(
    ({ offset, T0, S }) => {
      const RealDate = Date;
      const now = () => T0 + (RealDate.now() - T0) * S + offset;
      class DemoDate extends RealDate {
        constructor(...a) {
          if (a.length === 0) super(now());
          else super(...a);
        }
        static now() {
          return now();
        }
      }
      globalThis.Date = DemoDate;
      const rNow = performance.now.bind(performance);
      const base = rNow();
      const scaled = (t) => base + (t - base) * S;
      performance.now = () => scaled(rNow());
      const rST = window.setTimeout.bind(window),
        rSI = window.setInterval.bind(window),
        rRAF = window.requestAnimationFrame.bind(window);
      window.setTimeout = (fn, ms, ...a) => rST(fn, (ms || 0) / S, ...a);
      window.setInterval = (fn, ms, ...a) => rSI(fn, (ms || 0) / S, ...a);
      window.requestAnimationFrame = (cb) => rRAF((t) => cb(scaled(t)));
      const rPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        this.playbackRate = S;
        return rPlay.call(this);
      };
    },
    { offset: demoNow.getTime() - Date.now(), T0: Date.now(), S },
  );
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(STAGE);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await wait(4500); // 지도 타일, 서체 로드

  // ---- 자막(글자만), 터치 표시, 제목 카드(무대 위에 겹침) ----
  await page.addStyleTag({
    content: `
    .links{display:none}
    #cap{position:fixed;left:0;right:0;bottom:${44 * K}px;z-index:99;text-align:center;color:#fff;font:700 ${26 * K}px/1.45 "Asta Sans","Malgun Gothic",sans-serif;letter-spacing:-.01em;
      text-shadow:0 ${2 * K}px ${3 * K}px rgba(0,0,0,.95),0 0 ${18 * K}px rgba(0,0,0,.9),0 0 ${36 * K}px rgba(0,0,0,.7);transition:opacity .3s;white-space:nowrap}
    #cap:empty{opacity:0}
    #cap b{color:#7CC2F4}
    .tap{position:fixed;width:${58 * K}px;height:${58 * K}px;margin:-${29 * K}px 0 0 -${29 * K}px;border-radius:50%;background:rgba(47,140,255,.35);border:${4 * K}px solid #fff;box-shadow:0 0 0 ${3 * K}px rgba(47,140,255,.7);z-index:98;pointer-events:none;animation:tap .6s ease-out forwards}
    @keyframes tap{0%{transform:scale(.45);opacity:1}100%{transform:scale(1.7);opacity:0}}
    #card{position:fixed;inset:0;z-index:100;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${22 * K}px;background:radial-gradient(120% 90% at 50% 30%,#0B3D78 0%,#002C5F 45%,#00152E 100%);color:#fff;font-family:"Asta Sans","Malgun Gothic",sans-serif;transition:opacity .8s}
    #card.hide{opacity:0;pointer-events:none}
    #card svg{width:${210 * K}px;height:${140 * K}px}
    #card.only svg{width:${360 * K}px;height:${240 * K}px}
    #card .t{font-size:${64 * K}px;font-weight:800;letter-spacing:-.02em}
    #card .s{font-size:${30 * K}px;color:rgba(255,255,255,.85)}
    #card .team{font-size:${32 * K}px;font-weight:800;letter-spacing:.02em;color:#fff;margin-top:${6 * K}px;text-align:center;line-height:1.35}
    #card .team small{display:block;font-size:${22 * K}px;font-weight:600;letter-spacing:.06em;color:rgba(255,255,255,.75)}
    #card.still .ring,#card.still .hh{animation:none;stroke-dashoffset:0;transform:none;opacity:1}
    #card .k{font-size:${21 * K}px;color:rgba(255,255,255,.6);margin-top:${8 * K}px}
    ${Brand.animCss('#card.only')}`,
  });
  await page.evaluate((emb) => {
    const c = document.createElement('div');
    c.id = 'cap';
    document.body.appendChild(c);
    window.__cap = (t) => {
      c.innerHTML = t;
    };
    window.__tap = (x, y) => {
      const d = document.createElement('div');
      d.className = 'tap';
      d.style.left = x + 'px';
      d.style.top = y + 'px';
      document.body.appendChild(d);
      setTimeout(() => d.remove(), 700);
    };
    window.__card = (t, s, k, team) => {
      let el = document.getElementById('card');
      if (!el) {
        el = document.createElement('div');
        el.id = 'card';
        document.body.appendChild(el);
      }
      el.className = t ? '' : team ? 'only still' : 'only';
      el.innerHTML =
        emb +
        (t ? `<div class="t">${t}</div><div class="s">${s}</div>${k ? `<div class="k">${k}</div>` : ''}` : '') +
        (team ? `<div class="team">${team}</div>` : '');
    };
    window.__hideCard = () => {
      const el = document.getElementById('card');
      if (el) {
        el.className = el.className + ' hide';
        setTimeout(() => el.remove(), 900);
      }
    };
  }, Brand.emblem('vid'));
  const cap = async (t, ms) => {
    await page.evaluate((t) => window.__cap(t), t);
    if (ms) await wait(ms);
  };
  const frames = {
    dad: page.frameLocator('#f-dad'),
    kid: page.frameLocator('#f-kid'),
    car: page.frameLocator('#f-car'),
  };
  const frameOf = (k) =>
    page
      .frames()
      .find((f) =>
        f.url().includes(k === 'car' ? 'pleos-standalone' : k === 'dad' ? 'user=u_youngsoo' : 'user=u_haneul'),
      );
  // 무대의 각 화면(iframe)은 축소되어 있으므로, 화면 안 좌표에 축소 비율을 곱해 무대 좌표로 바꾼다
  const IFR = { dad: '#f-dad', kid: '#f-kid', car: '#f-car' };
  const tap = async (k, sel, ms) => {
    const loc = frames[k].locator(sel).first();
    await loc.waitFor({ state: 'visible', timeout: 60000 / S });
    // 스크롤되는 본문(.content) 안의 요소만, 본문을 부드럽게 굴려 가운데로 가져온다(고정된 탭, 상단은 그대로)
    const moved = await loc.evaluate((el) => {
      const c = el.closest('.content');
      if (!c || c.scrollHeight <= c.clientHeight) return false;
      const cr = c.getBoundingClientRect(),
        r = el.getBoundingClientRect();
      if (r.top >= cr.top + 40 && r.bottom <= cr.bottom - 40) return false;
      c.scrollBy({ top: r.top + r.height / 2 - (cr.top + cr.height / 2), behavior: 'smooth' });
      return true;
    });
    if (moved) await wait(700);
    const r = await loc.evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    });
    const fb = await page.locator(IFR[k]).boundingBox();
    const s = fb.width / (await page.locator(IFR[k]).evaluate((el) => el.offsetWidth));
    const x = fb.x + (r.x + r.w / 2) * s,
      y = fb.y + (r.y + r.h / 2) * s;
    await page.evaluate(([x, y]) => window.__tap(x, y), [x, y]);
    await wait(220);
    await page.mouse.click(x, y);
    await wait(ms || 900);
  };
  const tapText = (k, t, ms) => tap(k, `text=${t}`, ms);
  const until = async (k, fn, timeout) => {
    const f = frameOf(k);
    const t0 = Date.now();
    while (Date.now() - t0 < ((timeout || 60000) * 3) / S) {
      if (await f.evaluate(fn).catch(() => false)) return true;
      await wait(150);
    }
    return false;
  };

  // ---- 녹화: 프레임을 받은 시각과 함께 디스크에 저장 ----
  const shots = [];
  let stopped = false,
    n = 0;
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Animation.enable');
  await cdp.send('Animation.setPlaybackRate', { playbackRate: S }); // CSS 애니메이션, 전환도 같은 속도로
  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    if (!stopped) {
      const buf = Buffer.from(data, 'base64');
      if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
        const f = 'f' + String(n++).padStart(6, '0') + '.jpg';
        fs.writeFileSync(path.join(FR, f), buf);
        shots.push({ f, t: metadata.timestamp });
      }
    }
    try {
      await cdp.send('Page.screencastFrameAck', { sessionId });
    } catch (e) {
      /* 끝남 */
    }
  });
  await page.evaluate(() => window.__card(''));
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 95,
    maxWidth: 1920 * K,
    maxHeight: 1080 * K,
    everyNthFrame: 1,
  });
  await wait(3200);
  await page.evaluate(() => window.__hideCard());
  await wait(900);

  // ① 로그인
  await cap('퇴근한 <b>지민(워킹맘)</b>이 아이오닉 5에 탑니다. 차량 화면의 QR로 카품을 연결합니다.', 3200);
  await tap('car', '[data-act="demoScan"]', 1800);
  await cap('연결되었습니다. 왼쪽 위는 <b>알림</b>, 왼쪽 아래는 <b>지도</b>, 오른쪽은 <b>좌석</b>입니다.', 2800);

  // ② 아버지 요청
  await cap('데이케어센터에 계신 <b>아버지(영수)</b>가 휴대폰으로 픽업을 요청합니다.', 1500);
  await tap('dad', '.nav [data-view="booking"]', 900);
  await tapText('dad', '네, 예약할게요', 1900);
  await tapText('dad', '내 위치 사용', 800);
  await tap('dad', '[data-action="locDecide"][data-v="1"]', 1300);
  await cap('탑승 시간은 <b>지금 바로</b>, 좌석은 늘 앉던 <b>조수석(기억함)</b>입니다.', 2300);
  await tap('dad', '[data-action="confirmBooking"]', 1700);
  await cap('차량 화면에 <b>픽업 요청</b>이 바로 표시됩니다.', 2400);

  // ③ 딸 요청
  await cap(
    '학교에 있는 <b>딸(하늘)</b>은 시간을 <b>직접 입력</b>해 <b>18시</b>에 <b>뒷좌석 오른쪽</b>으로 요청합니다.',
    1500,
  );
  await tap('kid', '.nav [data-view="booking"]', 900);
  await tapText('kid', '네, 예약할게요', 1900);
  await tapText('kid', '내 위치 사용', 800);
  await tap('kid', '[data-action="locDecide"][data-v="1"]', 1300);
  await tap('kid', '#f-bth', 300);
  await page.keyboard.type('18', { delay: 180 / S });
  await wait(250);
  await page.keyboard.type('00', { delay: 180 / S });
  await wait(700);
  await tap('kid', '.seatbtn[data-seat="RR"]', 1000);
  await tap('kid', '[data-action="confirmBooking"]', 1800);

  // ④ 수락, 좌석
  await cap('운전자는 화면을 <b>한 번만</b> 눌러 수락합니다.', 1200);
  await tap('car', '[data-act="accept"]', 1300);
  await cap('아버지가 <b>기억한 조수석</b>을 이번에도 쓸지 묻습니다.', 1600);
  await tap('car', '[data-act="memYes"]', 1000);
  await tap('car', '[data-act="accept"]', 1600);

  // ⑤ 순서 계획
  await cap(
    '<b>시간과 위치를 함께 비교</b>해 순서를 정합니다. 학교가 더 가깝지만 아버지가 지금 기다리므로 먼저 갑니다.',
    4800,
  );
  await cap('아버지와 딸의 휴대폰에도 <b>몇 번째로, 몇 시쯤</b> 도착하는지 바로 전달됩니다.', 3200);

  // ⑥ 안내 시작
  await frameOf('car').evaluate(() => {
    window.__pleos.ui.speed = 1.7;
    window.__pleos.ui.mismatchDemo = false;
  });
  await cap('<b>안내를 시작</b>합니다. NaviHelper로 경유지 2곳(아버지와 딸)과 목적지(집)를 전달합니다.', 1300);
  await tap('car', '[data-act="startDrive"]', 3600);
  await cap('휴대폰 지도에서도 <b>차가 오는 모습</b>이 실시간으로 보입니다.', 1000);
  await until(
    'dad',
    () => window.__carpoom.core.state.notifications.some((n) => n.userId === 'u_youngsoo' && n.title === '곧 도착해요'),
    60000,
  );
  await cap('<b>50m 전</b>에 아버지 휴대폰으로 <b>곧 도착해요</b> 알림을 보냅니다.', 1000);
  await until('car', () => window.__pleos.ui.board && window.__pleos.ui.board.step === 'identify', 30000);

  // ⑦ 아버지 탑승
  await cap('도착하면 <b>좌석 점유 센서</b>로 착석을 감지하고, 탄 사람이 화면에서 <b>본인</b>을 누릅니다.', 2600);
  await tap('car', '[data-act="iam"]', 1300);
  await cap('<b>조수석</b>에 앉았는지 확인합니다.', 900);
  await tap('car', '[data-act="seatYes"]', 600);
  await cap('<b>Vehicle SDK</b>로 아버지 자리의 등받이, 열선, 공조를 맞춥니다.', 3800);

  // ⑧ 장애물 → 탑승 위치 변경
  await until(
    'car',
    () => window.__pleos.drive && !window.__pleos.drive.paused && window.__pleos.drive.idx === 1,
    15000,
  );
  await wait(1200);
  await frameOf('car').evaluate(() => window.__pleos.act.demoObstacle());
  await cap('학교 앞에 <b>주정차 차량</b>이 있습니다. 딸에게 <b>45m 앞</b> 탑승 위치를 안내합니다.', 2600);
  await tap('kid', '[data-action="confirmRelocation"]', 900);
  await cap('딸이 <b>새 위치</b>를 확인하면 차량 경로가 바로 바뀝니다.', 3000);

  // ⑨ 딸 탑승(다른 자리)
  await frameOf('car').evaluate(() => {
    window.__pleos.ui.mismatchDemo = true;
  });
  await cap('이번에는 딸이 <b>예정과 다른 자리</b>에 앉은 경우입니다.', 1000);
  await until('car', () => window.__pleos.ui.board && window.__pleos.ui.board.step === 'identify', 60000);
  await tap('car', '[data-act="iam"]', 1100);
  await tap('car', '[data-act="seatYes"]', 900);
  await cap('예정 좌석과 다르므로 <b>좌석 배정과 설정값</b>을 바꿀지 묻습니다.', 2600);
  await tap('car', '[data-act="mismatchFix"]', 600);
  await cap('실제로 앉은 <b>뒷좌석 왼쪽</b>에 딸의 설정을 적용합니다.', 4200);
  await until('car', () => window.__pleos.ui.done, 15000);
  await cap('모두 탑승했습니다. 운전자는 <b>경로 검색도, 좌석 조작도 없이</b> 운전에만 집중합니다.', 2600);
  await tap('car', '[data-act="goHome"]', 4500);
  await cap('', 300);

  // ⑩ 마무리
  await page.evaluate(() => window.__card('', '', '', '티키타카<small>TikiTa_Car</small>')); // 마지막 화면: 엠블럼과 팀명만
  await wait(4200);
  stopped = true;
  await cdp.send('Page.stopScreencast');
  await browser.close();

  // ---- 저장한 프레임을 받은 시각대로 이어 붙여 60fps 영상으로 ----
  const list = [];
  shots.forEach((s, i) => {
    const next = shots[i + 1];
    list.push(`file '${s.f}'`, `duration ${(((next ? next.t : s.t + 0.5) - s.t) * S).toFixed(6)}`);
  });
  list.push(`file '${shots[shots.length - 1].f}'`);
  fs.writeFileSync(path.join(FR, 'list.txt'), list.join('\n'));
  const enc = (args) => {
    const r = spawnSync(FFMPEG, args, { cwd: FR, stdio: ['ignore', 'inherit', 'inherit'] });
    if (r.status !== 0) throw new Error('ffmpeg 실패');
  };
  const out4k = path.join(OUT, NAME + '_4K.mp4'),
    out1080 = path.join(OUT, NAME + '_1080p.mp4');
  enc([
    '-y',
    '-loglevel',
    'error',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    'list.txt',
    '-fps_mode',
    'cfr',
    '-r',
    String(FPS),
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '16',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    out4k,
  ]);
  enc([
    '-y',
    '-loglevel',
    'error',
    '-i',
    out4k,
    '-vf',
    'scale=1920:1080:flags=lanczos',
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '17',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    out1080,
  ]);
  fs.rmSync(FR, { recursive: true, force: true });
  const dur = shots.length ? (shots[shots.length - 1].t - shots[0].t) * S + 0.5 : 0;
  console.log(
    'saved',
    out4k,
    '+',
    out1080,
    dur.toFixed(1) + 's',
    shots.length + ' frames',
    errors.length ? 'errors: ' + errors.join(' | ') : 'no page errors',
  );
})().catch((e) => {
  console.error(e);
  try {
    fs.rmSync(FR, { recursive: true, force: true });
  } catch (_) {}
  process.exit(1);
});
