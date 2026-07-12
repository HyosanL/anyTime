// 시간표를 PNG 이미지로 렌더링해 저장/공유한다.
// DOM→이미지 라이브러리(html-to-image 등)는 iOS Safari에서 canvas 오염으로 자주 실패하므로,
// TimetableGrid 와 동일한 블록 계산을 canvas 2D로 직접 그린다(모든 기기에서 안정적).
import { dayLabel } from './cache';

const PALETTE = [
  '#dbeafe', '#dcfce7', '#fef9c3', '#fce7f3', '#ede9fe',
  '#ffedd5', '#cffafe', '#fee2e2', '#e0e7ff', '#d1fae5',
];
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';

function parseHM(t) {
  if (!t) return null;
  const [h, m] = String(t).split(':').map(Number);
  if (Number.isNaN(h)) return null;
  return h * 60 + (m || 0);
}
const pad2 = (n) => String(n).padStart(2, '0');

// TimetableGrid 와 동일하게 통합 블록 목록을 만든다.
function buildBlocks({ mine = [], periods = [], customClasses = [] }) {
  const periodByNo = Object.fromEntries((periods || []).map((p) => [p.no, p]));
  const colorByKey = {};
  let ci = 0;
  const colorFor = (k) => (colorByKey[k] ??= PALETTE[ci++ % PALETTE.length]);

  const blocks = [];
  (mine || []).forEach((s) =>
    (s.times || []).forEach((t) => {
      const startMin = parseHM(periodByNo[t.start_period]?.start_time);
      const endMin = parseHM(periodByNo[t.end_period]?.end_time);
      if (startMin == null || endMin == null || endMin <= startMin) return;
      blocks.push({ day: t.day_of_week, startMin, endMin, title: s.course_name, room: t.room, color: colorFor('c:' + s.course_code) });
    })
  );
  (customClasses || []).forEach((c) => {
    if (c.startMin == null || c.endMin == null || c.endMin <= c.startMin) return;
    blocks.push({ day: c.day, startMin: c.startMin, endMin: c.endMin, title: c.title, room: c.room, color: colorFor('x:' + c.id) });
  });
  return blocks;
}

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
  // 남은 글자 처리(말줄임)
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

// 시간표 canvas 를 생성. 블록이 없으면 null.
export function renderTimetableCanvas({ mine, periods, customClasses, commonBlocks = [], title = '시간표' }) {
  const classes = buildBlocks({ mine, periods, customClasses });
  if (classes.length === 0) return null;

  // 공통 비수업 시간(생도대·군사훈련·자율선택형교과)은 수업 아래에 회색으로 깐다 —
  // 화면 격자와 같은 그림이 나와야 저장한 이미지가 딴판이 되지 않는다.
  const backdrop = (commonBlocks || []).map((b) => ({
    day: b.day, startMin: b.startMin, endMin: b.endMin, title: b.label, color: null, noClass: true,
  }));
  const blocks = [...backdrop, ...classes];   // 수업을 나중에 그려 위에 얹는다

  const usedDays = new Set([1, 2, 3, 4, 5]);
  blocks.forEach((b) => usedDays.add(b.day));
  const days = [...usedDays].sort((a, b) => a - b);

  let minH = Infinity, maxH = -Infinity;
  blocks.forEach((b) => { minH = Math.min(minH, Math.floor(b.startMin / 60)); maxH = Math.max(maxH, Math.ceil(b.endMin / 60)); });
  const hours = [];
  for (let h = minH; h < maxH; h++) hours.push(h);

  const periodNoByHour = {};
  (periods || []).forEach((p) => { const sm = parseHM(p.start_time); if (sm != null) periodNoByHour[Math.floor(sm / 60)] = p.no; });

  // 레이아웃(CSS px). DPR 로 스케일해 선명하게.
  const PAD = 16, TITLE_H = 44, HEAD_H = 34, HOURCOL_W = 52, DAYCOL_W = 118, ROW_H = 58;
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

  // 배경(이미지는 항상 밝게 — 다크모드와 무관하게 가독성 확보)
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  // 제목
  ctx.fillStyle = '#111827';
  ctx.font = `700 20px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText(title, W / 2, PAD + 8);

  const gridTop = PAD + TITLE_H + HEAD_H;
  const gridLeft = PAD + HOURCOL_W;

  // 요일 헤더
  ctx.font = `600 14px ${FONT}`;
  ctx.fillStyle = '#374151';
  days.forEach((d, i) => ctx.fillText(dayLabel(d), gridLeft + i * DAYCOL_W + DAYCOL_W / 2, PAD + TITLE_H + 9));

  // 격자선 + 시(hour) 라벨
  ctx.strokeStyle = '#e5e7eb';
  ctx.lineWidth = 1;
  ctx.textAlign = 'left';
  for (let r = 0; r <= hours.length; r++) {
    const y = gridTop + r * ROW_H;
    ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(PAD + gridW, y); ctx.stroke();
  }
  for (let c = 0; c <= days.length; c++) {
    const x = gridLeft + c * DAYCOL_W;
    ctx.beginPath(); ctx.moveTo(x, PAD + TITLE_H); ctx.lineTo(x, gridTop + gridH); ctx.stroke();
  }
  // 좌측 축(시각·교시)
  hours.forEach((h, i) => {
    const y = gridTop + i * ROW_H;
    ctx.textAlign = 'center';
    if (periodNoByHour[h] != null) {
      ctx.fillStyle = '#9ca3af';
      ctx.font = `600 11px ${FONT}`;
      ctx.fillText(String(periodNoByHour[h]), PAD + HOURCOL_W / 2, y + 6);
    }
    ctx.fillStyle = '#6b7280';
    ctx.font = `600 13px ${FONT}`;
    ctx.fillText(pad2(h), PAD + HOURCOL_W / 2, y + 22);
  });

  // 강의 블록 (공통 비수업 시간이 먼저 깔리고 그 위에 수업이 얹힌다)
  blocks.forEach((b) => {
    const di = days.indexOf(b.day);
    if (di < 0) return;
    const x = gridLeft + di * DAYCOL_W;
    const y = gridTop + ((b.startMin - minH * 60) / 60) * ROW_H;
    const h = ((b.endMin - b.startMin) / 60) * ROW_H;
    roundRect(ctx, x + 2.5, y + 2.5, DAYCOL_W - 5, h - 5, 8);
    ctx.fillStyle = b.noClass ? '#eef1f5' : b.color;
    ctx.fill();

    const innerX = x + 9, innerW = DAYCOL_W - 18;
    ctx.textAlign = 'left';
    ctx.fillStyle = b.noClass ? '#94a3b8' : '#1f2937';
    ctx.font = `600 12.5px ${FONT}`;
    const roomLines = b.room ? 1 : 0;
    const maxTitleLines = Math.max(1, Math.min(3, Math.floor((h - 12) / 16) - roomLines));
    const titleLines = wrapText(ctx, b.title, innerW, maxTitleLines);
    let ty = y + 8;
    titleLines.forEach((ln) => { ctx.fillText(ln, innerX, ty); ty += 16; });
    if (b.room && ty + 14 <= y + h) {
      ctx.fillStyle = '#4b5563';
      ctx.font = `500 11px ${FONT}`;
      const roomLine = wrapText(ctx, b.room, innerW, 1)[0] || '';
      ctx.fillText(roomLine, innerX, ty);
    }
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
