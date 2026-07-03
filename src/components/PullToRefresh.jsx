import { useEffect, useRef, useState } from 'react';

// =====================================================================
//  아래로 당겨 새로고침 (터치 전용)
//  - 문서 스크롤이 맨 위일 때 아래로 당기면 인디케이터가 내려오고,
//    THRESHOLD 이상 당긴 뒤 놓으면 onRefresh() 완료까지 스피너를 유지한다.
//  - 콘텐츠(페이지·헤더)는 움직이지 않고 인디케이터 칩만 내려온다
//    (본문이 범위 밖까지 딸려 움직이는 모션 제거 — 머티리얼 방식).
//  - 기존 <div className="page"> 자리를 그대로 대체해서 쓴다:
//      <PullToRefresh className="page" onRefresh={...}>…</PullToRefresh>
// =====================================================================

const THRESHOLD = 64; // 이만큼(px) 당기면 발동
const HOLD = 52;      // 새로고침 동안 유지되는 당김 높이
const MAX_PULL = 108; // 당김 표시 한계
const DAMPING = 0.5;  // 손가락 이동 대비 당김 비율(저항감)

export default function PullToRefresh({ onRefresh, className = '', children }) {
  const ref = useRef(null);
  const indRef = useRef(null);
  const [phase, setPhase] = useState('idle'); // idle | pull | ready | refreshing
  const cb = useRef(onRefresh);
  useEffect(() => { cb.current = onRefresh; });

  useEffect(() => {
    const el = ref.current;
    const ind = indRef.current;
    if (!el || !ind) return;
    const s = { startX: 0, startY: 0, active: false, pull: 0, refreshing: false, phase: 'idle' };

    const setPh = (p) => { if (s.phase !== p) { s.phase = p; setPhase(p); } };
    // 이동은 리렌더 없이 인디케이터 transform 으로만 (콘텐츠는 고정, 60fps)
    const move = (px, animate) => {
      s.pull = px;
      ind.style.transition = animate ? 'transform 0.22s ease' : 'none';
      ind.style.transform = px > 0 ? `translateY(${px}px)` : '';
    };
    const atTop = () => (window.scrollY || document.documentElement.scrollTop || 0) <= 0;

    const onStart = (e) => {
      if (s.refreshing || e.touches.length !== 1 || !atTop()) return;
      s.startX = e.touches[0].clientX;
      s.startY = e.touches[0].clientY;
      s.active = true;
    };
    const onMove = (e) => {
      if (!s.active || s.refreshing) return;
      const t = e.touches[0];
      const dy = t.clientY - s.startY;
      // 가로 제스처(스와이프 등)는 건드리지 않는다
      if (s.pull === 0 && Math.abs(t.clientX - s.startX) > Math.abs(dy)) { s.active = false; return; }
      if (dy <= 0 || !atTop()) {
        // 위로 스크롤로 전환: 당김을 접고 네이티브 스크롤에 맡긴다
        if (s.pull > 0) { move(0, false); setPh('idle'); }
        return;
      }
      if (e.cancelable) e.preventDefault(); // 네이티브 오버스크롤/PTR 차단
      const pull = Math.min(MAX_PULL, dy * DAMPING);
      move(pull, false);
      setPh(pull >= THRESHOLD ? 'ready' : 'pull');
    };
    const onEnd = async () => {
      if (!s.active) return;
      s.active = false;
      if (s.pull >= THRESHOLD) {
        s.refreshing = true;
        setPh('refreshing');
        move(HOLD, true);
        try { await cb.current?.(); } catch { /* 실패해도 접기만 한다 */ }
        s.refreshing = false;
      }
      move(0, true);
      setPh('idle');
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, []);

  return (
    <div ref={ref} className={`ptr ${className}${phase !== 'idle' ? ` ptr-${phase}` : ''}`}>
      <div ref={indRef} className="ptr-ind" aria-hidden="true">
        <span className="ptr-chip">
          {phase === 'refreshing' ? <span className="ptr-spinner" /> : <span className="ptr-arrow">↓</span>}
        </span>
      </div>
      {children}
    </div>
  );
}
