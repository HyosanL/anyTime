import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams, useLocation } from 'react-router-dom';
import { getCatalog } from '../lib/cache';
import { useAuthContext } from '../contexts/AuthContext';
import { callAdmin, CATALOG_ACTIONS } from '../lib/admin';
import { ProfessorPicker, SectionCard } from '../components/SectionCard';
import BackButton from '../components/BackButton';
import '../styles/admin.css';
import '../styles/course.css';

// 화면9-1: 과목 하나만 다루는 관리자 화면(/admin/courses/:code). 관리자 허브의 과목 검색에서
// 새 탭으로 열린다 — 목록 안에서 분반을 펼쳐 고치면 어느 과목을 만지는 중인지 헷갈린다.
// 이 화면에서는 화면 전체가 한 과목이므로, 분반·교수·강의시간을 그 자리에서 바로 고친다.
// 분반 카드 자체(SectionCard/ProfessorPicker)는 components/SectionCard.jsx 로 뽑혀 있다 —
// Admin.jsx 의 "빈 정보 분반"도 같은 걸 쓴다.
const CORR_FIELD_LABEL = { time: '요일·교시', room: '강의실', professor: '담당교수', name: '과목명', section: '분반 추가' };

const keyOf = (s) => `${s.year}-${s.term}-${s.sectionNo}`;

// 분반추가 제안값(JSON) → 화면·프리필용. prof 표기 "이름 (코드)"에서 기존 교수코드도 뽑는다("신규"는 제외).
function parseSectionAdd(suggested) {
  try {
    const j = JSON.parse(suggested);
    const codeM = String(j.prof || '').match(/\(([^()]+)\)\s*$/);
    const code = codeM && codeM[1] !== '신규' ? codeM[1] : '';
    return { no: Number(j.no) || null, prof: j.prof || '', profCode: code, room: j.room || '', times: j.times || '' };
  } catch { return null; }
}


