import { useMemo, useState } from 'react';

// 분반 한 개(교수 지정 + 강의시간 추가/삭제)를 그 자리에서 고치는 카드. 두 화면이 함께 쓴다:
//  - AdminCourse.jsx(/admin/courses/:code) — 과목 하나의 분반 목록.
//  - Admin.jsx 의 "빈 정보 분반" — 여러 과목에 걸친 미완성 분반을 한 화면에 모아보기.
// 두 화면이 서로 다른 라우트라 각자 페이지 코드를 정적 import 하면 번들이 서로 새어들어가므로
// (syllabusPlan.js 의 같은 이유), 공용 로직만 이 파일 하나로 뽑아 둔다.
export const DAY_KO = { 1: '월', 2: '화', 3: '수', 4: '목', 5: '금', 6: '토', 7: '일' };
const DAYS = [1, 2, 3, 4, 5, 6, 7];

// 교수 선택 — 드롭다운은 수백 명을 굴려야 한다. 이름·학과·코드로 검색해 고른다.
// 비워 두면 '교수 미정'(professorCode = null).
export function ProfessorPicker({ professors, value, onChange }) {
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

  const pick = (p) => { onChange(p.code); setQ(''); };

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
function SectionTimeRow({ t, base, run, periods }) {
  const [f, setF] = useState({
    day: t.dayOfWeek, start: t.startPeriod, end: t.endPeriod, room: t.room || '',
  });
  const dirty = f.day !== t.dayOfWeek || f.start !== t.startPeriod
    || f.end !== t.endPeriod || (f.room || '') !== (t.room || '');
  const valid = f.end >= f.start;

  const save = () => run('set_section_time', {
    ...base,
    dayOfWeek: f.day, startPeriod: f.start, endPeriod: f.end, room: f.room.trim() || null,
    old: { dayOfWeek: t.dayOfWeek, startPeriod: t.startPeriod },
  }, '강의시간 저장');

  const remove = () => {
    if (!confirm(`${DAY_KO[t.dayOfWeek]} ${t.startPeriod}교시 강의시간을 삭제할까요?`)) return;
    run('delete_catalog', {
      table: 'sectionTime',
      key: { ...base, dayOfWeek: t.dayOfWeek, startPeriod: t.startPeriod },
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

// 분반 한 개 — 접힌 상태에서는 요약 한 줄, 펼치면 교수·강의시간을 그 자리에서 고친다.
// courseName 은 여러 과목을 한 화면에 모아 보여줄 때만 넘긴다(단일 과목 화면에선 페이지
// 제목이 이미 과목명이라 생략).
export function SectionCard({ s, times, professors, periods, run, open, onToggle, courseName }) {
  const [profCode, setProfCode] = useState(s.professorCode || '');
  const [nt, setNt] = useState({ day: 1, start: 1, end: 1, room: '' });
  const base = { courseCode: s.courseCode, year: s.year, term: s.term, sectionNo: s.sectionNo };
  const prof = professors.find((p) => p.code === s.professorCode);
  const dirty = profCode !== (s.professorCode || '');
  const when = times
    .map((t) => (t.startPeriod === t.endPeriod
      ? `${DAY_KO[t.dayOfWeek]}${t.startPeriod}`
      : `${DAY_KO[t.dayOfWeek]}${t.startPeriod}-${t.endPeriod}`))
    .join(', ');

  const remove = () => {
    if (!confirm(`${s.year}-${s.term} ${s.sectionNo}분반과 그 강의시간을 삭제합니다.`)) return;
    run('delete_catalog', { table: 'section', key: base }, `${s.sectionNo}분반 삭제`);
  };

  return (
    <div className={`adm-sec-card${open ? ' open' : ''}`}>
      <div className="adm-sec-head">
        <button type="button" className="adm-sec-lead" onClick={onToggle} aria-expanded={open}>
          <span className="adm-sec-no">{courseName ? `${courseName} · ` : ''}{s.sectionNo}분반</span>
          <span className="adm-sec-meta">
            {s.year}-{s.term} · {prof?.name || '교수미정'} · {when || '시간미정'}
          </span>
          <span className="adm-sec-chevron">{open ? '⌃' : '⌄'}</span>
        </button>
        <button className="rev-del-btn" onClick={remove}>삭제</button>
      </div>

      {open && (
        <div className="adm-sec-body">
          <div className="field">
            <span className="field-label">담당 교수</span>
            <ProfessorPicker professors={professors} value={profCode} onChange={setProfCode} />
          </div>
          <button className="btn-add btn-block btn-sm" disabled={!dirty}
            onClick={() => run('set_section', { ...base, professorCode: profCode || null }, `${s.sectionNo}분반 저장`)}>
            {dirty ? '담당 교수 저장' : '저장됨'}
          </button>

          <div className="section-label adm-sub-label">강의시간</div>
          <div className="adm-blk-list">
            {times.length === 0 && <p className="note">등록된 강의시간이 없습니다. 아래에서 추가하세요.</p>}
            {times.map((t) => (
              <SectionTimeRow key={`${t.dayOfWeek}-${t.startPeriod}`} t={t} base={base} run={run} periods={periods} />
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
                <button className="btn-add btn-sm btn-block"
                  onClick={async () => {
                    const r = await run('set_section_time', {
                      ...base, dayOfWeek: nt.day, startPeriod: nt.start, endPeriod: nt.end,
                      room: nt.room.trim() || null,
                    }, '강의시간 추가');
                    if (r.ok) setNt({ day: 1, start: 1, end: 1, room: '' });
                  }}>＋ 강의시간 추가</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
