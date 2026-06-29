import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../supabase';
import { flagText, highlightParts } from '../lib/moderation';

const TYPE_LABEL = { review: '강의평', class_memo: '메모', exam_archive: '족보' };
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
  const [updatedAt, setUpdatedAt] = useState(null);
  const [edit, setEdit] = useState(null); // { type, id, text }
  const timer = useRef(null);

  useEffect(() => {
    supabase.rpc('is_admin').then(({ data }) => setIsAdmin(!!data));
  }, []);

  const load = useCallback(async () => {
    const r = await call('list_recent', { limit: 100 });
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
        <header className="page-header row">
          <Link to="/admin" className="link-btn">← 관리자</Link>
          <h2>모더레이션</h2><span style={{ width: '2.5rem' }} />
        </header>
        <p className="muted center">관리자 권한이 없습니다.</p>
      </div>
    );
  }

  const flaggedCount = items.filter((i) => i.flags.length).length;

  return (
    <div className="page">
      <header className="page-header row">
        <Link to="/admin" className="link-btn">← 관리자</Link>
        <h2>모더레이션</h2>
        <button className="link-btn" onClick={load}>새로고침</button>
      </header>

      <p className="mod-status">
        실시간(15초) · 총 {items.length}건 · <span className="mod-flag-n">검토필요 {flaggedCount}건</span>
        {updatedAt && ` · ${updatedAt.toLocaleTimeString('ko-KR')} 갱신`}
      </p>

      <ul className="mod-list">
        {items.length === 0 && <p className="muted center">게시글이 없습니다.</p>}
        {items.map((it) => (
          <li key={`${it.type}-${it.id}`} className={`mod-card ${it.flags.length ? 'flagged' : ''}`}>
            <div className="mod-card-top">
              <span className="mod-type">{TYPE_LABEL[it.type]}</span>
              <span className="mod-course">{it.course_code}{it.meta?.section_no ? `·${it.meta.section_no}분반` : ''}</span>
              {it.flags.length > 0 && <span className="mod-badge">⚠ {it.flags.join(', ')}</span>}
              <span className="mod-time">{new Date(it.created_at).toLocaleString('ko-KR')}</span>
            </div>

            {edit && edit.type === it.type && edit.id === it.id ? (
              <div className="mod-edit">
                <textarea value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value })} rows={3} />
                <div className="mod-edit-actions">
                  <button className="btn-add" onClick={saveEdit}>저장</button>
                  <button className="rev-del-btn" onClick={() => setEdit(null)}>취소</button>
                </div>
              </div>
            ) : (
              <p className="mod-text"><Highlighted text={it.text || '(내용 없음)'} /></p>
            )}

            <div className="mod-actions">
              <button className="rev-del-btn" onClick={() => setEdit({ type: it.type, id: it.id, text: editableText(it) })}>수정</button>
              <button className="btn-remove" onClick={() => remove(it)}>삭제</button>
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
