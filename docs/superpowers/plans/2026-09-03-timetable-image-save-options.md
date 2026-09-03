# 시간표 이미지 저장 옵션 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 시간표 이미지 저장에 "배경화면용 꽉 채우기(드래그·핀치 배치)"와 "배경색 지정" 옵션을 더한다.

**Architecture:** 홈 🖼️ 버튼이 즉시저장 대신 lazy 로드되는 `TimetableImageSheet` 바텀시트를 연다. 시트는 일반/배경화면 모드 토글, 배경색 프리셋+스포이트, 미리보기(배경화면은 인터랙티브 캔버스)를 제공한다. 렌더링은 기존 canvas-2D 방식을 유지하되 `lib/timetableImage.js`를 「격자만 그리기 → 배경색·모드로 합성 → 공유/다운로드」 3단계로 분리하고, 색 대비·배치 수학은 순수 모듈(`imageColor`, `wallpaperTransform`)로 뺀다.

**Tech Stack:** React 19, Vite 6, canvas 2D API, `navigator.share`/`<a download>`. 새 의존성 없음.

## Global Constraints

- **색은 항상 `var(--token)`** — 컴포넌트/CSS에서 색 하드코딩 금지. 단 캔버스에 그리는 색(배경색·팔레트색·대비색)은 데이터값이라 예외([design-system-tokens]).
- **CSS는 `src/styles/` 파셜**로, 컴포넌트가 자기 CSS를 `import` (Vite가 청크와 함께 로드). 첫 화면 번들에 안 들어가야 하는 것은 `index.css`에서 `@import` 금지.
- **다크모드**: `data-theme` + 시스템 기본. 시트 UI는 토큰이라 자동. 저장 이미지는 사용자가 고른 배경색 그대로(테마 무관).
- **대화는 한국어, 코드·주석·커밋·문서(플랜/스펙 제외)는 영어 유지 아님** — 이 저장소 관례는 코드 주석도 한국어다([chat-korean-work-english]는 커밋 메시지·식별자에만 적용; 주석은 기존 파일들이 전부 한국어). 커밋 메시지는 영어.
- **커밋 트레일러**: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`
- **다른 세션이 피드백 답변 기능(FeedbackPopup, lib/feedback, AppReportModal, CorrectionModal, SW)을 편집 중** — 그 파일들은 절대 건드리지 않는다. 공유 파일은 `src/pages/Home.jsx` 하나뿐이며 변경을 최소화한다.
- **팔레트 읽기**: `paletteByKey(getPaletteKey())` — 사용자가 고른 과목 색 테마. 렌더러 내부에서 읽는다(현행 유지).
- **iOS 공유 제약**: `navigator.share({files})`는 클릭 제스처 안에서 동기적으로 호출돼야 한다. 합성(`composeTimetableImage`)은 동기, `saveComposedImage`의 첫 `await`가 곧 `navigator.share` 그 자체가 되도록 유지.
- **배포**: schema 변경 없음. `main`에 커밋 → push 시 Cloudflare Pages Git 연동이 자동 빌드·배포. 빌드 검증은 `npm run build`.

---

## 파일 구조

| 파일 | 책임 | 신규/수정 |
|---|---|---|
| `src/lib/imageColor.js` | 배경색 → 상대휘도·대비 글자색 3톤·오버레이 틴트. 순수. | 신규 |
| `src/lib/wallpaperTransform.js` | 배경화면 배치 수학: fit 기준 배율·줌 클램프·중앙 스냅·저장 정규화·뷰 복귀. 순수. | 신규 |
| `src/lib/timetableImage.js` | `renderTimetableGrid`(격자만, 배경색 인지, 투명 바깥, 고정 픽셀밀도) · `composeTimetableImage`(모드·배경색 합성) · `saveComposedImage`(공유/다운로드) · `roundRect` export. 구 `renderTimetableCanvas`/`saveTimetableImage` 제거. | 재작성 |
| `src/styles/timetableImage.css` | 시트·모드 토글·미리보기 프레임·배경색 줄. 토큰 기반. | 신규 |
| `src/components/TimetableImageSheet.jsx` | 시트 UI + 미리보기 캔버스 + 드래그/핀치/휠 + 스냅 + 저장. | 신규 |
| `src/pages/Home.jsx` | `handleSaveImage` 제거 → `imgSheetOpen` state + lazy `TimetableImageSheet` 마운트. 🖼️ 버튼 onClick만 교체. | 수정(최소) |

---

## Task 1: `lib/imageColor.js` — 배경색 대비 계산

**Files:**
- Create: `src/lib/imageColor.js`

**Interfaces:**
- Produces:
  - `luminance(hex: string) => number` (0~1, sRGB 상대휘도)
  - `isLight(hex: string) => boolean` (휘도 > 0.5)
  - `overlayTint(hex: string, amount: number) => string` (`#rrggbb`, 배경 위 흰/검을 amount(0~1) 섞은 불투명색)
  - `contrastText(hex: string) => { strong: string, mid: string, soft: string }` (배경 대비 글자색 3톤)

- [ ] **Step 1: 파일 작성**

```js
// 이미지 저장(배경색) 전용 색 계산 — 순수 함수, DOM 의존 없음.
// 사용자가 고른 배경색 위에서 격자선·글자가 항상 읽히도록 대비색과 오버레이 틴트를 만든다.

// "#rgb" / "#rrggbb"(#은 선택) → { r, g, b } (0~255). 잘못된 값은 흰색.
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
```

- [ ] **Step 2: 빌드 검증**

Run: `npm run build`
Expected: 성공(이 모듈은 아직 import되지 않으므로 트리셰이킹으로 빠져도 무방 — 문법 오류만 확인).

- [ ] **Step 3: 스모크 (선택, node)**

Run: `node -e "import('./src/lib/imageColor.js').then(m=>{console.log(m.isLight('#ffffff'), m.isLight('#0b0d10'), m.overlayTint('#ffffff',0.05), m.overlayTint('#2b2f36',0.12), m.contrastText('#2b2f36'))})"`
Expected: `true false #f2f2f2 #45484e { strong: '#f9fafb', ... }` 비슷하게. (`node`가 ESM 확장자 해석 못 하면 이 스텝은 건너뛴다 — 빌드가 진짜 게이트.)

- [ ] **Step 4: 커밋**

```bash
git add src/lib/imageColor.js
git commit -m "$(printf 'feat: imageColor — luminance/contrast/overlay helpers for image bg color\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>')"
```

---

## Task 2: `lib/wallpaperTransform.js` — 배경화면 배치 수학

