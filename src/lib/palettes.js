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
  // 우주선: 어두운 네이비 → 화사한 코스믹(라벤더·인디고·시안·핑크). 밝고 선명하게.
  { key: 'spaceship',     label: '우주선',   colors: ['#a78bfa', '#a5b4fc', '#f0abfc', '#7dd3fc', '#c4b5fd', '#f9a8d4', '#93c5fd', '#d8b4fe', '#67e8f9', '#b5a8fb'] },
  // 심해: 칙칙한 남색 → 선명하고 시원한 바다색(청록·아쿠아·하늘). 밝게.
  { key: 'deepsea',       label: '심해',     colors: ['#22d3ee', '#5eead4', '#38bdf8', '#99f6e4', '#7dd3fc', '#2dd4bf', '#67e8f9', '#06b6d4', '#a5f3fc', '#14b8a6'] },
  { key: 'cider',         label: '사이다',   colors: ['#d6f5c9', '#c9f0e6', '#eafcc7', '#c9ecff', '#d9f9e0', '#f2fbc0', '#c7f5f0', '#ddf6cf', '#cdeeff', '#e6fbd0'] },
  { key: 'pink',          label: '핑크',     colors: ['#ffcdda', '#ffdcc8', '#ffc0d3', '#ffe3ec', '#ffb6c9', '#ffd0e2', '#f8c2cf', '#ffe0d2', '#ffc9e0', '#ffd9e4'] },
  { key: 'candy',         label: '캔디',     colors: ['#ffb3c1', '#a0e7e5', '#ffd6a5', '#b5ead7', '#c7ceea', '#fbe7a1', '#ffaec9', '#a5d8ff', '#ffc6ff', '#caffbf'] },
  { key: 'balloon',       label: '풍선',     colors: ['#ffb3ba', '#ffdfba', '#fdfcae', '#baffc9', '#bae1ff', '#d0baff', '#ffbaf0', '#baf5ff', '#e0ffba', '#ffcaba'] },
  // 크레파스: 탁한 색 → 밝은 크레용 12색 느낌으로.
  { key: 'crayon',        label: '크레파스', colors: ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#4dabf7', '#9775fa', '#f783ac', '#3bc9db', '#ffb84d', '#94d82d'] },
  { key: 'mint',          label: '민트',     colors: ['#c4f0e2', '#a8e6cf', '#d6f2e6', '#b0e8d8', '#cdeef0', '#bce8cf', '#9fe0c8', '#d8f5ea', '#b8ecd6', '#c9f2df'] },
  // 포레스트: 어두운 숲 → 싱그러운 초록/라임 초원으로.
  { key: 'forest',        label: '포레스트', colors: ['#4ade80', '#84cc16', '#22c55e', '#a3e635', '#34d399', '#86efac', '#65d97a', '#bef264', '#10b981', '#b7e56a'] },
  { key: 'spring',        label: '봄',       colors: ['#d7f0c2', '#ffd6e0', '#fff2b8', '#c9ecd6', '#ffe0ec', '#eaf7c0', '#ffd9c2', '#cdeede', '#f7d9ef', '#e2f4c4'] },
  { key: 'summer',        label: '여름',     colors: ['#4fc3f7', '#ffca7a', '#ffe066', '#4dd0a8', '#ff8a80', '#40c4d6', '#ffb347', '#5ac8fa', '#a5e05a', '#ff9eb0'] },
  // 가을: 탁한 중간톤 → 진한 러스트(흰 글자) + 밝은 골드(어두운 글자)로 대비를 살림.
  { key: 'autumn',        label: '가을',     colors: ['#9a3412', '#f59e0b', '#7c2d12', '#fbbf24', '#b45309', '#fcd34d', '#92400e', '#f8b13c', '#c2410c', '#eab308'] },
  { key: 'winter',        label: '겨울',     colors: ['#dbe6f0', '#c9d8e8', '#e0e8f2', '#b8cce0', '#d0dcec', '#c2d4e6', '#dae4f0', '#b0c8de', '#cdd9e8', '#e4ecf5'] },
  // ── 추가 테마 ──────────────────────────────────────────────────────
  { key: 'mono',          label: '모노',     colors: ['#e2e5e9', '#cbd2da', '#aab3bf', '#dfe3e8', '#b8c0cb', '#9aa4b2', '#d3d9e0', '#c0c8d2', '#e8ebee', '#adb6c1'] },
  { key: 'mediterranean', label: '지중해',   colors: ['#2563eb', '#38bdf8', '#f4f1e8', '#c04a2f', '#9bbf3f', '#f2cc4e', '#1d6fd4', '#b83d24', '#b5d15a', '#efe6d0'] },
  { key: 'sunset',        label: '선셋',     colors: ['#ff9e64', '#ff7e79', '#ff6b9d', '#ffc06b', '#f77fb0', '#ff8e72', '#ffb27a', '#ff97b5', '#ffd08a', '#ff6f91'] },
  { key: 'lavender',      label: '라벤더',   colors: ['#c4b5fd', '#d8b4fe', '#e9d5ff', '#cabffd', '#dcd0ff', '#b9a7f5', '#e5d4fb', '#d0bff9', '#efe4ff', '#c9b6f7'] },
  { key: 'retro',         label: '레트로',   colors: ['#e6a93f', '#b8542a', '#a3b84f', '#3f9e9e', '#efd9a6', '#e89a45', '#9e4a2a', '#7cbf9a', '#d4bd6e', '#8fb0bf'] },
  { key: 'tropical',      label: '트로피컬', colors: ['#2dd4bf', '#fb7185', '#fcd34d', '#34d399', '#f472b6', '#22d3ee', '#fb923c', '#a3e635', '#38bdf8', '#fda4af'] },
  { key: 'rosegold',      label: '로즈골드', colors: ['#f4c2c2', '#eac9b8', '#f6d5c6', '#e8b4b8', '#f2cbb6', '#edc3ae', '#f7d9cf', '#e6b8a2', '#f5cdc0', '#ecd0bd'] },
  { key: 'matcha',        label: '말차',     colors: ['#aec96a', '#c8d98f', '#97bd5a', '#dbe6a5', '#b9d47a', '#8db84f', '#d0e29a', '#a6cd6b', '#86ac48', '#e2ebb0'] },
  { key: 'berry',         label: '베리',     colors: ['#ec4899', '#d946ef', '#f472b6', '#e879f9', '#be185d', '#f0abfc', '#db2777', '#f9a8d4', '#a21caf', '#c2185b'] },
  { key: 'mocha',         label: '모카',     colors: ['#d9c4a8', '#9a6a44', '#e8d7bf', '#8a5a34', '#cdb392', '#decdb0', '#a67142', '#d4bb98', '#6b4423', '#c9a877'] },
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

// ── 칸 글자색 ─────────────────────────────────────────────────────────
// 어두운·진한 타일엔 흰 글자, 밝은 타일엔 어두운 글자.
// 예전엔 '대비 최대화'라 중간톤 배경에 어두운 글자가 붙어(가을처럼) '배경도 어둡고 글자도 어두워'
// 답답했다. 교차점을 살짝 올려(밝기 L<0.32 면 흰 글자) 진한 타일은 흰/회색 글자로 또렷하게 읽힌다.
const FG_DARK = '#1f2937';   // 밝은 타일 위 (기존 --on-pastel 과 동일)
const FG_LIGHT = '#f8fafc';  // 어두운/진한 타일 위 (메타 줄은 opacity 0.78 → 회색 느낌)

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

export function textOn(hex) {
  return relLum(hex) < 0.32 ? FG_LIGHT : FG_DARK;
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
