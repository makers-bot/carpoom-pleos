/*
 * 카품 엠블럼 — 모바일 앱·Pleos 앱·시연 영상이 같은 모양을 쓴다.
 * 모바일 UI 손그림 스케치를 따른다:
 *  - 반듯한 가로 타원(기울이지 않음)
 *  - 이탤릭 대문자 H, 위아래가 안쪽 타원에 잘림(클리핑 마스크)
 *  - 왼쪽 위에서 오른쪽 아래로 휘어 내려오는 선(안전벨트처럼 H를 '품는' 선). H와 함께 나타난다
 * 색은 글자색(currentColor). 애니메이션용 class: ring(타원), hh(H와 벨트)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CarpoomBrand = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const TILT = 0; // 타원은 반듯하게 둔다
  const SKEW = -14; // H 이탤릭 기울기(도)
  function emblem(id, cls, label) {
    id = String(id || 'e').replace(/[^a-zA-Z0-9_-]/g, '');
    return `<svg class="${cls || ''}" viewBox="0 0 150 100" role="img" aria-label="${label || '카품 엠블럼'}">
  <defs>
    <clipPath id="ec-${id}"><ellipse cx="75" cy="50" rx="57.5" ry="33" transform="rotate(${TILT} 75 50)"/></clipPath>
    <mask id="em-${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="150" height="100"><rect width="150" height="100" fill="#fff"/><path d="M36 30 Q62 64 101 76" stroke="#000" stroke-width="10" fill="none" stroke-linecap="round"/></mask>
  </defs>
  <ellipse class="ring" pathLength="100" cx="75" cy="50" rx="66" ry="40" transform="rotate(${TILT} 75 50)" fill="none" stroke="currentColor" stroke-width="7"/>
  <g clip-path="url(#ec-${id})"><g class="hh"><g mask="url(#em-${id})"><g transform="translate(75 50) skewX(${SKEW}) translate(-75 -50)" fill="currentColor">
    <rect x="45" y="-10" width="19" height="120"/><rect x="86" y="-10" width="19" height="120"/><rect x="63" y="41.5" width="24" height="16"/>
  </g></g><path class="belt" d="M36 30 Q62 64 101 76" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></g></g>
</svg>`;
  }
  // 스플래시·영상 첫 장면용 애니메이션 CSS(선택자 앞부분을 받아 붙인다)
  function animCss(sel) {
    return `${sel} .ring{stroke-dasharray:101 101;stroke-dashoffset:101;animation:cpDraw 1s cubic-bezier(.6,.1,.2,1) .15s forwards}
${sel} .hh{transform:translateY(46px);opacity:0;animation:cpRise .8s cubic-bezier(.2,1.2,.4,1) .75s forwards}
@keyframes cpDraw{to{stroke-dashoffset:0}} @keyframes cpRise{to{transform:none;opacity:1}}`;
  }
  return { emblem, animCss };
});
