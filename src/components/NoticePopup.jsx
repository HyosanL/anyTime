import { useEffect, useState } from 'react';
import { supabase } from '../supabase';

// 관리자 공지 팝업(홈 진입 시). 활성 공지를 모달로 표시하고,
// 닫으면 이 세션(탭) 동안만 숨김 → 앱 재접속 시 다시 표시.
// seen 키에 updated_at 을 포함해 공지가 수정되면 같은 세션에도 다시 뜬다.
const seenKey = (n) => `notice-seen:${n.id}:${n.updated_at ?? ''}`;

const fmtDate = (iso) => {
  try { return new Date(iso).toLocaleDateString('ko-KR', { dateStyle: 'medium' }); }
  catch { return ''; }
};

export default function NoticePopup() {
  const [notices, setNotices] = useState([]);

  useEffect(() => {
    let active = true;
    supabase.from('notice')
      .select('id, title, content, created_at, updated_at')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (!active || error || !data?.length) return;
        setNotices(data.filter((n) => {
          try { return !sessionStorage.getItem(seenKey(n)); } catch { return true; }
        }));
      });
    return () => { active = false; };
  }, []);

  if (notices.length === 0) return null;

  function close() {
    for (const n of notices) {
      try { sessionStorage.setItem(seenKey(n), '1'); } catch { /* 시크릿 등 저장 불가 → 다음에 또 표시 */ }
    }
    setNotices([]);
  }

  return (
    <div className="ntc-overlay" onClick={close}>
      <div className="ntc-modal" role="dialog" aria-modal="true" aria-label="공지사항" onClick={(e) => e.stopPropagation()}>
        <div className="ntc-head">
          <h3 className="ntc-title">📢 공지사항</h3>
          <button className="ntc-x" onClick={close} aria-label="닫기">✕</button>
        </div>
        <div className="ntc-list">
          {notices.map((n) => (
            <article key={n.id} className="ntc-item">
              <div className="ntc-item-head">
                <strong className="ntc-item-title">{n.title}</strong>
                <span className="ntc-date">{fmtDate(n.updated_at ?? n.created_at)}</span>
              </div>
              <p className="ntc-content">{n.content}</p>
            </article>
          ))}
        </div>
        <button className="btn-add btn-block" onClick={close}>확인</button>
      </div>
    </div>
  );
}
