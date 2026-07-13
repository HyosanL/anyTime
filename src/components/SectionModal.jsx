import { useEffect, useMemo, useState } from 'react';
import '../styles/admin.css';

// 분반 편집 다이얼로그 (관리자 · 과목/분반).
// 목록 안에서 인라인으로 펼치면 다른 과목의 분반과 뒤섞여 보인다 — 한 번에 한 분반만,
// 어떤 과목의 몇 분반을 고치는지 머리말에 박아 두고 다이얼로그로 띄운다.
//
// mode: initial 이 있으면 수정, 없으면 새 분반.
//  · 수정: 연도·학기·분반번호는 PK 라 못 바꾼다(머리말에 표시만).
//  · 추가: 저장에 성공하면 그 자리에서 수정 모드로 넘어가 강의시간을 이어서 넣는다
//    (section 이 있어야 section_time 을 걸 수 있다).
const DAY_KO = { 1: '월', 2: '화', 3: '수', 4: '목', 5: '금', 6: '토', 7: '일' };
const DAYS = [1, 2, 3, 4, 5, 6, 7];

// 교수 선택 — 드롭다운은 수백 명을 스크롤해야 해서 못 쓴다. 이름·학과로 검색해 고른다.
// 비워 두면 '교수 미정'(professor_code = null).
function ProfessorPicker({ professors, value, onChange }) {
  const [q, setQ] = useState('');
  const picked = useMemo(
    () => (value ? professors.find((p) => p.code === value) : null),
    [professors, value]
  );

  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return professors
      .filter((p) => [p.name, p.department, p.code].some((v) => (v || '').toLowerCase().includes(s)))
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
      .slice(0, 20);
  }, [professors, q]);

  function pick(p) {
    onChange(p.code);
    setQ('');
  }

  if (picked) {
    return (
      <div className="adm-pp-picked">
        <span className="adm-pp-name"><b>{picked.name}</b> · {picked.department || '학과 미정'}</span>
        <button type="button" className="link-btn" onClick={() => onChange('')}>변경</button>
      </div>
    );
  }
  return (
    <div className="adm-pp">
      <input type="search" value={q} placeholder="교수 검색 (성명 · 학과)"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && results[0]) { e.preventDefault(); pick(results[0]); } }} />
      {q.trim() ? (
        <ul className="adm-pp-list">
          {results.map((p) => (
            <li key={p.code}>
              <button type="button" onClick={() => pick(p)}>
                <b>{p.name}</b> <span className="adm-pp-dept">{p.department || '학과 미정'}</span>
              </button>
            </li>
          ))}
          {results.length === 0 && (
            <li className="adm-pp-empty">검색 결과가 없습니다 — ‘교수’ 화면에서 먼저 추가하세요.</li>
          )}
        </ul>
      ) : (
        <p className="note adm-pp-hint">현재 <b>교수 미정</b> — 비워 두면 그대로 미정입니다.</p>
      )}
    </div>
  );
}

// 강의시간 한 줄 — 요일·시작·끝·강의실을 그 자리에서 고친다.
// 요일·시작교시는 PK 라, 자리를 옮기면 옛 행을 지우고 새 자리에 넣어야 한다(old 로 알려준다).
function SectionTimeRow({ t, base, act, periods }) {
  const [f, setF] = useState({
    day: t.day_of_week, start: t.start_period, end: t.end_period, room: t.room || '',
  });
  const dirty = f.day !== t.day_of_week || f.start !== t.start_period
    || f.end !== t.end_period || (f.room || '') !== (t.room || '');
  const valid = f.end >= f.start;

  const save = () => act('set_section_time', {
    ...base,
    day_of_week: f.day, start_period: f.start, end_period: f.end, room: f.room.trim() || null,
    old: { day_of_week: t.day_of_week, start_period: t.start_period },
  }, '강의시간 저장');

  const remove = () => {
    if (!confirm(`${DAY_KO[t.day_of_week]} ${t.start_period}교시 강의시간을 삭제할까요?`)) return;
    act('delete_catalog', {
      table: 'section_time',
      key: { ...base, day_of_week: t.day_of_week, start_period: t.start_period },
    }, '강의시간 삭제');
  };

  return (
    <div className={`adm-blk${dirty ? ' is-dirty' : ''}`}>
      <div className="adm-blk-time">
        <select aria-label="요일" value={f.day} onChange={(e) => setF({ ...f, day: +e.target.value })}>
          {DAYS.map((d) => <option key={d} value={d}>{DAY_KO[d]}요일</option>)}
        </select>
        <select aria-label="시작교시" value={f.start}
          onChange={(e) => {
            const start = +e.target.value;
            setF({ ...f, start, end: Math.max(start, f.end) });
          }}>
          {periods.map((p) => <option key={p} value={p}>{p}교시</option>)}
        </select>
        <span className="adm-blk-tilde">~</span>
        <select aria-label="끝교시" value={f.end} onChange={(e) => setF({ ...f, end: +e.target.value })}>
          {periods.filter((p) => p >= f.start).map((p) => <option key={p} value={p}>{p}교시</option>)}
        </select>
      </div>
      <input className="adm-blk-label" placeholder="강의실 (예: 본관 201)" value={f.room}
        onChange={(e) => setF({ ...f, room: e.target.value })} />
      <div className="adm-blk-acts">
        <button className="btn-add btn-sm" disabled={!dirty || !valid} onClick={save}>
          {dirty ? '저장' : '저장됨'}
        </button>
        <button className="btn-remove btn-sm" onClick={remove}>삭제</button>
      </div>
    </div>
  );
}