**Files:**
- Create: `src/lib/wallpaperTransform.js`

**Interfaces:**
- 좌표계: **최종 캔버스의 픽셀**. `transform = { x, y, scale }` — `x,y`=그리드(원본 픽셀 `gridW×gridH`) 좌상단의 캔버스 좌표, `scale`=그리드 원본 대비 배율.
- Produces:
  - `fitWidthBaseline({ gridW, canvasW, marginFrac? }) => number`
  - `clampScale(scale, baseline, min?=0.4, max?=3) => number`
  - `centeredTransform({ gridW, gridH, canvasW, canvasH, scale }) => {x,y,scale}`
  - `snapCenter({ transform, gridW, gridH, canvasW, canvasH, thresholdFrac?=0.025 }) => { x, y, guides: { v: boolean, h: boolean } }`
  - `toStored({ transform, canvasW, canvasH, gridW, gridH, baseline }) => { scaleRel, cxFrac, cyFrac }`
  - `fromStored(stored, { canvasW, canvasH, gridW, gridH, baseline }) => {x,y,scale}`
  - `nudgeIntoView({ transform, gridW, gridH, canvasW, canvasH, keepFrac?=0.25 }) => {x,y,scale}`

- [ ] **Step 1: 파일 작성**

```js
// 배경화면 모드에서 시간표 배치(이동/확대)와 중앙 스냅을 계산하는 순수 함수.
// 좌표계는 '최종 캔버스의 픽셀'. transform = { x, y, scale }
//   x,y  = 그리드(원본 크기 gridW×gridH) 좌상단의 캔버스 좌표
//   scale= 그리드 원본 대비 배율

// 그리드를 좌우 여백 marginFrac 만큼 두고 캔버스 폭에 맞추는 기준 배율.
export function fitWidthBaseline({ gridW, canvasW, marginFrac = 0.06 }) {
  if (!gridW || !canvasW) return 1;
  return (canvasW * (1 - 2 * marginFrac)) / gridW;
}

// 줌 한계: 기준 배율의 min~max 배.
export function clampScale(scale, baseline, min = 0.4, max = 3) {
  const b = baseline || 1;
  return Math.max(b * min, Math.min(b * max, scale));
}

// 그리드를 캔버스 정중앙에 놓는 transform.
export function centeredTransform({ gridW, gridH, canvasW, canvasH, scale }) {
  return {
    x: (canvasW - gridW * scale) / 2,
    y: (canvasH - gridH * scale) / 2,
    scale,
  };
}

// 그리드 중심이 캔버스의 세로중앙선/가로중앙선 근처면 그 축으로 스냅.
// guides.v = 세로 가이드선(= x축이 중앙에 붙음), guides.h = 가로 가이드선(= y축).
export function snapCenter({ transform, gridW, gridH, canvasW, canvasH, thresholdFrac = 0.025 }) {
  const cx = transform.x + (gridW * transform.scale) / 2;
  const cy = transform.y + (gridH * transform.scale) / 2;
  const tx = canvasW / 2;
  const ty = canvasH / 2;
  const v = Math.abs(cx - tx) <= canvasW * thresholdFrac;
  const h = Math.abs(cy - ty) <= canvasH * thresholdFrac;
  return {
    x: v ? transform.x + (tx - cx) : transform.x,
    y: h ? transform.y + (ty - cy) : transform.y,
    guides: { v, h },
  };
}

// 화면/그리드 크기가 달라져도 대략 살아남도록 정규화해 저장.
export function toStored({ transform, canvasW, canvasH, gridW, gridH, baseline }) {
  const cx = transform.x + (gridW * transform.scale) / 2;
  const cy = transform.y + (gridH * transform.scale) / 2;
  return {
    scaleRel: baseline ? transform.scale / baseline : 1,
    cxFrac: canvasW ? cx / canvasW : 0.5,
    cyFrac: canvasH ? cy / canvasH : 0.5,
  };
}

export function fromStored(stored, { canvasW, canvasH, gridW, gridH, baseline }) {
  const b = baseline || 1;
  const scaleRel = stored && typeof stored.scaleRel === 'number' ? stored.scaleRel : 1;
  const scale = clampScale(b * scaleRel, b);
  const cxFrac = stored && typeof stored.cxFrac === 'number' ? stored.cxFrac : 0.5;
  const cyFrac = stored && typeof stored.cyFrac === 'number' ? stored.cyFrac : 0.5;
  return {
    x: canvasW * cxFrac - (gridW * scale) / 2,
    y: canvasH * cyFrac - (gridH * scale) / 2,
    scale,
  };
}

// 그리드가 캔버스 밖으로 과하게 벗어났으면 최소 keepFrac 만큼은 겹치게 당겨 넣는다.
// (완전 클램프는 안 함 — 의도적 크롭 허용.)
export function nudgeIntoView({ transform, gridW, gridH, canvasW, canvasH, keepFrac = 0.25 }) {
  const w = gridW * transform.scale;
  const h = gridH * transform.scale;
  const minVisX = Math.min(w, canvasW) * keepFrac;
  const minVisY = Math.min(h, canvasH) * keepFrac;
  let { x, y } = transform;
  if (x + w < minVisX) x = minVisX - w;
  if (x > canvasW - minVisX) x = canvasW - minVisX;
  if (y + h < minVisY) y = minVisY - h;
  if (y > canvasH - minVisY) y = canvasH - minVisY;
  return { x, y, scale: transform.scale };
}
```

- [ ] **Step 2: 빌드 검증**

Run: `npm run build`
Expected: 성공.

- [ ] **Step 3: 커밋**

```bash
git add src/lib/wallpaperTransform.js
git commit -m "$(printf 'feat: wallpaperTransform — fit/clamp/snap math for wallpaper placement\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>')"
```

---

## Task 3: `lib/timetableImage.js` 재작성 — 격자/합성/저장 3단계

**Files:**
- Rewrite: `src/lib/timetableImage.js`

**Interfaces:**
- Consumes: `imageColor.{contrastText,overlayTint}`, `wallpaperTransform`(re-export 안 함 — 시트가 직접 import), `timetableLayout.{buildClassBlocks,layoutTimetable,pad2}`, `palettes.{paletteByKey,getPaletteKey}`, `cache.dayLabel`
- Produces:
  - `renderTimetableGrid({ mine, periods, customClasses, commonBlocks?, title?, background? }) => { canvas: HTMLCanvasElement, w: number, h: number } | null` — 격자만. 바깥 투명. `w,h`=캔버스 실제 픽셀. blocks 없으면 `null`.
  - `composeTimetableImage({ grid, mode, background, screen?, transform? }) => HTMLCanvasElement` — `grid`는 `renderTimetableGrid` 반환값. `mode='plain'`이면 여백+배경색. `mode='wallpaper'`이면 `screen={w,h}` 캔버스 + iOS 폴더풍 패널 + `transform`.
  - `saveComposedImage(canvas, filename) => Promise<'shared'|'cancelled'|'downloaded'>`
  - `roundRect(ctx, x, y, w, h, r)` — path만 그림(fill/stroke는 호출측).
