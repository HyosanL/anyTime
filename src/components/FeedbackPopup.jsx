import { useEffect, useState } from 'react';
import { fetchFeedback, readSeen, markSeen, readThreadSeen, markThreadSeen, threadKeyOf } from '../lib/feedback';
import FeedbackThread from './FeedbackThread';

// 앱 접속 시, 안 본 관리자 메시지·결과를 공지처럼 한 번 띄운다. ntc-* 클래스는 home.css(전역).

function hasNewAdmin(item, seenT) {
  const t = item.thread;
  if (!t) return false;
  const lastAdmin = [...t.messages].reverse().find((m) => m.who === 'admin');
  return lastAdmin && lastAdmin.seq > (seenT[threadKeyOf(item)] ?? 0);
}

export default function FeedbackPopup() {
  const [items, setItems] = useState([]);

  const load = () => fetchFeedback().then((f) => {
    const seen = new Set(readSeen());
    const seenT = readThreadSeen();
    const all = [
      ...(f.corrections || []).map((c) => ({ ...c, kind: 'correction', title: c.summary || c.label || '수정 제안' })),
      ...(f.contentReports || []).map((c) => ({ ...c, kind: 'content', title: '신고' })),
      ...(f.appReports || []).map((a) => ({ ...a, kind: 'appReport', title: a.summary || a.text || '앱 문제' })),
    ].filter((item) => {
      if (hasNewAdmin(item, seenT)) return true;
      // 스레드 없는 옛 경로: 결과를 아직 안 봤을 때
      const key = threadKeyOf(item);
      if (item.kind === 'correction' && !item.thread && ['applied', 'rejected', 'resolved'].includes(item.status)) return !seen.has(key);
      if (item.kind === 'content' && !item.thread && item.outcome) return !seen.has(key);
      return false;
    });
    setItems(all);
  }).catch(() => {});

  useEffect(() => { load(); }, []);

  if (items.length === 0) return null;

  function close() {
    for (const item of items) {
      const key = threadKeyOf(item);
      markSeen([key]);
      if (item.thread?.messages?.length) markThreadSeen(key, item.thread.messages[item.thread.messages.length - 1].seq);
    }
    setItems([]);
  }

  return (
    <div className="ntc-overlay" onClick={close}>
      <div className="ntc-modal" role="dialog" aria-modal="true" aria-label="피드백" onClick={(e) => e.stopPropagation()}>
        <div className="ntc-head">
          <h3 className="ntc-title">📬 보내주신 의견에 새 소식이 있어요</h3>
          <button className="ntc-x" onClick={close} aria-label="닫기">✕</button>
        </div>
        <div className="ntc-list">
          {items.map((item) => (
            <article key={threadKeyOf(item)} className="ntc-item">
              <div className="ntc-item-head"><strong className="ntc-item-title">{item.title}</strong></div>
              {item.thread
                ? <FeedbackThread item={item} onReplied={load} />
                : <p className="ntc-content">{legacyLine(item)}</p>}
            </article>
          ))}
        </div>
        <button className="btn-add btn-block" onClick={close}>확인</button>
      </div>
    </div>
  );
}

function legacyLine(item) {
  if (item.kind === 'correction') {
    return item.status === 'applied' && item.autoApplied ? '📌 여러 명이 같은 제안을 해서 자동 반영됐어요.'
      : item.status === 'applied' ? '✅ 제안이 반영됐어요.'
      : item.status === 'rejected' ? '🔎 검토했지만 이번엔 반영하지 않았어요.'
      : '✅ 확인 후 처리했어요.';
  }
  if (item.kind === 'content') {
    return item.outcome === 'removed' ? '🗑️ 신고하신 내용이 삭제 조치됐어요.'
      : item.outcome === 'edited' ? '✏️ 신고하신 내용이 수정 조치됐어요.'
      : (item.note ? `검토 결과 유지됩니다: ${item.note}` : '검토 결과 유지됩니다.');
  }
  return item.reply || '답변이 등록됐어요.';
}
