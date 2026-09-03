// 시간표 이미지 저장 시트 — 일반/배경화면 모드, 배경색·배경사진, iOS 글래스 패널, 글자 크기.
// 배경화면: 시간표 영역을 드래그하면 시간표가, 그 바깥을 드래그하면 사진이 움직인다.
// 배경화면 편집(모드·배경색·글자크기·시간표 배치·사진·사진 배치)은 기기에 기억한다.
// 격자 캔버스는 배경(글래스 베이스)·글자크기가 바뀔 때만 다시 렌더하고, 드래그 프레임엔 미리보기만.
// 제목은 저장 이미지에 넣지 않는다(항상 숨김).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  renderTimetableGrid, composeTimetableImage, saveComposedImage, paintWallpaper,
  coverFitTransform, clampCover, PANEL_PAD_FRAC, TEXT_SCALES,
} from '../lib/timetableImage';
import {
  fitWidthBaseline, clampScale, centeredTransform, snapCenter,
  toStored, fromStored, nudgeIntoView,
} from '../lib/wallpaperTransform';
import { recommendBackground, luminance } from '../lib/imageColor';
import { paletteByKey, getPaletteKey, usePalette } from '../lib/palettes';
import { savePhotoBlob, loadPhotoBlob, clearPhotoBlob } from '../lib/ttImageStore';
import { lockScroll, unlockScroll } from '../lib/scrollLock';
import '../styles/palette.css';
import '../styles/timetableImage.css';

// 프리셋 배경색 — 화이트/오프화이트/라이트그레이/차콜/블랙/소프트 블루·그린·핑크.
const PRESETS = ['#ffffff', '#f7f5f0', '#e8eaed', '#2b2f36', '#0b0d10', '#dbe8f7', '#dcefe0', '#f6e0e6'];
const SIZES = [['S', '작게'], ['M', '보통'], ['L', '크게']];
const PHOTO_MAX = 2200;   // 저장·표시용 사진 긴 변 상한(디코드 메모리·용량)

const LS = {
  get mode() { try { return localStorage.getItem('ttimg:mode') || 'plain'; } catch { return 'plain'; } },
  set mode(v) { try { localStorage.setItem('ttimg:mode', v); } catch { /* ignore */ } },
  get bg() { try { return localStorage.getItem('ttimg:bg') || null; } catch { return null; } },
  set bg(v) { try { if (v) localStorage.setItem('ttimg:bg', v); else localStorage.removeItem('ttimg:bg'); } catch { /* ignore */ } },
  get textsize() { try { const v = localStorage.getItem('ttimg:textsize'); return TEXT_SCALES[v] ? v : 'M'; } catch { return 'M'; } },
  set textsize(v) { try { localStorage.setItem('ttimg:textsize', v); } catch { /* ignore */ } },
  get wp() { try { return JSON.parse(localStorage.getItem('ttimg:wp') || 'null'); } catch { return null; } },
  set wp(v) { try { localStorage.setItem('ttimg:wp', JSON.stringify(v)); } catch { /* ignore */ } },
  get photoT() { try { return JSON.parse(localStorage.getItem('ttimg:photoT') || 'null'); } catch { return null; } },
  set photoT(v) { try { if (v) localStorage.setItem('ttimg:photoT', JSON.stringify(v)); else localStorage.removeItem('ttimg:photoT'); } catch { /* ignore */ } },
};

// 이 기기 화면의 실제 픽셀 크기(세로). 예전엔 CSS px × min(dpr,2) 라 실해상도보다
// 훨씬 작았고, 배경화면으로 깔면 OS 가 확대해 흐릿했다 — 이제 실제 물리 픽셀을 쓴다.
function screenDims() {
  const dpr = window.devicePixelRatio || 1;
  const a = Math.round((window.screen.width || 390) * dpr);
  const b = Math.round((window.screen.height || 844) * dpr);
  let w = Math.min(a, b);   // 항상 세로
  let h = Math.max(a, b);
  const CAP_W = 1500;       // 아주 큰 화면(태블릿·고배율 데스크톱)만 축소
  if (w > CAP_W) { const k = CAP_W / w; w = Math.round(w * k); h = Math.round(h * k); }
  return { w, h };
}

