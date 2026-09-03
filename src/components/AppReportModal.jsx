import { useState } from 'react';
import { callFn } from '../lib/functions';
import { isStandalone } from './InstallGate';
import '../styles/correction.css';

// 앱 문제 리포트 — 정보 수정 제안(CorrectionModal, 강의 데이터 오류용)과는 별개 채널.
// 앱 자체의 버그·오류를 익명으로 접수한다. 진단 정보(경로·기기환경)는 자동 첨부되고
// 사용자가 편집하지 않는다(제출 시점에 채워 넣을 뿐).
export default function AppReportModal({ onClose }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    const t = text.trim();
    if (t.length < 5) return setErr('무엇이 문제였는지 5자 이상 적어주세요.');
    setBusy(true); setErr('');
    const r = await callFn('submitAppReport', {
      text: t,
      path: location.pathname,
      ua: navigator.userAgent,
      standalone: isStandalone(),
    });
    setBusy(false);
    if (!r.ok) return setErr(r.message || '제출에 실패했습니다.');
    setDone(true);
  }

  return (
    <div className="cor-overlay" onClick={onClose}>
      <div className="cor-modal" onClick={(e) => e.stopPropagation()}>
        <div className="cor-head">
          <b>🚩 앱 문제 리포트</b>
          <button className="cor-x" onClick={onClose} aria-label="닫기">✕</button>
        </div>

        {done ? (
          <div className="cor-done">
            <p>✅ 접수되었습니다. 검토 후 반영됩니다. 감사합니다!</p>
            <button className="btn-add btn-block" onClick={onClose}>닫기</button>
          </div>
        ) : (
          <>
            <label className="field"><span className="field-label">무엇이 문제였나요?</span>
              <textarea
                rows={4}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="예: 시간표에 강의를 추가했는데 저장이 안 돼요."
                maxLength={500}
              />
            </label>
            {err && <p className="error-msg">{err}</p>}
            <button className="btn-add btn-block" disabled={busy} onClick={submit}>{busy ? '제출 중…' : '제출하기'}</button>
            <p className="cor-hint">익명으로 접수됩니다(작성자 정보 미저장). 진단 정보(현재 화면 경로·기기환경)가 함께 전송돼요.</p>
          </>
        )}
      </div>
    </div>
  );
}
