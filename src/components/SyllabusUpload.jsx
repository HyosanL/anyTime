import { useState } from 'react';
import { getCatalog } from '../lib/cache';

const DAY = { 1: '월', 2: '화', 3: '수', 4: '목', 5: '금', 6: '토', 7: '일' };
const fmtTimes = (blocks) =>
  (blocks || []).map((b) => `${DAY[b.day]}${b.start}${b.end > b.start ? `-${b.end}` : ''}`).join(' ') || '시간미정';

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
      if (isCsv) {
        const text = paste.trim() ? paste : await file.text();
        ({ rows, periods } = lib.parseCsvRows(text));
      } else {
        let model; let cachedPages; let coursePages;
        ({ rows, periods, errors = [], model, cachedPages, coursePages } = await lib.parseSyllabus(file, {
          noCache,
          onProgress: (d, t) => setProgress({ label: 'AI 분석 중…', done: d, total: t }),
        }));
        const billed = coursePages - cachedPages;
        setCost(`${model} · ${coursePages}장 중 ${cachedPages}장은 캐시(무과금), ${billed}장 호출`);
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
      const r = await lib.applyPlan(plan, { onProgress: (d, t) => setProgress({ label: '적용 중…', done: d, total: t }) });
      setResult(`✅ 적용 완료 — 과목 ${total}개(신규 ${r.courses}), 분반 ${r.sections}개, 교수 신규 ${plan.stats.newProfessors}개.`);
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

  const canAnalyze = isCsv ? (!!paste.trim() || !!file) : !!file;

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
            {plan.stats.ambiguous > 0 && <span className="tag tag-warn">동명이인 검토 {plan.stats.ambiguous}</span>}
          </div>

          {plan.periods.length > 0 && (
            <label className="adm-check syl-period">
              <input type="checkbox" checked={plan.includePeriods} onChange={(e) => patchPlan((p) => { p.includePeriods = e.target.checked; })} />
              교시 시각 {plan.periods.length}개도 갱신 ({plan.periods.map((p) => `${p.no}:${p.start}`).join(', ')})
            </label>
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
                      <b>{s.sectionNo}분반</b> · {s.professorName || '교수미정'} · {fmtTimes(s.times)}{s.room ? ` · ${s.room}` : ''}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <button className="btn-add btn-block" disabled={busy} onClick={apply}>{busy ? '적용 중…' : '검토 완료 — DB에 적용'}</button>
        </div>
      )}
    </div>
  );
}
