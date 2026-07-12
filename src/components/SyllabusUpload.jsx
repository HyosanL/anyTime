import { useMemo, useState } from 'react';
import { getCatalog } from '../lib/cache';

const DAY = { 1: '월', 2: '화', 3: '수', 4: '목', 5: '금', 6: '토', 7: '일' };
const fmtTimes = (blocks) =>
  (blocks || []).map((b) => `${DAY[b.day]}${b.start}${b.end > b.start ? `-${b.end}` : ''}`).join(' ') || '시간미정';
// 격자 대조용 "요일-교시" 키 목록 → "월1 월2 목1"
const fmtSlots = (keys) =>
  (keys || [])
    .map((k) => k.split('-').map(Number))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map(([d, p]) => `${DAY[d]}${p}`)
    .join(' ');

function downloadCsv(name, text) {
  const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

// 관리자: 강의 소스(PDF 또는 CSV) → 파싱 → 기존 DB 대조 → 검토 후 적용.
// mode='ai' : PDF(수강편람) → Workers AI 로 구조화.  mode='csv' : 표 CSV → 결정적 파싱.
// 대조(reconcile)·검토 UI·적용(applyPlan)은 두 모드가 완전히 동일하다.
export default function SyllabusUpload({ mode = 'ai', defaultYear = 2026, defaultTerm = 1, onApplied }) {
  const isCsv = mode === 'csv';
  const [file, setFile] = useState(null);
  const [paste, setPaste] = useState('');
  const [year, setYear] = useState(defaultYear);
  const [term, setTerm] = useState(defaultTerm);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [plan, setPlan] = useState(null);
  const [err, setErr] = useState('');
  const [result, setResult] = useState('');
  // 같은 PDF 재분석은 캐시로 공짜(Gemini 미호출). 파싱이 틀렸을 때만 캐시를 버리고 새로 부른다.
  const [noCache, setNoCache] = useState(false);
  const [cost, setCost] = useState('');
  // 직접 추가할 공통 비수업 시간(자동 유도가 못 찾는 자율선택형교과 등)
  const [nb, setNb] = useState({ day: 1, start: 7, end: 8, label: '자율선택형교과' });

  function patchPlan(updater) {
    setPlan((p) => {
      const next = { ...p };
      updater(next);
      return next;
    });
  }

  function resetOut() { setPlan(null); setResult(''); setCost(''); }

  async function analyze() {
    if (isCsv && !paste.trim() && !file) return setErr('CSV 파일을 선택하거나 아래에 붙여넣으세요.');
    if (!isCsv && !file) return setErr('PDF 파일을 선택하세요.');
    setErr(''); setResult(''); setPlan(null); setBusy(true);
    setProgress({ label: isCsv ? 'CSV 읽는 중…' : 'PDF 읽는 중…', done: 0, total: 0 });
    try {
      const lib = await import('../lib/syllabus');
      const catalog = await getCatalog({ force: true }).catch(() => null);
      let rows;
      let periods = [];
      let errors = [];
      let grids = [];   // 주간 격자(좌표로 직접 읽음 — AI 호출 0회)
      if (isCsv) {
        const text = paste.trim() ? paste : await file.text();
        ({ rows, periods } = lib.parseCsvRows(text));
      } else {
        let model; let cachedPages; let coursePages;
        ({ rows, periods, errors = [], grids = [], model, cachedPages, coursePages } = await lib.parseSyllabus(file, {
          noCache,
          onProgress: (d, t) => setProgress({ label: 'AI 분석 중…', done: d, total: t }),
        }));
        const billed = coursePages - cachedPages;
        setCost(`${model} · ${coursePages}장 중 ${cachedPages}장은 캐시(무과금), ${billed}장 호출`
          + (grids.length ? ` · 주간 격자 ${grids.length}장은 AI 없이 직접 읽음(무과금)` : ''));
      }
      if (!rows.length) {
        // 서버가 실패해서 비었다면 PDF 형식 탓으로 오인시키지 말고 실제 사유를 보여준다.
        if (errors.length) setErr('분석 실패: ' + errors[0]);
        else setErr(isCsv ? '읽어들인 과목이 없습니다. 헤더(과목명/분반/담당교수/강의시간…)와 형식을 확인하세요.'
          : '추출된 과목이 없습니다. 다른 PDF이거나 형식이 다를 수 있어요.');
        return;
      }
      // 일부 페이지만 실패한 경우: 결과는 보여주되 누락 가능성을 경고한다.
      if (errors.length) setErr(`일부 페이지 분석 실패(${errors.length}건) — 과목이 누락됐을 수 있습니다: ${errors[0]}`);
      setPlan(lib.reconcile(rows, periods, catalog || {}, Number(year), Number(term), grids));
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
      const r = await lib.applyPlan(plan, { onProgress: (d, t) => setProgress({ label: '적용 중…', done: d, total: t }) });
      const cleaned = r.removed
        ? ` 편람에 없던 기존 분반 ${r.removed.sections}개 삭제${r.removed.entries ? ` (생도 시간표 ${r.removed.entries}건에서 함께 제거됨)` : ''}.`
        : '';
      const named = r.blocks ? ` 비수업 시간 이름 ${r.blocks}개 저장.` : '';
      setResult(`✅ 적용 완료 — 과목 ${total}개(신규 ${r.courses}), 분반 ${r.sections}개, 교수 신규 ${plan.stats.newProfessors}개.${cleaned}${named}`);
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
  // 자동 유도는 '개설 분반 0개'인 칸만 찾는다. 월7·8, 수7·8 처럼 자율선택형교과(체육)가
  // 열려 있는 시간은 강의가 있으니 못 찾는다 — 관리자가 직접 넣는다.
  function addBlock() {
    const day = Number(nb.day);
    const start = Number(nb.start);
    const end = Number(nb.end);
    if (!day || !start || !end || end < start) return;
    patchPlan((p) => {
      const rest = p.commonBlocks.filter((b) => !(b.day === day && b.start === start));
      p.commonBlocks = [...rest, { day, start, end, label: nb.label.trim(), manual: true }]
        .sort((a, b) => a.day - b.day || a.start - b.start);
    });
  }

  const canAnalyze = isCsv ? (!!paste.trim() || !!file) : !!file;

  // 제외(체크 해제)한 과목은 적용되지 않으니 충돌 경고에서도 빼준다.
  // 남은 분반이 하나뿐이면 더 이상 충돌이 아니다.
  const conflicts = useMemo(() => {
    const excluded = new Set((plan?.courses ?? []).filter((c) => c.include === false).map((c) => c.name));
    if (!excluded.size) return plan?.conflicts ?? [];
    return (plan?.conflicts ?? [])
      .map((c) => ({ ...c, sections: c.sections.filter((s) => !excluded.has(s.courseName)) }))
      .filter((c) => c.sections.length > 1);
  }, [plan]);

  return (
    <div className="syl">
      {isCsv ? (
        <p className="note">
          과목·분반 표를 <b>CSV</b>로 올리면(또는 붙여넣으면) 기존 DB와 <b>대조</b>합니다.
          열: <b>과목명·분반·담당교수·학과·강의시간·강의실</b>. <b>분반을 비우면</b> 과목별로 1,2,3… 자동 부여되고,
          강의시간은 <b>“수1 수2 금1”</b>(요일+교시) 형식입니다. 교수는 이름으로 매칭하며 <b>적용 전 반드시 검토</b>하세요.
        </p>
      ) : (
        <p className="note">
          학기 강의 PDF(수강편람)를 올리면 AI가 과목·분반·교수·시간을 뽑아 <b>기존 DB와 대조</b>합니다.
          교수는 <b>이름으로 매칭</b>하고(동명이인은 과목 이력으로 보정), 새 교수는 자동 등록(코드 자동). <b>적용 전 반드시 검토</b>하세요.
        </p>
      )}

      <div className="adm-form-grid">
        <label className="field"><span className="field-label">연도</span>
          <input type="number" value={year} onChange={(e) => setYear(e.target.value)} /></label>
        <label className="field"><span className="field-label">학기</span>
          <select value={term} onChange={(e) => setTerm(e.target.value)}><option value={1}>1</option><option value={2}>2</option></select></label>
      </div>

      {isCsv ? (
        <>
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
        </>
      ) : (
        <label className="board-file-field syl-file">
          <span className="board-file-label">📄 강의 PDF 선택{file ? ` · ${file.name}` : ''}</span>
          <input type="file" accept="application/pdf,.pdf" onChange={(e) => { setFile(e.target.files?.[0] || null); resetOut(); }} />
        </label>
      )}

      {!isCsv && (
        <label className="note">
          <input type="checkbox" checked={noCache} onChange={(e) => { setNoCache(e.target.checked); resetOut(); }} />
          {' '}캐시 무시하고 다시 분석 (AI를 새로 호출 — 파싱 결과가 틀렸을 때만)
        </label>
      )}

      <button className="btn-add btn-block" disabled={busy || !canAnalyze} onClick={analyze}>
        {busy && !plan ? '분석 중…' : (isCsv ? 'CSV 분석' : 'PDF 분석')}
      </button>

      {progress && (
        <p className="note syl-progress">{progress.label}{progress.total ? ` (${progress.done}/${progress.total})` : ''}</p>
      )}

      {cost && !progress && <p className="note">{cost}</p>}
      {err && <p className="error-msg">{err}</p>}
      {result && <p className="admin-msg is-ok">{result}</p>}

      {plan && (
        <div className="syl-plan">
          <div className="divider adm-divider" />
          <div className="syl-stats">
            <span className="tag tag-success">과목 {plan.stats.courses}</span>
            <span className="tag tag-primary">신규과목 {plan.stats.newCourses}</span>
            <span className="tag">교수 {plan.stats.professors}</span>
            <span className="tag tag-primary">신규교수 {plan.stats.newProfessors}</span>
            {plan.stats.reusedSections > 0 && <span className="tag tag-success">기존분반 재사용 {plan.stats.reusedSections}</span>}
            {plan.stats.ambiguous > 0 && <span className="tag tag-warn">동명이인 검토 {plan.stats.ambiguous}</span>}
            {conflicts.length > 0 && <span className="tag tag-warn">시간 충돌 {conflicts.length}</span>}
            {plan.stats.commonBlocks > 0 && <span className="tag">비수업 시간 {plan.stats.commonBlocks}</span>}
            {plan.stats.gridWarnings > 0 && <span className="tag tag-warn">격자와 어긋남 {plan.stats.gridWarnings}</span>}
          </div>

          {/* 세부내용 표 ↔ 주간 격자 대조. 편람의 표 자체가 틀리는 일이 있다 —
              2026-2 신호및시스템 1분반은 표가 '월1 월2 목1', 격자가 '화1 화2 목1' 이었다.
              AI 는 표를 충실히 옮길 뿐이라 이건 격자로만 잡힌다(AI 호출 0회). */}
          {plan.grid?.mismatches?.length > 0 && (
            <div className="syl-conflicts">
              <div className="section-label adm-sub-label">
                ⚠️ 주간 격자와 어긋나는 분반 ({plan.grid.mismatches.length})
              </div>
              <p className="note">
                편람의 <b>세부내용 표</b>가 말하는 요일이 같은 편람의 <b>주간 격자</b>에 없습니다.
                이런 경우 <b>표가 틀린 것</b>입니다(격자가 정답). 아래를 확인하고 CSV로 바로잡아 올리세요.
                {' '}격자를 못 읽는 편람(양식이 다른 해)에서는 이 대조를 건너뜁니다.
              </p>
              <div className="syl-list">
                {plan.grid.mismatches.map((m) => (
                  <div className="syl-conflict" key={`${m.course}-${m.sectionNo}`}>
                    <b>{m.course} {m.sectionNo}분반</b>
                    <div className="muted">
                      표: {fmtSlots(m.table)} · 격자: {fmtSlots(m.grid)}
                      {' — 격자에 없는 요일: '}
                      <b>{m.badDays.map((d) => DAY[d]).join(', ')}</b>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {conflicts.length > 0 && (
            <div className="syl-conflicts">
              <div className="section-label adm-sub-label">⚠️ 같은 교수 · 같은 교시 ({conflicts.length})</div>
              <p className="note">
                한 교수가 같은 교시에 두 분반을 <b>동시에</b> 담당하는 것으로 읽혔습니다.
                같은 시간대에 나란히 열린 분반(예: 영어회화 4·5·6분반이 모두 목1교시)의 교수 이름을
                {isCsv ? ' CSV 에서 잘못 적었을' : ' AI 가 한 사람에게 몰아 붙였을'} 가능성이 큽니다.
                {isCsv ? ' 해당 행을 고쳐 다시 올리세요.' : ' ‘캐시 무시하고 다시 분석’으로 재시도하거나, CSV 로 바로잡아 올리세요.'}
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
            </div>
          )}

          {plan.periods.length > 0 && (
            <label className="adm-check syl-period">
              <input type="checkbox" checked={plan.includePeriods} onChange={(e) => patchPlan((p) => { p.includePeriods = e.target.checked; })} />
              교시 시각 {plan.periods.length}개도 갱신 ({plan.periods.map((p) => `${p.no}:${p.start}`).join(', ')})
            </label>
          )}

          {/* 전 생도 공통 비수업 시간 — 이 편람에서 어떤 분반도 열리지 않는 요일·교시.
              시각은 자동으로 나오고, 관리자는 이름만 붙인다(생도대시간·군사훈련·자율선택형교과). */}
          {plan.commonBlocks?.length > 0 && (
            <div className="syl-blocks">
              <div className="section-label adm-sub-label">
                전 생도 비수업 시간 ({plan.commonBlocks.length}) — 이름 붙이기
              </div>
              <p className="note">
                이 편람에서 <b>어떤 분반도 열리지 않는</b> 시간입니다(생도대시간·군사훈련·자율선택형교과 등).
                이름을 붙이면 <b>시간표 마법사 격자에 그대로 뜨고</b>, 마법사가 이 시간을
                <b> 빈 시간(공강)으로 세지 않습니다</b>. 비워 두면 이름 없이 ‘수업 없는 시간’으로만 보입니다
                (계산은 이름과 무관하게 됩니다).
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

              {/* 자동 유도는 '개설 분반 0개'인 칸만 찾는다. 월7·8, 수7·8 처럼 자율선택형교과(무도·
                  체력단련)가 열려 있는 시간은 강의가 있어서 못 찾는다 → 여기서 직접 넣는다. */}
              <p className="note">
                <b>월7·8, 수7·8</b>처럼 체육(무도·체력단련)만 열리는 <b>자율선택형교과</b> 시간은
                강의가 있어서 자동으로 잡히지 않습니다. 아래에서 직접 추가하세요 (한 번 넣으면 다음 편람 등록 때도 유지됩니다).
              </p>
              <div className="syl-block syl-block-new">
                <select value={nb.day} onChange={(e) => setNb({ ...nb, day: +e.target.value })}>
                  {[1, 2, 3, 4, 5].map((d) => <option key={d} value={d}>{DAY[d]}</option>)}
                </select>
                <input type="number" min="1" max="12" value={nb.start}
                  onChange={(e) => setNb({ ...nb, start: +e.target.value })} />
                <span className="syl-block-tilde">~</span>
                <input type="number" min="1" max="12" value={nb.end}
                  onChange={(e) => setNb({ ...nb, end: +e.target.value })} />
                <input className="syl-block-label" list="syl-block-names" maxLength={20}
                  placeholder="이름" value={nb.label}
                  onChange={(e) => setNb({ ...nb, label: e.target.value })} />
                <button className="btn-add btn-sm" onClick={addBlock}>＋ 추가</button>
              </div>
            </div>
          )}

          <div className="section-label adm-sub-label">교수 ({plan.professors.length}) — 매칭 확인</div>
          <div className="syl-list">
            {plan.professors.map((p, i) => (
              <div className={`syl-prof ${p.action === 'ambiguous' ? 'is-warn' : ''}`} key={p.name}>
                <div className="syl-prof-head">
                  <b>{p.name}</b>
                  <span className={`tag ${p.action === 'create' ? 'tag-primary' : p.action === 'ambiguous' ? 'tag-warn' : 'tag-success'}`}>
                    {p.action === 'create' ? '신규' : p.action === 'ambiguous' ? '동명이인?' : '기존'}
                  </span>
                </div>
                {p.candidates.length > 0 && (
                  <select value={p.code ?? '__new__'} onChange={(e) => setProfChoice(i, e.target.value)}>
                    <option value="__new__">+ 새 교수로 등록</option>
                    {p.candidates.map((c) => (
                      <option key={c.code} value={c.code}>{[c.department, c.code].filter(Boolean).join(' · ') || c.code}</option>
                    ))}
                  </select>
                )}
                <div className="syl-prof-meta">
                  <input placeholder="학과(추정)" value={p.department || ''} onChange={(e) => setProfField(i, 'department', e.target.value)} />
                </div>
              </div>
            ))}
          </div>

          <div className="section-label adm-sub-label">과목 · 분반 ({plan.courses.length})</div>
          <div className="syl-list">
            {plan.courses.map((c, i) => (
              <div className="syl-course" key={c.name}>
                <label className="syl-course-head">
                  <input type="checkbox" checked={c.include !== false} onChange={(e) => setCourseInclude(i, e.target.checked)} />
                  <b>{c.name}</b>
                  <span className={`tag ${c.code == null ? 'tag-primary' : 'tag-success'}`}>{c.code == null ? '신규' : '통합'}</span>
                  <span className="muted">{c.sections.length}분반</span>
                </label>
                <div className="syl-sections">
                  {c.sections.map((s) => (
                    <div className="syl-sec" key={s.sectionNo}>
                      <b>{s.sectionNo}분반</b>{s.reused ? <span className="tag tag-success">기존 분반</span> : null} · {s.professorName || '교수미정'} · {fmtTimes(s.times)}{s.room ? ` · ${s.room}` : ''}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {plan.stale.length > 0 && (
            <>
              <div className="section-label adm-sub-label">이 파일에 없는 기존 분반 ({plan.stale.length})</div>
              <p className="note">
                {plan.year}-{plan.term} 학기에 <b>이미 등록돼 있는데</b> 이번 파일에는 없는 분반입니다.
                다른 소스(CSV↔PDF)로 두 번 적재해 생긴 <b>중복</b>이거나 폐강된 분반일 수 있어요.
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
            </>
          )}

          <button className="btn-add btn-block" disabled={busy} onClick={apply}>{busy ? '적용 중…' : '검토 완료 — DB에 적용'}</button>
        </div>
      )}
    </div>
  );
}
