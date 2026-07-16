// 직접설정(커스텀) 테마 편집기 — 자유 색 여러 개 + 통일 글씨색을 골라 기기에만 저장한다.
// 색은 네이티브 <input type="color"> 로 고른다(OS 컬러피커: 스펙트럼/스포이드/HEX, 의존성 0).
// 저장하면 lib/palettes 가 활성 테마를 'custom' 으로 바꿔 홈·마법사·이미지에 즉시 반영한다.
import { useEffect, useState } from 'react';
import {
  CUSTOM_MIN, CUSTOM_MAX,
  getCustomPalette, setCustomPalette, paletteByKey, getPaletteKey,
} from '../lib/palettes';

// 처음(커스텀 없음) 열 때의 시작값 — 지금 활성 팔레트의 앞 5색 + 그 글씨색(빈 화면 대신).
function seedFromActive() {
  const pal = paletteByKey(getPaletteKey());
  return { colors: pal.colors.slice(0, 5), fg: pal.fg };
}

// 미리보기 — 고른 배경색 위에 글씨색으로 '글씨' 를 얹어 가독성을 바로 확인한다.
function Preview({ colors, fg }) {
  return (
    <div className="cte-preview" aria-hidden="true">
      {colors.map((c, i) => (
        <span key={i} className="cte-preview-cell" style={{ background: c, color: fg }}>글씨</span>
      ))}
    </div>
  );
}

// 색 스와치(탭하면 네이티브 컬러피커) — 진짜 input 은 위에 투명하게 덮어 라벨 어디를 눌러도 열린다.
function Swatch({ value, onChange, ariaLabel }) {
  return (
    <label className="cte-swatch" style={{ background: value }}>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} aria-label={ariaLabel} />
    </label>
  );
}

export default function CustomThemeEditor({ onClose }) {
  const [{ colors, fg }, setState] = useState(() => getCustomPalette() || seedFromActive());

  // Esc 로 닫기 + 배경 스크롤 잠금(PaletteSheet 와 동일한 처리).
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const html = document.documentElement;
    const prevBody = document.body.style.overflow;
    const prevHtml = html.style.overflow;
    document.body.style.overflow = 'hidden';
    html.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevBody;
      html.style.overflow = prevHtml;
    };
  }, [onClose]);

  const setColorAt = (i, v) =>
    setState((s) => ({ ...s, colors: s.colors.map((c, ci) => (ci === i ? v : c)) }));
  const removeAt = (i) =>
    setState((s) => (s.colors.length <= CUSTOM_MIN ? s : { ...s, colors: s.colors.filter((_, ci) => ci !== i) }));
  const addColor = () =>
    setState((s) => (s.colors.length >= CUSTOM_MAX
      ? s
      : { ...s, colors: [...s.colors, s.colors[s.colors.length - 1] || '#dbeafe'] }));
  const setFg = (v) => setState((s) => ({ ...s, fg: v }));

  const save = () => { setCustomPalette({ colors, fg }); onClose(); };

  const canRemove = colors.length > CUSTOM_MIN;
  const canAdd = colors.length < CUSTOM_MAX;

  return (
    <div className="pal-overlay cte-overlay" role="presentation" onClick={onClose}>
      <div className="pal-sheet cte-sheet" role="dialog" aria-modal="true" aria-label="직접설정 테마" onClick={(e) => e.stopPropagation()}>
        <div className="pal-sheet-head">
          <h3 className="pal-sheet-title">🎨 직접설정</h3>
          <button className="pal-sheet-x" onClick={onClose} aria-label="닫기">✕</button>
        </div>

        <div className="pal-sheet-body cte-body">
          <Preview colors={colors} fg={fg} />

          <div className="cte-label">색 <span className="cte-count">{colors.length}/{CUSTOM_MAX}</span></div>
          <div className="cte-colors">
            {colors.map((c, i) => (
              <div className="cte-row" key={i}>
                <Swatch value={c} onChange={(v) => setColorAt(i, v)} ariaLabel={`색 ${i + 1}`} />
                <span className="cte-hex">{c.toUpperCase()}</span>
                <button
                  type="button"
                  className="cte-del"
                  onClick={() => removeAt(i)}
                  disabled={!canRemove}
                  aria-label={`색 ${i + 1} 삭제`}
                >✕</button>
              </div>
            ))}
          </div>
          <button type="button" className="cte-add" onClick={addColor} disabled={!canAdd}>
            ＋ 색 추가
          </button>

          <div className="cte-label">글씨색</div>
          <div className="cte-row cte-fg-row">
            <Swatch value={fg} onChange={setFg} ariaLabel="글씨색" />
            <span className="cte-hex">{fg.toUpperCase()}</span>
            <span className="cte-fg-hint">모든 칸에 공통 적용</span>
          </div>
        </div>

        <p className="pal-sheet-note">이 기기에만 저장돼요.</p>
        <div className="cte-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>취소</button>
          <button type="button" className="btn btn-primary" onClick={save}>저장하고 적용</button>
        </div>
      </div>
    </div>
  );
}
