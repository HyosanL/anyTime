import { useEffect, useState } from 'react';
import { supabase } from '../supabase';

// 관리자 공지 팝업(홈 진입 시). 게시 중(활성·만료 전, 만료는 RLS 가 판정) 공지를 모달로 표시.
// 한 번 본 공지는 기기(localStorage)에 기록되어 다시 뜨지 않는다.
// seen 키에 updated_at 이 들어가므로 공지를 수정·재게시하면 다시 뜬다.
const SEEN_PREFIX = 'notice-seen:';
const seenKey = (n) => `${SEEN_PREFIX}${n.id}:${n.updated_at ?? ''}`;

// 지난 공지(내려짐·만료·삭제·수정 전 버전)의 열람 기록 정리 — 게시 중 공지의 키만 남긴다
function pruneSeen(current) {
  try {
    const keep = new Set(current.map(seenKey));
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(SEEN_PREFIX) && !keep.has(k)) localStorage.removeItem(k);
    }
  } catch { /* ignore */ }
}

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
        if (!active || error || !data) return;
        pruneSeen(data);
        setNotices(data.filter((n) => {
          try { return !localStorage.getItem(seenKey(n)); } catch { return true; }
        }));
      });
    return () => { active = false; };
  }, []);

  if (notices.length === 0) return null;

  function close() {
    for (const n of notices) {
      try { localStorage.setItem(seenKey(n), '1'); } catch { /* 저장 불가 → 다음에 또 표시 */ }
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
