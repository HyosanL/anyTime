import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuthContext } from '../contexts/AuthContext';
import BackButton from '../components/BackButton';
import { getCatalog, currentSemester, semesterList, buildMyTimetable } from '../lib/cache';
import { listTimetables, listEntries } from '../lib/timetable';
import {
  GRADE_ORDER, listGrades, addGrade, addGrades, updateGrade, deleteGrade,
  gpaOf, groupBySemester, cumulativeGpa, trendPoints,
} from '../lib/grades';
import {
  computeCourse, isWarn, sortCourses, round1,
  loadState, saveState, makeCourse, mergeCourses,
} from '../lib/failscore';
import '../styles/calc.css';

// 한 학기의 확정(없으면 최신) 시간표에 담긴 과목명을 뽑아 온다 — 두 계산기의 '시간표에서 불러오기' 공용.
async function timetableCourseNames(catalog, year, term) {
  const list = await listTimetables();
  const tt = list
    .filter((t) => t.year === year && t.term === term)
    .sort((a, b) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0) || new Date(b.created_at) - new Date(a.created_at))[0];
  if (!tt) return [];
  const entries = await listEntries(tt.id);
  const { mine } = buildMyTimetable(catalog, entries, { year, term });
  return mine.map((s) => s.course_name);
}

// =====================================================================
//  학점계산기 탭 — 서버(grade_entry) 저장, 학기별 평점·누적·추이
// =====================================================================
function GpaTab({ catalog, uid }) {
  const [rows, setRows] = useState(null);       // null = 로딩 전
  const [sem, setSem] = useState(null);          // { year, term }
  const [err, setErr] = useState('');
  const [seeding, setSeeding] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const data = await listGrades();
        if (!active) return;
        setRows(data);
      } catch {
        if (active) { setRows([]); setErr('성적을 불러오지 못했어요. 잠시 후 다시 시도하세요.'); }
      }
    })();
    return () => { active = false; };
  }, []);

  // 학기 후보: 편람 학기 ∪ 내 성적행의 학기.
  const semesters = useMemo(() => {
    const map = new Map();
    for (const s of (catalog ? semesterList(catalog) : [])) map.set(`${s.year}-${s.term}`, { year: s.year, term: s.term });
    for (const r of (rows ?? [])) map.set(`${r.year}-${r.term}`, { year: r.year, term: r.term });
    return [...map.values()].sort((a, b) => b.year - a.year || b.term - a.term);
  }, [catalog, rows]);

  // 기본 선택 학기: 현재 학기 → 없으면 가장 최근 후보.
  useEffect(() => {
    if (sem || !semesters.length) return;
    const cur = catalog ? currentSemester(catalog) : null;
    const pick = (cur && semesters.find((s) => s.year === cur.year && s.term === cur.term)) || semesters[0];
    setSem(pick);
  }, [sem, semesters, catalog]);

  const semRows = useMemo(
    () => (rows ?? []).filter((r) => sem && r.year === sem.year && r.term === sem.term),
    [rows, sem]
  );
  const semStat = useMemo(() => gpaOf(semRows), [semRows]);
  const cumStat = useMemo(() => cumulativeGpa(rows ?? []), [rows]);
  const points = useMemo(() => trendPoints(groupBySemester(rows ?? [])), [rows]);

  // 로컬 낙관 갱신 + 서버 반영. 실패하면 한 번 알린다(값은 유지 — 재시도는 사용자 몫).
  const patchRow = useCallback((id, patch) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    updateGrade(id, patch).catch(() => setErr('저장에 실패했어요. 네트워크를 확인하세요.'));
  }, []);

  const handleAddRow = useCallback(async () => {
    if (!sem) return;
    setErr('');
    const order = (semRows.reduce((m, r) => Math.max(m, r.sort_order ?? 0), 0)) + 1;
    try {
      const made = await addGrade(uid, { year: sem.year, term: sem.term, course_name: '새 과목', credit: null, grade: null, sort_order: order });
      setRows((prev) => [...(prev ?? []), made]);
    } catch {
      setErr('과목 추가에 실패했어요.');
    }
  }, [sem, semRows, uid]);

  const handleSeed = useCallback(async () => {
    if (!sem || !catalog) return;
    setErr('');
    setSeeding(true);
    try {
      const names = await timetableCourseNames(catalog, sem.year, sem.term);
      const have = new Set(semRows.map((r) => r.course_name.trim()));
      const fresh = names.filter((n) => n && !have.has(n.trim()));
      if (!fresh.length) { setErr('시간표에서 새로 가져올 과목이 없어요.'); setSeeding(false); return; }
      let order = semRows.reduce((m, r) => Math.max(m, r.sort_order ?? 0), 0);
      const made = await addGrades(uid, fresh.map((n) => ({ year: sem.year, term: sem.term, course_name: n, credit: null, grade: null, sort_order: ++order })));
      setRows((prev) => [...(prev ?? []), ...made]);
    } catch {
      setErr('시간표에서 불러오지 못했어요.');
    }
    setSeeding(false);
  }, [sem, catalog, semRows, uid]);

  const handleDelete = useCallback((id) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
    deleteGrade(id).catch(() => setErr('삭제에 실패했어요.'));
  }, []);

  if (rows === null) return <p className="center">불러오는 중…</p>;

  return (
    <div className="calc-body">
      <div className="calc-sem-row">
        <label className="calc-sem-label">학기</label>
        <select
          className="calc-sem-select"
          value={sem ? `${sem.year}-${sem.term}` : ''}
          onChange={(e) => {
            const [y, t] = e.target.value.split('-').map(Number);
            setSem({ year: y, term: t });
          }}
        >
          {semesters.length === 0 && <option value="">학기 없음</option>}
          {semesters.map((s) => (
            <option key={`${s.year}-${s.term}`} value={`${s.year}-${s.term}`}>{s.year}년 {s.term}학기</option>
          ))}
        </select>
      </div>

      {err && <p className="error-msg calc-err">{err}</p>}

      {sem ? (
        <>
          <div className="gpa-rows">
            <div className="gpa-row gpa-row-head">
              <span className="gpa-c-name">과목</span>
              <span className="gpa-c-credit">학점</span>
              <span className="gpa-c-grade">성적</span>
              <span className="gpa-c-del" />
            </div>
            {semRows.length === 0 && <p className="muted calc-hint">아래 버튼으로 과목을 추가하거나 시간표에서 불러오세요.</p>}
            {semRows.map((r) => (
              <div className="gpa-row" key={r.id}>
                <input
                  className="gpa-c-name"
                  defaultValue={r.course_name}
                  maxLength={60}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== r.course_name) patchRow(r.id, { course_name: v });
                    else if (!v) e.target.value = r.course_name;
                  }}
                />
                <input
                  className="gpa-c-credit"
                  type="number" inputMode="decimal" step="0.1" min="0" max="30"
                  placeholder="—"
                  defaultValue={r.credit ?? ''}
                  onBlur={(e) => {
                    const raw = e.target.value;
                    const val = raw === '' ? null : Math.min(30, Math.max(0, round1(Number(raw))));
                    e.target.value = val ?? '';
                    if ((val ?? null) !== (r.credit ?? null)) patchRow(r.id, { credit: val });
                  }}
                />
                <select
                  className="gpa-c-grade"
                  value={r.grade ?? ''}
                  onChange={(e) => patchRow(r.id, { grade: e.target.value || null })}
                >
                  <option value="">—</option>
                  {GRADE_ORDER.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
                <button className="gpa-c-del icon-btn" aria-label="삭제" onClick={() => handleDelete(r.id)}>🗑️</button>
              </div>
            ))}
          </div>

          <div className="calc-actions">
            <button className="btn-add btn-sm" onClick={handleAddRow}>＋ 과목 추가</button>
            <button className="btn-ghost btn-sm" onClick={handleSeed} disabled={seeding || !catalog}>
              {seeding ? '불러오는 중…' : '🗓️ 시간표에서 불러오기'}
            </button>
          </div>

          <div className="gpa-summary">
            <div className="gpa-stat">
              <span className="gpa-stat-k">이 학기 평점</span>
              <span className="gpa-stat-v">{semStat.gpa != null ? semStat.gpa.toFixed(2) : '—'}</span>
              <span className="gpa-stat-sub">{semStat.credits}학점</span>
            </div>
            <div className="gpa-stat">
              <span className="gpa-stat-k">누적 평점</span>
              <span className="gpa-stat-v">{cumStat.gpa != null ? cumStat.gpa.toFixed(2) : '—'}</span>
              <span className="gpa-stat-sub">{cumStat.credits}학점</span>
            </div>
          </div>
        </>
      ) : (
        <p className="center muted">학기 정보가 없어요.</p>
      )}

      {points.length > 0 && (
        <section className="gpa-trend">
          <h3 className="calc-sec-title">학기별 평점 추이</h3>
          <TrendChart points={points} />
        </section>
      )}
    </div>
  );
}