export default function SectionModal({ course, initial, cat, run, onClose, defYear, defTerm }) {
  // 저장이 끝난 분반(=강의시간을 걸 수 있는 상태). 새 분반은 저장 전까지 null.
  const [sec, setSec] = useState(initial ?? null);
  const [f, setF] = useState({
    year: initial?.year ?? defYear,
    term: initial?.term ?? defTerm,
    section_no: initial?.section_no ?? 1,
    professor_code: initial?.professor_code || '',
    capacity: initial?.capacity ?? '',
  });
  const [nt, setNt] = useState({ day: 1, start: 1, end: 1, room: '' });
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const periods = useMemo(() => {
    const ps = [...(cat.period ?? [])].map((p) => p.no).sort((a, b) => a - b);
    return ps.length ? ps : [1, 2, 3, 4, 5, 6, 7, 8];
  }, [cat]);

  // 새 분반: 그 학기에 아직 없는 분반번호를 미리 채워 준다(연도·학기를 바꾸면 다시 계산).
  useEffect(() => {
    if (sec) return;
    const used = (cat.section ?? [])
      .filter((s) => s.course_code === course.code && s.year === f.year && s.term === f.term)
      .map((s) => s.section_no);
    setF((cur) => ({ ...cur, section_no: used.length ? Math.max(...used) + 1 : 1 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sec, cat, course.code, f.year, f.term]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 결과 배너는 페이지가 아니라 이 다이얼로그 안에 띄운다(오버레이에 가려지면 못 본다).
  async function act(action, payload, okMsg) {
    setBusy(true);
    const r = await run(action, payload, okMsg);
    setBusy(false);
    setMsg(r.ok ? `✅ ${okMsg}` : `⚠️ 실패: ${r.status ?? '오류'}`);
    return r;
  }

  const base = sec && {
    course_code: course.code, year: sec.year, term: sec.term, section_no: sec.section_no,
  };
  const times = useMemo(() => (base
    ? (cat.section_time ?? [])
      .filter((t) => t.course_code === base.course_code && t.year === base.year
        && t.term === base.term && t.section_no === base.section_no)
      .sort((a, b) => a.day_of_week - b.day_of_week || a.start_period - b.start_period)
    : []), [cat, base?.course_code, base?.year, base?.term, base?.section_no]); // eslint-disable-line react-hooks/exhaustive-deps

  async function saveSection() {
    const r = await act('set_section', {
      course_code: course.code,
      year: f.year, term: f.term, section_no: f.section_no,
      professor_code: f.professor_code || null,
      capacity: f.capacity === '' ? null : +f.capacity,
    }, sec ? '분반 저장' : '분반 추가');
    // 추가에 성공하면 그대로 수정 모드로 — 강의시간을 이어서 넣을 수 있다.
    if (r.ok && !sec) setSec({ course_code: course.code, year: f.year, term: f.term, section_no: f.section_no });
  }

  const title = sec
    ? `${sec.year}-${sec.term} · ${sec.section_no}분반`
    : '새 분반';

  return (
    <div className="adm-modal-overlay" onClick={onClose} role="presentation">
      <div className="adm-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true"
        aria-label={`${course.name} ${title}`}>
        <div className="adm-modal-head">
          <div className="adm-modal-titles">
            <div className="adm-modal-title">{course.name}</div>
            <div className="adm-modal-sub">{[course.code, title].filter(Boolean).join(' · ')}</div>
          </div>
          <button className="adm-modal-x" onClick={onClose} aria-label="닫기">✕</button>
        </div>

        {msg && <p className={`admin-msg adm-modal-msg ${msg.startsWith('⚠️') ? 'is-fail' : 'is-ok'}`}>{msg}</p>}

        <div className="adm-modal-body">
          {!sec && (
            <div className="adm-form-grid">
              <label className="field"><span className="field-label">연도</span>
                <input type="number" value={f.year} onChange={(e) => setF({ ...f, year: +e.target.value })} />
              </label>
              <label className="field"><span className="field-label">학기</span>
                <select value={f.term} onChange={(e) => setF({ ...f, term: +e.target.value })}>
                  <option value={1}>1</option><option value={2}>2</option>
                </select>
              </label>
              <label className="field"><span className="field-label">분반</span>
                <input type="number" min="1" value={f.section_no}
                  onChange={(e) => setF({ ...f, section_no: +e.target.value })} />
              </label>
              <label className="field"><span className="field-label">정원</span>
                <input type="number" value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} />
              </label>
            </div>
          )}

          <div className="field">
            <span className="field-label">담당 교수</span>
            <ProfessorPicker professors={cat.professor ?? []} value={f.professor_code}
              onChange={(code) => setF({ ...f, professor_code: code })} />
          </div>

          {sec && (
            <label className="field"><span className="field-label">정원</span>
              <input type="number" value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} />
            </label>
          )}

          <button className="btn-add btn-block" disabled={busy} onClick={saveSection}>
            {sec ? '분반 저장' : '분반 추가'}
          </button>

          <div className="divider adm-divider" />
          <div className="section-label adm-sub-label">강의시간</div>

          {!sec ? (
            <p className="note">분반을 먼저 추가하면 강의시간을 넣을 수 있습니다.</p>
          ) : (
            <div className="adm-blk-list">
              {times.length === 0 && <p className="note">등록된 강의시간이 없습니다. 아래에서 추가하세요.</p>}
              {times.map((t) => (
                <SectionTimeRow key={`${t.day_of_week}-${t.start_period}`} t={t} base={base} act={act} periods={periods} />
              ))}
              <div className="adm-blk adm-blk-new">
                <div className="adm-blk-time">
                  <select aria-label="요일" value={nt.day} onChange={(e) => setNt({ ...nt, day: +e.target.value })}>
                    {DAYS.map((d) => <option key={d} value={d}>{DAY_KO[d]}요일</option>)}
                  </select>
                  <select aria-label="시작교시" value={nt.start}
                    onChange={(e) => {
                      const start = +e.target.value;
                      setNt({ ...nt, start, end: Math.max(start, nt.end) });
                    }}>
                    {periods.map((p) => <option key={p} value={p}>{p}교시</option>)}
                  </select>
                  <span className="adm-blk-tilde">~</span>
                  <select aria-label="끝교시" value={nt.end} onChange={(e) => setNt({ ...nt, end: +e.target.value })}>
                    {periods.filter((p) => p >= nt.start).map((p) => <option key={p} value={p}>{p}교시</option>)}
                  </select>
                </div>
                <input className="adm-blk-label" placeholder="강의실 (예: 본관 201)" value={nt.room}
                  onChange={(e) => setNt({ ...nt, room: e.target.value })} />
                <div className="adm-blk-acts">
                  <button className="btn-add btn-sm btn-block" disabled={busy}
                    onClick={async () => {
                      const r = await act('set_section_time', {
                        ...base, day_of_week: nt.day, start_period: nt.start, end_period: nt.end,
                        room: nt.room.trim() || null,
                      }, '강의시간 추가');
                      if (r.ok) setNt({ day: 1, start: 1, end: 1, room: '' });
                    }}>＋ 강의시간 추가</button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="adm-modal-foot">
          <button className="btn-ghost btn-block" onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>
  );
}
