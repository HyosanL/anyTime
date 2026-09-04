import { useEffect, useRef, useState } from 'react';
import { replyToThread, markThreadSeen, threadKeyOf } from '../lib/feedback';

// 한 항목(수정제안/앱문제/신고)의 대화. item.kind ∈ 'correction'|'appReport'|'content'.
// item.thread = { messages:[{seq,who,pid,text,at}], status, outcome } | null.
const REPLY_REF = {
  correction: (it) => ({ correctionId: it.id }),
  appReport: (it) => ({ appReportId: it.id }),
  content: (it) => ({ contentRef: { type: it.type, id: it.id } }),
};
const CHANNEL = { correction: 'correction', appReport: 'app_report', content: 'content_report' };

function fmtAt(at) {
  const ms = typeof at === 'number' ? at : Date.parse(at);
  return ms ? new Date(ms).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
}

// 스레드 없는 옛 경로(배포 이전에 처리된 건) 한 줄 표시.
function legacyLine(item) {
  if (item.kind === 'correction') {
    if (item.status === 'applied') return item.autoApplied ? '📌 여러 명이 같은 제안을 해서 자동 반영됐어요.' : '✅ 제안이 반영됐어요.';
    if (item.status === 'rejected') return item.reply ? `🔎 ${item.reply}` : '🔎 검토했지만 이번엔 반영하지 않았어요.';
    if (item.status === 'resolved') return '✅ 확인 후 처리했어요.';
    return null;
  }
  if (item.kind === 'content') {
    if (item.outcome === 'removed') return '🗑️ 신고하신 내용이 삭제 조치됐어요.';
    if (item.outcome === 'edited') return '✏️ 신고하신 내용이 수정 조치됐어요.';
    if (item.outcome === 'kept') return item.note ? `검토 결과 유지됩니다: ${item.note}` : '검토 결과 유지됩니다.';
    return null;
  }
  if (item.kind === 'appReport') return item.reply || null;
  return null;
}

export default function FeedbackThread({ item, onReplied }) {
  const t = item.thread;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const endRef = useRef(null);

  useEffect(() => {
    if (t && t.messages.length) markThreadSeen(threadKeyOf(item), t.messages[t.messages.length - 1].seq);
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [item, t]);

  if (!t) {
    const legacy = legacyLine(item);
    return <p className="fb-thread-empty">{legacy || '검토 대기 중이에요. 관리자가 확인하면 여기에 표시됩니다.'}</p>;
  }

  async function send() {
    const v = text.trim();
    if (!v) return;
    setBusy(true); setErr('');
    const r = await replyToThread(CHANNEL[item.kind], REPLY_REF[item.kind](item), v);
    setBusy(false);
    if (!r.ok) { setErr(r.status === 'FULL' ? '대화가 가득 찼어요.' : '전송에 실패했어요.'); return; }
    setText('');
    onReplied?.();
  }

  return (
    <div className="fb-thread">
      <ul className="fb-msgs">
        {t.messages.map((m) => (
          <li key={m.seq} className={`fb-msg fb-msg-${m.who}`}>
            <span className="fb-msg-who">{m.who === 'admin' ? '관리자' : m.who === 'me' ? '나' : `제안자 ${m.pid}`}</span>
            <p className="fb-msg-text">{m.text}</p>
            <span className="fb-msg-at">{fmtAt(m.at)}</span>
          </li>
        ))}
        <li ref={endRef} />
      </ul>
      {t.status === 'open' ? (
        <div className="fb-reply">
          <textarea rows={2} value={text} maxLength={1000} placeholder="답장 입력…"
            onChange={(e) => setText(e.target.value)} />
          <button className="btn-add btn-sm" disabled={busy || !text.trim()} onClick={send}>보내기</button>
        </div>
      ) : (
        <p className="fb-thread-status">{t.status === 'closed' ? '처리 완료' : '관리자 확인 중'}</p>
      )}
      {err && <p className="error-msg">{err}</p>}
    </div>
  );
}