- 제거: `renderTimetableCanvas`, `saveTimetableImage` (유일 호출처 `Home.jsx handleSaveImage`도 Task 6에서 제거).

- [ ] **Step 1: 파일 전체 교체**

```js
// 시간표를 PNG 이미지로 렌더링해 저장/공유한다. 3단계로 나뉜다:
//   renderTimetableGrid   — 격자만 canvas 2D 로 직접 그린다(바깥 투명, 배경색 인지).
//   composeTimetableImage — 모드(일반/배경화면)·배경색으로 최종 이미지를 합성.
//   saveComposedImage     — 공유 시트(iOS 사진저장/안드 공유) 또는 다운로드.
// DOM→이미지 라이브러리는 iOS Safari 에서 canvas 오염으로 자주 실패하므로 canvas 직접 렌더 유지.
// 격자 계산(블록·요일·시)은 화면(TimetableGrid)과 공유하는 lib/timetableLayout 을 쓴다.
import { dayLabel } from './cache';
import { paletteByKey, getPaletteKey } from './palettes';
import { buildClassBlocks, layoutTimetable, pad2 } from './timetableLayout';
import { contrastText, overlayTint } from './imageColor';

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';

// 격자는 항상 이 픽셀 밀도로 그린다 — 배경화면 모드에서 확대해도 덜 흐리도록 넉넉히.
const PIX = 3;

// 텍스트를 maxWidth 안에서 최대 maxLines 줄로 접고, 넘치면 말줄임.
function wrapText(ctx, text, maxWidth, maxLines) {
  const chars = [...String(text || '')];
  const lines = [];
  let line = '';
  for (const ch of chars) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = ch;
      if (lines.length === maxLines - 1) break;
    } else {
      line = test;
    }
  }
  const rest = chars.slice([...lines.join('')].length).join('');
  if (lines.length < maxLines) {
    let last = rest;
    while (last && ctx.measureText(last + (chars.length > [...lines.join(''), ...last].length ? '…' : '')).width > maxWidth) {
      last = last.slice(0, -1);
    }
    if (last) lines.push(last + (rest.length > last.length ? '…' : ''));
  }
  return lines.slice(0, maxLines);
}

export function roundRect(ctx, x, y, w, h, r) {
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function tile(ctx, x, y, w, h, r, fill, stroke) {
  roundRect(ctx, x, y, w, h, r);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
}

// 시간표 격자만 캔버스로. 바깥(paper)은 투명 — 배경 위에 얹는다.
// background: 최종 배경색 — 빈 칸 틴트·글자 대비가 여기에 종속(밝으면 짙은 글자, 어두우면 밝은 글자).
export function renderTimetableGrid({
  mine, periods, customClasses, commonBlocks = [], title = '시간표', background = '#ffffff',
}) {
  const pal = paletteByKey(getPaletteKey());
  const classBlocks = buildClassBlocks({ mine, periods, customClasses, colors: pal.colors, fg: pal.fg });
  const grid = layoutTimetable({ classBlocks, periods, commonBlocks });
  if (grid.empty) return null;
  const { days, hours, periodNoByHour, cells } = grid;

  const PAD = 16, TITLE_H = 44, HEAD_H = 34, HOURCOL_W = 52, DAYCOL_W = 118, ROW_H = 58;
  const RAD = 8;
  const INSET = 1.5;
  const gridW = HOURCOL_W + days.length * DAYCOL_W;
  const gridH = hours.length * ROW_H;
  const W = PAD * 2 + gridW;
  const H = PAD * 2 + TITLE_H + HEAD_H + gridH;

  const ink = contrastText(background);
  const emptyFill = overlayTint(background, 0.05);
  const emptyBorder = overlayTint(background, 0.16);
  const blockFill = overlayTint(background, 0.11);

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(W * PIX);
  canvas.height = Math.round(H * PIX);
  const ctx = canvas.getContext('2d');
  ctx.scale(PIX, PIX);
  ctx.textBaseline = 'top';
  // 바깥은 투명(fillRect 안 함).

  // 제목
  ctx.fillStyle = ink.strong;
  ctx.font = `700 20px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText(title, W / 2, PAD + 8);

  const gridTop = PAD + TITLE_H + HEAD_H;
  const gridLeft = PAD + HOURCOL_W;

  // 요일 헤더
  ctx.font = `600 14px ${FONT}`;
  ctx.fillStyle = ink.mid;
  days.forEach((d, i) => ctx.fillText(dayLabel(d), gridLeft + i * DAYCOL_W + DAYCOL_W / 2, PAD + TITLE_H + 9));

  // 좌축(시각·교시)
  hours.forEach((h, i) => {
    const y = gridTop + i * ROW_H;
    ctx.textAlign = 'center';
    if (periodNoByHour[h] != null) {
      ctx.fillStyle = ink.soft;
      ctx.font = `600 11px ${FONT}`;
      ctx.fillText(String(periodNoByHour[h]), PAD + HOURCOL_W / 2, y + 6);
    }
    ctx.fillStyle = ink.mid;
    ctx.font = `600 13px ${FONT}`;
    ctx.fillText(pad2(h), PAD + HOURCOL_W / 2, y + 22);
  });

  // 칸
  days.forEach((d, di) => {
    hours.forEach((h, hi) => {
      const cx = gridLeft + di * DAYCOL_W;
      const cy = gridTop + hi * ROW_H;
      const cell = cells[`${d}-${h}`];

      if (!cell) {
        tile(ctx, cx + INSET, cy + INSET, DAYCOL_W - 2 * INSET, ROW_H - 2 * INSET, RAD, emptyFill, emptyBorder);
        return;
      }
      if (cell.skip) return;

      const tx = cx + INSET;
      const ty = cy + INSET;
      const tw = DAYCOL_W - 2 * INSET;
      const th = cell.span * ROW_H - 2 * INSET;

      if (cell.block) {
        tile(ctx, tx, ty, tw, th, RAD, blockFill, null);
        ctx.fillStyle = ink.soft;
        ctx.font = `600 11.5px ${FONT}`;
        ctx.textAlign = 'center';
        const lines = wrapText(ctx, cell.title, tw - 16, 2);
        let yy = ty + (th - lines.length * 15) / 2;
        lines.forEach((ln) => { ctx.fillText(ln, tx + tw / 2, yy); yy += 15; });
        return;
      }

      tile(ctx, tx, ty, tw, th, RAD, cell.color, null);
      ctx.textAlign = 'center';
      ctx.fillStyle = cell.fg;
      ctx.font = `700 12px ${FONT}`;
      const titleLines = wrapText(ctx, cell.title, tw - 16, 2);
      const hasMeta = !!cell.meta;
      const blockH = titleLines.length * 15 + (hasMeta ? 13 : 0);
      let yy = ty + Math.max(6, (th - blockH) / 2);
      titleLines.forEach((ln) => { ctx.fillText(ln, tx + tw / 2, yy); yy += 15; });
      if (hasMeta) {
        ctx.save();
        ctx.globalAlpha = 0.78;
        ctx.font = `600 10px ${FONT}`;
        const metaLine = wrapText(ctx, cell.meta, tw - 14, 1)[0] || '';
        ctx.fillText(metaLine, tx + tw / 2, yy + 1);
        ctx.restore();
      }
      if (cell.custom) {
        ctx.save();
        ctx.globalAlpha = 0.6;
        ctx.textAlign = 'right';
        ctx.font = `800 8px ${FONT}`;
        ctx.fillStyle = cell.fg;
        ctx.fillText('직접', tx + tw - 4, ty + 3);
        ctx.restore();
      }
    });
  });

  return { canvas, w: canvas.width, h: canvas.height };
}

