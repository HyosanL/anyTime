import { useState } from 'react';
import { getCatalog } from '../lib/cache';

const DAY = { 1: '월', 2: '화', 3: '수', 4: '목', 5: '금', 6: '토', 7: '일' };
const fmtTimes = (blocks) =>
  (blocks || []).map((b) => `${DAY[b.day]}${b.start}${b.end > b.start ? `-${b.end}` : ''}`).join(' ') || '시간미정';

// 관리자: 강의 PDF → Workers AI 파싱 → 기존 DB 대조 → 검토 후 적용.
export default function AiSyllabusUpload({ defaultYear = 2026, defaultTerm = 1, onApplied }) {
  const [file, setFile] = useState(null);
  const [year, setYear] = useState(defaultYear);
  const [term, setTerm] = useState(defaultTerm);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [plan, setPlan] = useState(null);
  const [err, setErr] = useState('');
  const [result, setResult] = useState('');

  function patchPlan(updater) {
    setPlan((p) => {
      const next = { ...p };
      updater(next);
      return next;
    });
  }

  async function analyze() {
    if (!file) return setErr('PDF 파일을 선택하세요.');
    setErr(''); setResult(''); setPlan(null); setBusy(true);
    setProgress({ label: 'PDF 읽는 중…', done: 0, total: 0 });
    try {
      const lib = await import('../lib/syllabus');
      const catalog = await getCatalog({ force: true }).catch(() => null);
      const { rows, periods } = await lib.parseSyllabus(file, {
        onProgress: (d, t) => setProgress({ label: 'AI 분석 중…', done: d, total: t }),
      });
      if (!rows.length) { setErr('추출된 과목이 없습니다. 다른 PDF이거나 형식이 다를 수 있어요.'); return; }
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
      setPlan(null); setFile(null);
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
        if (cand) { pr.department = cand.department ?? pr.department; pr.title = cand.title ?? pr.title; }
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

  return (
    <div className="syl">
      <p className="note">
        학기 강의 PDF(수강편람)를 올리면 AI가 과목·분반·교수·시간을 뽑아 <b>기존 DB와 대조</b>합니다.
        교수는 <b>이름으로 매칭</b>하고(동명이인은 과목 이력으로 보정), 새 교수는 자동 등록(코드 자동). <b>적용 전 반드시 검토</b>하세요.
      </p>

      <div className="adm-form-grid">
        <label className="field"><span className="field-label">연도</span>
          <input type="number" value={year} onChange={(e) => setYear(e.target.value)} /></label>
        <label className="field"><span className="field-label">학기</span>
          <select value={term} onChange={(e) => setTerm(e.target.value)}><option value={1}>1</option><option value={2}>2</option></select></label>
      </div>
      <label className="board-file-field syl-file">
        <span className="board-file-label">📄 강의 PDF 선택{file ? ` · ${file.name}` : ''}</span>
        <input type="file" accept="application/pdf,.pdf" onChange={(e) => { setFile(e.target.files?.[0] || null); setPlan(null); setResult(''); }} />
      </label>
      <button className="btn-add btn-block" disabled={busy || !file} onClick={analyze}>{busy && !plan ? '분석 중…' : 'PDF 분석'}</button>

      {progress && (
        <p className="note syl-progress">{progress.label}{progress.total ? ` (${progress.done}/${progress.total})` : ''}</p>
      )}
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
                      <option key={c.code} value={c.code}>{[c.title, c.department, c.code].filter(Boolean).join(' · ') || c.code}</option>
                    ))}
                  </select>
                )}
                <div className="syl-prof-meta">
                  <input placeholder="학과(추정)" value={p.department || ''} onChange={(e) => setProfField(i, 'department', e.target.value)} />
                  <input placeholder="계급(모르면 비움)" value={p.title || ''} onChange={(e) => setProfField(i, 'title', e.target.value)} />
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
                  <span className="muted">{c.sections.length}분반{c.credits ? ` · ${c.credits}학점` : ''}</span>
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
