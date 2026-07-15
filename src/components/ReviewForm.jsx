import { useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { maskText, prefetchMask } from '../lib/mask';
import { markReviewed } from '../lib/reactions';

const SCORES = [
  ['overall', '종합', true],
  ['workload', '과제량', false],
  ['progress', '진도', false],
  ['difficulty', '난이도', false],
  ['class_time', '수업시간', false],
];

function ScoreRow({ label, required, value, onChange }) {
  return (
    <div className="score-row">
      <span className="score-label">{label}{required && ' *'}</span>
      <span className="score-stars">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            type="button"
            key={n}
            className={`star ${value != null && n <= value ? 'on' : ''}`}
            aria-label={`${n}점`}
            onClick={() => onChange(value === n ? null : n)}
          >
            ★
          </button>
        ))}
      </span>
    </div>
  );
}

// 강의평 작성 폼. create_review 호출(자격 검사는 서버 RPC).
export default function ReviewForm({ courseCode, professors, defaultProf, onDone }) {
  const [prof, setProf] = useState(defaultProf || (professors[0]?.code ?? ''));
  // defaultProf·professors 는 부모(ReviewWrite)가 카탈로그를 '마운트 뒤에' 비동기로 읽어 채운다.
  // useState 초기값은 그 전(빈 값)에 한 번만 잡히므로, 뒤늦게 도착한 기본 교수를 여기서 반영한다.
  // 이게 없으면 <select>는 교수 이름을 보여주면서도 값은 '' 인 채 제출돼 professor_code=null → '교수 미정'으로 저장된다.
  const firstCode = professors[0]?.code;
  useEffect(() => {
    if (prof) return;                        // 사용자가 이미 고른 값은 건드리지 않는다
    const next = defaultProf || firstCode;
    if (next) setProf(next);                 // 도착한 기본 교수를 채택(없으면 진짜 '교수 미정' — 그대로 둔다)
  }, [defaultProf, firstCode, prof]);
  const [scores, setScores] = useState({ overall: null, workload: null, progress: null, difficulty: null, class_time: null });
  const [fail, setFail] = useState(false);
  const [teamplay, setTeamplay] = useState(false);
  const [presentation, setPresentation] = useState(false);
  const [profComment, setProfComment] = useState('');
  const [courseComment, setCourseComment] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function setScore(key, v) {
    setScores((s) => ({ ...s, [key]: v }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!scores.overall) return setError('종합 평점은 필수입니다.');
    // 교수 선택지가 있는데 값이 비어 있으면 막는다 — 비면 professor_code=null 로 '교수 미정'에 저장돼 버린다.
    if (professors.length > 0 && !prof) return setError('교수를 선택해주세요.');

    setSubmitting(true);
    const { error } = await supabase.rpc('create_review', {
      p_post_password: password,
      p_course_code: courseCode,
      p_professor_code: prof || null,
      p_overall: scores.overall,
      p_workload: scores.workload,
      p_progress: scores.progress,
      p_difficulty: scores.difficulty,
      p_class_time: scores.class_time,
      p_prof_comment: (await maskText(profComment.trim())) || null,
      p_course_comment: (await maskText(courseComment.trim())) || null,
      p_fail: fail,
      p_teamplay: teamplay,
      p_presentation: presentation,
    });
    setSubmitting(false);

    if (error) {
      setError(error.message || '작성에 실패했습니다.');
      return;
    }
    markReviewed(courseCode, prof);   // 이 과목·교수 재작성 잠금(기기 로컬 — 서버는 익명 다건)
    onDone?.();
  }

  return (
    <form className="rev-form" onSubmit={handleSubmit}>
      <label className="field rev-form-field">
        <span className="field-label">교수</span>
        <select value={prof} onChange={(e) => setProf(e.target.value)}>
          {professors.length === 0 && <option value="">교수 정보 없음</option>}
          {professors.map((p) => (
            <option key={p.code} value={p.code}>{p.name}</option>
          ))}
        </select>
      </label>

      <div className="rev-scores-block">
        <p className="score-legend">
          <span>← 부정적</span>
          <span>긍정적 →</span>
        </p>
        <div className="rev-scores">
          {SCORES.map(([key, label, required]) => (
            <ScoreRow
              key={key}
              label={label}
              required={required}
              value={scores[key]}
              onChange={(v) => setScore(key, v)}
            />
          ))}
        </div>
      </div>

      <div className="rev-checks">
        <label><input type="checkbox" checked={fail} onChange={(e) => setFail(e.target.checked)} /> 나는 과락이다.</label>
        <label><input type="checkbox" checked={teamplay} onChange={(e) => setTeamplay(e.target.checked)} /> 팀플 있음</label>
        <label><input type="checkbox" checked={presentation} onChange={(e) => setPresentation(e.target.checked)} /> 발표 있음</label>
      </div>

      <label className="field rev-form-field">
        <span className="field-label">교수 평</span>
        {/* 입력창에 손을 대면 그때 비속어 사전을 미리 받는다(제출 때 기다리지 않도록) */}
        <textarea value={profComment} onFocus={prefetchMask} onChange={(e) => setProfComment(e.target.value)} rows={2} placeholder="수업 스타일, 성적 등" />
      </label>
      <label className="field rev-form-field">
        <span className="field-label">과목 평</span>
        <textarea value={courseComment} onFocus={prefetchMask} onChange={(e) => setCourseComment(e.target.value)} rows={2} placeholder="난이도, 과제 등" />
      </label>

      <label className="field rev-form-field">
        <span className="field-label">삭제용 비밀번호 (선택)</span>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="비우면 누구나 삭제 가능" />
      </label>

      {error && <p className="error-msg">{error}</p>}

      <button type="submit" className="btn-add btn-block" disabled={submitting}>
        {submitting ? '등록 중…' : '강의평 등록'}
      </button>
    </form>
  );
}
