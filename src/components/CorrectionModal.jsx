import { useState } from 'react';
import { supabase } from '../supabase';

// 정보 수정 제안 모달 (익명). options: [{label, target, targetKey, field, placeholder, current}]
// 제출은 submit_correction RPC(SECURITY DEFINER) — 작성자 미저장.
export default function CorrectionModal({ subject, options, onClose }) {
  const [idx, setIdx] = useState(0);
  const [val, setVal] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState('');
  const opt = options[idx] || {};

  async function submit() {
    if (!val.trim() && !note.trim()) return setErr('올바른 값이나 설명 중 하나는 입력하세요.');
    setBusy(true); setErr('');
    const { error } = await supabase.rpc('submit_correction', {
      p_target: opt.target,
      p_target_key: opt.targetKey,
      p_label: subject,
      p_field: opt.field,
      p_suggested: val.trim(),
      p_note: note.trim(),
    });
    setBusy(false);
    if (error) return setErr(error.message || '제출에 실패했습니다.');
    setDone(true);
  }

  return (
    <div className="cor-overlay" onClick={onClose}>
      <div className="cor-modal" onClick={(e) => e.stopPropagation()}>
        <div className="cor-head">
          <b>🚩 정보 수정 제안</b>
          <button className="cor-x" onClick={onClose} aria-label="닫기">✕</button>
        </div>
        <p className="cor-subject">{subject}</p>

        {done ? (
          <div className="cor-done">
            <p>✅ 제안이 접수되었습니다. 관리자 검토 후 반영됩니다. 감사합니다!</p>
            <button className="btn-add btn-block" onClick={onClose}>닫기</button>
          </div>
        ) : (
          <>
            <label className="field"><span className="field-label">무엇이 잘못됐나요?</span>
              <select value={idx} onChange={(e) => { setIdx(+e.target.value); setVal(''); setErr(''); }}>
                {options.map((o, i) => <option key={i} value={i}>{o.label}</option>)}
              </select>
            </label>
            {opt.current != null && String(opt.current) !== '' && (
              <p className="cor-current">현재: <b>{String(opt.current)}</b></p>
            )}
            <label className="field"><span className="field-label">올바른 값</span>
              <input value={val} onChange={(e) => setVal(e.target.value)} placeholder={opt.placeholder || '올바른 값'} />
            </label>
            <label className="field"><span className="field-label">설명(선택)</span>
              <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="무엇이 어떻게 잘못됐는지 알려주세요." />
            </label>
            {err && <p className="error-msg">{err}</p>}
            <button className="btn-add btn-block" disabled={busy} onClick={submit}>{busy ? '제출 중…' : '제안 보내기'}</button>
            <p className="cor-hint">익명으로 접수됩니다(작성자 정보 미저장).</p>
          </>
        )}
      </div>
    </div>
  );
}
