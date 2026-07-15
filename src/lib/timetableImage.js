// 시간표를 PNG 이미지로 렌더링해 저장/공유한다.
// DOM→이미지 라이브러리(html-to-image 등)는 iOS Safari에서 canvas 오염으로 자주 실패하므로,
// TimetableGrid 와 동일한 블록 계산(lib/timetableLayout)을 canvas 2D로 직접 그린다(모든 기기에서 안정적).
//
// ⭐ 화면 격자(home.css)와 '똑같은 그림'이 나오도록 그린다:
//   - 격자선 없이 3px 간격으로 분리된 둥근 타일(빈 칸도 연한 테두리 박스)
//   - 공통 공강은 수업 없는 칸에만 회색으로(공용 cells 모델을 그대로 사용)
//   - 직접추가 칸엔 '직접' 태그, 글자색은 팔레트 밝기 자동 대비(cell.fg)
//   - 색은 사용자가 고른 팔레트(lib/palettes)를 클릭 시점에 읽어 화면과 일치
import { dayLabel } from './cache';
import { getColors, getPaletteKey } from './palettes';
import { buildClassBlocks, layoutTimetable, pad2 } from './timetableLayout';

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';

// 화면 토큰과 맞춘 값(이미지는 항상 밝게 — 다크모드와 무관하게 가독성).
const C = {
  bg: '#ffffff',
  title: '#111827',
  dayHead: '#374151',
  emptyFill: '#ffffff',
  emptyBorder: '#e5e7eb',   // --border(라이트) 근사
  block: '#e5eaf1',         // --block-bg(라이트)
  blockText: '#475569',     // 회색 위 읽는 색(--text-2 근사)
  axisPeriod: '#9ca3af',
  axisHour: '#6b7280',
};

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

function roundRect(ctx, x, y, w, h, r) {
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

// 시간표 canvas 를 생성. 블록이 없으면 null.
export function renderTimetableCanvas({ mine, periods, customClasses, commonBlocks = [], title = '시간표' }) {
  // 화면과 같은 팔레트·같은 격자 계산.
  const classBlocks = buildClassBlocks({ mine, periods, customClasses, colors: getColors(getPaletteKey()) });
  const grid = layoutTimetable({ classBlocks, periods, commonBlocks });
  if (grid.empty) return null;
  const { days, hours, minH, periodNoByHour, cells } = grid;

  // 레이아웃(CSS px). DPR 로 스케일해 선명하게.
  const PAD = 16, TITLE_H = 44, HEAD_H = 34, HOURCOL_W = 52, DAYCOL_W = 118, ROW_H = 58;
  const RAD = 8;      // --r-sm
  const INSET = 1.5;  // 타일 사이 3px 간격(화면 border-spacing) 근사
  const gridW = HOURCOL_W + days.length * DAYCOL_W;
  const gridH = hours.length * ROW_H;
  const W = PAD * 2 + gridW;
  const H = PAD * 2 + TITLE_H + HEAD_H + gridH;
  const DPR = Math.min(window.devicePixelRatio || 1, 3);

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  const ctx = canvas.getContext('2d');
  ctx.scale(DPR, DPR);
  ctx.textBaseline = 'top';

  // 배경
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  // 제목
  ctx.fillStyle = C.title;
  ctx.font = `700 20px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText(title, W / 2, PAD + 8);

  const gridTop = PAD + TITLE_H + HEAD_H;
  const gridLeft = PAD + HOURCOL_W;

  // 요일 헤더
  ctx.font = `600 14px ${FONT}`;
  ctx.fillStyle = C.dayHead;
  days.forEach((d, i) => ctx.fillText(dayLabel(d), gridLeft + i * DAYCOL_W + DAYCOL_W / 2, PAD + TITLE_H + 9));

  // 좌축(시각·교시) — 격자선은 그리지 않는다(화면처럼 분리 타일).
  hours.forEach((h, i) => {
    const y = gridTop + i * ROW_H;
    ctx.textAlign = 'center';
    if (periodNoByHour[h] != null) {
      ctx.fillStyle = C.axisPeriod;
      ctx.font = `600 11px ${FONT}`;
      ctx.fillText(String(periodNoByHour[h]), PAD + HOURCOL_W / 2, y + 6);
    }
    ctx.fillStyle = C.axisHour;
    ctx.font = `600 13px ${FONT}`;
    ctx.fillText(pad2(h), PAD + HOURCOL_W / 2, y + 22);
  });

  // 칸: 화면과 같은 cells 모델을 그대로 그린다.
  days.forEach((d, di) => {
    hours.forEach((h, hi) => {
      const cx = gridLeft + di * DAYCOL_W;
      const cy = gridTop + hi * ROW_H;
      const cell = cells[`${d}-${h}`];

      if (!cell) {   // 빈 칸 — 연한 테두리 둥근 박스
        tile(ctx, cx + INSET, cy + INSET, DAYCOL_W - 2 * INSET, ROW_H - 2 * INSET, RAD, C.emptyFill, C.emptyBorder);
        return;
      }
      if (cell.skip) return;   // 위 칸의 rowSpan 이 덮음

      const tx = cx + INSET;
      const ty = cy + INSET;
      const tw = DAYCOL_W - 2 * INSET;
      const th = cell.span * ROW_H - 2 * INSET;

      if (cell.block) {   // 공통 공강 — 회색 타일 + 회색 글자(가운데)
        tile(ctx, tx, ty, tw, th, RAD, C.block, null);
        ctx.fillStyle = C.blockText;
        ctx.font = `600 11.5px ${FONT}`;
        ctx.textAlign = 'center';
        const lines = wrapText(ctx, cell.title, tw - 16, 2);
        let yy = ty + (th - lines.length * 15) / 2;
        lines.forEach((ln) => { ctx.fillText(ln, tx + tw / 2, yy); yy += 15; });
        return;
      }

      // 수업 칸 — 팔레트 색 타일 + 자동 대비 글자(가운데)
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
        ctx.globalAlpha = 0.78;   // 화면 .tt-meta opacity
        ctx.font = `600 10px ${FONT}`;
        const metaLine = wrapText(ctx, cell.meta, tw - 14, 1)[0] || '';
        ctx.fillText(metaLine, tx + tw / 2, yy + 1);
        ctx.restore();
      }
      if (cell.custom) {   // '직접' 태그 — 우상단(화면 .tt-custom-tag)
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

  return canvas;
}

function dataURLtoBlob(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const mime = (head.match(/:(.*?);/) || [])[1] || 'image/png';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// 시간표를 이미지로 저장/공유. 반환: 'empty' | 'shared' | 'cancelled' | 'downloaded'
// 사용자 제스처(클릭) 안에서 동기적으로 canvas·blob 을 만들어 공유(iOS 활성화 유지).
export async function saveTimetableImage(opts) {
  const canvas = renderTimetableCanvas(opts);
  if (!canvas) return 'empty';
  const blob = dataURLtoBlob(canvas.toDataURL('image/png'));
  const fname = `${(opts.title || '시간표').replace(/\s+/g, '')}.png`;
  const file = new File([blob], fname, { type: 'image/png' });

  // 모바일: 파일 공유 시트(아이폰=사진에 저장, 안드=이미지 공유/저장)
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: opts.title || '내 시간표' }); return 'shared'; }
    catch (e) { if (e?.name === 'AbortError') return 'cancelled'; /* 실패 시 다운로드로 폴백 */ }
  }
  // 데스크톱 등: 다운로드
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fname;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  return 'downloaded';
}
