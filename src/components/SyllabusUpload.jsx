import { useMemo, useState } from 'react';
import { getCatalog } from '../lib/cache';
import { isFillableSection } from '../lib/syllabusPlan';

const DAY = { 1: '월', 2: '화', 3: '수', 4: '목', 5: '금', 6: '토', 7: '일' };
// 교수 매칭 결과 배지. similar = 파일의 짧은 이름("Justin")으로 기존 교수("Justin Bunting")를
// 찾아 이어붙인 것 — 자동이지만 확실하지 않으니 사람이 보게 경고색으로 띄운다.
const PROF_TAG = {
  create: ['신규', 'tag-primary'],
  match: ['기존', 'tag-success'],
  similar: ['비슷한 이름', 'tag-warn'],
  ambiguous: ['동명이인?', 'tag-warn'],
};
// 과목 매칭 결과 배지. similar = 파일의 과목명("체육(럭비)")이 기존 과목("럭비")과 정규화 구간이
// 통째로 일치 — 자동이지만 확실치 않으니 사람이 확인. ambiguous = 후보가 여럿(관리자가 고름).
const COURSE_TAG = {
  create: ['신규', 'tag-primary'],
  match: ['통합', 'tag-success'],
  linked: ['연결됨', 'tag-success'],
  similar: ['비슷한 이름', 'tag-warn'],
  ambiguous: ['여러 후보', 'tag-warn'],
};
const fmtTimes = (blocks) =>
  (blocks || []).map((b) => `${DAY[b.day]}${b.start}${b.end > b.start ? `-${b.end}` : ''}`).join(' ') || '시간미정';