// 격자 캔버스를 배경색·모드로 최종 이미지에 합성한다.
export function composeTimetableImage({ grid, mode, background = '#ffffff', screen, transform }) {
  const g = grid.canvas;
  const out = document.createElement('canvas');

  if (mode === 'wallpaper') {
    out.width = screen.w;
    out.height = screen.h;
    const ctx = out.getContext('2d');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, out.width, out.height);

    const t = transform;
    const dw = grid.w * t.scale;
    const dh = grid.h * t.scale;
    const shortSide = Math.min(out.width, out.height);
    const padP = shortSide * 0.03;
    const rad = shortSide * 0.055;

    roundRect(ctx, t.x - padP, t.y - padP, dw + 2 * padP, dh + 2 * padP, rad);
    ctx.fillStyle = overlayTint(background, 0.12);
    ctx.fill();
    ctx.strokeStyle = overlayTint(background, 0.20);
    ctx.lineWidth = Math.max(1, shortSide * 0.002);
    ctx.stroke();

    ctx.drawImage(g, t.x, t.y, dw, dh);
    return out;
  }

  // plain — 내용맞춤 + 배경색 여백
  const margin = Math.round(g.width * 0.05);
  out.width = g.width + margin * 2;
  out.height = g.height + margin * 2;
  const ctx = out.getContext('2d');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(g, margin, margin);
  return out;
}

function dataURLtoBlob(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const mime = (head.match(/:(.*?);/) || [])[1] || 'image/png';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// 최종 캔버스를 공유/다운로드. 반환: 'shared' | 'cancelled' | 'downloaded'
// 사용자 제스처(클릭) 안에서 동기적으로 호출해야 iOS 공유가 뜬다 —
// 첫 await 가 곧 navigator.share 그 자체가 되도록 그 앞은 전부 동기.
export async function saveComposedImage(canvas, filename) {
  const blob = dataURLtoBlob(canvas.toDataURL('image/png'));
  const file = new File([blob], filename, { type: 'image/png' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return 'shared'; }
    catch (e) { if (e?.name === 'AbortError') return 'cancelled'; /* 그 외엔 다운로드 폴백 */ }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  return 'downloaded';
}
```

- [ ] **Step 2: 빌드 검증**

Run: `npm run build`
Expected: 성공. (`Home.jsx`는 아직 구 `saveTimetableImage`를 **동적** import 하므로 빌드는 통과. 런타임에서 🖼️는 Task 6까지 잠깐 깨지지만 이 세션 안에서 곧 이어짐.)

- [ ] **Step 3: 커밋**

```bash
git add src/lib/timetableImage.js
git commit -m "$(printf 'refactor: timetableImage — split into render/compose/save, bg-color aware grid\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>')"
```

---

## Task 4: `styles/timetableImage.css` — 시트 스타일

**Files:**
- Create: `src/styles/timetableImage.css`

**Interfaces:**
- Produces 클래스: `.tti-body`, `.tti-modes`, `.tti-mode-btn`(+`.is-on`), `.tti-preview`, `.tti-preview-canvas`, `.tti-hint`, `.tti-colors`, `.tti-color`(+`.is-on`), `.tti-color-pick`, `.tti-actions`
- `.pal-overlay` / `.pal-sheet` / `.pal-sheet-head` / `.pal-sheet-title` / `.pal-sheet-x` / `.cte-swatch` 는 `palette.css`에서 이미 정의됨 — 이 시트도 그 클래스를 그대로 쓴다(시트는 `palette.css`도 import).

- [ ] **Step 1: 파일 작성**

```css
/* ============================================================
   시간표 이미지 저장 시트 (TimetableImageSheet)
   - 오버레이·시트 골격은 palette.css(.pal-overlay/.pal-sheet) 재사용.
   - 색은 전부 토큰. 미리보기 캔버스에 그려지는 색은 데이터값이라 예외.
   ============================================================ */

.tti-body {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  overflow-y: auto;
  min-height: 0;
  padding-top: 0.2rem;
  overscroll-behavior: contain;
  touch-action: pan-y;
}

/* 모드 토글 — 세그먼트 */
.tti-modes {
  display: flex;
  gap: 0.35rem;
  padding: 0.25rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
}
.tti-mode-btn {
  flex: 1;
  padding: 0.5rem 0.4rem;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-2);
  font-size: 0.85rem;
  font-weight: 700;
  cursor: pointer;
}
.tti-mode-btn.is-on {
  background: var(--card);
  color: var(--text);
  box-shadow: var(--shadow-sm);
}

/* 미리보기 프레임 — 체커보드로 '투명/화면 바깥'을 암시 */
.tti-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.6rem;
  border-radius: var(--r-md);
  background: var(--surface);
  border: 1px solid var(--border);
  min-height: 0;
}
.tti-preview-canvas {
  display: block;
  max-width: 100%;
  max-height: 46vh;
  border-radius: var(--r-sm);
  box-shadow: var(--shadow-md);
  touch-action: none;   /* 배경화면 모드 드래그/핀치가 페이지로 새지 않게 */
}
.tti-preview-canvas.is-plain { touch-action: auto; box-shadow: none; }