// 새 분반 — 학기·분반번호·담당 교수만 정하면 만들어지고, 강의시간은 만든 분반을 펼쳐 넣는다.
// prefill: 수정제안(분반추가)에서 넘어왔을 때 분반번호·학기·교수를 미리 채운다.
function NewSectionCard({ courseCode, sections, semesters, professors, run, defYear, defTerm, onAdded, prefill }) {
  const [f, setF] = useState({
    year: prefill?.year ?? defYear, term: prefill?.term ?? defTerm,
    sectionNo: prefill?.sectionNo ?? 1, professorCode: prefill?.professorCode ?? '',
  });
  // 프리필이 있으면 첫 자동번호 계산을 한 번 건너뛴다(제안한 번호가 살아남게).
  const skipAuto = useRef(!!prefill);

  // 그 학기에 아직 없는 분반번호를 미리 채운다(학기를 바꾸면 다시 계산).
  useEffect(() => {
    if (skipAuto.current) { skipAuto.current = false; return; }
    const used = sections
      .filter((s) => s.courseCode === courseCode && s.year === f.year && s.term === f.term)
      .map((s) => s.sectionNo);
    setF((cur) => ({ ...cur, sectionNo: used.length ? Math.max(...used) + 1 : 1 }));
  }, [sections, courseCode, f.year, f.term]);

  const sems = semesters.length
    ? [...semesters].sort((a, b) => b.year - a.year || b.term - a.term)
    : [{ year: defYear, term: defTerm }];

  return (
    <div className="adm-sec-card adm-sec-card-new">
      <div className="section-label adm-sub-label">새 분반 추가</div>
      <div className="adm-form-grid">
        <label className="field"><span className="field-label">학기</span>
          <select value={`${f.year}-${f.term}`}
            onChange={(e) => { const [y, t] = e.target.value.split('-').map(Number); setF({ ...f, year: y, term: t }); }}>
            {sems.map((s) => (
              <option key={`${s.year}-${s.term}`} value={`${s.year}-${s.term}`}>
                {s.year}-{s.term}{s.isCurrent ? ' (현재)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="field"><span className="field-label">분반</span>
          <input type="number" min="1" value={f.sectionNo}
            onChange={(e) => setF({ ...f, sectionNo: +e.target.value })} />
        </label>
      </div>
      <div className="field">
        <span className="field-label">담당 교수</span>
        <ProfessorPicker professors={professors} value={f.professorCode}
          onChange={(code) => setF({ ...f, professorCode: code })} />
      </div>
      <button className="btn-add btn-block"
        onClick={async () => {
          const payload = {
            courseCode, year: f.year, term: f.term, sectionNo: f.sectionNo,
            professorCode: f.professorCode || null,
          };
          const r = await run('set_section', payload, `${f.sectionNo}분반 추가`);
          if (r.ok) { setF({ ...f, professorCode: '' }); onAdded(keyOf(payload)); }
        }}>＋ 분반 추가</button>
    </div>
  );
}

export default function AdminCourse() {
  const { code } = useParams();
  const [sp] = useSearchParams();
  const location = useLocation();
  const { cadet } = useAuthContext();
  const isAdmin = cadet ? !!cadet.isAdmin : null;
  const [cat, setCat] = useState(null);
  const [msg, setMsg] = useState('');
  const [name, setName] = useState('');
  const [open, setOpen] = useState('');   // 펼친 분반 키
  const [gone, setGone] = useState(false); // 과목을 지운 뒤
  // 수정 제안에서 딥링크로 넘어온 경우: 배너로 제안값을 보여 주고, 한 번에 적용/정리한다.
  const [corr, setCorr] = useState(location.state?.corr ?? null);
  const corrId = sp.get('corr');
  const secParam = sp.get('sec');
  const addParam = sp.get('add');
  const newSecRef = useRef(null);

  useEffect(() => {
    if (isAdmin) getCatalog().then(setCat).catch(() => setCat(null));
  }, [isAdmin]);

  // 새로고침 등으로 라우터 state 가 사라졌으면 id 로 제안을 다시 읽는다.
  useEffect(() => {
    if (!isAdmin || corr || !corrId) return;
    callAdmin('get_correction', { id: Number(corrId) }).then((r) => { if (r.ok && r.data?.item) setCorr(r.data.item); });
  }, [isAdmin, corr, corrId]);

  // 딥링크로 지정된 분반을 펼치거나(분반추가면 새 분반 카드로 스크롤).
  useEffect(() => {
    if (secParam) setOpen(secParam);
  }, [secParam]);
  useEffect(() => {
    if (addParam && newSecRef.current) newSecRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [addParam, cat]);

  const course = useMemo(
    () => (cat?.courses ?? []).find((c) => c.code === code) || null,
    [cat, code]
  );
  // 과목명 입력칸은 과목이 처음 잡힐 때만 채운다(저장 후 카탈로그가 갱신돼도 입력 중인 값을 덮지 않게).
  useEffect(() => { if (course) setName((v) => v || course.name || ''); }, [course]);

  const professors = cat?.professors ?? [];
  const semesters = cat?.semesters ?? [];
  const periods = useMemo(() => {
    const ps = [...(cat?.periods ?? [])].map((p) => p.no).sort((a, b) => a - b);
    return ps.length ? ps : [1, 2, 3, 4, 5, 6, 7, 8];
  }, [cat]);
  const curSem = semesters.find((s) => s.isCurrent) || semesters[0] || { year: 2026, term: 1 };

  const sections = useMemo(() => (cat?.sections ?? [])
    .filter((s) => s.courseCode === code)
    .sort((a, b) => b.year - a.year || b.term - a.term || a.sectionNo - b.sectionNo),
  [cat, code]);
  // sectionTimes 는 section 문서에 배열로 임베드돼 있다(설계 §3) — 옛 section_time 별도 테이블
  // 조인이 필요 없다.
  const timesOf = (s) => [...(s.sectionTimes ?? [])]
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startPeriod - b.startPeriod);

  async function run(action, payload, okMsg) {
    setMsg('');
    const r = await callAdmin(action, payload);
    setMsg(r.ok ? `✅ ${okMsg}` : `⚠️ 실패: ${r.status ?? '오류'}`);
    if (r.ok && CATALOG_ACTIONS.has(action)) setCat(await getCatalog({ force: true }).catch(() => cat));
    return r;
  }

  async function deleteCourse() {
    if (!confirm(`'${course.name}' 과목과 분반 ${sections.length}개·강의시간이 모두 삭제됩니다. 되돌릴 수 없습니다.`)) return;
    const r = await run('delete_catalog', { table: 'course', key: { code } }, '과목 삭제');
    if (r.ok) setGone(true);
  }

  // 분반추가 제안 → NewSectionCard 프리필(분반번호·학기·기존 교수코드).
  const addPrefill = useMemo(() => {
    if (!addParam || corr?.target !== 'section_add' || !corr?.suggested) return null;
    const sa = parseSectionAdd(corr.suggested);
    if (!sa) return null;
    return { sectionNo: sa.no ?? 1, year: corr.year, term: corr.term, professorCode: sa.profCode || '' };
  }, [addParam, corr]);

  // 제안대로 적용: 대표 1건 반영 + 동일 묶음 나머지 정리 + 카탈로그 새로고침.
  async function applyProposal() {
    if (!corr) return;
    setMsg('');
    const r = await callAdmin('apply_correction', { id: corr.id });
    if (!r.ok && r.status !== 'ALREADY_DONE') { setMsg(`⚠️ 적용 실패: ${r.status ?? '오류'}`); return; }
    const others = (corr.ids || []).filter((id) => id !== corr.id);
    if (others.length) await callAdmin('resolve_correction', { ids: others });
    setCat(await getCatalog({ force: true }).catch(() => cat));
    setMsg(r.status === 'ALREADY_DONE' ? '✅ 이미 반영돼 있어 제안만 정리했습니다.' : '✅ 제안을 반영했습니다.');
    setCorr(null);
  }
  // 제안 정리: 반영 없이 큐에서 삭제(직접 고친 뒤 처리완료).
  async function dismissProposal() {
    if (!corr) return;
    await callAdmin('resolve_correction', { ids: corr.ids || [corr.id] });
    setMsg('✅ 제안을 정리했습니다.');
    setCorr(null);
  }

  if (isAdmin === null || (isAdmin && !cat)) return <div className="page-center">불러오는 중…</div>;
  if (!isAdmin) return (
    <div className="page">
      <header className="page-header"><BackButton /><h2>과목 관리</h2></header>
      <div className="empty"><span className="empty-emoji">🔒</span><p>관리자 권한이 없습니다.</p></div>
    </div>
  );
  if (gone || !course) return (
    <div className="page admin">
      <header className="page-header"><BackButton fallback="/admin/courses" /><h2>과목 관리</h2></header>
      <div className="empty">
        <span className="empty-emoji">{gone ? '🗑️' : '🤔'}</span>
        <p>{gone ? '과목을 삭제했습니다. 이 탭은 닫아도 됩니다.' : '없는 과목입니다.'}</p>
      </div>
    </div>
  );

  return (
    <div className="page admin">
      <header className="page-header">
        <BackButton fallback="/admin/courses" />
        <h2>{course.name}</h2>
      </header>
      <p className="note adm-course-sub">{[course.code, course.department].filter(Boolean).join(' · ')}</p>

      {msg && <p className={`admin-msg ${msg.startsWith('⚠️') ? 'is-fail' : 'is-ok'}`}>{msg}</p>}

      {corr && (() => {
        const sa = corr.target === 'section_add' ? parseSectionAdd(corr.suggested) : null;
        const shown = sa
          ? [`${sa.no}분반`, sa.prof || '교수 미정', sa.times || '시간 미정', sa.room ? `강의실 ${sa.room}` : ''].filter(Boolean).join(' · ')
          : corr.suggested;
        return (
          <div className="adm-corr-banner">
            <div className="adm-corr-banner-head">
              <span className="tag tag-primary">🚩 {corr.target === 'section_add' ? '분반 추가 제안' : `수정 제안 · ${CORR_FIELD_LABEL[corr.field] || corr.field}`}</span>
              {corr.count > 1 && <span className="tag mod-badge">동일 {corr.count}건</span>}
            </div>
            <p className="adm-corr-banner-val">제안값: <b>{shown || '(없음)'}</b></p>
            {corr.note && <p className="note">설명: {corr.note}</p>}
            <p className="note">
              {corr.target === 'section_add'
                ? '아래 «새 분반 추가»에 값이 채워져 있습니다. 그대로 만들거나 고쳐서 추가한 뒤, 또는 아래 버튼으로 한 번에 반영하세요.'
                : '해당 분반이 아래에 펼쳐져 있습니다. 값을 확인하고 직접 고치거나, 아래 버튼으로 제안값을 그대로 반영하세요.'}
            </p>
            <div className="adm-corr-banner-acts">
              <button className="btn-add btn-sm" onClick={applyProposal}>
                {corr.target === 'section_add' ? '제안대로 분반 생성' : '제안대로 적용'}
              </button>
              <button className="rev-del-btn" onClick={dismissProposal}>제안 정리(직접 수정함)</button>
            </div>
          </div>
        );
      })()}

      <div className="cards admin-cards">
        <section className="card admin-card">
          <div className="card-head">
            <span className="card-ic">📚</span>
            <div>
              <div className="card-title">분반 ({sections.length})</div>
              <div className="card-desc">분반을 펼쳐 담당 교수와 강의시간을 고칩니다. 담당 교수는 이름·학과로 검색해 고릅니다.</div>
            </div>
          </div>
          <div className="card-body">
            {sections.length === 0 && <p className="note">등록된 분반이 없습니다. 아래에서 추가하세요.</p>}
            <div className="adm-sec-list">
              {sections.map((s) => {
                const k = keyOf(s);
                return (
                  <SectionCard key={k} s={s} times={timesOf(s)} professors={professors} periods={periods}
                    run={run} open={open === k} onToggle={() => setOpen(open === k ? '' : k)} />
                );
              })}
            </div>

            <div className="divider adm-divider" ref={newSecRef} />
            <NewSectionCard courseCode={code} sections={cat.sections ?? []} semesters={semesters}
              professors={professors} run={run} defYear={curSem.year} defTerm={curSem.term}
              onAdded={(k) => setOpen(k)} prefill={addPrefill} />
          </div>
        </section>

        <section className="card admin-card">
          <div className="card-head">
            <span className="card-ic">✏️</span>
            <div>
              <div className="card-title">과목 정보</div>
              <div className="card-desc">과목명을 고치거나 과목을 삭제합니다. 과목코드는 바꿀 수 없습니다.</div>
            </div>
          </div>
          <div className="card-body">
            <label className="field"><span className="field-label">과목명</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="과목명" />
            </label>
            <button className="btn-add btn-block" disabled={!name.trim() || name.trim() === course.name}
              onClick={() => run('set_course', { code, name: name.trim() }, '과목명 저장')}>
              {name.trim() === course.name ? '저장됨' : '과목명 저장'}
            </button>

            <div className="divider adm-divider" />
            <button className="btn-danger btn-block" onClick={deleteCourse}>
              과목 삭제 (분반 {sections.length}개 · 강의시간 함께 삭제)
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
