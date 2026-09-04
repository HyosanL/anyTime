import { useEffect, useRef, useState } from 'react';
import { fetchFeedback, readSeen, markSeen, readThreadSeen, markThreadSeen, threadKeyOf } from '../lib/feedback';
import FeedbackThread from './FeedbackThread';
import '../styles/feedback.css';

// 홈 진입 시, 안 본 관리자 메시지·결과가 있으면 대화 시트로 띄운다.
// 한 번 열리면 그 세션 동안 항목 목록은 고정 — 답장해도 사라지거나 재배치되지 않는다.

const KIND_TITLE = {
  correction: '수정 제안', content: '신고', appReport: '앱 문제',
};

function hasNewAdmin(item, seenT) {
  const t = item.thread;
  if (!t) return false;
  const lastAdmin = [...t.messages].reverse().find((m) => m.who === 'admin');
  return lastAdmin && lastAdmin.seq > (seenT[threadKeyOf(item)] ?? 0);
}

function toItems(f) {
  return [
    ...(f.corrections || []).map((c) => ({ ...c, kind: 'correction', title: c.summary || c.label || '수정 제안' })),
    ...(f.contentReports || []).map((c) => ({ ...c, kind: 'content', title: c.type === 'board_post' ? '게시글 신고' : c.type === 'review' ? '강의평 신고' : '메모 신고' })),
    ...(f.appReports || []).map((a) => ({ ...a, kind: 'appReport', title: a.summary || a.text || '앱 문제' })),
  ];
}

function preview(item) {
  const last = item.thread?.messages?.[item.thread.messages.length - 1];
  if (last) return `${last.who === 'me' ? '나' : last.who === 'admin' ? '관리자' : '제안자'}: ${last.text}`;
  if (item.kind === 'correction' && item.status === 'applied') return '제안이 반영됐어요';
  if (item.kind === 'correction' && item.status === 'rejected') return item.reply || '이번엔 반영하지 않았어요';
  if (item.kind === 'content' && item.outcome) return { removed: '삭제 조치했어요', edited: '수정 조치했어요', kept: '검토 결과 유지돼요' }[item.outcome];
  if (item.kind === 'appReport' && item.reply) return item.reply;
  return '';
}

export default function FeedbackPopup() {
  const [items, setItems] = useState(null); // null = 아직 안 뜸, [] = 뜰 것 없음
  const [sel, setSel] = useState(null); // 선택된 threadKey (목록에서 고른 것)
  const started = useRef(false);

  // 최초 1회: 안 본 소식이 있으면 그 항목들로 고정.
  useEffect(() => {
    fetchFeedback().then((f) => {
      const seen = new Set(readSeen());
      const seenT = readThreadSeen();
      const news = toItems(f).filter((item) => {
        if (hasNewAdmin(item, seenT)) return true;
        if (item.thread) return false;
        const key = threadKeyOf(item);
        if (item.kind === 'correction') return ['applied', 'rejected', 'resolved'].includes(item.status) && !seen.has(key);
        if (item.kind === 'content') return !!item.outcome && !seen.has(key);
        if (item.kind === 'appReport') return !!item.reply && !seen.has(key);
        return false;
      });
      started.current = news.length > 0;
      setItems(news);
      if (news.length === 1) setSel(threadKeyOf(news[0]));
    }).catch(() => setItems([]));
  }, []);

  // 답장 후: 목록·선택은 그대로 두고 각 항목의 thread 데이터만 새로 반영(재조회).
  function refresh() {
    fetchFeedback().then((f) => {
      const fresh = new Map(toItems(f).map((it) => [threadKeyOf(it), it]));
      setItems((prev) => (prev || []).map((it) => {
        const n = fresh.get(threadKeyOf(it));
        return n ? { ...it, thread: n.thread, status: n.status, outcome: n.outcome, reply: n.reply, note: n.note } : it;
      }));
    }).catch(() => {});
  }

  function close() {
    for (const item of items || []) {
      const key = threadKeyOf(item);
      markSeen([key]);
      const msgs = item.thread?.messages;
      if (msgs?.length) markThreadSeen(key, msgs[msgs.length - 1].seq);
    }
    setItems([]);
  }

  if (!items || items.length === 0) return null;

  const single = items.length === 1;
  const active = single ? items[0] : items.find((it) => threadKeyOf(it) === sel);

  return (
    <div className="fbp-overlay" onClick={close}>
      <div className="fbp-sheet" role="dialog" aria-modal="true" aria-label="피드백 대화" onClick={(e) => e.stopPropagation()}>
        <header className="fbp-head">
          {active && !single
            ? <button className="fbp-back" onClick={() => setSel(null)} aria-label="목록으로">‹</button>
            : <span className="fbp-head-icon" aria-hidden="true">📬</span>}
          <h2 className="fbp-title">{active ? active.title : `새 소식 ${items.length}건`}</h2>
          <button className="fbp-close" onClick={close} aria-label="닫기">✕</button>
        </header>

        {active ? (
          <FeedbackThread key={threadKeyOf(active)} item={active} onReplied={refresh} variant="sheet" />
        ) : (
          <ul className="fbp-list">
            {items.map((item) => {
              const key = threadKeyOf(item);
              const unread = hasNewAdmin(item, readThreadSeen());
              return (
                <li key={key}>
                  <button className="fbp-row" onClick={() => setSel(key)}>
                    <span className="fbp-row-top">
                      <span className="fbp-row-kind">{KIND_TITLE[item.kind]}</span>
                      <span className="fbp-row-name">{item.title}</span>
                      {unread && <span className="fbp-row-dot" aria-label="안 읽음" />}
                    </span>
                    <span className="fbp-row-prev">{preview(item)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
