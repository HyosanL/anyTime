// 시간표 과목 색 테마(팔레트) — 단일 원본.
// 예전엔 같은 파스텔 10색이 TimetableGrid·timetableImage·Wizard 세 곳에 복붙돼 있었다.
// 여기 한 곳에서 정의하고, 사용자가 고른 팔레트는 기기(localStorage)에만 저장한다
// (화면 테마 lib/theme.js 와 같은 패턴 — 'palettechange' 커스텀 이벤트로 즉시 반영).
//
// 팔레트는 데이터성 값이라 라이트/다크 모드와 무관하게 고정이다. 대신 어두운 팔레트(심해·우주선 등)도
// 칸 글자가 읽히도록 글자색은 타일 배경 밝기로 자동 선택한다(textOn).
import { useEffect, useState } from 'react';

const KEY = 'tt-palette';

// 각 팔레트: 과목(키) 순서대로 colors[i % 10] 로 배정된다.
// '기본'은 예전 색 그대로 — 기존 사용자는 변화가 없다.
export const PALETTES = [
  { key: 'default',       label: '기본',     colors: ['#dbeafe', '#dcfce7', '#fef9c3', '#fce7f3', '#ede9fe', '#ffedd5', '#cffafe', '#fee2e2', '#e0e7ff', '#d1fae5'] },
  { key: 'pastel',        label: '파스텔',   colors: ['#f7c8d4', '#f9e0a8', '#bfe8cf', '#bcd8f2', '#d6c8ee', '#f5d1b0', '#b9e3e0', '#e7c9e8', '#cfe6b4', '#f2c9c0'] },
  { key: 'cottoncandy',   label: '솜사탕',   colors: ['#ffc9de', '#c6e4ff', '#e6c8ff', '#ffe0b8', '#c9f6ec', '#f6c9ec', '#d3d0ff', '#ffd4e6', '#cdefff', '#ead0ff'] },
  { key: 'cherryblossom', label: '벚꽃',     colors: ['#ffd7e2', '#fce4ec', '#f7c1d1', '#e7f0d5', '#ffeef3', '#f4cddb', '#dcefd0', '#fbdbe6', '#f9c9d8', '#eef6df'] },
  { key: 'spaceship',     label: '우주선',   colors: ['#22304f', '#2e2a5e', '#163a4a', '#3b2a63', '#1d3a63', '#4a2a55', '#1a4550', '#2a2f6e', '#34345f', '#123a52'] },
  { key: 'deepsea',       label: '심해',     colors: ['#0e2f3a', '#12384a', '#103a3a', '#16465a', '#0f2d44', '#1a4d5a', '#14424d', '#0d3550', '#1e5560', '#123f4a'] },
  { key: 'cider',         label: '사이다',   colors: ['#d6f5c9', '#c9f0e6', '#eafcc7', '#c9ecff', '#d9f9e0', '#f2fbc0', '#c7f5f0', '#ddf6cf', '#cdeeff', '#e6fbd0'] },
  { key: 'pink',          label: '핑크',     colors: ['#ffcdda', '#ffdcc8', '#ffc0d3', '#ffe3ec', '#ffb6c9', '#ffd0e2', '#f8c2cf', '#ffe0d2', '#ffc9e0', '#ffd9e4'] },
  { key: 'candy',         label: '캔디',     colors: ['#ffb3c1', '#a0e7e5', '#ffd6a5', '#b5ead7', '#c7ceea', '#fbe7a1', '#ffaec9', '#a5d8ff', '#ffc6ff', '#caffbf'] },
  { key: 'balloon',       label: '풍선',     colors: ['#ffb3ba', '#ffdfba', '#fdfcae', '#baffc9', '#bae1ff', '#d0baff', '#ffbaf0', '#baf5ff', '#e0ffba', '#ffcaba'] },
  { key: 'crayon',        label: '크레파스', colors: ['#e8746b', '#f2a65a', '#f2d44e', '#7bc96f', '#5aa9e6', '#7d6bd6', '#d96bb0', '#4fc4c4', '#e6935a', '#9bcf5a'] },
  { key: 'mint',          label: '민트',     colors: ['#c4f0e2', '#a8e6cf', '#d6f2e6', '#b0e8d8', '#cdeef0', '#bce8cf', '#9fe0c8', '#d8f5ea', '#b8ecd6', '#c9f2df'] },
  { key: 'forest',        label: '포레스트', colors: ['#3f6b4a', '#557a4a', '#6b7f3e', '#2f5d43', '#7a8a4a', '#46734f', '#8a7a3e', '#33604a', '#607a3f', '#4a6b3a'] },
  { key: 'spring',        label: '봄',       colors: ['#d7f0c2', '#ffd6e0', '#fff2b8', '#c9ecd6', '#ffe0ec', '#eaf7c0', '#ffd9c2', '#cdeede', '#f7d9ef', '#e2f4c4'] },
  { key: 'summer',        label: '여름',     colors: ['#4fc3f7', '#ffca7a', '#ffe066', '#4dd0a8', '#ff8a80', '#40c4d6', '#ffb347', '#5ac8fa', '#a5e05a', '#ff9eb0'] },
  { key: 'autumn',        label: '가을',     colors: ['#d98a4e', '#c56a3a', '#e0b04a', '#a85a3c', '#b8823e', '#cf7a4a', '#9c5a3a', '#d4a24e', '#b06a4a', '#e0975a'] },
  { key: 'winter',        label: '겨울',     colors: ['#dbe6f0', '#c9d8e8', '#e0e8f2', '#b8cce0', '#d0dcec', '#c2d4e6', '#dae4f0', '#b0c8de', '#cdd9e8', '#e4ecf5'] },
];