// 인라인 SVG 추이 차트 — 외부 라이브러리 없이 토큰 색만. Y 0~4.3.
function TrendChart({ points }) {
  const W = 320, H = 150, padL = 30, padR = 12, padT = 12, padB = 26;
  const maxY = 4.3, minY = 0;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const n = points.length;
  const x = (i) => padL + (n === 1 ? innerW / 2 : (innerW * i) / (n - 1));
  const y = (v) => padT + innerH * (1 - (v - minY) / (maxY - minY));
  const gridY = [0, 1, 2, 3, 4, 4.3];
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.gpa).toFixed(1)}`).join(' ');

  return (
    <svg className="gpa-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="학기별 평점 추이 차트">
      {gridY.map((g) => (
        <g key={g}>
          <line x1={padL} y1={y(g)} x2={W - padR} y2={y(g)} className="gpa-chart-grid" />
          <text x={padL - 5} y={y(g) + 3} className="gpa-chart-axis" textAnchor="end">{g}</text>
        </g>
      ))}
      {n > 1 && <path d={line} className="gpa-chart-line" fill="none" />}
      {points.map((p, i) => (
        <g key={p.label + i}>
          <circle cx={x(i)} cy={y(p.gpa)} r="3.5" className="gpa-chart-dot" />
          <text x={x(i)} y={H - 8} className="gpa-chart-axis" textAnchor="middle">{p.label}</text>
          <text x={x(i)} y={y(p.gpa) - 8} className="gpa-chart-val" textAnchor="middle">{p.gpa.toFixed(2)}</text>
        </g>
      ))}
    </svg>
  );
}

// =====================================================================
//  과락점수계산기 탭 — 로컬(localStorage) 저장
// =====================================================================
function FailTab({ catalog, uid }) {
  const [state, setState] = useState(() => loadState(uid));
  const [seeded, setSeeded] = useState(false);
  const [msg, setMsg] = useState('');
  const seedTried = useRef(false);

  // 첫 진입에 과목이 없으면 현재 학기 확정 시간표로 시드(한 번만).
  useEffect(() => {
    if (seedTried.current || !catalog) return;
    seedTried.current = true;
    if (state.courses.length > 0) return;
    (async () => {
      const cur = currentSemester(catalog);
      if (!cur) return;
      try {
        const names = await timetableCourseNames(catalog, cur.year, cur.term);
        if (!names.length) return;
        setState((prev) => {
          const next = { ...prev, courses: mergeCourses(prev.courses, names) };
          saveState(uid, next);
          return next;
        });
        setSeeded(true);
      } catch { /* 오프라인 등 — 수동 추가로 사용 */ }
    })();
  }, [catalog, uid, state.courses.length]);

  const update = useCallback((updater) => {
    setState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      saveState(uid, next);
      return next;
    });
  }, [uid]);

  const patchCourse = useCallback((id, patch) => {
    update((prev) => ({ ...prev, courses: prev.courses.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  }, [update]);

  const patchEval = useCallback((courseId, key, patch) => {
    update((prev) => ({
      ...prev,
      courses: prev.courses.map((c) => (c.id !== courseId ? c
        : { ...c, evals: c.evals.map((ev) => (ev.key === key ? { ...ev, ...patch } : ev)) })),
    }));
  }, [update]);

  const addCourse = useCallback(() => {
    update((prev) => ({ ...prev, courses: [...prev.courses, makeCourse('새 과목')] }));
  }, [update]);

  const removeCourse = useCallback((id) => {
    update((prev) => ({ ...prev, courses: prev.courses.filter((c) => c.id !== id) }));
  }, [update]);

  const reseed = useCallback(async () => {
    if (!catalog) return;
    const cur = currentSemester(catalog);
    if (!cur) { setMsg('현재 학기 정보가 없어요.'); return; }
    setMsg('');
    try {
      const names = await timetableCourseNames(catalog, cur.year, cur.term);
      if (!names.length) { setMsg('시간표에 담긴 과목이 없어요.'); return; }
      update((prev) => {
        const before = prev.courses.length;
        const courses = mergeCourses(prev.courses, names);
        setMsg(courses.length > before ? `${courses.length - before}개 과목을 추가했어요.` : '새로 추가할 과목이 없어요.');
        return { ...prev, courses };
      });
    } catch {
      setMsg('시간표에서 불러오지 못했어요.');
    }
  }, [catalog, update]);

  // 정렬은 '탭에 들어온 시점'에 한 번만 고정한다 — 점수 입력 중 확보 기여분이 바뀌어도
  // 카드가 즉시 재정렬돼 산만하지 않게. 다시 들어오면(탭 전환·페이지 재진입) 재마운트되며
  // 아래 초기값이 다시 계산돼 위험순으로 새로고침된다. 마운트 뒤 추가·시드된 과목은 맨 아래.
  const [order] = useState(() => sortCourses(state.courses).map((c) => c.id));
  const ordered = useMemo(() => {
    const byId = new Map(state.courses.map((c) => [c.id, c]));
    const inOrder = order.filter((id) => byId.has(id)).map((id) => byId.get(id));
    const known = new Set(order);
    const extra = state.courses.filter((c) => !known.has(c.id));
    return [...inOrder, ...extra];
  }, [state.courses, order]);

  return (
    <div className="calc-body">
      <div className="fc-warn-bar">
        <div className="fc-warn-top">
          <span className="fc-warn-label">경고 기준 원점수</span>
          <span className="fc-warn-val">{state.warnThreshold}</span>
        </div>
        <input
          type="range" min="0" max="100" step="1"
          value={state.warnThreshold}
          onChange={(e) => update((prev) => ({ ...prev, warnThreshold: Number(e.target.value) }))}
        />
        <p className="muted fc-warn-note">남은 평가에 필요한 원점수가 이 값을 넘는 과목을 <b>빨갛게</b> 표시해요.</p>
      </div>

      {msg && <p className="muted calc-hint">{msg}</p>}
      {seeded && <p className="muted calc-hint">현재 학기 시간표 과목을 불러왔어요.</p>}

      {ordered.length === 0 && <p className="center muted">과목을 추가하거나 시간표에서 불러오세요.</p>}

      <div className="fc-cards">
        {ordered.map((course) => (
          <FailCard
            key={course.id}
            course={course}
            warnThreshold={state.warnThreshold}
            onPatchCourse={patchCourse}
            onPatchEval={patchEval}
            onRemove={removeCourse}
          />
        ))}
      </div>

      <div className="calc-actions">
        <button className="btn-add btn-sm" onClick={addCourse}>＋ 과목 추가</button>
        <button className="btn-ghost btn-sm" onClick={reseed} disabled={!catalog}>🗓️ 시간표에서 다시 불러오기</button>
      </div>
    </div>
  );
}

function FailCard({ course, warnThreshold, onPatchCourse, onPatchEval, onRemove }) {
  const c = useMemo(() => computeCourse(course), [course]);
  const warn = isWarn(c, warnThreshold);
  const ratioOff = c.ratioSum !== 100;

  return (
    <div className={`fc-card${warn ? ' is-warn' : ''}`}>
      <div className="fc-card-head">
        <input
          className="fc-name"
          defaultValue={course.name}
          placeholder="과목명"
          onBlur={(e) => { const v = e.target.value.trim(); if (v !== course.name) onPatchCourse(course.id, { name: v }); }}
        />
        <label className="fc-threshold">
          과락
          <input
            type="number" inputMode="decimal" step="1" min="0" max="100"
            defaultValue={course.threshold}
            onBlur={(e) => {
              const v = Math.min(100, Math.max(0, round1(Number(e.target.value)) ?? 60));
              e.target.value = v;
              if (v !== course.threshold) onPatchCourse(course.id, { threshold: v });
            }}
          />
        </label>
        <button className="fc-del icon-btn" aria-label="과목 삭제" onClick={() => onRemove(course.id)}>🗑️</button>
      </div>

      {ratioOff && <p className="fc-ratio-warn">반영비율 합이 {c.ratioSum}%예요 (100% 권장).</p>}

      <div className="fc-evals">
        {c.evals.map((ev) => {
          const raw = course.evals.find((x) => x.key === ev.key);
          return (
            <div className={`fc-eval${ev.entered ? ' is-entered' : ''}`} key={ev.key}>
              <div className="fc-eval-top">
                <span className="fc-eval-name">{ev.key}</span>
                <span className="fc-ratio-wrap">
                  <input
                    className="fc-ratio"
                    type="number" inputMode="numeric" step="1" min="0" max="100"
                    defaultValue={raw.ratio}
                    onBlur={(e) => {
                      const v = Math.min(100, Math.max(0, Math.round(Number(e.target.value)) || 0));
                      e.target.value = v;
                      if (v !== raw.ratio) onPatchEval(course.id, ev.key, { ratio: v });
                    }}
                  />%
                </span>
              </div>

              <input
                className={`fc-score${ev.entered ? ' is-entered' : ''}`}
                type="number" inputMode="decimal" step="0.1" min="0" max="100"
                placeholder="점수"
                value={raw.score ?? ''}
                onChange={(e) => {
                  const s = e.target.value;
                  onPatchEval(course.id, ev.key, { score: s === '' ? null : Math.min(100, Math.max(0, round1(Number(s)))) });
                }}
              />

              {ev.entered ? (
                <div className="fc-eval-foot fc-eval-secured">확보 {round1(raw.score * ev.ratio / 100)}점</div>
              ) : (
                <button
                  type="button"
                  className={`fc-suggest${ev.impossible ? ' is-imp' : ''}`}
                  onClick={() => { if (!ev.impossible) onPatchEval(course.id, ev.key, { score: ev.neededRaw }); }}
                  disabled={ev.impossible}
                  title="탭하면 이 필요한 점수로 채워요"
                >
                  {/* 원칙: 빈 칸은 '필요한 점수'(과락을 면하려면 이 평가에서 받아야 할 최저 원점수)를 크게 보여준다 */}
                  <span className="fc-suggest-main">{ev.impossible ? '불가' : ev.neededRaw}</span>
                  <span className="fc-suggest-sub">{ev.impossible ? '100점↑ 필요' : '필요한 점수'}</span>
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="fc-card-foot">
        <span>현재 원점수합 <b>{c.enteredContribution}</b> / 과락 {c.threshold}</span>
        {c.impossible && <span className="fc-imp-tag">현 점수로 통과 불가</span>}
        {!c.hasBlank && c.enteredContribution >= c.threshold && <span className="fc-ok-tag">통과 ✓</span>}
        {!c.hasBlank && c.enteredContribution < c.threshold && <span className="fc-imp-tag">과락</span>}
      </div>
    </div>
  );
}

// =====================================================================
//  페이지: 학점/과락점수계산 (탭 2개)
// =====================================================================
export default function Calc() {
  const { cadet } = useAuthContext();
  const uid = cadet?.id;
  const [tab, setTab] = useState('gpa');
  const [catalog, setCatalog] = useState(null);

  useEffect(() => { getCatalog().then(setCatalog).catch(() => {}); }, []);

  return (
    <div className="page calc-page">
      <header className="page-header">
        <BackButton />
        <h2>🧮 학점·과락 계산</h2>
      </header>

      <div className="calc-tabs">
        <button className={`calc-tab${tab === 'gpa' ? ' is-active' : ''}`} onClick={() => setTab('gpa')}>학점계산기</button>
        <button className={`calc-tab${tab === 'fail' ? ' is-active' : ''}`} onClick={() => setTab('fail')}>과락점수계산기</button>
      </div>

      {tab === 'gpa'
        ? <GpaTab catalog={catalog} uid={uid} />
        : <FailTab catalog={catalog} uid={uid} />}
    </div>
  );
}
