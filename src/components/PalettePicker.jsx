// 시간표 색상 테마 피커 — 팔레트마다 미니 모자이크 미리보기 + 이름 + 선택 링.
// 프로필 설정(인라인 그리드)과 홈(⚙️ 바텀시트) 두 곳에서 같은 그리드를 쓴다.
// 고른 테마는 lib/palettes 가 기기(localStorage)에 저장하고 'palettechange' 로 즉시 반영한다.
import { useEffect, useState } from 'react';
import { PALETTES, usePalette, getCustomPalette, CUSTOM_KEY, CUSTOM_LABEL } from '../lib/palettes';
import CustomThemeEditor from './CustomThemeEditor';
import { lockScroll, unlockScroll } from '../lib/scrollLock';
import '../styles/palette.css';

// 미리보기 모자이크: 5열의 세로 블록(시간표 축소판 느낌).
// 각 칸의 숫자는 세로 비중(flex-grow), 음수는 빈 칸(수업 없는 시간).
const MOSAIC = [
  [2, 1, 3, -1],
  [1, 3, -1, 2],
  [3, 1, 2, 1],
  [-1, 2, 1, 3],
  [2, 1, 2, -1],
];

function Mosaic({ colors }) {
  let n = 0;
  return (
    <span className="pal-mosaic" aria-hidden="true">
      {MOSAIC.map((col, ci) => (
        <span className="pal-col" key={ci}>
          {col.map((w, ri) => {
            const gap = w < 0;
            const bg = gap ? 'var(--surface)' : colors[n++ % colors.length];
            return <span key={ri} className="pal-block" style={{ flexGrow: Math.abs(w), background: bg }} />;
          })}
        </span>
      ))}
    </span>
  );
}

// 스와치 그리드 — 어디서든 재사용. 맨 끝은 '직접설정'(커스텀) 스와치로, 탭하면 편집기를 연다.
export default function PalettePicker() {
  const [key, setKey] = usePalette();
  const [editing, setEditing] = useState(false);
  const custom = getCustomPalette();   // usePalette 리렌더 때 다시 읽혀 편집 결과가 미리보기에 반영된다.
  const customOn = key === CUSTOM_KEY;

  return (
    <>
      <div className="pal-grid" role="radiogroup" aria-label="시간표 색상 테마">
        {PALETTES.map((p) => {
          const on = p.key === key;
          return (
            <button
              key={p.key}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={p.label}
              className={`pal-swatch${on ? ' is-on' : ''}`}
              onClick={() => setKey(p.key)}
            >
              <Mosaic colors={p.colors} />
              <span className="pal-name">{p.label}</span>
            </button>
          );
        })}

        {/* 직접설정 — 항상 마지막. 만든 게 있으면 그 색으로 미리보기, 없으면 🎨 안내. */}
        <button
          type="button"
          role="radio"
          aria-checked={customOn}
          aria-label={`${CUSTOM_LABEL}${custom ? '' : ' (새로 만들기)'}`}
          className={`pal-swatch pal-swatch-custom${customOn ? ' is-on' : ''}`}
          onClick={() => setEditing(true)}
        >
          {custom
            ? <Mosaic colors={custom.colors} />
            : <span className="pal-mosaic pal-custom-empty"><span aria-hidden="true">🎨</span></span>}
          <span className="pal-name">{CUSTOM_LABEL}</span>
        </button>
      </div>

      {editing && <CustomThemeEditor onClose={() => setEditing(false)} />}
    </>
  );
}

// 홈 ⚙️ 가 여는 바텀시트 — 바깥/✕/Esc 로 닫는다. 선택은 즉시 반영(닫지 않아도 됨).
export function PaletteSheet({ onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    // 시트가 열린 동안 배경(홈) 스크롤 잠금 — 스와치 사이 여백을 드래그해도 뒤 화면이 안 밀린다.
    // position:fixed 로 얼리는 방식(iOS 대응) + 참조 카운트라 위에 편집기가 겹쳐도 안전하다.
    lockScroll();
    return () => {
      window.removeEventListener('keydown', onKey);
      unlockScroll();
    };
  }, [onClose]);

  return (
    <div className="pal-overlay" role="presentation" onClick={onClose}>
      <div className="pal-sheet" role="dialog" aria-modal="true" aria-label="시간표 색상 테마" onClick={(e) => e.stopPropagation()}>
        <div className="pal-sheet-head">
          <h3 className="pal-sheet-title">🎨 시간표 색상</h3>
          <button className="pal-sheet-x" onClick={onClose} aria-label="닫기">✕</button>
        </div>
        <p className="pal-sheet-note">과목 색을 골라보세요. 이 기기에만 저장돼요.</p>
        <div className="pal-sheet-body">
          <PalettePicker />
        </div>
      </div>
    </div>
  );
}