export const DEFAULT_KEY = 'default';
const BY_KEY = Object.fromEntries(PALETTES.map((p) => [p.key, p]));

export function paletteByKey(key) {
  return BY_KEY[key] || BY_KEY[DEFAULT_KEY];
}

export function getPaletteKey() {
  try {
    const k = localStorage.getItem(KEY);
    return k && BY_KEY[k] ? k : DEFAULT_KEY;
  } catch {
    return DEFAULT_KEY;
  }
}

export function getColors(key = getPaletteKey()) {
  return paletteByKey(key).colors;
}

export function setPaletteKey(key) {
  const k = BY_KEY[key] ? key : DEFAULT_KEY;
  try { localStorage.setItem(KEY, k); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent('palettechange', { detail: k }));
}

// ── 칸 글자색 자동 대비 ────────────────────────────────────────────────
// 타일 배경 위에 검정(어두운 슬레이트) / 흰(near-white) 중 대비가 더 큰 쪽을 고른다.
// → 어떤 팔레트(밝은 파스텔이든 어두운 심해든)를 넣어도 칸 글자가 항상 읽힌다.
const FG_DARK = '#1f2937';   // 밝은 타일 위 (기존 --on-pastel 과 동일)
const FG_LIGHT = '#f7f9fc';  // 어두운 타일 위

function relLum(hex) {
  const h = String(hex).replace('#', '');
  const toLin = (c) => {
    const s = parseInt(c, 16) / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const r = toLin(h.slice(0, 2));
  const g = toLin(h.slice(2, 4));
  const b = toLin(h.slice(4, 6));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const L_DARK = relLum(FG_DARK);
const L_LIGHT = relLum(FG_LIGHT);
const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

export function textOn(hex) {
  const L = relLum(hex);
  return contrast(L, L_DARK) >= contrast(L, L_LIGHT) ? FG_DARK : FG_LIGHT;
}

// React 훅: [key, setPaletteKey] — 'palettechange' 를 구독해 홈·마법사·피커가 함께 갱신된다.
export function usePalette() {
  const [key, setLocal] = useState(getPaletteKey);
  useEffect(() => {
    const onChange = (e) => setLocal(e.detail || getPaletteKey());
    window.addEventListener('palettechange', onChange);
    return () => window.removeEventListener('palettechange', onChange);
  }, []);
  return [key, setPaletteKey];
}