.tti-hint {
  margin: 0;
  font-size: 0.76rem;
  color: var(--text-3);
  text-align: center;
}

/* 배경색 줄 — 프리셋 스와치 + 스포이트 */
.tti-colors {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  align-items: center;
}
.tti-color {
  width: 30px;
  height: 30px;
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.22);
  cursor: pointer;
  padding: 0;
}
.tti-color.is-on {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px var(--primary);
}
/* 스포이트 — .cte-swatch(palette.css) 를 재사용하되 크기만 맞춘다 */
.tti-color-pick.cte-swatch {
  width: 30px;
  height: 30px;
  border-radius: var(--r-sm);
  border: 1px dashed var(--border-strong, var(--border));
}

.tti-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.15rem;
}
.tti-actions .btn { flex: 1; }
```

- [ ] **Step 2: 커밋** (CSS는 Task 5에서 import되므로 빌드는 그때 검증)

```bash
git add src/styles/timetableImage.css
git commit -m "$(printf 'feat: timetableImage.css — save sheet styles (token-based)\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>')"
```

---

## Task 5: `components/TimetableImageSheet.jsx` — 시트 + 인터랙티브 미리보기

**Files:**
- Create: `src/components/TimetableImageSheet.jsx`

**Interfaces:**
- Consumes: `renderTimetableGrid`, `composeTimetableImage`, `saveComposedImage`, `roundRect` (from `../lib/timetableImage`); `wallpaperTransform.*`; `imageColor.overlayTint`; `scrollLock.{lockScroll,unlockScroll}`; `../styles/palette.css`, `../styles/timetableImage.css`
- Props: `{ mine, periods, customClasses, commonBlocks, title, onClose }`
- Default export: `TimetableImageSheet` (React component)

- [ ] **Step 1: 파일 작성**

```jsx
// 시간표 이미지 저장 시트 — 일반/배경화면 모드, 배경색, (배경화면은) 드래그·핀치·휠 배치.
// 격자 캔버스는 배경색이 바뀔 때만 다시 렌더하고, 드래그 프레임엔 미리보기만 다시 그린다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  renderTimetableGrid, composeTimetableImage, saveComposedImage, roundRect,
} from '../lib/timetableImage';
import {
  fitWidthBaseline, clampScale, centeredTransform, snapCenter,
  toStored, fromStored, nudgeIntoView,
} from '../lib/wallpaperTransform';
import { overlayTint } from '../lib/imageColor';
import { lockScroll, unlockScroll } from '../lib/scrollLock';
import '../styles/palette.css';
import '../styles/timetableImage.css';

// 프리셋 배경색 — 화이트/오프화이트/라이트그레이/차콜/블랙/소프트 블루·그린·핑크.
const PRESETS = ['#ffffff', '#f7f5f0', '#e8eaed', '#2b2f36', '#0b0d10', '#dbe8f7', '#dcefe0', '#f6e0e6'];

const LS = {
  get mode() { try { return localStorage.getItem('ttimg:mode') || 'plain'; } catch { return 'plain'; } },
  set mode(v) { try { localStorage.setItem('ttimg:mode', v); } catch { /* ignore */ } },
  get bg() { try { return localStorage.getItem('ttimg:bg') || '#ffffff'; } catch { return '#ffffff'; } },
  set bg(v) { try { localStorage.setItem('ttimg:bg', v); } catch { /* ignore */ } },
  get wp() { try { return JSON.parse(localStorage.getItem('ttimg:wp') || 'null'); } catch { return null; } },
  set wp(v) { try { localStorage.setItem('ttimg:wp', JSON.stringify(v)); } catch { /* ignore */ } },
};

// 이 기기 화면 비율의 세로 캔버스 크기(px).
function screenDims() {
  const short = Math.min(window.screen.width || 390, window.screen.height || 844);
  const long = Math.max(window.screen.width || 390, window.screen.height || 844);
  const q = Math.min(window.devicePixelRatio || 1, 2);
  let w = Math.round(short * q);
  let h = Math.round(long * q);
  const cap = 2600;
  if (h > cap) { const k = cap / h; w = Math.round(w * k); h = Math.round(h * k); }
  return { w, h };
}

