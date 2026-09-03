// 이미지 저장(배경색) 전용 색 계산 — 순수 함수, DOM 의존 없음.
// 사용자가 고른 배경색 위에서 격자선·글자가 항상 읽히도록 대비색과 오버레이 틴트를 만든다.

// "#rgb" / "#rrggbb"(# 은 선택) → { r, g, b } (0~255). 잘못된 값은 흰색.
function parseHex(hex) {
  let h = String(hex || '').trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return { r: 255, g: 255, b: 255 };
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

const clamp255 = (n) => Math.max(0, Math.min(255, Math.round(n)));
const toHex = ({ r, g, b }) =>
  '#' + [r, g, b].map((n) => clamp255(n).toString(16).padStart(2, '0')).join('');

// 두 색을 t(0~1) 비율로 섞은다(t=0 → a, t=1 → b).
export function mixHex(a, b, t) {
  const x = parseHex(a);
  const y = parseHex(b);
  const k = Math.max(0, Math.min(1, t));
  return toHex({
    r: x.r + (y.r - x.r) * k,
    g: x.g + (y.g - x.g) * k,
    b: x.b + (y.b - x.b) * k,
  });
}

// sRGB 상대 휘도(WCAG). 0(검정)~1(흰색).
export function luminance(hex) {
  const { r, g, b } = parseHex(hex);
  const lin = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// 배경이 밝은가(어두운 글자를 써야 하는가).
export function isLight(hex) {
  return luminance(hex) > 0.5;
}

// 배경색 위에 흰색(어두운 배경) 또는 검정(밝은 배경)을 amount(0~1)만큼 섞은 불투명색.
// 반투명 대신 미리 합성한 색을 돌려줘 캔버스에서 겹쳐 그릴 때 결과가 예측 가능하다.
export function overlayTint(hex, amount) {
  const base = parseHex(hex);
  const towards = isLight(hex) ? 0 : 255;
  const a = Math.max(0, Math.min(1, amount));
  return toHex({
    r: base.r + (towards - base.r) * a,
    g: base.g + (towards - base.g) * a,
    b: base.b + (towards - base.b) * a,
  });
}

// 배경 대비 글자색 3톤. 밝은 배경 → 짙은 회색 계열, 어두운 배경 → 밝은 회색 계열.
// (팔레트 fg 처럼 명도 일관 설계 — 값은 tokens 의 text 계열 근사치.)
export function contrastText(hex) {
  return isLight(hex)
    ? { strong: '#111827', mid: '#374151', soft: '#6b7280' }
    : { strong: '#f9fafb', mid: '#d1d5db', soft: '#9ca3af' };
}

// 시간표 색 테마( { colors, fg } )에 어울리는 배경색을 추천한다.
// 팔레트의 색조는 살리되, 시간표 타일이 배경 위에서 도드라지도록
// 라이트 테마는 아주 옅게(거의 흰색), 다크 테마는 깊게(거의 검정) 민다.
export function recommendBackground(palette) {
  const colors = (palette && palette.colors) || [];
  const fg = (palette && palette.fg) || '#111827';
  const seed = colors[0] || '#dbeafe';
  // 밝은 글자색 = 다크 테마(팔레트 명도 일관 설계).
  return isLight(fg)
    ? mixHex(seed, '#0b0d10', 0.80)
    : mixHex(seed, '#ffffff', 0.82);
}
