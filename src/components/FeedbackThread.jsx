import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { replyToThread, markThreadSeen, threadKeyOf } from '../lib/feedback';

// 한 항목(수정제안/앱문제/신고)의 대화. item.kind ∈ 'correction'|'appReport'|'content'.
// item.thread = { messages:[{seq,who,pid,text,at}], status, outcome } | null.
// variant: 'sheet' — 부모 높이를 꽉 채우고 스크롤 영역 하나(팝업). 'inline' — 자연 높이, 상한만(페이지 아코디언).
const REPLY_REF = {
  correction: (it) => ({ correctionId: it.id }),
  appReport: (it) => ({ appReportId: it.id }),
  content: (it) => ({ contentRef: { type: it.type, id: it.id } }),
};
const CHANNEL = { correction: 'correction', appReport: 'app_report', content: 'content_report' };
const WHO_LABEL = { admin: '관리자', other: '제안자' };

function fmtTime(at) {
  const ms = typeof at === 'number' ? at : Date.parse(at);
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}월 ${d.getDate()}일`;
  return `${d.getFullYear()}. ${d.getMonth() + 1}.`;
}

// 배포 이전에 스레드 없이 처리된 건 한 줄 표시.
function legacyLine(item) {
  if (item.kind === 'correction') {
    if (item.status === 'applied') return item.autoApplied ? '여러 명이 같은 제안을 해서 자동 반영됐어요.' : '제안이 반영됐어요.';
    if (item.status === 'rejected') return item.reply ? item.reply : '검토했지만 이번엔 반영하지 않았어요.';
    if (item.status === 'resolved') return '확인 후 처리했어요.';
    return null;
  }
  if (item.kind === 'content') {
    if (item.outcome === 'removed') return '신고하신 내용이 삭제 조치됐어요.';
    if (item.outcome === 'edited') return '신고하신 내용이 수정 조치됐어요.';
    if (item.outcome === 'kept') return item.note ? `검토 결과 유지됩니다 — ${item.note}` : '검토 결과 유지됩니다.';
    return null;
  }
  if (item.kind === 'appReport') return item.reply || null;
  return null;
}

// 연속된 같은 발신자 메시지를 한 묶음(run)으로 — 라벨·시각은 묶음 단위로만 표시.
function toRuns(messages) {
  const runs = [];
  for (const m of messages) {
    const last = runs[runs.length - 1];
    if (last && last.who === m.who && last.pid === m.pid) last.msgs.push(m);
    else runs.push({ who: m.who, pid: m.pid, msgs: [m] });
  }
  return runs;
}

export default function FeedbackThread({ item, onReplied, variant = 'inline' }) {
  const t = item.thread;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [pending, setPending] = useState([]); // 방금 보낸 내 메시지(서버 반영 전 낙관적 표시)
  const scrollRef = useRef(null);
  const taRef = useRef(null);

  const serverMsgs = t?.messages ?? [];
  const lastServerSeq = serverMsgs[serverMsgs.length - 1]?.seq ?? 0;
  // 서버 메시지가 늘어나면(재조회 반영) 낙관적 목록을 비운다.
  useEffect(() => { setPending([]); }, [serverMsgs.length]);

  // 재조회가 내 메시지를 이미 담아 왔으면 낙관적 항목은 숨긴다(한 프레임 중복 방지).
  const msgs = [...serverMsgs, ...pending.filter((p) => p.seq > lastServerSeq)];

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs.length, item]);

  useEffect(() => {
    if (msgs.length) markThreadSeen(threadKeyOf(item), msgs[msgs.length - 1].seq ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item, serverMsgs.length]);

  function grow(e) {
    setText(e.target.value);
    const ta = taRef.current;
    if (ta) { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`; }
  }

  async function send() {
    const v = text.trim();
    if (!v || busy) return;
    setBusy(true); setErr('');
    const r = await replyToThread(CHANNEL[item.kind], REPLY_REF[item.kind](item), v);
    setBusy(false);
    if (!r.ok) { setErr(r.status === 'FULL' ? '대화가 가득 찼어요.' : '전송에 실패했어요. 잠시 후 다시 시도해 주세요.'); return; }
    setPending((p) => [...p, { seq: (msgs[msgs.length - 1]?.seq ?? 0) + 1, who: 'me', text: v, at: Date.now() }]);
    setText('');
    if (taRef.current) taRef.current.style.height = 'auto';
    onReplied?.();
  }

  if (!t) {
    const legacy = legacyLine(item);
    return (
      <div className={`fbt fbt-${variant}`}>
        <div className="fbt-scroll" ref={scrollRef}>
          <p className="fbt-note">{legacy || '검토 대기 중이에요. 관리자가 확인하면 여기에 표시됩니다.'}</p>
        </div>
      </div>
    );
  }

  const runs = toRuns(msgs);
  const canReply = t.status !== 'closed';   // 종료(closed) 전까진 제출자도 언제든 보낼 수 있다
  const waiting = t.status === 'answered';  // 내가 마지막으로 보냄 — 관리자 답변 대기 중

  return (
    <div className={`fbt fbt-${variant}`}>
      <div className="fbt-scroll" ref={scrollRef}>
        {runs.map((run, i) => {
          const last = run.msgs[run.msgs.length - 1];
          return (
            <div key={run.msgs[0].seq ?? i} className={`fbt-run fbt-run-${run.who}`}>
              {run.who !== 'me' && (
                <span className="fbt-name">{run.who === 'other' ? `제안자 ${run.pid}` : WHO_LABEL[run.who]}</span>
              )}
              {run.msgs.map((m) => (
                <p key={m.seq} className="fbt-bubble">{m.text}</p>
              ))}
              <span className="fbt-time">{fmtTime(last.at)}</span>
            </div>
          );
        })}
      </div>

      {canReply ? (
        <form className="fbt-bar" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <textarea
            ref={taRef}
            className="fbt-input"
            rows={1}
            value={text}
            maxLength={1000}
            placeholder={waiting ? '관리자 답변 대기 중 · 더 남길 수 있어요' : '답장 쓰기…'}
            onChange={grow}
          />
          <button type="submit" className="fbt-send" disabled={busy || !text.trim()} aria-label="보내기">↑</button>
        </form>
      ) : (
        <p className="fbt-foot">처리 완료된 대화예요</p>
      )}
      {err && <p className="fbt-err">{err}</p>}
    </div>
  );
}
