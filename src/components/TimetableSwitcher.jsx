import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

// 홈 시간표 카드의 제목 = 시간표 전환 드롭다운.
// 목록에서 전환하고, 그 자리에서 확정 지정·이름 변경·삭제·새로 만들기까지 처리한다.
// (배송지 목록에서 기본 배송지를 고르는 것과 같은 모델 — 확정은 학기별 1개)
export default function TimetableSwitcher({
  timetables = [],
  selected,
  semesters = [],
  onSelect,
  onCreate,
  onRename,
  onSetPrimary,
  onDelete,
  onSummary,        // 수강신청용 요약표 열기(지금 보고 있지 않은 시간표도 그 자리에서)
  onOpenCreate,     // 새로 열린 학기(관리자가 방금 추가한 다음 학기)를 그 자리에서 받아오기
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef(null);

  // 새 시간표의 기본 학기는 '이번 학기'(없으면 가장 최근 학기)
  const cur = semesters.find((s) => s.is_current) ?? semesters[0];
  const [newSem, setNewSem] = useState('');
  const [newName, setNewName] = useState('');

  // 바깥을 누르면 닫기
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) close(); };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  function close() {
    setOpen(false);
    setCreating(false);
    setErr('');
  }

  // 그 학기의 첫 시간표면 '내 시간표', 아니면 '초안 N' 을 제안(바로 만들기 한 번으로 끝나게)
  function suggestName(sem) {
    if (!sem) return '';
    const n = timetables.filter((t) => t.year === sem.year && t.term === sem.term).length;
    return n === 0 ? '내 시간표' : `초안 ${n}`;
  }

  async function openCreate() {
    setErr('');
    setNewSem(`${cur?.year ?? ''}-${cur?.term ?? ''}`);
    setNewName(suggestName(cur));
    setCreating(true);
    // 카탈로그 캐시는 24시간이라, 관리자가 방금 연 다음 학기가 안 보일 수 있다.
    // 이 폼을 열 때만 서버에서 학기 목록을 다시 받는다(평소엔 캐시 그대로).
    if (onOpenCreate) { try { await onOpenCreate(); } catch { /* 오프라인 → 캐시 목록 */ } }
  }

  async function run(fn) {
    setBusy(true);
    setErr('');
    try {
      await fn();
      return true;
    } catch (e) {
      setErr(e?.message || '처리하지 못했습니다.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submitCreate(e) {
    e.preventDefault();
    const [y, t] = newSem.split('-').map(Number);
    if (!y || !t) return setErr('학기를 고르세요.');
    const name = newName.trim();
    if (!name) return setErr('시간표 이름을 입력하세요.');
    const ok = await run(() => onCreate({ year: y, term: t, name }));
    if (ok) close();
  }

  async function rename(t) {
    const name = prompt('시간표 이름', t.name)?.trim();
    if (!name || name === t.name) return;
    await run(() => onRename(t.id, name));
  }

  async function remove(t) {
    const msg = t.is_primary
      ? `'${t.name}'은(는) ${t.year}-${t.term} 확정 시간표입니다.\n삭제하면 담긴 강의와 직접추가 항목도 함께 사라지고, 같은 학기의 다른 시간표가 확정이 됩니다.\n삭제할까요?`
      : `'${t.name}' 시간표를 삭제할까요?\n담긴 강의와 직접추가 항목도 함께 사라집니다.`;
    if (!confirm(msg)) return;
    await run(() => onDelete(t.id));
  }

  const label = selected ? `${selected.year}-${selected.term} ${selected.name}` : '시간표';

  return (
    <div className="tt-switch" ref={wrapRef}>
      <button
        type="button"
        className="tt-switch-btn"
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
      >
        <span className="card-title">{label}</span>
        {selected?.is_primary && <span className="tt-star" title="확정 시간표">★</span>}
        <span className="tt-caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="tt-switch-panel" role="menu">
          <ul className="tt-switch-list">
            {timetables.map((t) => (
              <li key={t.id} className={`tt-switch-item${t.id === selected?.id ? ' is-on' : ''}`}>
                <button
                  type="button"
                  className="tt-switch-pick"
                  onClick={() => { onSelect(t.id); close(); }}
                >
                  <span className="tt-switch-sem">{t.year}-{t.term}</span>
                  <span className="tt-switch-name">{t.name}</span>
                  {t.is_primary && <span className="tt-badge-primary">확정</span>}
                </button>
                <span className="tt-switch-ops">
                  {/* 수강신청 때 과목명·분반·교수·시간을 한눈에 — 격자를 눈으로 옮겨 적지 않게 */}
                  <button type="button" className="link-btn" disabled={busy}
                    title="수강신청용 요약표 보기"
                    onClick={() => { onSummary(t); close(); }}>요약</button>
                  {!t.is_primary && (
                    <button type="button" className="link-btn" disabled={busy}
                      title="이 학기의 확정 시간표로 지정"
                      onClick={() => run(() => onSetPrimary(t.id))}>★ 확정</button>
                  )}
                  <button type="button" className="link-btn" disabled={busy}
                    onClick={() => rename(t)}>이름</button>
                  <button type="button" className="link-btn tt-op-del" disabled={busy}
                    onClick={() => remove(t)}>삭제</button>
                </span>
              </li>
            ))}
          </ul>

          {err && <p className="error-msg tt-switch-err">{err}</p>}

          {creating ? (
            <form className="tt-switch-new" onSubmit={submitCreate}>
              <select value={newSem} onChange={(e) => setNewSem(e.target.value)}>
                {semesters.map((s) => (
                  <option key={`${s.year}-${s.term}`} value={`${s.year}-${s.term}`}>
                    {s.year}-{s.term}학기{s.is_current ? ' (이번)' : ''}
                  </option>
                ))}
              </select>
              <input
                value={newName}
                maxLength={20}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="이름 (예: 초안A)"
              />
              <div className="tt-switch-new-row">
                <button type="submit" className="btn-add btn-sm" disabled={busy}>만들기</button>
                <button type="button" className="btn-ghost btn-sm" onClick={() => setCreating(false)}>취소</button>
              </div>
              <p className="account-note">학기당 5개까지. 새 시간표는 빈 상태로 시작합니다.</p>
            </form>
          ) : (
            <>
              <button type="button" className="tt-switch-add" onClick={openCreate}>＋ 새 시간표 만들기</button>
              {/* 여러 경우의 수를 한 번에: 과목·가능한 분반만 고르면 조합을 만들어 준다 */}
              <Link to="/wizard" className="tt-switch-add tt-switch-wiz" onClick={close}>
                🪄 시간표 마법사로 짜기
              </Link>
            </>
          )}
        </div>
      )}
    </div>
  );
}
