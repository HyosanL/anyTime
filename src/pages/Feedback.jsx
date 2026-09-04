import { useCallback, useEffect, useState } from 'react';
import BackButton from '../components/BackButton';
import AppReportModal from '../components/AppReportModal';
import FeedbackThread from '../components/FeedbackThread';
import { fetchFeedback, readThreadSeen, threadKeyOf } from '../lib/feedback';
import '../styles/feedback.css';

const CH_ICON = { correction: '🚩', appReport: '🐞', content: '🚨' };
const OUTCOME_LABEL = {
  applied: '반영됨', rejected: '반려', resolved: '처리됨',
  removed: '삭제 조치', kept: '유지', edited: '수정 조치',
  reviewing: '검토중', planned: '반영예정', done: '완료',
};

function statusBadge(item) {
  const t = item.thread;
  if (t?.status === 'open') return '답장 필요';
  if (t?.outcome) return OUTCOME_LABEL[t.outcome] || '완료';
  if (t?.status === 'answered') return '관리자 확인 중';
  if (t?.status === 'closed') return '완료';
  if (item.kind === 'correction' && ['applied', 'rejected', 'resolved'].includes(item.status)) return OUTCOME_LABEL[item.status];
  if (item.kind === 'content' && item.outcome) return OUTCOME_LABEL[item.outcome];
  if (item.kind === 'appReport' && item.reply) return OUTCOME_LABEL[item.replyStatus] || '답변';
  return '검토 대기';
}
// 접힌 행 요약 한 줄.
function rowSummary(item) {
  if (item.thread) return `대화 ${item.thread.messages.length}개`;
  if (item.kind === 'correction' && ['applied', 'rejected', 'resolved'].includes(item.status)) return '처리 완료 · 눌러서 보기';
  if (item.kind === 'content' && item.outcome) return '처리 완료 · 눌러서 보기';
  if (item.kind === 'appReport' && item.reply) return '답변 도착 · 눌러서 보기';
  return '검토 대기 중';
}

export default function Feedback() {
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(null);   // threadKey
  const [modal, setModal] = useState(false);

  const load = useCallback(async () => {
    const f = await fetchFeedback().catch(() => null);
    if (!f) return;
    const all = [
      ...(f.corrections || []).map((c) => ({ ...c, kind: 'correction', title: c.summary || c.label || '수정 제안', at: c.repliedAt || 0 })),
      ...(f.contentReports || []).map((c) => ({ ...c, kind: 'content', title: `신고 · ${c.type === 'board_post' ? '게시글' : c.type === 'review' ? '강의평' : '메모'}`, at: 0 })),
      ...(f.appReports || []).map((a) => ({ ...a, kind: 'appReport', title: a.summary || a.text || '앱 문제', at: 0 })),
    ];
    setRows(all);
  }, []);

  useEffect(() => { load(); }, [load]);

  const seenT = readThreadSeen();
  const hasUnread = (item) => {
    const t = item.thread;
    if (!t) return false;
    const lastAdmin = [...t.messages].reverse().find((m) => m.who === 'admin');
    return lastAdmin && lastAdmin.seq > (seenT[threadKeyOf(item)] ?? 0);
  };

  return (
    <div className="page fb-page">
      <header className="page-header"><BackButton /><h2>내 피드백</h2></header>
      <button className="btn-add fb-new-btn" onClick={() => setModal(true)}>🐞 앱 문제 신고</button>

      {rows.length === 0 && <p className="fb-thread-empty">보낸 제안·신고가 없어요.</p>}
      <ul className="fb-list">
        {rows.map((item) => {
          const key = threadKeyOf(item);
          const isOpen = open === key;
          return (
            <li key={key} className="fb-row" onClick={() => setOpen(isOpen ? null : key)}>
              <div className="fb-row-head">
                <span>{CH_ICON[item.kind]}</span>
                <span className="fb-row-title">{item.title}</span>
                <span className="fb-row-badge">{statusBadge(item)}</span>
                {hasUnread(item) && <span className="fb-row-dot" />}
              </div>
              {!isOpen && <p className="fb-row-sum">{rowSummary(item)}</p>}
              {isOpen && <div onClick={(e) => e.stopPropagation()}><FeedbackThread item={item} onReplied={load} /></div>}
            </li>
          );
        })}
      </ul>

      {modal && <AppReportModal onClose={() => { setModal(false); load(); }} />}
    </div>
  );
}
