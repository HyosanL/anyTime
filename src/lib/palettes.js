// 시간표 과목 색 테마(팔레트) — 단일 원본.
// 예전엔 같은 파스텔 10색이 TimetableGrid·timetableImage·Wizard 세 곳에 복붙돼 있었다.
// 여기 한 곳에서 정의하고, 사용자가 고른 팔레트는 기기(localStorage)에만 저장한다
// (화면 테마 lib/theme.js 와 같은 패턴 — 'palettechange' 커스텀 이벤트로 즉시 반영).
//
// 각 팔레트는 { colors[10], fg } 로, fg 는 그 테마 '한 벌'의 글자색(테마 안에서 통일).
// 팔레트는 명도(밝기)를 일관되게 짜서 그 하나의 fg 가 10칸 배경 어디에서도 읽히게 한다
// (밝은 테마=어두운 글자, 어두운 테마=밝은 글자). 배색은 팬톤/검증된 조합을 참고.
// 순서는 '인기 많을 법한 순' — 뉴트럴·소프트 파스텔 → 비비드 → 다크.
import { useEffect, useState } from 'react';

const KEY = 'tt-palette';

export const PALETTES = [
  // ── 뉴트럴·소프트(어두운 글자) ──────────────────────────────────────
  { key: 'default',       label: '기본',       fg: '#1f2937', colors: ['#dbeafe', '#dcfce7', '#fef9c3', '#fce7f3', '#ede9fe', '#ffedd5', '#cffafe', '#fee2e2', '#e0e7ff', '#d1fae5'] },
  { key: 'latte',         label: '라떼',       fg: '#4a3a2c', colors: ['#efe6d8', '#e3d3bf', '#f3ece0', '#e8dcc8', '#dcc9ae', '#f0e4d2', '#e5d6c0', '#ded0b8', '#f2e8da', '#d8c7ac'] },
  { key: 'sage',          label: '세이지',     fg: '#2f3b30', colors: ['#dbe4d3', '#c9d8c0', '#e2e9db', '#cfdcc7', '#bcd0b2', '#d6e2cc', '#c3d4b8', '#e0e8d6', '#cddcc4', '#b8ccae'] },
  { key: 'pastel',        label: '파스텔',     fg: '#33384a', colors: ['#f7c8d4', '#f9e0a8', '#bfe8cf', '#bcd8f2', '#d6c8ee', '#f5d1b0', '#b9e3e0', '#e7c9e8', '#cfe6b4', '#f2c9c0'] },
  { key: 'peach',         label: '피치',       fg: '#5a3626', colors: ['#ffdfd0', '#ffd0bd', '#ffe8dc', '#ffc9b0', '#ffd8c2', '#ffe0d0', '#ffcbb5', '#ffeae0', '#ffd3bd', '#ffe4d6'] },
  { key: 'blush',         label: '블러쉬',     fg: '#4a2f38', colors: ['#f7dde3', '#f2cdd6', '#fae6ea', '#eec4cf', '#f5d5dc', '#e9bcc8', '#f8e2e6', '#efc9d2', '#fbe8ec', '#e6b8c4'] },
  { key: 'lavender',      label: '라벤더',     fg: '#3a2f4a', colors: ['#e6ddfa', '#d8c9f5', '#efeafd', '#ddd0f7', '#cbb8f0', '#e3d6fb', '#d2c2f2', '#ece4fc', '#d6c8f4', '#c7b3ee'] },
  { key: 'mint',          label: '민트',       fg: '#234a40', colors: ['#d3f2e6', '#c0ead8', '#e0f6ee', '#c9efe0', '#b5e6d2', '#d8f4ea', '#c3ecdc', '#e6f8f0', '#cdf0e4', '#bce9d6'] },
  { key: 'sky',           label: '스카이',     fg: '#23384d', colors: ['#d6ecfb', '#c2e2f8', '#e2f2fd', '#cbe6f9', '#b3d8f4', '#d9eefb', '#c6e4f8', '#e6f4fd', '#cfe8fa', '#bcdcf5'] },
  { key: 'cottoncandy',   label: '솜사탕',     fg: '#3a3550', colors: ['#ffd6ea', '#d6e6ff', '#e9d6ff', '#ffe4c4', '#d6f6ee', '#f6d6ee', '#dcd6ff', '#ffdcec', '#d6efff', '#ecd6ff'] },
  { key: 'oatmeal',       label: '오트밀',     fg: '#40382c', colors: ['#eae2d4', '#ddd2be', '#f0eae0', '#e3d8c6', '#d5c7ae', '#ece4d6', '#ddd0ba', '#e8dfce', '#d9ccb2', '#efe8dc'] },
  { key: 'sakura',        label: '벚꽃',       fg: '#4a2f3a', colors: ['#ffe0e9', '#fce8ef', '#ffcfdd', '#eef3e0', '#fff2f6', '#f8d3df', '#e6f0d8', '#ffe6ee', '#f9cdda', '#f0f6e4'] },
  { key: 'rosegold',      label: '로즈골드',   fg: '#5a3a34', colors: ['#f4d5c8', '#ecc9b8', '#f8e0d4', '#e8bca8', '#f2cebe', '#eec4b0', '#f6dccf', '#e6b8a2', '#f4d2c4', '#eecab6'] },
  { key: 'macaron',       label: '마카롱',     fg: '#3a3340', colors: ['#f6d9c4', '#d9ecc9', '#c9e4f0', '#f0d0e0', '#e6d9f2', '#fce8cc', '#d0ecdc', '#f4d4d4', '#d4e0f4', '#ecdcc4'] },
  { key: 'butter',        label: '버터',       fg: '#4a3f1f', colors: ['#fdf2c9', '#fae9a8', '#fef7dc', '#f8e59c', '#fbeeb8', '#fdf4d0', '#f6e298', '#fef2c4', '#f9ebac', '#fcf0c0'] },
  { key: 'french',        label: '프렌치',     fg: '#33384a', colors: ['#dfe4ec', '#e8d5d0', '#eef0e6', '#d5dee0', '#e3cfc6', '#dde3d4', '#e6d6d0', '#d9e2e6', '#e0d0c8', '#e9ede2'] },
  { key: 'seafoam',       label: '씨폼',       fg: '#23423c', colors: ['#d4f0ea', '#c2e8e0', '#e2f6f1', '#cdeee6', '#b6e2d8', '#d8f2ec', '#c6ece2', '#e6f7f3', '#cfeee7', '#bce6dc'] },
  { key: 'celadon',       label: '셀러돈',     fg: '#244038', colors: ['#d6ebe0', '#c4e2d4', '#e2f0ea', '#cde8dd', '#b8dccb', '#d9ede4', '#c8e4d6', '#e6f2ec', '#d0e8de', '#bfe0d0'] },
  { key: 'ice',           label: '아이스',     fg: '#2a3a4a', colors: ['#e4f0f6', '#d4e8f2', '#eef6fa', '#dcedf5', '#c8e0ee', '#e8f2f8', '#d8eaf4', '#f0f8fb', '#e0eef6', '#cee6f0'] },
  { key: 'lilaccream',    label: '라일락크림', fg: '#3f3548', colors: ['#ece4f4', '#f3ecdc', '#e2d6ee', '#f6f0e4', '#e6dcf0', '#efe6d6', '#e8def2', '#f2ead8', '#e4d8ee', '#f4efe0'] },
  { key: 'honey',         label: '허니',       fg: '#4a3a12', colors: ['#f5ead0', '#eeddb0', '#f9f0da', '#ecd9a4', '#f2e4c0', '#f6ecd2', '#ecdcac', '#f3e6c4', '#eaddb4', '#f8efd8'] },
  { key: 'dustyrose',     label: '더스티로즈', fg: '#4a2f38', colors: ['#e6c2ca', '#dcb2be', '#ecccd2', '#d4a4b2', '#e2bac4', '#dcaebc', '#e8c6ce', '#d6a2b0', '#e4bec8', '#d8a8b6'] },

  // ── 비비드·컬러풀(어두운 글자) ──────────────────────────────────────
  { key: 'coral',         label: '코랄',       fg: '#4a2016', colors: ['#ff9e8d', '#ffb3a0', '#ff8f7c', '#ffc4b0', '#ffa590', '#ff9c88', '#ffbaa5', '#ff9784', '#ffcabb', '#ffab96'] },
  { key: 'sunset',        label: '선셋',       fg: '#4a1f2a', colors: ['#ff9e64', '#ff8e72', '#ff87a8', '#ffbb6b', '#ffa07a', '#ff97b5', '#ffb27a', '#ffab8a', '#ffc08a', '#ff9a8a'] },
  { key: 'candy',         label: '캔디',       fg: '#3a2a4a', colors: ['#ffb3c1', '#a0e7e5', '#ffd6a5', '#b5ead7', '#c7ceea', '#fbe7a1', '#ffaec9', '#a5d8ff', '#ffc6ff', '#caffbf'] },
  { key: 'tropical',      label: '트로피컬',   fg: '#123a34', colors: ['#2dd4bf', '#fda4af', '#fcd34d', '#5eead4', '#f9a8d4', '#67e8f9', '#fdba74', '#a3e635', '#7dd3fc', '#fca5a5'] },
  { key: 'citrus',        label: '시트러스',   fg: '#4a3a10', colors: ['#ffd54d', '#ffe066', '#ffc93d', '#d4e84d', '#ffcf3d', '#e8e04d', '#ffd93d', '#c4e05a', '#ffdb5c', '#dce85a'] },
  { key: 'meadow',        label: '초원',       fg: '#1f3d1a', colors: ['#8fd35a', '#a3e635', '#7ac943', '#bef264', '#98d84e', '#86efac', '#b0e05a', '#a8e06a', '#7dd870', '#c4ea6e'] },
  { key: 'rainbow',       label: '레인보우',   fg: '#2a2a3a', colors: ['#ff9aa2', '#ffb347', '#ffe066', '#a3e635', '#7dd3fc', '#b4a0f5', '#ff9ec4', '#5eead4', '#ffc48a', '#c4b5fd'] },
  { key: 'periwinkle',    label: '베리페리',   fg: '#26265a', colors: ['#a5b4fc', '#b8c0ff', '#93a3f5', '#c4cbff', '#aeb8fa', '#9fb0f8', '#c0c8ff', '#a8b4fc', '#b4bcff', '#96a6f6'] },
  { key: 'flamingo',      label: '플라밍고',   fg: '#4a1a34', colors: ['#ff7fb0', '#ff9ec4', '#ff6ba0', '#ffb0d0', '#ff85b8', '#ff92be', '#ffa8c8', '#ff7aa8', '#ffbcd6', '#ff8fb8'] },
  { key: 'skyocean',      label: '하늘바다',   fg: '#14344a', colors: ['#7dd3fc', '#67e8f9', '#a5f3fc', '#5eead4', '#93c5fd', '#7ee7f5', '#a0e0f5', '#6ee7d6', '#8fd6f7', '#b0eef2'] },
  { key: 'apricot',       label: '살구',       fg: '#4a3320', colors: ['#ffc48a', '#ffb870', '#ffd0a0', '#ffb264', '#ffc07a', '#ffcc94', '#ffb466', '#ffd6ac', '#ffbe82', '#ffc890'] },
  { key: 'bubblegum',     label: '버블껌',     fg: '#3a2340', colors: ['#ff9ecd', '#c9a8f5', '#a5d8ff', '#ffb3d9', '#d8b4fe', '#93c5fd', '#ffc4e0', '#b8a0f0', '#bce4ff', '#f0a8e0'] },
  { key: 'jade',          label: '옥',         fg: '#143a30', colors: ['#5ed9a8', '#6ee0b4', '#4ecf9a', '#84e6c0', '#5cd6a4', '#72dcb0', '#56cc9c', '#7ce0ba', '#66dcac', '#54d29e'] },
  { key: 'denim',         label: '데님',       fg: '#1f3346', colors: ['#8faec9', '#a0bcd4', '#7ea0be', '#b0c8dc', '#94b4cf', '#88a8c6', '#a8c2d8', '#7c9cbc', '#9cbad2', '#84a4c2'] },
  { key: 'olive',         label: '올리브',     fg: '#2f3018', colors: ['#9aa060', '#a8ae6e', '#8e9454', '#b4ba7c', '#9ea468', '#a4aa6a', '#90965a', '#b0b676', '#969c5e', '#aab072'] },
  { key: 'terracotta',    label: '테라코타',   fg: '#4a2016', colors: ['#e0a080', '#d68e6a', '#e8ac8e', '#d4906c', '#d99674', '#dc9a78', '#e2a488', '#d68862', '#dc9a78', '#d08260'] },
  { key: 'mustard',       label: '머스타드',   fg: '#3a2f10', colors: ['#e0b03a', '#d9a52e', '#e8bc4a', '#cf9a28', '#dcac36', '#e4b442', '#d29e2c', '#e6b840', '#d8a832', '#eab84c'] },
  { key: 'berry',         label: '베리',       fg: '#4a1836', colors: ['#ff6bb0', '#ff85c0', '#f472b6', '#ff9ecd', '#ec6bab', '#ff7ab8', '#f088c4', '#ff92c8', '#e878b4', '#ffa0d2'] },
  { key: 'amethyst',      label: '자수정',     fg: '#33204a', colors: ['#c4a0f0', '#cba8f4', '#b890ea', '#d4b4f8', '#c09cf0', '#bd97ee', '#d0aef6', '#b58ce8', '#c8a4f2', '#caa0f4'] },

  // ── 다크·무드(밝은 글자) ────────────────────────────────────────────
  { key: 'midnight',      label: '미드나잇',   fg: '#dbe4f5', colors: ['#1e2a52', '#232f5e', '#1a2648', '#2a3468', '#1d2a56', '#252f60', '#1e2d5a', '#28336a', '#202c54', '#26305e'] },
  { key: 'deepsea',       label: '심해',       fg: '#d4f0ea', colors: ['#0e3a44', '#0f4a4a', '#103a52', '#124e56', '#0d4048', '#135a5a', '#0e4650', '#134858', '#0f505a', '#124252'] },
  { key: 'galaxy',        label: '갤럭시',     fg: '#ece0f5', colors: ['#3a1a5a', '#432066', '#341852', '#4a2670', '#3d1e60', '#46236a', '#38195a', '#4e2a74', '#3a2064', '#421e62'] },
  { key: 'wine',          label: '와인',       fg: '#f2dcd0', colors: ['#4a1526', '#5a1a2e', '#42122a', '#601e34', '#4e1628', '#561a30', '#48142a', '#5e1c32', '#4c182c', '#521830'] },
  { key: 'espresso',      label: '에스프레소', fg: '#ede0cc', colors: ['#3a2618', '#432c1c', '#342014', '#4a3320', '#3d2a1a', '#46301e', '#382616', '#4e3624', '#3c2818', '#442e1c'] },
  { key: 'forestnight',   label: '딥포레스트', fg: '#d8ecd0', colors: ['#16341f', '#1a3d24', '#132e1c', '#1e4428', '#173820', '#1c4026', '#152f1c', '#204628', '#183a22', '#1a3c24'] },
  { key: 'charcoal',      label: '차콜',       fg: '#e8ebef', colors: ['#2a2f36', '#32373f', '#24282f', '#373d46', '#2c313a', '#30363e', '#262b32', '#3a404a', '#2e343c', '#343a42'] },
  { key: 'aurora',        label: '오로라',     fg: '#e0f2ea', colors: ['#123a3a', '#164048', '#1a3a52', '#204040', '#183a58', '#1e4444', '#22384f', '#164a44', '#203a56', '#184048'] },
  { key: 'noir',          label: '느와르',     fg: '#e6e6ea', colors: ['#222226', '#282830', '#1c1c22', '#2e2e38', '#242430', '#2a2a34', '#1e1e26', '#32323c', '#26262e', '#2c2c36'] },
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

// 그 테마의 통일 글자색(모든 칸 공통). 배경 명도에 맞춰 미리 정해 둔 값이라 항상 읽힌다.
export function getFg(key = getPaletteKey()) {
  return paletteByKey(key).fg;
}

export function setPaletteKey(key) {
  const k = BY_KEY[key] ? key : DEFAULT_KEY;
  try { localStorage.setItem(KEY, k); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent('palettechange', { detail: k }));
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