export default function TimetableImageSheet({ mine, periods, customClasses, commonBlocks, title, onClose }) {
  const [mode, setMode] = useState(LS.mode);
  const [bg, setBg] = useState(LS.bg);
  const [busy, setBusy] = useState(false);
  const [transform, setTransform] = useState(null);   // { x, y, scale } — 배경화면 모드
  const [guides, setGuides] = useState({ v: false, h: false });

  const dims = useMemo(screenDims, []);
  const gridRef = useRef(null);        // { canvas, w, h } | null
  const [gridVer, setGridVer] = useState(0);
  const baselineRef = useRef(1);
  const canvasRef = useRef(null);      // 미리보기 <canvas>
  const pointers = useRef(new Map());  // pointerId -> {x,y}  (핀치용)
  const pinchRef = useRef(null);       // { dist, scale, cx, cy }

  // Esc + 배경 스크롤 잠금
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    lockScroll();
    return () => { window.removeEventListener('keydown', onKey); unlockScroll(); };
  }, [onClose]);

  // 격자 렌더 — 배경색이 바뀔 때만.
  useEffect(() => {
    gridRef.current = renderTimetableGrid({ mine, periods, customClasses, commonBlocks, title, background: bg });
    setGridVer((v) => v + 1);
  }, [bg, mine, periods, customClasses, commonBlocks, title]);

  // 배경화면 모드로 들어오거나 격자가 바뀌면 transform 초기화(저장본 있으면 복원).
  useEffect(() => {
    const g = gridRef.current;
    if (mode !== 'wallpaper' || !g) return;
    const baseline = fitWidthBaseline({ gridW: g.w, canvasW: dims.w });
    baselineRef.current = baseline;
    const stored = LS.wp;
    const t = stored
      ? nudgeIntoView({
          transform: fromStored(stored, { canvasW: dims.w, canvasH: dims.h, gridW: g.w, gridH: g.h, baseline }),
          gridW: g.w, gridH: g.h, canvasW: dims.w, canvasH: dims.h,
        })
      : centeredTransform({ gridW: g.w, gridH: g.h, canvasW: dims.w, canvasH: dims.h, scale: baseline });
    setTransform({ ...t });
  }, [mode, gridVer, dims]);

  // 미리보기 그리기
  const paint = useCallback(() => {
    const cv = canvasRef.current;
    const g = gridRef.current;
    if (!cv || !g) return;
    const ctx = cv.getContext('2d');

    if (mode === 'wallpaper') {
      const S = cv.width / dims.w;   // 미리보기 축소율
      cv.height = Math.round(dims.h * S);
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, cv.width, cv.height);
      const t = transform || centeredTransform({ gridW: g.w, gridH: g.h, canvasW: dims.w, canvasH: dims.h, scale: baselineRef.current });
      const x = t.x * S, y = t.y * S;
      const dw = g.w * t.scale * S, dh = g.h * t.scale * S;
      const shortSide = Math.min(cv.width, cv.height);
      const padP = shortSide * 0.03;
      const rad = shortSide * 0.055;
      roundRect(ctx, x - padP, y - padP, dw + 2 * padP, dh + 2 * padP, rad);
      ctx.fillStyle = overlayTint(bg, 0.12);
      ctx.fill();
      ctx.strokeStyle = overlayTint(bg, 0.20);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.drawImage(g.canvas, x, y, dw, dh);
      // 스냅 가이드선
      ctx.strokeStyle = overlayTint(bg, 0.45);
      ctx.lineWidth = 1;
      if (guides.v) { ctx.beginPath(); ctx.moveTo(cv.width / 2, 0); ctx.lineTo(cv.width / 2, cv.height); ctx.stroke(); }
      if (guides.h) { ctx.beginPath(); ctx.moveTo(0, cv.height / 2); ctx.lineTo(cv.width, cv.height / 2); ctx.stroke(); }
      return;
    }

    // plain — 배경색 위 격자(중앙, 여백)
    const margin = Math.round(g.w * 0.05);
    const fullW = g.w + margin * 2;
    const fullH = g.h + margin * 2;
    const S = cv.width / fullW;
    cv.height = Math.round(fullH * S);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(g.canvas, margin * S, margin * S, g.w * S, g.h * S);
  }, [mode, bg, transform, guides, dims]);

  // 미리보기 캔버스 백킹 해상도 설정 + 다시 그림
  useEffect(() => {
    const cv = canvasRef.current;
    const g = gridRef.current;
    if (!cv || !g) return;
    const q = Math.min(window.devicePixelRatio || 1, 2);
    if (mode === 'wallpaper') {
      const targetH = 0.46 * window.innerHeight * q;
      const w = Math.round(targetH * dims.w / dims.h);
      cv.width = w;
      cv.style.width = `${Math.round(w / q)}px`;
    } else {
      const margin = Math.round(g.w * 0.05);
      const fullW = g.w + margin * 2;
      const w = Math.min(fullW, Math.round(0.9 * Math.min(520, window.innerWidth) * q));
      cv.width = w;
      cv.style.width = `${Math.round(w / q)}px`;
    }
    paint();
  }, [mode, gridVer, dims, paint]);

  // transform / guides / bg 변화 시 다시 그림
  useEffect(() => { paint(); }, [transform, guides, bg, paint]);

  // ── 포인터: 드래그 이동 + 핀치 확대 ────────────────────────────────
  const cvToCanvas = useCallback((e) => {
    const cv = canvasRef.current;
    const r = cv.getBoundingClientRect();
    const k = dims.w / r.width;   // CSS px → 최종 캔버스 px
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
  }, [dims]);

  const onPointerDown = useCallback((e) => {
    if (mode !== 'wallpaper') return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, cvToCanvas(e));
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinchRef.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        scale: transform?.scale || baselineRef.current,
        cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2,
      };
    }
  }, [mode, cvToCanvas, transform]);

  const onPointerMove = useCallback((e) => {
    if (mode !== 'wallpaper' || !pointers.current.has(e.pointerId)) return;
    const prev = pointers.current.get(e.pointerId);
    const cur = cvToCanvas(e);
    pointers.current.set(e.pointerId, cur);

    setTransform((t) => {
      if (!t) return t;
      if (pointers.current.size >= 2 && pinchRef.current) {
        const [a, b] = [...pointers.current.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const p = pinchRef.current;
        const next = clampScale(p.scale * (dist / p.dist), baselineRef.current);
        // 핀치 중심 고정: 중심 아래의 그리드 지점이 그대로 있도록 x,y 보정
        const gx = (p.cx - t.x) / t.scale;
        const gy = (p.cy - t.y) / t.scale;
        return { x: p.cx - gx * next, y: p.cy - gy * next, scale: next };
      }
      return { ...t, x: t.x + (cur.x - prev.x), y: t.y + (cur.y - prev.y) };
    });

    // 드래그 중 스냅 가이드 표시(붙이진 않음 — 놓을 때 확정)
    setTransform((t) => {
      if (!t) return t;
      const s = snapCenter({ transform: t, gridW: gridRef.current.w, gridH: gridRef.current.h, canvasW: dims.w, canvasH: dims.h });
      setGuides(s.guides);
      return t;
    });
  }, [mode, cvToCanvas, dims]);

  const settle = useCallback(() => {
    setGuides({ v: false, h: false });
    setTransform((t) => {
      if (!t) return t;
      const g = gridRef.current;
      const s = snapCenter({ transform: t, gridW: g.w, gridH: g.h, canvasW: dims.w, canvasH: dims.h });
      const nudged = nudgeIntoView({ transform: { ...t, x: s.x, y: s.y }, gridW: g.w, gridH: g.h, canvasW: dims.w, canvasH: dims.h });
      LS.wp = toStored({ transform: nudged, canvasW: dims.w, canvasH: dims.h, gridW: g.w, gridH: g.h, baseline: baselineRef.current });
      return nudged;
    });
  }, [dims]);

  const onPointerUp = useCallback((e) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchRef.current = null;
    if (pointers.current.size === 0) settle();
  }, [settle]);

  const onWheel = useCallback((e) => {
    if (mode !== 'wallpaper') return;
    e.preventDefault();
    const at = cvToCanvas(e);
    setTransform((t) => {
      if (!t) return t;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const next = clampScale(t.scale * factor, baselineRef.current);
      const gx = (at.x - t.x) / t.scale;
      const gy = (at.y - t.y) / t.scale;
      return { x: at.x - gx * next, y: at.y - gy * next, scale: next };
    });
    if (wheelTimer.current) clearTimeout(wheelTimer.current);
    wheelTimer.current = setTimeout(settle, 200);
  }, [mode, cvToCanvas, settle]);
  const wheelTimer = useRef(null);

  // 휠은 passive 가 아니어야 preventDefault 가 먹는다 — 직접 등록.
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return undefined;
    const h = (e) => onWheel(e);
    cv.addEventListener('wheel', h, { passive: false });
    return () => cv.removeEventListener('wheel', h);
  }, [onWheel]);

  // ── 모드/배경색 바뀌면 영속 ───────────────────────────────────────
  const pickMode = (m) => { setMode(m); LS.mode = m; };
  const pickBg = (c) => { setBg(c); LS.bg = c; };

  // ── 저장 ─────────────────────────────────────────────────────────
  const onSave = useCallback(async () => {
    const g = gridRef.current;
    if (!g) return;
    setBusy(true);
    try {
      const composed = mode === 'wallpaper'
        ? composeTimetableImage({ grid: g, mode, background: bg, screen: dims, transform })
        : composeTimetableImage({ grid: g, mode: 'plain', background: bg });
      const base = String(title || '시간표').replace(/\s+/g, '');
      const fname = mode === 'wallpaper' ? `${base}_배경화면.png` : `${base}.png`;
      const res = await saveComposedImage(composed, fname);
      if (res !== 'cancelled') onClose();
    } finally {
      setBusy(false);
    }
  }, [mode, bg, dims, transform, title, onClose]);

  const hasGrid = !!gridRef.current;

  return (
    <div className="pal-overlay" role="presentation" onClick={onClose}>
      <div className="pal-sheet" role="dialog" aria-modal="true" aria-label="시간표 이미지 저장" onClick={(e) => e.stopPropagation()}>
        <div className="pal-sheet-head">
          <h3 className="pal-sheet-title">🖼️ 시간표 이미지</h3>
          <button className="pal-sheet-x" onClick={onClose} aria-label="닫기">✕</button>
        </div>

        <div className="tti-body">
          <div className="tti-modes" role="tablist" aria-label="저장 형식">
            <button type="button" role="tab" aria-selected={mode === 'plain'}
              className={`tti-mode-btn${mode === 'plain' ? ' is-on' : ''}`} onClick={() => pickMode('plain')}>
              일반
            </button>
            <button type="button" role="tab" aria-selected={mode === 'wallpaper'}
              className={`tti-mode-btn${mode === 'wallpaper' ? ' is-on' : ''}`} onClick={() => pickMode('wallpaper')}>
              배경화면
            </button>
          </div>

          <div className="tti-preview">
            {hasGrid ? (
              <canvas
                ref={canvasRef}
                className={`tti-preview-canvas${mode === 'plain' ? ' is-plain' : ''}`}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              />
            ) : (
              <p className="tti-hint">시간표가 비어 있어요.</p>
            )}
          </div>
          {mode === 'wallpaper' && hasGrid && (
            <p className="tti-hint">드래그로 이동 · 두 손가락(또는 휠)로 확대 · 가운데에서 살짝 붙어요</p>
          )}

          <div className="tti-colors" role="group" aria-label="배경색">
            {PRESETS.map((c) => (
              <button key={c} type="button" aria-label={`배경색 ${c}`}
                className={`tti-color${bg.toLowerCase() === c ? ' is-on' : ''}`}
                style={{ background: c }} onClick={() => pickBg(c)} />
            ))}
            <label className={`tti-color-pick cte-swatch${PRESETS.includes(bg.toLowerCase()) ? '' : ' is-on'}`}
              style={{ background: PRESETS.includes(bg.toLowerCase()) ? 'transparent' : bg }} title="직접 고르기">
              <input type="color" value={bg} onChange={(e) => pickBg(e.target.value)} aria-label="배경색 직접 고르기" />
            </label>
          </div>

          <div className="tti-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>취소</button>
            <button type="button" className="btn btn-primary" onClick={onSave} disabled={busy || !hasGrid}>
              {busy ? '저장 중…' : '저장'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 빌드 검증**

Run: `npm run build`
Expected: 성공. `dist/assets/e2/`에 `TimetableImageSheet-*.js` 청크가 별도로 생겼는지 확인(Task 6에서 lazy 로드).

- [ ] **Step 3: 커밋**

```bash
git add src/components/TimetableImageSheet.jsx
git commit -m "$(printf 'feat: TimetableImageSheet — plain/wallpaper modes, bg color, drag/pinch placement\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>')"
```

---

## Task 6: `Home.jsx` 연결 — lazy 시트 마운트

**Files:**
- Modify: `src/pages/Home.jsx`

**Interfaces:**
- Consumes: `TimetableImageSheet` (default export, lazy)
- 제거: `handleSaveImage` 콜백(구 `import('../lib/timetableImage')` 동적 로드)

- [ ] **Step 1: import — 파일 상단, `lazy`/`Suspense` 추가**

`src/pages/Home.jsx:1` 를:
```js
import { useCallback, useEffect, useMemo, useState } from 'react';
```
→
```js
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
```

`src/pages/Home.jsx:23` (`import AppReportModal ...` 다음 줄) 아래에 추가:
```js

const TimetableImageSheet = lazy(() => import('../components/TimetableImageSheet'));
```

- [ ] **Step 2: state 추가**

`src/pages/Home.jsx:93` `const [appReportOpen, setAppReportOpen] = useState(false);` 다음 줄에:
```js
  const [imgSheetOpen, setImgSheetOpen] = useState(false);   // 시간표 이미지 저장 시트(🖼️)
```

- [ ] **Step 3: `handleSaveImage` 콜백 제거**

`src/pages/Home.jsx:171-178` 블록 전체 삭제:
```js
  // 캔버스 렌더러(lib/timetableImage)는 버튼을 누른 사람만 쓴다 → 첫 화면 번들에서 빼고 그때 받는다.
  const handleSaveImage = useCallback(async () => {
    const { saveTimetableImage } = await import('../lib/timetableImage');
    saveTimetableImage({
      mine, periods, customClasses, commonBlocks,
      title: selected ? `${selected.year}-${selected.term} ${selected.name}` : '시간표',
    });
  }, [mine, periods, customClasses, commonBlocks, selected]);
```

- [ ] **Step 4: 🖼️ 버튼 onClick 교체**

`src/pages/Home.jsx:435-437` 를:
```jsx
              {(mine.length > 0 || customClasses.length > 0) && (
                <button className="btn-ghost btn-sm tt-icon-btn" title="시간표를 이미지로 저장" aria-label="시간표를 이미지로 저장"
                  onClick={handleSaveImage}>🖼️</button>
              )}
```
→
```jsx
              {(mine.length > 0 || customClasses.length > 0) && (
                <button className="btn-ghost btn-sm tt-icon-btn" title="시간표를 이미지로 저장" aria-label="시간표를 이미지로 저장"
                  onClick={() => setImgSheetOpen(true)}>🖼️</button>
              )}
```

- [ ] **Step 5: 시트 마운트**

`src/pages/Home.jsx` 의 `{palOpen && <PaletteSheet onClose={() => setPalOpen(false)} />}` 줄 다음에:
```jsx
      {imgSheetOpen && (
        <Suspense fallback={null}>
          <TimetableImageSheet
            mine={mine}
            periods={periods}
            customClasses={customClasses}
            commonBlocks={commonBlocks}
            title={selected ? `${selected.year}-${selected.term} ${selected.name}` : '시간표'}
            onClose={() => setImgSheetOpen(false)}
          />
        </Suspense>
      )}
```

- [ ] **Step 6: 빌드 검증**

Run: `npm run build`
Expected: 성공. 경고 없이 `TimetableImageSheet` 청크가 `Home` 청크에서 분리돼 로드되는지 확인(`dist` 출력의 청크 목록).

- [ ] **Step 7: 개발 서버 수동 확인**

Run: `npm run dev` → 브라우저에서 홈 열기(로그인 세션 필요 — 이미 개발 중 세션이 있으면 그대로).
확인:
1. 🖼️ 탭 → 시트가 아래에서 올라옴. 제목·✕·모드 토글·미리보기·배경색 줄·저장 버튼.
2. **일반** 모드: 미리보기에 시간표가 흰 배경으로. 배경색 차콜 클릭 → 빈 칸·제목·요일 글자가 밝게 대비되고 수업 색은 유지.
3. **배경화면** 모드: 세로 캔버스, 시간표가 가로폭에 맞게 가운데. 드래그로 이동, 마우스 휠로 확대/축소. 시간표를 화면 정중앙으로 끌면 세로/가로 가이드선이 잠깐 뜨고 살짝 붙음.
4. 배경색 스포이트(🎨)로 임의 색 → 미리보기 즉시 반영.
5. **저장**(데스크톱) → PNG 다운로드. 파일 열어 배경색·패널·시간표 배치가 미리보기와 일치.
6. 시트 닫았다 다시 열기 → 마지막 모드·배경색·배경화면 배치가 복원.
7. Esc·바깥탭·✕·취소로 닫힘. 닫는 동안 홈 스크롤 잠금 정상.

- [ ] **Step 8: 커밋**

```bash
git add src/pages/Home.jsx
git commit -m "$(printf 'feat: home — 🖼️ opens image save sheet (was instant save)\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>')"
```

---

## Task 7: 스펙 마킹 · 빌드 · 배포

**Files:**
- Modify: `docs/superpowers/specs/2026-09-03-timetable-image-save-options-design.md` (상단에 구현완료 표시)

- [ ] **Step 1: 스펙에 완료 표시**

스펙 파일 `작성: 2026-09-03` 줄 아래에 추가:
```
구현: 2026-09-03 완료 — plan docs/superpowers/plans/2026-09-03-timetable-image-save-options.md
```

- [ ] **Step 2: 최종 빌드**

Run: `npm run build`
Expected: 성공. 에러·신규 경고 없음.

- [ ] **Step 3: 커밋 + 푸시(배포)**

```bash
git add docs/superpowers/specs/2026-09-03-timetable-image-save-options-design.md
git commit -m "$(printf 'docs: mark timetable-image-save-options spec implemented\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>')"
git push origin main
```

Cloudflare Pages Git 연동이 push 를 받아 자동 빌드·배포한다(별도 명령 불필요). schema 변경 없음 → DB 작업 없음.

- [ ] **Step 4: 배포 확인**

`git push` 성공 후, 사용자에게 Cloudflare Pages 대시보드에서 빌드 상태를 확인하도록 안내(이 환경에서 CF 대시보드 접근 불가). 배포 완료되면 실기기(안드/아이폰)에서:
- 🖼️ → 배경화면 모드 → 배치 → 저장 → 공유 시트에서 "사진에 저장"(iOS) / 저장(안드)
- 저장된 이미지를 실제 잠금화면/홈화면 배경으로 설정해 시간표가 읽히는지 최종 확인

---

## Self-Review

**1. Spec coverage:**
- Ⅰ 진입·시트 UI → Task 4,5,6 ✅
- Ⅱ 일반 모드(배경색·빈칸 틴트·글자 대비) → Task 1(대비), Task 3(`renderTimetableGrid` background), Task 5(plain 미리보기/합성) ✅
- Ⅲ 배경화면 모드(화면비율·패널·드래그·핀치·휠·스냅·transform 영속) → Task 2(수학), Task 3(`composeTimetableImage` wallpaper), Task 5(인터랙션) ✅
- Ⅳ 배경색(프리셋 8 + 스포이트) → Task 5 `PRESETS` + `<input type=color>` ✅
- Ⅴ 저장(공유/다운로드, 파일명, iOS 제스처) → Task 3 `saveComposedImage`, Task 5 `onSave` ✅
- Ⅵ 코드 구조 → Task 1–6 파일 그대로 ✅
- Ⅶ 테스트 없음 → 각 Task는 빌드+수동확인만 ✅
- Ⅷ 범위 밖 → 계획에 미포함 ✅

**2. Placeholder scan:** 모든 Step에 실제 코드/명령 포함. "적절히 처리" 류 없음. ✅

**3. Type consistency:**
- `renderTimetableGrid` → `{ canvas, w, h }`; Task 5는 `gridRef.current.{canvas,w,h}` 로 소비 ✅
- `composeTimetableImage({ grid, mode, background, screen, transform })` — Task 5 호출 시그니처 일치 ✅
- `transform = {x,y,scale}` — `wallpaperTransform` 전 함수·`compose`·시트에서 동일 ✅
- `screen = {w,h}` — `screenDims()` 반환과 `compose` 파라미터 일치 ✅
- `saveComposedImage` 반환 `'shared'|'cancelled'|'downloaded'` — 시트는 `!== 'cancelled'` 로만 분기 ✅
- `LS.wp` 저장형 `{scaleRel,cxFrac,cyFrac}` — `toStored` 반환 / `fromStored` 입력 일치 ✅

**주의(실행 중 확인):**
- `Home.jsx` 줄번호(171-178, 435-437, 93, 23, 1)는 스냅샷 기준 — 다른 세션이 먼저 커밋했으면 어긋날 수 있다. 줄번호 대신 **앵커 문자열**로 찾아 교체할 것.
- `snapCenter` 를 `onPointerMove` 안에서 `setTransform` 콜백 중 `setGuides` 호출 — React 배치상 동작하나, 실행 중 가이드가 안 뜨면 별도 `useEffect([transform])` 로 옮긴다.
