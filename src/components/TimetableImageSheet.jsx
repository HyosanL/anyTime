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
  const transformRef = useRef(null);   // transform 상태의 동기 사본(포인터 핸들러용)
  const canvasRef = useRef(null);      // 미리보기 <canvas>
  const pointers = useRef(new Map());  // pointerId -> {x,y}  (핀치용)
  const pinchRef = useRef(null);       // { dist, scale, cx, cy }
  const wheelTimer = useRef(null);

  // Esc + 배경 스크롤 잠금
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    lockScroll();
    return () => { window.removeEventListener('keydown', onKey); unlockScroll(); };
  }, [onClose]);

  // 격자 렌더 — 배경색(또는 시간표 입력)이 바뀔 때만.
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
    transformRef.current = t;
    setTransform({ ...t });
  }, [mode, gridVer, dims]);

  // 미리보기 그리기 — transform/guides 는 인자로 받는다(포인터 프레임마다 최신값으로).
  const paint = useCallback((t, gd) => {
    const cv = canvasRef.current;
    const g = gridRef.current;
    if (!cv || !g) return;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);

    if (mode === 'wallpaper') {
      const S = cv.width / dims.w;   // 미리보기 축소율
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, cv.width, cv.height);
      const tr = t || centeredTransform({ gridW: g.w, gridH: g.h, canvasW: dims.w, canvasH: dims.h, scale: baselineRef.current });
      const x = tr.x * S, y = tr.y * S;
      const dw = g.w * tr.scale * S, dh = g.h * tr.scale * S;
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
      if (gd && (gd.v || gd.h)) {
        ctx.strokeStyle = overlayTint(bg, 0.5);
        ctx.lineWidth = 1;
        if (gd.v) { ctx.beginPath(); ctx.moveTo(cv.width / 2, 0); ctx.lineTo(cv.width / 2, cv.height); ctx.stroke(); }
        if (gd.h) { ctx.beginPath(); ctx.moveTo(0, cv.height / 2); ctx.lineTo(cv.width, cv.height / 2); ctx.stroke(); }
      }
      return;
    }

    // plain — 배경색 위 격자(중앙, 여백)
    const margin = Math.round(g.w * 0.05);
    const fullW = g.w + margin * 2;
    const S = cv.width / fullW;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(g.canvas, margin * S, margin * S, g.w * S, g.h * S);
  }, [mode, bg, dims]);

  // 미리보기 캔버스 백킹 해상도 설정 + 첫 그림 (모드/격자/화면 바뀔 때만)
  useEffect(() => {
    const cv = canvasRef.current;
    const g = gridRef.current;
    if (!cv || !g) return;
    const q = Math.min(window.devicePixelRatio || 1, 2);
    if (mode === 'wallpaper') {
      const h = Math.round(0.46 * window.innerHeight * q);
      const w = Math.round(h * dims.w / dims.h);
      cv.width = w; cv.height = h;
      cv.style.width = `${Math.round(w / q)}px`;
    } else {
      const margin = Math.round(g.w * 0.05);
      const fullW = g.w + margin * 2;
      const fullH = g.h + margin * 2;
      const w = Math.min(fullW, Math.round(0.9 * Math.min(520, window.innerWidth) * q));
      cv.width = w; cv.height = Math.round(w * fullH / fullW);
      cv.style.width = `${Math.round(w / q)}px`;
    }
    paint(transformRef.current, { v: false, h: false });
  }, [mode, gridVer, dims, paint]);

  // transform / guides / bg 변화 시 다시 그림
  useEffect(() => { paint(transform, guides); }, [transform, guides, bg, paint]);

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
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        scale: transformRef.current?.scale || baselineRef.current,
        cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2,
      };
    }
  }, [mode, cvToCanvas]);

  const onPointerMove = useCallback((e) => {
    if (mode !== 'wallpaper' || !pointers.current.has(e.pointerId)) return;
    const prev = pointers.current.get(e.pointerId);
    const cur = cvToCanvas(e);
    pointers.current.set(e.pointerId, cur);
    const t = transformRef.current;
    if (!t) return;

    let next;
    if (pointers.current.size >= 2 && pinchRef.current) {
      const pts = [...pointers.current.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const p = pinchRef.current;
      const ns = clampScale(p.scale * (dist / p.dist), baselineRef.current);
      const gx = (p.cx - t.x) / t.scale;
      const gy = (p.cy - t.y) / t.scale;
      next = { x: p.cx - gx * ns, y: p.cy - gy * ns, scale: ns };
    } else {
      next = { x: t.x + (cur.x - prev.x), y: t.y + (cur.y - prev.y), scale: t.scale };
    }
    transformRef.current = next;
    setTransform(next);
    const g = gridRef.current;
    setGuides(snapCenter({ transform: next, gridW: g.w, gridH: g.h, canvasW: dims.w, canvasH: dims.h }).guides);
  }, [mode, cvToCanvas, dims]);

  const settle = useCallback(() => {
    setGuides({ v: false, h: false });
    const t = transformRef.current;
    const g = gridRef.current;
    if (!t || !g) return;
    const s = snapCenter({ transform: t, gridW: g.w, gridH: g.h, canvasW: dims.w, canvasH: dims.h });
    const nudged = nudgeIntoView({
      transform: { x: s.x, y: s.y, scale: t.scale },
      gridW: g.w, gridH: g.h, canvasW: dims.w, canvasH: dims.h,
    });
    transformRef.current = nudged;
    setTransform({ ...nudged });
    LS.wp = toStored({ transform: nudged, canvasW: dims.w, canvasH: dims.h, gridW: g.w, gridH: g.h, baseline: baselineRef.current });
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
    const t = transformRef.current;
    if (!t) return;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const ns = clampScale(t.scale * factor, baselineRef.current);
    const gx = (at.x - t.x) / t.scale;
    const gy = (at.y - t.y) / t.scale;
    const next = { x: at.x - gx * ns, y: at.y - gy * ns, scale: ns };
    transformRef.current = next;
    setTransform(next);
    if (wheelTimer.current) clearTimeout(wheelTimer.current);
    wheelTimer.current = setTimeout(settle, 200);
  }, [mode, cvToCanvas, settle]);

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
        ? composeTimetableImage({ grid: g, mode, background: bg, screen: dims, transform: transformRef.current })
        : composeTimetableImage({ grid: g, mode: 'plain', background: bg });
      const base = String(title || '시간표').replace(/\s+/g, '');
      const fname = mode === 'wallpaper' ? `${base}_배경화면.png` : `${base}.png`;
      const res = await saveComposedImage(composed, fname);
      if (res !== 'cancelled') onClose();
    } finally {
      setBusy(false);
    }
  }, [mode, bg, dims, title, onClose]);

  const hasGrid = !!gridRef.current;
  const bgLower = bg.toLowerCase();

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
                className={`tti-color${bgLower === c ? ' is-on' : ''}`}
                style={{ background: c }} onClick={() => pickBg(c)} />
            ))}
            <label
              className={`tti-color-pick cte-swatch${PRESETS.includes(bgLower) ? '' : ' is-on'}`}
              style={{ background: PRESETS.includes(bgLower) ? 'transparent' : bg }}
              title="직접 고르기"
            >
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
