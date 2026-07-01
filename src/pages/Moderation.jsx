import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../supabase';
import { flagText, highlightParts } from '../lib/moderation';

const TYPE_LABEL = { review: '강의평', class_memo: '메모', exam_archive: '족보' };
const FIELD_LABEL = { time: '요일·교시', room: '강의실', professor: '담당교수', name: '이름/과목명', department: '학과', credits: '학점' };
const POLL_MS = 15000;

async function call(action, payload = {}) {
  const { data, error } = await supabase.functions.invoke('admin-action', { body: { action, payload } });
  let status = data?.status;
  if (error) { try { status = (await error.context?.json?.())?.status; } catch { /* ignore */ } }
  return { ok: status === 'OK', status, data };
}

function Highlighted({ text }) {
  return (
    <>
      {highlightParts(text).map((p, i) =>
        p.bad ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>
      )}
    </>
  );
}

// 화면9-2: 실시간 모더레이션 대시보드. 모든 게시글을 최신순으로,
// 부정어 포함 글은 강조 + 최상단. 진입 없이 즉시 수정/삭제.
export default function Moderation() {
  const [isAdmin, setIsAdmin] = useState(null);
  const [items, setItems] = useState([]);
  const [corrs, setCorrs] = useState([]); // 수정 제안(pending)
  const [updatedAt, setUpdatedAt] = useState(null);
  const [edit, setEdit] = useState(null); // { type, id, text }
  const timer = useRef(null);

  useEffect(() => {
    supabase.rpc('is_admin').then(({ data }) => setIsAdmin(!!data));
  }, []);

  const load = useCallback(async () => {
    const [r, rc] = await Promise.all([
      call('list_recent', { limit: 100 }),
      call('list_corrections', { status: 'pending' }),
    ]);
    if (rc.ok) setCorrs(rc.data.items ?? []);
    if (!r.ok) return;
    const withFlags = (r.data.items ?? []).map((it) => ({ ...it, flags: flagText(it.text) }));
    // 부정어 포함 글을 위로, 그 다음 최신순
    withFlags.sort((a, b) => {
      const fa = a.flags.length > 0, fb = b.flags.length > 0;
      if (fa !== fb) return fa ? -1 : 1;
      return a.created_at < b.created_at ? 1 : -1;
    });
    setItems(withFlags);
    setUpdatedAt(new Date());
  }, []);

  async function applyCorr(c) {
    const r = await call('apply_correction', { id: c.id });
    if (r.ok) setCorrs((prev) => prev.filter((x) => x.id !== c.id));
    else alert('적용 실패: ' + (r.status ?? '오류') + (r.status === 'BAD_TIME' ? ' (시간 형식: 예 "수3 수4 금1")' : ''));
  }
  async function rejectCorr(c) {
    if (!confirm('이 수정 제안을 반려할까요?')) return;
    const r = await call('reject_correction', { id: c.id });
    if (r.ok) setCorrs((prev) => prev.filter((x) => x.id !== c.id));
  }

  useEffect(() => {
    if (!isAdmin) return;
    load();
    timer.current = setInterval(load, POLL_MS);
    return () => clearInterval(timer.current);
  }, [isAdmin, load]);

  async function remove(it) {
    if (!confirm(`이 ${TYPE_LABEL[it.type]}을(를) 삭제할까요?`)) return;
    const r = await call('delete_post', { table: it.type, id: it.id });
    if (r.ok) setItems((prev) => prev.filter((x) => !(x.type === it.type && x.id === it.id)));
  }

  async function saveEdit() {
    const fields = edit.type === 'class_memo'
      ? { content: edit.text }
      : edit.type === 'exam_archive'
        ? { description: edit.text }
        : { course_comment: edit.text };
    const r = await call('edit_post', { table: edit.type, id: edit.id, fields });
    if (r.ok) { setEdit(null); load(); }
  }

  if (isAdmin === null) return <div className="page-center">확인 중…</div>;
  if (!isAdmin) {
    return (
      <div className="page">
        <header className="page-header">
          <Link to="/admin" className="link-btn">← 관리자</Link>
          <h2>모더레이션</h2>
        </header>
        <div className="empty">
          <span className="empty-emoji">🔒</span>
          <p>관리자 권한이 없습니다.</p>
        </div>
      </div>
    );
  }

  const flaggedCount = items.filter((i) => i.flags.length).length;

  return (
    <div className="page">
      <header className="page-header">
        <Link to="/admin" className="link-btn">← 관리자</Link>
        <h2>모더레이션</h2>
        <button className="link-btn" onClick={load}>새로고침</button>
      </header>

      <p className="mod-status">
        실시간(15초) · 총 {items.length}건 · <span className="mod-flag-n">검토필요 {flaggedCount}건</span>
        {corrs.length > 0 && <span className="mod-flag-n"> · 수정제안 {corrs.length}건</span>}
        {updatedAt && ` · ${updatedAt.toLocaleTimeString('ko-KR')} 갱신`}
      </p>

      {corrs.length > 0 && (
        <>
          <h3 className="mod-corr-head">🚩 정보 수정 제안 {corrs.length}건</h3>
          <ul className="mod-list">
            {corrs.map((c) => (
              <li key={`corr-${c.id}`} className="card mod-card">
                <div className="mod-card-top">
                  <span className="tag tag-primary mod-type">수정제안</span>
                  <span className="mod-course">{c.label || c.target} · <span className="mod-corr-field">{FIELD_LABEL[c.field] || c.field}</span></span>
                  <span className="mod-time">{new Date(c.created_at).toLocaleString('ko-KR')}</span>
                </div>
                <p className="mod-text">
                  {c.suggested ? <>제안값: <b className="mod-corr-sug">{c.suggested}</b></> : <span className="muted">제안값 없음</span>}
                  {c.note ? <><br />설명: {c.note}</> : null}
                </p>
                <div className="mod-actions">
                  <button className="btn-add btn-sm" onClick={() => applyCorr(c)}>적용</button>
                  <button className="rev-del-btn" onClick={() => rejectCorr(c)}>반려</button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <ul className="mod-list">
        {items.length === 0 && (
          <li className="empty">
            <span className="empty-emoji">🗂️</span>
            <p>게시글이 없습니다.</p>
          </li>
        )}
        {items.map((it) => (
          <li key={`${it.type}-${it.id}`} className={`card mod-card ${it.flags.length ? 'flagged' : ''}`}>
            <div className="mod-card-top">
              <span className="tag tag-primary mod-type">{TYPE_LABEL[it.type]}</span>
              <span className="mod-course">{it.course_code}{it.meta?.section_no ? `·${it.meta.section_no}분반` : ''}</span>
              {it.flags.length > 0 && <span className="tag tag-warn mod-badge">⚠ {it.flags.join(', ')}</span>}
              <span className="mod-time">{new Date(it.created_at).toLocaleString('ko-KR')}</span>
            </div>

            {edit && edit.type === it.type && edit.id === it.id ? (
              <div className="mod-edit">
                <textarea value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value })} rows={3} />
                <div className="mod-edit-actions">
                  <button className="btn-add btn-sm" onClick={saveEdit}>저장</button>
                  <button className="rev-del-btn" onClick={() => setEdit(null)}>취소</button>
                </div>
              </div>
            ) : (
              <p className="mod-text"><Highlighted text={it.text || '(내용 없음)'} /></p>
            )}

            <div className="mod-actions">
              <button className="rev-del-btn" onClick={() => setEdit({ type: it.type, id: it.id, text: editableText(it) })}>수정</button>
              <button className="btn-remove btn-sm" onClick={() => remove(it)}>삭제</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// 수정 대상 텍스트(편집 가능한 필드)
function editableText(it) {
  return it.text || '';
}
