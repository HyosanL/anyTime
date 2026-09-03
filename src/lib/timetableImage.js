// 시간표를 PNG 이미지로 렌더링해 저장/공유한다. 3단계로 나뉜다:
//   renderTimetableGrid   — 격자만 canvas 2D 로 직접 그린다(바깥 투명, 배경색 인지).
//   composeTimetableImage — 모드(일반/배경화면)·배경색으로 최종 이미지를 합성.
//   saveComposedImage     — 공유 시트(iOS 사진저장 / 안드 공유) 또는 다운로드.
// DOM→이미지 라이브러리는 iOS Safari 에서 canvas 오염으로 자주 실패하므로 canvas 직접 렌더를 유지한다.
// 격자 계산(블록·요일·시)은 화면(TimetableGrid)과 공유하는 lib/timetableLayout 을 쓴다
// — 저장본이 화면과 '똑같은 그림'이 되도록.
import { dayLabel } from './cache';
import { paletteByKey, getPaletteKey } from './palettes';
import { buildClassBlocks, layoutTimetable, pad2 } from './timetableLayout';
import { contrastText, overlayTint } from './imageColor';

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';

// 격자는 항상 이 픽셀 밀도로 그린다 — 배경화면 모드에서 확대해도 덜 흐리도록 넉넉히.
const PIX = 3.5;

// 배경화면 패널(iOS 폴더풍)이 시간표 밖으로 두는 여백 — 캔버스 짧은 변 기준 비율.
// (시트 미리보기와 최종 합성이 같은 값을 써야 하므로 export.)
export const PANEL_PAD_FRAC = 0.02;

// 글자 크기 단계 — 시트 토글(작게/보통/크게)이 고른다. '보통'이 홈 화면 시간표와 같은 비율.
export const TEXT_SCALES = { S: 0.82, M: 1, L: 1.18 };

