import { useEffect, useState } from 'react';
import { collection, query, where, getDocs, Timestamp } from 'firebase/firestore';
import { db } from '../firebase';

// 관리자 공지 팝업(홈 진입 시). 게시 중(활성·만료 전, 만료는 Rules 가 판정) 공지를 모달로 표시.
// 한 번 본 공지는 기기(localStorage)에 기록되어 다시 뜨지 않는다.
// seen 키에 updatedAt 이 들어가므로 공지를 수정·재게시하면 다시 뜬다.
const SEEN_PREFIX = 'notice-seen:';
const seenKey = (n) => `${SEEN_PREFIX}${n.id}:${n.updatedAt?.toMillis?.() ?? ''}`;

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

const fmtDate = (ts) => {
  try { return ts.toDate().toLocaleDateString('ko-KR', { dateStyle: 'medium' }); }
  catch { return ''; }
};

export default function NoticePopup() {
  const [notices, setNotices] = useState([]);

  useEffect(() => {
    let active = true;
    // Rules(firestore.rules: match /notices/{id})와 정확히 같은 조건 — 클라이언트가
    // 직접 읽는다(공지·금지어는 admin-write-only/direct-client-read, 설계 §3).
    const q = query(
      collection(db, 'notices'),
      where('isActive', '==', true),
      where('expiresAt', '>', Timestamp.now()),
    );
    getDocs(q).then((snap) => {
      if (!active) return;
      const data = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
      pruneSeen(data);
      setNotices(data.filter((n) => {
        try { return !localStorage.getItem(seenKey(n)); } catch { return true; }
      }));
    }).catch(() => {});
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
                <span className="ntc-date">{fmtDate(n.updatedAt ?? n.createdAt)}</span>
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
