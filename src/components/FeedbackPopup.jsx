import { useEffect, useState } from 'react';
import { fetchFeedback, readSeen, markSeen } from '../lib/feedback';

// ntc-* 클래스는 home.css(전역). 앱 접속 시, 안 본 제안·신고 결과를 공지처럼 한 번 띄운다.
const APP_STATUS = { reviewing: '검토중', resolved: '해결됨', planned: '반영예정' };

function appReportLine(it) {
  return { key: `appReport:${it.id}`, badge: APP_STATUS[it.replyStatus] || '답변',
    q: it.summary, a: it.reply };
}
function correctionLine(it) {
  const a = it.status === 'applied' && it.autoApplied ? '📌 여러 명이 같은 제안을 해서 자동 반영됐어요.'
    : it.status === 'applied' ? '✅ 제안이 반영됐어요.'
    : it.status === 'rejected' ? (it.reply ? `❌ 반려됐어요: ${it.reply}` : '❌ 이번엔 반영하지 않았어요.')
    : it.status === 'resolved' ? '✅ 확인 후 직접 수정했어요.'
    : null;
  return a ? { key: `correction:${it.id}`, badge: '수정 제안', q: it.summary, a } : null;
}
function contentLine(it) {
  const a = it.outcome === 'removed' ? '🗑️ 신고하신 내용이 삭제 조치됐어요.'
    : it.outcome === 'kept' ? (it.reason ? `검토 결과 유지됩니다: ${it.reason}` : '검토 결과 규정 위반이 아니라 유지됩니다.')
    : null;
  return a ? { key: `content:${it.type}_${it.id}`, badge: '신고', q: '', a } : null;
}

export default function FeedbackPopup() {
  const [lines, setLines] = useState([]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const f = await fetchFeedback();
        if (!active) return;
        const seen = new Set(readSeen());
        const all = [
          ...f.appReports.filter((i) => i.reply).map(appReportLine),
          ...f.corrections.map(correctionLine).filter(Boolean),
          ...f.contentReports.map(contentLine).filter(Boolean),
        ].filter((l) => l && !seen.has(l.key));
        setLines(all);
      } catch { /* 오프라인 등 */ }
    })();
    return () => { active = false; };
  }, []);

  if (lines.length === 0) return null;

  function close() {
    markSeen(lines.map((l) => l.key));
    setLines([]);
  }

  return (
    <div className="ntc-overlay" onClick={close}>
      <div className="ntc-modal" role="dialog" aria-modal="true" aria-label="제안·신고 결과" onClick={(e) => e.stopPropagation()}>
        <div className="ntc-head">
          <h3 className="ntc-title">📬 보내주신 의견에 결과가 있어요</h3>
          <button className="ntc-x" onClick={close} aria-label="닫기">✕</button>
        </div>
        <div className="ntc-list">
          {lines.map((l) => (
            <article key={l.key} className="ntc-item">
              <div className="ntc-item-head">
                <strong className="ntc-item-title">{l.badge}</strong>
              </div>
              {l.q && <p className="ntc-content ar-pop-q">“{l.q}”</p>}
              <p className="ntc-content">{l.a}</p>
            </article>
          ))}
        </div>
        <button className="btn-add btn-block" onClick={close}>확인</button>
      </div>
    </div>
  );
}
