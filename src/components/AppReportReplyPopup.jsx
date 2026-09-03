import { useEffect, useState } from 'react';
import { fetchMyReports, readSeenReplies, markReplySeen } from '../lib/appReport';

// ntc-* 클래스는 home.css(index.css 가 전역 @import)에 있다 — NoticePopup 과 동일하게 별도 import 불필요.
const STATUS_LABEL = { reviewing: '검토중', resolved: '해결됨', planned: '반영예정' };

// 앱 접속 시, 내가 낸 리포트에 새 답변이 있으면 공지처럼 한 번 띄운다(NoticePopup 과 같은 톤).
// 한 번 본 답변은 기기(localStorage)에 기록되어 다시 뜨지 않는다.
export default function AppReportReplyPopup() {
  const [replies, setReplies] = useState([]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const items = await fetchMyReports();
        if (!active) return;
        const seen = new Set(readSeenReplies());
        setReplies(items.filter((i) => i.reply && !seen.has(i.id)));
      } catch { /* 오프라인 등 — 다음 진입 때 */ }
    })();
    return () => { active = false; };
  }, []);

  if (replies.length === 0) return null;

  function close() {
    markReplySeen(replies.map((r) => r.id));
    setReplies([]);
  }

  return (
    <div className="ntc-overlay" onClick={close}>
      <div className="ntc-modal" role="dialog" aria-modal="true" aria-label="문의 답변" onClick={(e) => e.stopPropagation()}>
        <div className="ntc-head">
          <h3 className="ntc-title">📬 문의하신 문제에 답변이 도착했어요</h3>
          <button className="ntc-x" onClick={close} aria-label="닫기">✕</button>
        </div>
        <div className="ntc-list">
          {replies.map((r) => (
            <article key={r.id} className="ntc-item">
              <div className="ntc-item-head">
                <strong className="ntc-item-title">{STATUS_LABEL[r.replyStatus] || '답변'}</strong>
              </div>
              <p className="ntc-content ar-pop-q">“{r.text}”</p>
              <p className="ntc-content">{r.reply}</p>
            </article>
          ))}
        </div>
        <button className="btn-add btn-block" onClick={close}>확인</button>
      </div>
    </div>
  );
}