// 사진 평균 휘도(0~1) — 글래스 자동 톤 판정용.
function photoLuminance(img) {
  try {
    const c = document.createElement('canvas');
    c.width = 32; c.height = 32;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0, 32, 32);
    const d = cx.getImageData(0, 0, 32, 32).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    return s / (d.length / 4);
  } catch {
    return 0.5;
  }
}

export default function TimetableImageSheet({ mine, periods, customClasses, commonBlocks, title, onClose }) {
  const [pkey] = usePalette();
  const recBg = useMemo(() => recommendBackground(paletteByKey(pkey)), [pkey]);

  const [mode, setMode] = useState(LS.mode);
  const [bg, setBg] = useState(() => LS.bg || recommendBackground(paletteByKey(getPaletteKey())));
  const [textSize, setTextSize] = useState(LS.textsize);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);          // 저장 직후 잠깐 표시(시트는 안 닫힘)
  const [transform, setTransform] = useState(null);   // 시간표 배치 { x, y, scale }
  const [guides, setGuides] = useState({ v: false, h: false });
  const [photo, setPhoto] = useState(null);           // HTMLImageElement | null
  const [photoLum, setPhotoLum] = useState(0.5);
  const [photoT, setPhotoT] = useState(null);         // 사진 배치 { x, y, scale }

  const dims = useMemo(screenDims, []);
  const autoBgRef = useRef(!LS.bg);   // 사용자가 배경색을 직접 안 골랐으면 테마 추천색을 따라간다
  const gridRef = useRef(null);        // { canvas, w, h } | null
  const [gridVer, setGridVer] = useState(0);
  const baselineRef = useRef(1);
  const transformRef = useRef(null);
  const photoTRef = useRef(null);
  const gestureTargetRef = useRef('grid');   // 이번 제스처가 움직이는 대상 (첫 포인터 위치로 결정)
  const fileRef = useRef(null);
  const urlRef = useRef(null);
  const canvasRef = useRef(null);
  const pointers = useRef(new Map());
  const pinchRef = useRef(null);
  const wheelTimer = useRef(null);

  // 글래스 톤은 자동 — 뒤 배경(사진 평균밝기 또는 색) 어두우면 어두운 글래스(밝은 글자).
  const glassTone = (photo ? photoLum : luminance(bg)) < 0.5 ? 'dark' : 'light';
  const glassBase = glassTone === 'dark' ? '#1b1d23' : '#e9ebef';
  const isWall = mode === 'wallpaper';

  // Esc + 배경 스크롤 잠금 + 사진 objectURL 정리
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    lockScroll();
    return () => {
      window.removeEventListener('keydown', onKey);
      unlockScroll();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, [onClose]);

  // 테마가 바뀌었고 사용자가 배경색을 직접 안 골랐으면 추천색을 새로 반영.
  useEffect(() => { if (autoBgRef.current) setBg(recBg); }, [recBg]);

  // 격자 렌더 — 배경(글래스 베이스)·글자크기·모드(또는 시간표 입력)가 바뀔 때만. 제목은 항상 숨김.
  useEffect(() => {
    gridRef.current = renderTimetableGrid({
      mine, periods, customClasses, commonBlocks, title,
      background: isWall ? glassBase : bg,
      glass: isWall,
      textScale: TEXT_SCALES[textSize] || 1,
      showTitle: false,
    });
    setGridVer((v) => v + 1);
  }, [isWall, glassBase, bg, textSize, mine, periods, customClasses, commonBlocks, title]);

  // 배경화면 모드로 들어오거나 격자가 바뀌면 시간표 transform 초기화(저장본 있으면 복원).
  useEffect(() => {
    const g = gridRef.current;
    if (!isWall || !g) return;
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
  }, [isWall, gridVer, dims]);

  // 미리보기 그리기 — transform/guides 는 인자로(포인터 프레임마다 최신값).
  const paint = useCallback((t, gd) => {
    const cv = canvasRef.current;
    const g = gridRef.current;
    if (!cv || !g) return;
    const ctx = cv.getContext('2d');

    if (isWall) {
      const S = cv.width / dims.w;
      paintWallpaper(ctx, S, {
        canvasW: dims.w, canvasH: dims.h, bgColor: bg,
        photo, photoT: photoTRef.current, glassTone,
        gridCanvas: g.canvas, gridW: g.w, gridH: g.h,
        gridT: t || centeredTransform({ gridW: g.w, gridH: g.h, canvasW: dims.w, canvasH: dims.h, scale: baselineRef.current }),
        guides: gd,
      });
      return;
    }

    // plain — 배경색 위 격자(중앙, 여백)
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, cv.width, cv.height);
    const margin = Math.round(g.w * 0.025);
    const fullW = g.w + margin * 2;
    const S = cv.width / fullW;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(g.canvas, margin * S, margin * S, g.w * S, g.h * S);
  }, [isWall, bg, dims, photo, glassTone]);

  // 미리보기 캔버스 백킹 해상도 설정 + 첫 그림 (모드/격자/화면 바뀔 때만)
  useEffect(() => {
    const cv = canvasRef.current;
    const g = gridRef.current;
    if (!cv || !g) return;
    const q = Math.min(window.devicePixelRatio || 1, 2);
    if (isWall) {
      const h = Math.round(0.54 * window.innerHeight * q);
      const w = Math.round(h * dims.w / dims.h);
      cv.width = w; cv.height = h;
      cv.style.width = `${Math.round(w / q)}px`;
    } else {
      const margin = Math.round(g.w * 0.025);
      const fullW = g.w + margin * 2;
      const fullH = g.h + margin * 2;
      const w = Math.min(fullW, Math.round(0.92 * Math.min(540, window.innerWidth) * q));
      cv.width = w; cv.height = Math.round(w * fullH / fullW);
      cv.style.width = `${Math.round(w / q)}px`;
    }
    paint(transformRef.current, { v: false, h: false });
  }, [isWall, gridVer, dims, paint]);

  // transform / photoT / guides / bg / glass 변화 시 다시 그림
  useEffect(() => { paint(transform, guides); }, [transform, photoT, guides, bg, glassTone, paint]);

  // ── 사진 첨부 ────────────────────────────────────────────────────
  // blob(다운스케일된 JPEG)을 <img>로 만들어 상태에 얹는다. restoredT 있으면 그 배치를 복원.
  const applyPhotoBlob = useCallback((blob, restoredT) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    const url = URL.createObjectURL(blob);
    urlRef.current = url;
    const img = new Image();
    img.onload = () => {
      setPhotoLum(photoLuminance(img));
      const box = { imgW: img.naturalWidth, imgH: img.naturalHeight, canvasW: dims.w, canvasH: dims.h };
      const t = restoredT ? clampCover(restoredT, box) : coverFitTransform(box);
      photoTRef.current = t;
      setPhotoT(t);
      setPhoto(img);
    };
    img.onerror = () => alert('사진을 불러오지 못했어요.');
    img.src = url;
  }, [dims]);

  const onPickPhoto = useCallback((e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const purl = URL.createObjectURL(file);
    const probe = new Image();
    probe.onload = () => {
      const s = Math.min(1, PHOTO_MAX / Math.max(probe.naturalWidth, probe.naturalHeight));
      const w = Math.max(1, Math.round(probe.naturalWidth * s));
      const h = Math.max(1, Math.round(probe.naturalHeight * s));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const cx = c.getContext('2d');
      cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
      cx.drawImage(probe, 0, 0, w, h);
      URL.revokeObjectURL(purl);
      c.toBlob((blob) => {
        if (!blob) { alert('사진 처리에 실패했어요.'); return; }
        savePhotoBlob(blob);
        LS.photoT = null;
        setSaved(false);
        applyPhotoBlob(blob);
      }, 'image/jpeg', 0.9);
    };
    probe.onerror = () => { URL.revokeObjectURL(purl); alert('사진을 불러오지 못했어요.'); };
    probe.src = purl;
  }, [applyPhotoBlob]);

  const removePhoto = useCallback(() => {
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    setPhoto(null); setPhotoT(null); photoTRef.current = null;
    clearPhotoBlob();
    LS.photoT = null;
    setSaved(false);
  }, []);

  // 배경화면 모드에서 마지막에 쓰던 사진 복원(있으면, 아직 안 불렀으면).
  useEffect(() => {
    if (!isWall || photo) return undefined;
    let cancelled = false;
    loadPhotoBlob().then((blob) => {
      if (!cancelled && blob) applyPhotoBlob(blob, LS.photoT);
    });
    return () => { cancelled = true; };
  }, [isWall, photo, applyPhotoBlob]);

  // ── 포인터: 시간표 영역이면 시간표, 바깥이면 사진을 이동/확대 ──────
  const cvToCanvas = useCallback((e) => {
    const cv = canvasRef.current;
    const r = cv.getBoundingClientRect();
    const k = dims.w / r.width;
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
  }, [dims]);

  // pt(최종 캔버스 px)가 시간표 패널 안인가.
  const inPanel = useCallback((pt) => {
    const g = gridRef.current;
    const t = transformRef.current;
    if (!g || !t) return true;
    const pad = Math.min(dims.w, dims.h) * PANEL_PAD_FRAC;
    return pt.x >= t.x - pad && pt.x <= t.x + g.w * t.scale + pad
        && pt.y >= t.y - pad && pt.y <= t.y + g.h * t.scale + pad;
  }, [dims]);

  const targetFor = useCallback((pt) => (photo && !inPanel(pt) ? 'photo' : 'grid'), [photo, inPanel]);

  const onPointerDown = useCallback((e) => {
    if (!isWall) return;
    setSaved(false);
    const pt = cvToCanvas(e);
    const first = pointers.current.size === 0;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, pt);
    if (first) gestureTargetRef.current = targetFor(pt);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const cur = gestureTargetRef.current === 'photo' ? photoTRef.current : transformRef.current;
      pinchRef.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        scale: (cur && cur.scale) || baselineRef.current,
        cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2,
      };
    }
  }, [isWall, cvToCanvas, targetFor]);

  const onPointerMove = useCallback((e) => {
    if (!isWall || !pointers.current.has(e.pointerId)) return;
    const prev = pointers.current.get(e.pointerId);
    const cur = cvToCanvas(e);
    pointers.current.set(e.pointerId, cur);

    const movingPhoto = gestureTargetRef.current === 'photo' && !!photo;
    const ref = movingPhoto ? photoTRef : transformRef;
    const t = ref.current;
    if (!t) return;

    let next;
    if (pointers.current.size >= 2 && pinchRef.current) {
      const pts = [...pointers.current.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const p = pinchRef.current;
      const raw = p.scale * (dist / p.dist);
      const ns = movingPhoto ? raw : clampScale(raw, baselineRef.current);
      const gx = (p.cx - t.x) / t.scale;
      const gy = (p.cy - t.y) / t.scale;
      next = { x: p.cx - gx * ns, y: p.cy - gy * ns, scale: ns };
    } else {
      next = { x: t.x + (cur.x - prev.x), y: t.y + (cur.y - prev.y), scale: t.scale };
    }

    if (movingPhoto) {
      next = clampCover(next, { imgW: photo.naturalWidth, imgH: photo.naturalHeight, canvasW: dims.w, canvasH: dims.h });
      photoTRef.current = next;
      setPhotoT(next);
    } else {
      transformRef.current = next;
      setTransform(next);
      const g = gridRef.current;
      setGuides(snapCenter({ transform: next, gridW: g.w, gridH: g.h, canvasW: dims.w, canvasH: dims.h }).guides);
    }
  }, [isWall, cvToCanvas, dims, photo]);

  const settle = useCallback(() => {
    if (gestureTargetRef.current === 'photo' && photo) {
      const t = clampCover(photoTRef.current, { imgW: photo.naturalWidth, imgH: photo.naturalHeight, canvasW: dims.w, canvasH: dims.h });
      photoTRef.current = t;
      setPhotoT({ ...t });
      LS.photoT = t;
      return;
    }
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
  }, [photo, dims]);

  const onPointerUp = useCallback((e) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchRef.current = null;
    if (pointers.current.size === 0) settle();
  }, [settle]);

  const onWheel = useCallback((e) => {
    if (!isWall) return;
    e.preventDefault();
    const at = cvToCanvas(e);
    gestureTargetRef.current = targetFor(at);
    const movingPhoto = gestureTargetRef.current === 'photo' && !!photo;
    const ref = movingPhoto ? photoTRef : transformRef;
    const t = ref.current;
    if (!t) return;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const raw = t.scale * factor;
    const ns = movingPhoto ? raw : clampScale(raw, baselineRef.current);
    const gx = (at.x - t.x) / t.scale;
    const gy = (at.y - t.y) / t.scale;
    let next = { x: at.x - gx * ns, y: at.y - gy * ns, scale: ns };
    if (movingPhoto) {
      next = clampCover(next, { imgW: photo.naturalWidth, imgH: photo.naturalHeight, canvasW: dims.w, canvasH: dims.h });
      photoTRef.current = next;
      setPhotoT(next);
    } else {
      transformRef.current = next;
      setTransform(next);
    }
    if (wheelTimer.current) clearTimeout(wheelTimer.current);
    wheelTimer.current = setTimeout(settle, 200);
  }, [isWall, cvToCanvas, targetFor, photo, settle]);

  // 휠은 passive 가 아니어야 preventDefault 가 먹는다 — 직접 등록.
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return undefined;
    const h = (e) => onWheel(e);
    cv.addEventListener('wheel', h, { passive: false });
    return () => cv.removeEventListener('wheel', h);
  }, [onWheel]);

  // ── 선택 영속 ────────────────────────────────────────────────────
  const pickMode = (m) => { setMode(m); LS.mode = m; setSaved(false); };
  const pickBg = (c, isRec = false) => { autoBgRef.current = isRec; setBg(c); LS.bg = isRec ? null : c; setSaved(false); };
  const pickSize = (s) => { setTextSize(s); LS.textsize = s; setSaved(false); };

  // ── 저장 ─────────────────────────────────────────────────────────
  // 저장 후 시트를 닫지 않는다 — 결과를 확인하고 바로 다시 손볼 수 있게.
  const onSave = useCallback(async () => {
    const g = gridRef.current;
    if (!g) return;
    setBusy(true);
    setSaved(false);
    try {
      const usePhoto = isWall && !!photo;
      const composed = isWall
        ? composeTimetableImage({
            grid: g, mode: 'wallpaper', background: bg, screen: dims,
            transform: transformRef.current, photo, photoT: photoTRef.current, glassTone,
          })
        : composeTimetableImage({ grid: g, mode: 'plain', background: bg });
      const base = String(title || '시간표').replace(/\s+/g, '');
      const ext = usePhoto ? 'jpg' : 'png';
      const fname = isWall ? `${base}_배경화면.${ext}` : `${base}.png`;
      const res = await saveComposedImage(composed, fname, usePhoto ? 'image/jpeg' : 'image/png');
      if (res !== 'cancelled') setSaved(true);
    } finally {
      setBusy(false);
    }
  }, [isWall, bg, dims, title, photo, glassTone]);

  const hasGrid = !!gridRef.current;
  const bgLower = bg.toLowerCase();
  const bgIsPreset = PRESETS.includes(bgLower) || bgLower === recBg.toLowerCase();

  return (
    <div className="pal-overlay" role="presentation" onClick={onClose}>
      <div className="pal-sheet tti-sheet" role="dialog" aria-modal="true" aria-label="시간표 이미지 저장" onClick={(e) => e.stopPropagation()}>
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
                className={`tti-preview-canvas ${isWall ? 'is-wall' : 'is-plain'}`}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              />
            ) : (
              <p className="tti-hint">시간표가 비어 있어요.</p>
            )}
          </div>
          {isWall && hasGrid && (
            <p className="tti-hint">
              {photo
                ? '시간표 영역을 드래그하면 시간표, 바깥을 드래그하면 사진이 움직여요'
                : '드래그·핀치로 시간표 배치 · 가운데에서 살짝 붙어요'}
            </p>
          )}

          {isWall && (
            <div className="tti-row">
              <span className="tti-label">배경 사진</span>
              <div className="tti-photo">
                <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPickPhoto} />
                {photo ? (
                  <>
                    <span className="tti-photo-on">사진 적용됨</span>
                    <button type="button" className="link-btn" onClick={() => fileRef.current?.click()}>변경</button>
                    <button type="button" className="link-btn tti-photo-rm" onClick={removePhoto}>제거</button>
                  </>
                ) : (
                  <button type="button" className="btn btn-ghost btn-sm tti-photo-btn" onClick={() => fileRef.current?.click()}>
                    사진 선택
                  </button>
                )}
              </div>
            </div>
          )}

          {!(isWall && photo) && (
            <div className="tti-row">
              <span className="tti-label">배경색</span>
              <div className="tti-colors" role="group" aria-label="배경색">
                <button type="button" aria-label="테마 추천 배경색"
                  className={`tti-color tti-rec${bgLower === recBg.toLowerCase() ? ' is-on' : ''}`}
                  style={{ background: recBg }} onClick={() => pickBg(recBg, true)} title="테마 추천색">
                  <span aria-hidden="true">✦</span>
                </button>
                {PRESETS.map((c) => (
                  <button key={c} type="button" aria-label={`배경색 ${c}`}
                    className={`tti-color${bgLower === c ? ' is-on' : ''}`}
                    style={{ background: c }} onClick={() => pickBg(c)} />
                ))}
                <label
                  className={`tti-color-pick cte-swatch${bgIsPreset ? '' : ' is-on'}`}
                  style={{ background: bgIsPreset ? 'transparent' : bg }}
                  title="직접 고르기"
                >
                  <input type="color" value={bg} onChange={(e) => pickBg(e.target.value)} aria-label="배경색 직접 고르기" />
                </label>
              </div>
            </div>
          )}

          <div className="tti-row">
            <span className="tti-label">글자 크기</span>
            <div className="tti-modes tti-sizes" role="group" aria-label="글자 크기">
              {SIZES.map(([v, label]) => (
                <button key={v} type="button" aria-pressed={textSize === v}
                  className={`tti-mode-btn${textSize === v ? ' is-on' : ''}`} onClick={() => pickSize(v)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="tti-actions">
          {saved && <span className="tti-saved" role="status">✓ 저장했어요</span>}
          <button type="button" className="btn btn-ghost" onClick={onClose}>닫기</button>
          <button type="button" className="btn btn-primary" onClick={onSave} disabled={busy || !hasGrid}>
            {busy ? '저장 중…' : (saved ? '다시 저장' : '저장')}
          </button>
        </div>
      </div>
    </div>
  );
}