function downloadCsv(name, text) {
  const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

// 관리자: 강의 CSV → 결정적 파싱 → 기존 DB 대조(reconcile) → 검토 UI → 적용(applyPlan).
// 2026-09 AI(PDF/HWP → Gemini) 경로 폐지 — 같은 표를 다시 돌려도 매번 살짝 다른 결과가
// 나오는 문제를 프롬프트로 계속 좁혀도 완전히 없어지지 않아, 결정적인 CSV 경로만 남겼다
// (수강편람을 CSV로 옮겨 적어 올리는 흐름은 그대로 — 옮겨 적는 사람이 곧 검증자가 된다).
export default function SyllabusUpload({ defaultYear = 2026, defaultTerm = 1, onApplied }) {
  const [file, setFile] = useState(null);
  const [paste, setPaste] = useState('');
  const [year, setYear] = useState(defaultYear);
  const [term, setTerm] = useState(defaultTerm);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [plan, setPlan] = useState(null);
  const [err, setErr] = useState('');
  const [result, setResult] = useState('');
  // 빈 칸만 채우기 모드: 이미 값이 있는 교수·강의실·강의시간은 이 CSV로 덮어쓰지 않고,
  // 비어 있는 칸만 채운다. 일부 분반만 미입력인 표도 안심하고 통째로 올릴 수 있다.
  const [partial, setPartial] = useState(false);
  // 위 모드에서 검토 목록을 줄이려는 화면 필터 — 실제 적용 범위는 partial 이 결정한다.
  const [onlyMissing, setOnlyMissing] = useState(false);

  function patchPlan(updater) {
    setPlan((p) => {
      const next = { ...p };
      updater(next);
      return next;
    });
  }

  function resetOut() { setPlan(null); setResult(''); }

  async function analyze() {
    if (!paste.trim() && !file) return setErr('CSV 파일을 선택하거나 아래에 붙여넣으세요.');
    setErr(''); setResult(''); setPlan(null); setBusy(true);
    setProgress({ label: 'CSV 읽는 중…', done: 0, total: 0 });
    try {
      const lib = await import('../lib/syllabus');
      const catalog = await getCatalog({ force: true }).catch(() => null);
      const text = paste.trim() ? paste : await file.text();
      const { rows, periods } = lib.parseCsvRows(text);
      if (!rows.length) {
        setErr('읽어들인 과목이 없습니다. 헤더(과목명/분반/담당교수/강의시간…)와 형식을 확인하세요.');
        return;
      }
      setPlan(lib.reconcile(rows, periods, catalog || {}, Number(year), Number(term)));
    } catch (e) {
      setErr('분석 실패: ' + (e?.message || e));
    } finally {
      setBusy(false); setProgress(null);
    }
  }

  async function apply() {
    if (!plan) return;
    setBusy(true); setErr('');
    const total = plan.courses.filter((c) => c.include !== false).length;
    setProgress({ label: '적용 중…', done: 0, total });
    try {
      const lib = await import('../lib/syllabus');
      const r = await lib.applyPlan(plan, { partial, onProgress: (d, t) => setProgress({ label: '적용 중…', done: d, total: t }) });
      const cleaned = r.removed
        ? ` 파일에 없던 기존 분반 ${r.removed.sections}개 삭제${r.removed.entries ? ` (생도 시간표 ${r.removed.entries}건에서 함께 제거됨)` : ''}.`
        : '';
      const named = r.blocks ? ` 공통 공강 시간 이름 ${r.blocks}개 저장.` : '';
      const partialNote = partial ? ' (빈 칸만 채우기 — 이미 값이 있던 항목은 그대로 두었습니다.)' : '';
      setResult(`✅ 적용 완료 — 과목 ${total}개(신규 ${r.courses}), 분반 ${r.sections}개, 교수 신규 ${plan.stats.newProfessors}개.${cleaned}${named}${partialNote}`);
      setPlan(null); setFile(null); setPaste('');
      onApplied?.();
    } catch (e) {
      setErr('적용 실패: ' + (e?.message || e));
    } finally {
      setBusy(false); setProgress(null);
    }
  }

  function setProfChoice(i, val) {
    patchPlan((p) => {
      const arr = [...p.professors];
      const pr = { ...arr[i] };
      if (val === '__new__') { pr.code = null; pr.action = 'create'; pr.update = false; }
      else {
        pr.code = val; pr.action = 'match';
        const cand = pr.candidates.find((c) => c.code === val);
        if (cand) { pr.department = cand.department ?? pr.department; }
        pr.update = false;
      }
      arr[i] = pr; p.professors = arr;
    });
  }
  function setProfField(i, field, value) {
    patchPlan((p) => {
      const arr = [...p.professors];
      arr[i] = { ...arr[i], [field]: value, update: arr[i].code != null };
      p.professors = arr;
    });
  }
  function setCourseInclude(i, v) {
    patchPlan((p) => { const arr = [...p.courses]; arr[i] = { ...arr[i], include: v }; p.courses = arr; });
  }
  // 과목 매칭 확정: 기존 과목에 연결하거나 새 과목으로 등록. 연결하면 그 과목코드로 분반이 붙는다.
  function setCourseChoice(i, val) {
    patchPlan((p) => {
      const arr = [...p.courses];
      const c = { ...arr[i] };
      if (val === '__new__') { c.code = null; c.action = 'create'; }
      else { c.code = val; c.action = 'linked'; }
      arr[i] = c; p.courses = arr;
    });
  }
  function setBlockLabel(i, v) {
    patchPlan((p) => {
      const arr = [...p.commonBlocks];
      arr[i] = { ...arr[i], label: v };
      p.commonBlocks = arr;
    });
  }
  function removeBlock(i) {
    patchPlan((p) => { p.commonBlocks = p.commonBlocks.filter((_, k) => k !== i); });
  }

  const canAnalyze = !!paste.trim() || !!file;

  // 제외(체크 해제)한 과목은 적용되지 않으니 충돌 경고에서도 빼준다.
  // 남은 분반이 하나뿐이면 더 이상 충돌이 아니다.
  const conflicts = useMemo(() => {
    const excluded = new Set((plan?.courses ?? []).filter((c) => c.include === false).map((c) => c.name));
    if (!excluded.size) return plan?.conflicts ?? [];
    return (plan?.conflicts ?? [])
      .map((c) => ({ ...c, sections: c.sections.filter((s) => !excluded.has(s.courseName)) }))
      .filter((c) => c.sections.length > 1);
  }, [plan]);

  // 담당교수를 못 읽은 분반(적용할 과목에 한해). 원본에 원래 없으면 정상이지만,
  // CSV 열이 밀렸으면 조용히 '교수 미정'으로 들어가 버린다 — 적용 전에 눈에 띄게 한다.
  const noProf = useMemo(() => (plan?.courses ?? [])
    .filter((c) => c.include !== false)
    .flatMap((c) => c.sections.filter((s) => !s.professorName)
      .map((s) => ({ courseName: c.name, sectionNo: s.sectionNo, times: s.times }))),
  [plan]);

  // "미입력만 보기": 검토 목록을 DB에 이미 없던 값(교수/강의실)을 채울 수 있는 분반만으로 줄인다.
  // 화면 필터일 뿐이며, 실제로 무엇을 덮어쓰는지는 partial(빈 칸만 채우기 모드)이 결정한다.
  const visibleCourses = useMemo(() => {
    const list = (plan?.courses ?? []).map((c, i) => ({ c, i, sections: c.sections }));
    if (!onlyMissing) return list;
    return list
      .map((x) => ({ ...x, sections: x.c.sections.filter(isFillableSection) }))
      .filter((x) => x.sections.length > 0);
  }, [plan, onlyMissing]);

  return (
    <div className="syl">
      <p className="note">
        과목·분반 표를 <b>CSV</b>로 올리면(또는 붙여넣으면) 기존 DB와 <b>대조</b>합니다.
        열: <b>과목명·분반·담당교수·학과·강의시간·강의실</b>. <b>분반을 비우면</b> 과목별로 1,2,3… 자동 부여되고,
        강의시간은 <b>“수1 수2 금1”</b>(요일+교시) 형식입니다. 교수는 이름으로 매칭하며 <b>적용 전 반드시 검토</b>하세요.
      </p>

      <label className="note syl-partial">
        <input type="checkbox" checked={partial} onChange={(e) => { setPartial(e.target.checked); setOnlyMissing(e.target.checked); }} />
        {' '}<b>빈 칸만 채우기 모드</b> — 이미 교수·강의실·강의시간이 있는 분반은 이 CSV로 덮어쓰지 않고,
        비어 있는 값만 채웁니다. 일부 분반만 미입력이라 전체 갱신이 부담스러울 때 켜세요.
      </label>

      <div className="adm-form-grid">
        <label className="field"><span className="field-label">연도</span>
          <input type="number" value={year} onChange={(e) => setYear(e.target.value)} /></label>
        <label className="field"><span className="field-label">학기</span>
          <select value={term} onChange={(e) => setTerm(e.target.value)}><option value={1}>1</option><option value={2}>2</option></select></label>
      </div>

      <div className="adm-btn-row syl-csv-tools">
        <label className="board-file-field syl-file">
          <span className="board-file-label">📄 CSV 파일 선택{file ? ` · ${file.name}` : ''}</span>
          <input type="file" accept=".csv,text/csv,text/plain" onChange={(e) => { setFile(e.target.files?.[0] || null); resetOut(); }} />
        </label>
        <button className="btn-ghost btn-sm" type="button" onClick={() => import('../lib/syllabus').then((l) => downloadCsv('강의일괄등록_양식.csv', l.CSV_TEMPLATE))}>양식 내려받기</button>
      </div>
      <label className="field syl-paste">
        <span className="field-label">또는 CSV 붙여넣기</span>
        <textarea rows={5} placeholder={'과목명,분반,담당교수,학과,강의시간,강의실\n기초물리학및실험,,김득수,,수1 수2 금1,403'}
          value={paste} onChange={(e) => { setPaste(e.target.value); resetOut(); }} />
      </label>

      <button className="btn-add btn-block" disabled={busy || !canAnalyze} onClick={analyze}>
        {busy && !plan ? '분석 중…' : 'CSV 분석'}
      </button>

      {progress && (
        <p className="note syl-progress">{progress.label}{progress.total ? ` (${progress.done}/${progress.total})` : ''}</p>
      )}

      {err && <p className="error-msg">{err}</p>}
      {result && <p className="admin-msg is-ok">{result}</p>}

      {plan && (
        <div className="syl-plan">
          <div className="divider adm-divider" />
          {plan.semesterLooksOff && (
            <p className="error-msg">
              ⚠️ {plan.year}년 {plan.term}학기에 이미 등록된 분반 중 상당수({plan.stats.staleSections}개)가
              이 파일에서 발견되지 않았습니다. <b>연도·학기를 잘못 입력</b>했거나, 파일이 <b>일부만 분석</b>됐을 수 있습니다 —
              위 연도/학기와 아래 "이 파일에 없는 기존 분반" 목록을 확인한 뒤 적용하세요.
            </p>
          )}
          <div className="syl-stats">
            <span className="tag tag-success">과목 {plan.stats.courses}</span>
            <span className="tag tag-primary">신규과목 {plan.stats.newCourses}</span>
            {plan.stats.similarCourses > 0 && <span className="tag tag-warn">과목 비슷한 이름 {plan.stats.similarCourses}</span>}
            {plan.stats.ambiguousCourses > 0 && <span className="tag tag-warn">과목 후보 여럿 {plan.stats.ambiguousCourses}</span>}
            <span className="tag">교수 {plan.stats.professors}</span>
            <span className="tag tag-primary">신규교수 {plan.stats.newProfessors}</span>
            {plan.stats.reusedSections > 0 && <span className="tag tag-success">기존분반 재사용 {plan.stats.reusedSections}</span>}
            {plan.stats.fillableSections > 0 && <span className="tag tag-primary">빈 칸 채울 수 있음 {plan.stats.fillableSections}</span>}
            {plan.stats.ambiguous > 0 && <span className="tag tag-warn">동명이인 검토 {plan.stats.ambiguous}</span>}
            {plan.stats.similar > 0 && <span className="tag tag-warn">비슷한 이름 {plan.stats.similar}</span>}
            {plan.stats.noProfessor > 0 && <span className="tag tag-warn">교수 미정 {plan.stats.noProfessor}</span>}
            {conflicts.length > 0 && <span className="tag tag-warn">시간 충돌 {conflicts.length}</span>}
            {plan.stats.commonBlocks > 0 && <span className="tag">공통 공강 {plan.stats.commonBlocks}</span>}
          </div>

          {conflicts.length > 0 && (
            <details className="syl-collapse is-warn" open>
              <summary className="section-label adm-sub-label">⚠️ 같은 교수 · 같은 교시 ({conflicts.length})</summary>
              <p className="note">
                한 교수가 같은 교시에 두 분반을 <b>동시에</b> 담당하는 것으로 읽혔습니다.
                같은 시간대에 나란히 열린 분반(예: 영어회화 4·5·6분반이 모두 목1교시)의 교수 이름을
                CSV에서 잘못 적었을 가능성이 큽니다. 해당 행을 고쳐 다시 올리세요.
                {' '}(합반 수업이라면 그대로 적용해도 됩니다.)
              </p>
              <div className="syl-list">
                {conflicts.map((c) => (
                  <div className="syl-conflict" key={`${c.professorName}-${c.day}-${c.period}`}>
                    <b>{c.professorName}</b> · {DAY[c.day]}{c.period}교시
                    <span className="muted"> — {c.sections.map((s) => `${s.courseName} ${s.sectionNo}분반`).join(', ')}</span>
                  </div>
                ))}
              </div>
            </details>
          )}

          {noProf.length > 0 && (
            <details className="syl-collapse is-warn" open>
              <summary className="section-label adm-sub-label">⚠️ 교수 미정 분반 ({noProf.length})</summary>
              <p className="note">
                담당교수를 읽지 못한 분반입니다. 원본의 교수 칸이 <b>원래 비어 있으면</b> 그대로 적용해도 됩니다(교수 미정으로 저장).
                CSV에 교수를 적어 두었는데도 여기 뜬다면 그 행의 열이 밀린 것입니다.
              </p>
              <div className="syl-list">
                {noProf.map((s) => (
                  <div className="syl-conflict" key={`${s.courseName}-${s.sectionNo}`}>
                    <b>{s.courseName}</b> {s.sectionNo}분반
                    <span className="muted"> — {fmtTimes(s.times)}</span>
                  </div>
                ))}
              </div>
            </details>
          )}

          {plan.periods.length > 0 && (
            <label className="adm-check syl-period">
              <input type="checkbox" checked={plan.includePeriods} onChange={(e) => patchPlan((p) => { p.includePeriods = e.target.checked; })} />
              교시 시각 {plan.periods.length}개도 갱신 ({plan.periods.map((p) => `${p.no}:${p.start}`).join(', ')})
            </label>
          )}

          {/* 전 생도 공통 비수업 시간 — 이 파일에서 어떤 분반도 열리지 않는 요일·교시. */}
          {plan.commonBlocks?.length > 0 && (
            <details className="syl-collapse" open>
              <summary className="section-label adm-sub-label">
                공통 공강 시간 ({plan.commonBlocks.length}) — 이름 붙이기
              </summary>
              <div className="syl-blocks">
              <p className="note">
                이 파일에서 <b>어떤 분반도 열리지 않는</b> 시간입니다. 이미 저장된 이름이 있으면 그대로 이어받고,
                없으면 비워 둡니다 — 이름을 채우거나, <b>×</b>로 뺄 수 있습니다(계산은 이름과 무관합니다).
                시간표·마법사 격자에 회색으로 깔리고, 마법사가 이 시간을 <b>빈 시간(공강)으로 세지 않습니다</b>.
              </p>
              <div className="syl-list">
                {plan.commonBlocks.map((b, i) => (
                  <div className="syl-block" key={`${b.day}-${b.start}`}>
                    <span className="syl-block-when">
                      {DAY[b.day]} {b.start}{b.end > b.start ? `~${b.end}` : ''}교시
                      {b.manual && <em className="syl-block-manual"> 직접</em>}
                    </span>
                    <input
                      className="syl-block-label"
                      list="syl-block-names"
                      maxLength={20}
                      placeholder="이름 (비워도 됨)"
                      value={b.label}
                      onChange={(e) => setBlockLabel(i, e.target.value)}
                    />
                    <button className="rev-del-btn" title="이 블록 빼기" onClick={() => removeBlock(i)}>×</button>
                  </div>
                ))}
              </div>
              <datalist id="syl-block-names">
                <option value="생도대시간" />
                <option value="군사훈련" />
                <option value="자율선택형교과" />
                <option value="전 생도 연구시간" />
                <option value="체육" />
              </datalist>
              </div>
            </details>
          )}

          {/* 교수 매칭은 대부분 그대로 맞는다 — 확인이 필요할 때(동명이인·비슷한 이름·신규)만 펼쳐 둔다. */}
          <details className="syl-collapse" open={plan.stats.ambiguous > 0 || plan.stats.similar > 0 || plan.stats.newProfessors > 0}>
            <summary className="section-label adm-sub-label">교수 ({plan.professors.length}) — 매칭 확인</summary>
            <div className="syl-list">
            {plan.professors.map((p, i) => (
              <div className={`syl-prof ${p.action === 'ambiguous' || p.action === 'similar' ? 'is-warn' : ''}`} key={p.name}>
                <div className="syl-prof-head">
                  <b>{p.name}</b>
                  <span className={`tag ${PROF_TAG[p.action]?.[1] ?? 'tag-success'}`}>
                    {PROF_TAG[p.action]?.[0] ?? '기존'}
                  </span>
                </div>
                {/* 후보는 '이름'까지 보여준다 — 학과·코드만 보고는 어느 교수인지 알 수 없다.
                    비슷한 이름으로 이어붙인 경우(similar) 파일의 이름과 DB 이름이 다르기 때문. */}
                {p.candidates.length > 0 && (
                  <select value={p.code ?? '__new__'} onChange={(e) => setProfChoice(i, e.target.value)}>
                    <option value="__new__">+ 새 교수로 등록</option>
                    {p.candidates.map((c) => (
                      <option key={c.code} value={c.code}>{[c.name, c.department, c.code].filter(Boolean).join(' · ')}</option>
                    ))}
                  </select>
                )}
                {p.aliases?.length > 0 && (
                  <p className="note">
                    파일 표기: <b>{p.aliases.join(', ')}</b> → 기존 교수 <b>{p.name}</b> 로 봤습니다.
                    {p.action === 'similar' && ' 다른 사람이면 위에서 «새 교수로 등록»을 고르세요.'}
                  </p>
                )}
                <div className="syl-prof-meta">
                  <input placeholder="학과(추정)" value={p.department || ''} onChange={(e) => setProfField(i, 'department', e.target.value)} />
                </div>
              </div>
            ))}
            </div>
          </details>

          <details className="syl-collapse" open>
            <summary className="section-label adm-sub-label">
              과목 · 분반 ({visibleCourses.length}{onlyMissing ? `/${plan.courses.length}` : ''})
            </summary>
            {plan.stats.fillableSections > 0 && (
              <label className="syl-only-missing">
                <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} />
                {' '}빈 칸 채울 수 있는 분반만 보기
              </label>
            )}
            <div className="syl-list">
            {visibleCourses.map(({ c, i, sections }) => {
              const warn = c.action === 'similar' || c.action === 'ambiguous';
              const [tagText, tagCls] = COURSE_TAG[c.action] ?? (c.code == null ? ['신규', 'tag-primary'] : ['통합', 'tag-success']);
              return (
              <div className={`syl-course${warn ? ' is-warn' : ''}`} key={c.name}>
                <label className="syl-course-head">
                  <input type="checkbox" checked={c.include !== false} onChange={(e) => setCourseInclude(i, e.target.checked)} />
                  <b>{c.name}</b>
                  <span className={`tag ${tagCls}`}>{tagText}</span>
                  <span className="muted">{onlyMissing ? `${sections.length}/${c.sections.length}` : c.sections.length}분반</span>
                </label>
                {/* 비슷한 이름·후보 여럿: 기존 과목에 연결할지, 새 과목으로 등록할지 관리자가 고른다.
                    후보엔 학과·분반 수를 함께 보여 준다(예: 3학년 항공체력관리론 vs 1학년 항공우주체력관리론 구분). */}
                {c.candidates?.length > 0 && (
                  <>
                    <select className="syl-course-pick" value={c.code ?? '__new__'} onChange={(e) => setCourseChoice(i, e.target.value)}>
                      <option value="__new__">+ 새 과목으로 등록 «{c.name}»</option>
                      {c.candidates.map((cd) => (
                        <option key={cd.code} value={cd.code}>
                          기존 «{cd.name}»{cd.department ? ` · ${cd.department}` : ''} · {cd.sectionCount}분반
                        </option>
                      ))}
                    </select>
                    <p className="note">
                      파일의 <b>{c.name}</b> 을(를) {c.code ? <>기존 과목 <b>«{c.candidates.find((cd) => cd.code === c.code)?.name ?? c.code}»</b> 에 이어붙입니다.</> : '새 과목으로 등록합니다.'}
                      {' '}다른 과목이면 위에서 바꾸세요.
                    </p>
                  </>
                )}
                <div className="syl-sections">
                  {sections.map((s) => (
                    <div className="syl-sec" key={s.sectionNo}>
                      <b>{s.sectionNo}분반</b>{s.reused ? <span className="tag tag-success">기존 분반</span> : null} · {s.professorName || '교수미정'} · {fmtTimes(s.times)}{s.room ? ` · ${s.room}` : ''}
                      {isFillableSection(s) && <span className="tag tag-primary">빈 칸 채움</span>}
                    </div>
                  ))}
                </div>
              </div>
              );
            })}
            </div>
          </details>

          {/* 참고용 목록이라 기본은 접어 둔다 — 삭제 체크박스도 안에 있으니, 정리하려면 펼쳐서 본다. */}
          {plan.stale.length > 0 && (
            <details className="syl-collapse">
              <summary className="section-label adm-sub-label">이 파일에 없는 기존 분반 ({plan.stale.length})</summary>
              <p className="note">
                {plan.year}-{plan.term} 학기에 <b>이미 등록돼 있는데</b> 이번 파일에는 없는 분반입니다.
                다른 CSV로 두 번 적재해 생긴 <b>중복</b>이거나 폐강된 분반일 수 있어요.
              </p>
              <label className="adm-check">
                <input type="checkbox" checked={!!plan.removeStale}
                  onChange={(e) => patchPlan((p) => { p.removeStale = e.target.checked; })} />
                {' '}적용할 때 <b>삭제</b> (이 학기를 이번 파일로 대체) — 생도 시간표에 담긴 분반이면 그 항목도 함께 사라집니다
              </label>
              <div className="syl-list">
                {plan.stale.slice(0, 30).map((s) => (
                  <div className="syl-sec" key={`${s.courseCode}-${s.sectionNo}`}>
                    <b>{s.courseName}</b> {s.sectionNo}분반 · {s.professorName || '교수미정'} · {fmtTimes(s.times)}
                  </div>
                ))}
                {plan.stale.length > 30 && <div className="syl-sec muted">… 외 {plan.stale.length - 30}개</div>}
              </div>
            </details>
          )}

          <button className="btn-add btn-block" disabled={busy} onClick={apply}>{busy ? '적용 중…' : '검토 완료 — DB에 적용'}</button>
        </div>
      )}
    </div>
  );
}