// 폰트 px(보통=1 기준). 화면(home.css)의 rem 값을 이미지 칸 크기에 맞춰 키운 값 —
// 예전엔 화면과 거의 같은 절대 px 라, 칸이 1.6배 큰 이미지에서 글자가 작아 보였다.
const F = { title: 22, day: 16, period: 12, hour: 15, course: 18, meta: 15, tag: 11 };

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
// textScale: 글자 크기 배율(TEXT_SCALES).
// 반환: { canvas, w, h }  (w,h = 캔버스 실제 픽셀 크기)  또는 blocks 없으면 null.
export function renderTimetableGrid({
  mine, periods, customClasses, commonBlocks = [], title = '시간표', background = '#ffffff', textScale = 1,
}) {
  const pal = paletteByKey(getPaletteKey());
  const classBlocks = buildClassBlocks({ mine, periods, customClasses, colors: pal.colors, fg: pal.fg });
  const grid = layoutTimetable({ classBlocks, periods, commonBlocks });
  if (grid.empty) return null;
  const { days, hours, periodNoByHour, cells } = grid;

  const PAD = 18, TITLE_H = 48, HEAD_H = 32, HOURCOL_W = 46, DAYCOL_W = 126, ROW_H = 70;
  const RAD = 9;
  const INSET = 1.5;
  const gridW = HOURCOL_W + days.length * DAYCOL_W;
  const gridH = hours.length * ROW_H;
  const W = PAD * 2 + gridW;
  const H = PAD * 2 + TITLE_H + HEAD_H + gridH;

  const ts = textScale || 1;
  const fpx = (base) => Math.round(base * ts * 10) / 10;
  const step = Math.round(fpx(F.course) * 1.16);   // 제목 줄 간격(폰트 비례)

  const ink = contrastText(background);
  const emptyFill = overlayTint(background, 0.05);
  const emptyBorder = overlayTint(background, 0.16);

  // 공통 공강도 다른 수업처럼 '테마 안 색상'으로 칠한다 — 예전엔 배경색 틴트라
  // 배경색과 겹치면 묻혔다. 색은 팔레트 뒤쪽부터 배정(과목은 앞쪽부터라 충돌 최소).
  const blockColorByTitle = {};
  let bci = 0;
  const blockColorFor = (t) => (
    blockColorByTitle[t] ??= pal.colors[(pal.colors.length - 1 - (bci++)) % pal.colors.length] || pal.colors[0]
  );

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(W * PIX);
  canvas.height = Math.round(H * PIX);
  const ctx = canvas.getContext('2d');
  ctx.scale(PIX, PIX);
  ctx.textBaseline = 'top';
  // 바깥은 투명(fillRect 안 함).

  // 제목
  ctx.fillStyle = ink.strong;
  ctx.font = `700 ${fpx(F.title)}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText(title, W / 2, PAD + 9);

  const gridTop = PAD + TITLE_H + HEAD_H;
  const gridLeft = PAD + HOURCOL_W;

  // 요일 헤더
  ctx.font = `600 ${fpx(F.day)}px ${FONT}`;
  ctx.fillStyle = ink.mid;
  days.forEach((d, i) => ctx.fillText(dayLabel(d), gridLeft + i * DAYCOL_W + DAYCOL_W / 2, PAD + TITLE_H + 8));

  // 좌축(시각·교시) — 격자선은 그리지 않는다(화면처럼 분리 타일).
  hours.forEach((h, i) => {
    const y = gridTop + i * ROW_H;
    ctx.textAlign = 'center';
    if (periodNoByHour[h] != null) {
      ctx.fillStyle = ink.soft;
      ctx.font = `600 ${fpx(F.period)}px ${FONT}`;
      ctx.fillText(String(periodNoByHour[h]), PAD + HOURCOL_W / 2, y + 7);
    }
    ctx.fillStyle = ink.mid;
    ctx.font = `700 ${fpx(F.hour)}px ${FONT}`;
    ctx.fillText(pad2(h), PAD + HOURCOL_W / 2, y + 24);
  });

  // 칸: 화면과 같은 cells 모델을 그대로 그린다.
  days.forEach((d, di) => {
    hours.forEach((h, hi) => {
      const cx = gridLeft + di * DAYCOL_W;
      const cy = gridTop + hi * ROW_H;
      const cell = cells[`${d}-${h}`];

      if (!cell) {   // 빈 칸 — 배경색 위 옅은 틴트 박스
        tile(ctx, cx + INSET, cy + INSET, DAYCOL_W - 2 * INSET, ROW_H - 2 * INSET, RAD, emptyFill, emptyBorder);
        return;
      }
      if (cell.skip) return;   // 위 칸의 rowSpan 이 덮음

      const tx = cx + INSET;
      const ty = cy + INSET;
      const tw = DAYCOL_W - 2 * INSET;
      const th = cell.span * ROW_H - 2 * INSET;

      // 색·글자색: 공통 공강은 팔레트 뒤쪽 색, 수업은 자기 색.
      const fill = cell.block ? blockColorFor(cell.title) : cell.color;
      const fg = cell.block ? pal.fg : cell.fg;
      tile(ctx, tx, ty, tw, th, RAD, fill, null);

      ctx.textAlign = 'center';
      ctx.fillStyle = fg;
      ctx.font = `700 ${fpx(F.course)}px ${FONT}`;
      const titleLines = wrapText(ctx, cell.title, tw - 16, 2);
      const hasMeta = !cell.block && !!cell.meta;
      const contentH = titleLines.length * step + (hasMeta ? fpx(F.meta) + 3 : 0);
      let yy = ty + Math.max(6, (th - contentH) / 2);
      titleLines.forEach((ln) => { ctx.fillText(ln, tx + tw / 2, yy); yy += step; });
      if (hasMeta) {
        ctx.save();
        ctx.globalAlpha = 0.78;   // 화면 .tt-meta opacity
        ctx.font = `600 ${fpx(F.meta)}px ${FONT}`;
        const metaLine = wrapText(ctx, cell.meta, tw - 14, 1)[0] || '';
        ctx.fillText(metaLine, tx + tw / 2, yy + 1);
        ctx.restore();
      }
      if (cell.custom) {   // '직접' 태그 — 우상단(화면 .tt-custom-tag)
        ctx.save();
        ctx.globalAlpha = 0.6;
        ctx.textAlign = 'right';
        ctx.font = `800 ${fpx(F.tag)}px ${FONT}`;
        ctx.fillStyle = fg;
        ctx.fillText('직접', tx + tw - 5, ty + 4);
        ctx.restore();
      }
    });
  });

  return { canvas, w: canvas.width, h: canvas.height };
}

// 격자 캔버스를 배경색·모드로 최종 이미지에 합성한다.
// mode 'plain'    : 내용맞춤 + 배경색 여백.
// mode 'wallpaper': screen={w,h} 캔버스 + iOS 폴더풍 반투명 패널 + transform 배치.
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
    const padP = shortSide * PANEL_PAD_FRAC;
    const rad = shortSide * 0.045;

    roundRect(ctx, t.x - padP, t.y - padP, dw + 2 * padP, dh + 2 * padP, rad);
    ctx.fillStyle = overlayTint(background, 0.12);
    ctx.fill();
    ctx.strokeStyle = overlayTint(background, 0.20);
    ctx.lineWidth = Math.max(1, shortSide * 0.002);
    ctx.stroke();

    ctx.drawImage(g, t.x, t.y, dw, dh);
    return out;
  }

  // plain — 내용맞춤 + 배경색 여백(예전의 절반)
  const margin = Math.round(g.width * 0.025);
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

  // 모바일: 파일 공유 시트(아이폰=사진에 저장, 안드=이미지 공유/저장)
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return 'shared'; }
    catch (e) { if (e?.name === 'AbortError') return 'cancelled'; /* 그 외엔 다운로드로 폴백 */ }
  }
  // 데스크톱 등: 다운로드
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  return 'downloaded';
}
