import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase } from '../supabase';
import { getCatalog } from '../lib/cache';

// 화면9: 관리자. is_admin 게이트. 작업은 admin-action Edge Function(service-role).
// 라우팅: '/admin'=허브, '/admin/:section'=기능 화면. '/admin/moderation'은 별도 페이지(Moderation.jsx).
async function call(action, payload = {}) {
  const { data, error } = await supabase.functions.invoke('admin-action', { body: { action, payload } });
  let status = data?.status;
  if (error) { try { status = (await error.context?.json?.())?.status; } catch { /* ignore */ } }
  return { ok: status === 'OK', status, data };
}

// 기능 카드: 이모지 아이콘 + 제목 + 한 줄 설명 + 본문
function Card({ icon, title, desc, children }) {
  return (
    <section className="card admin-card">
      <div className="card-head">
        <span className="card-ic">{icon}</span>
        <div>
          <div className="card-title">{title}</div>
          {desc && <div className="card-desc">{desc}</div>}
        </div>
      </div>
      <div className="card-body">{children}</div>
    </section>
  );
}

const DAY_KO = { 1: '월', 2: '화', 3: '수', 4: '목', 5: '금', 6: '토', 7: '일' };

// 허브 항목 정의 (key는 라우팅 section 과 일치). moderation 은 별도 페이지로 링크.
const SECTIONS = [
  { key: 'courses', icon: '📚', title: '과목 · 분반', sub: '과목 검색·추가, 분반·강의시간 관리' },
  { key: 'csv', icon: '📥', title: 'CSV 일괄 업로드', sub: '양식으로 과목·분반을 한 번에 등록' },
  { key: 'professors', icon: '👤', title: '교수', sub: '교수 검색·추가·수정·삭제' },
  { key: 'semesters', icon: '🗓️', title: '학기 · 교시', sub: '현재 학기와 교시 시각 설정' },
  { key: 'signup', icon: '🔑', title: '가입코드', sub: '신규 가입 코드 확인·변경' },
  { key: 'settings', icon: '⚙️', title: '지오펜싱 · 기간', sub: '캠퍼스 위치·반경·각종 기간' },
  { key: 'board', icon: '💬', title: '게시판 관리', sub: '활성화·게시판별/전체 글 삭제' },
  { key: 'moderation', icon: '🧹', title: '모더레이션', sub: '신고·자동필터 강의평 검토', to: '/admin/moderation' },
  { key: 'admins', icon: '🛡️', title: '관리자', sub: '관리자 권한 부여·취소' },
];
const TITLE_OF = Object.fromEntries(SECTIONS.map((s) => [s.key, s.title]));

// CSV 파싱: name,department,credits,professor_code,year,term,section_no,times  (times: "월1,수1" / "금7-8")
function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map((s) => s.trim());
  const ix = (k) => header.indexOf(k);
  const DAY = { 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6, 일: 7 };
  const parseTimes = (s) => (s || '').split(/[;]/).flatMap((g) => g.split(',')).map((t) => t.trim()).filter(Boolean)
    .map((t) => { const day = DAY[t[0]]; const [a, b] = t.slice(1).split('-').map(Number); return { day, start: a, end: b || a }; })
    .filter((t) => t.day && t.start);
  const byName = {};
  for (const line of lines.slice(1)) {
    const c = line.split(',').map((s) => s.trim());
    const name = c[ix('name')];
    if (!name) continue;
    const co = (byName[name] ??= { name, department: c[ix('department')] || null, credits: Number(c[ix('credits')]) || null, sections: [] });
    co.sections.push({
      section_no: Number(c[ix('section_no')]) || 1, year: Number(c[ix('year')]) || 2026, term: Number(c[ix('term')]) || 1,
      professor_code: c[ix('professor_code')] || null, times: parseTimes(c[ix('times')]),
    });
  }
  return Object.values(byName);
}

const CSV_HEADER = 'name,department,credits,professor_code,year,term,section_no,times';
function downloadCsvTemplate() {
  const sample = [
    CSV_HEADER,
    '컴퓨터구조,전산학과,3,P01,2026,1,1,월1;수1',
    '선형대수,기초과학과,3,P02,2026,1,2,화2;목2',
    '리더십,,2,P05,2026,1,1,금7-8',
  ].join('\n');
  const blob = new Blob(['﻿' + sample], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'anytime_과목분반_양식.csv';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

export default function Admin() {
  const { section } = useParams();
  const [isAdmin, setIsAdmin] = useState(null);
  const [cat, setCat] = useState(null);
  const [msg, setMsg] = useState('');

  const [admins, setAdmins] = useState([]);
  const [currentCode, setCurrentCode] = useState('');
  const [setting, setSetting] = useState({});
  const [boardsList, setBoardsList] = useState([]);

  // 폼 상태
  const [q, setQ] = useState('');
  const [selCourse, setSelCourse] = useState('');
  const [newCode, setNewCode] = useState('');
  const [adminUser, setAdminUser] = useState('');
  const [course, setCourse] = useState({ code: '', name: '', department: '', credits: 3 });
  const [prof, setProf] = useState({ code: '', name: '', department: '', title: '' });
  const [pq, setPq] = useState('');
  const [sem, setSem] = useState({ year: 2026, term: 1, is_current: true });
  const [per, setPer] = useState({ no: 1, start_time: '09:00', end_time: '09:50' });
  const [sec, setSec] = useState({ year: 2026, term: 1, section_no: 1, professor_code: '', capacity: 40 });
  const [stForm, setStForm] = useState({ day_of_week: 1, start_period: 1, end_period: 1, room: '' });
  const [csv, setCsv] = useState('');

  async function loadAll() {
    setCat(await getCatalog({ force: true }).catch(() => null));
    call('list_admins').then((r) => r.ok && setAdmins(r.data.admins ?? []));
    call('get_signup_code').then((r) => r.ok && setCurrentCode(r.data.code ?? ''));
    call('get_app_setting').then((r) => r.ok && setSetting(r.data.setting ?? {}));
    supabase.from('board').select('id, name').order('last_activity_at', { ascending: false }).then(({ data }) => setBoardsList(data || []));
  }
  useEffect(() => {
    supabase.rpc('is_admin').then(({ data }) => { setIsAdmin(!!data); if (data) loadAll(); });
  }, []);

  // 섹션이 바뀌면 메시지를 비워 깔끔하게 시작
  useEffect(() => { setMsg(''); }, [section]);

  async function run(action, payload, okMsg) {
    setMsg('');
    const r = await call(action, payload);
    setMsg(r.ok ? `✅ ${okMsg}` : `⚠️ 실패: ${r.status ?? '오류'}`);
    if (r.ok) loadAll();
    return r;
  }

  const courses = cat?.course ?? [];
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return courses.filter((c) => !s || c.name.toLowerCase().includes(s) || c.code.toLowerCase().includes(s));
  }, [courses, q]);
  const secOf = (code) => (cat?.section ?? []).filter((x) => x.course_code === code);
  const timesOf = (s) => (cat?.section_time ?? [])
    .filter((t) => t.course_code === s.course_code && t.year === s.year && t.term === s.term && t.section_no === s.section_no)
    .map((t) => (t.start_period === t.end_period ? `${DAY_KO[t.day_of_week]}${t.start_period}` : `${DAY_KO[t.day_of_week]}${t.start_period}-${t.end_period}`)).join(', ');

  if (isAdmin === null) return <div className="page-center">확인 중…</div>;
  if (!isAdmin) return (
    <div className="page">
      <header className="page-header">
        <Link to="/" className="link-btn">← 홈</Link>
        <h2>관리자</h2>
      </header>
      <div className="empty">
        <span className="empty-emoji">🔒</span>
        <p>관리자 권한이 없습니다.</p>
      </div>
    </div>
  );

  const isFail = msg.startsWith('⚠️');
  const banner = msg && <p className={`admin-msg ${isFail ? 'is-fail' : 'is-ok'}`}>{msg}</p>;

  // ───────────────────────── 허브(/admin) ─────────────────────────
  if (!section) {
    return (
      <div className="page admin">
        <header className="page-header">
          <Link to="/" className="link-btn">← 홈</Link>
          <h2>관리자</h2>
        </header>
        {banner}
        <p className="note adm-hub-intro">관리할 기능을 선택하세요.</p>
        <ul className="list adm-hub-list">
          {SECTIONS.map((s) => (
            <li key={s.key}>
              <Link to={s.to || `/admin/${s.key}`} className="list-row">
                <span className="row-lead">{s.icon}</span>
                <div className="row-body">
                  <div className="row-title"><span className="row-title-text">{s.title}</span></div>
                  <div className="row-sub">{s.sub}</div>
                </div>
                <span className="row-chevron">›</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  // 알 수 없는 섹션
  if (!TITLE_OF[section]) {
    return (
      <div className="page admin">
        <header className="page-header">
          <Link to="/admin" className="link-btn">← 관리자</Link>
          <h2>관리자</h2>
        </header>
        <div className="empty">
          <span className="empty-emoji">🤔</span>
          <p>알 수 없는 기능입니다.</p>
          <Link to="/admin" className="link-btn">허브로 돌아가기</Link>
        </div>
      </div>
    );
  }

  // ───────────────────────── 기능 화면(/admin/:section) ─────────────────────────
  return (
    <div className="page admin">
      <header className="page-header">
        <Link to="/admin" className="link-btn">← 관리자</Link>
        <h2>{TITLE_OF[section]}</h2>
      </header>

      {banner}

      <div className="cards admin-cards">
        {section === 'courses' && (
          <Card icon="📚" title="과목 · 분반 관리" desc="과목을 검색해 분반·강의시간을 관리하고, 아래에서 과목을 추가/수정합니다. 과목코드는 자동 부여됩니다.">
            <div className="search-bar adm-inline-search">
              <input type="search" placeholder="과목 검색 (이름 또는 코드)" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>

            <ul className="list adm-list">
              {filtered.map((c) => (
                <li key={c.code} className={`adm-item ${selCourse === c.code ? 'open' : ''}`}>
                  <div className="adm-item-row">
                    <div className="adm-item-body">
                      <div className="adm-item-title">{c.name}</div>
                      <div className="adm-item-sub">{[c.code, c.department, c.credits ? `${c.credits}학점` : ''].filter(Boolean).join(' · ')}</div>
                    </div>
                    <div className="adm-item-acts">
                      <button className="btn-ghost btn-sm" onClick={() => setSelCourse(selCourse === c.code ? '' : c.code)}>{selCourse === c.code ? '닫기' : '분반'}</button>
                      <button className="link-btn" onClick={() => setCourse({ code: c.code, name: c.name || '', department: c.department || '', credits: c.credits || 3 })}>수정</button>
                      <button className="rev-del-btn" onClick={() => { if (confirm(`'${c.name}' 과목과 분반·강의시간이 모두 삭제됩니다.`)) run('delete_catalog', { table: 'course', key: { code: c.code } }, '과목 삭제'); }}>삭제</button>
                    </div>
                  </div>

                  {selCourse === c.code && (
                    <div className="adm-expand">
                      <div className="section-label adm-sub-label">이 과목의 분반</div>
                      {secOf(c.code).length === 0 && <p className="note">등록된 분반이 없습니다. 아래에서 추가하세요.</p>}
                      {secOf(c.code).map((s) => (
                        <div key={s.section_no + '-' + s.year + s.term} className="adm-chip-row">
                          <span className="adm-chip-text">{s.year}-{s.term} · {s.section_no}분반 · {(cat.professor.find((p) => p.code === s.professor_code) || {}).name || '교수미정'} · {timesOf(s) || '시간미정'}</span>
                          <button className="rev-del-btn" onClick={() => run('delete_catalog', { table: 'section', key: { course_code: s.course_code, year: s.year, term: s.term, section_no: s.section_no } }, '분반 삭제')}>삭제</button>
                        </div>
                      ))}

                      <div className="section-label adm-sub-label">분반 추가 / 수정</div>
                      <div className="adm-form-grid">
                        <label className="field"><span className="field-label">연도</span><input type="number" value={sec.year} onChange={(e) => setSec({ ...sec, year: +e.target.value })} /></label>
                        <label className="field"><span className="field-label">학기</span><input type="number" value={sec.term} onChange={(e) => setSec({ ...sec, term: +e.target.value })} /></label>
                        <label className="field"><span className="field-label">분반</span><input type="number" value={sec.section_no} onChange={(e) => setSec({ ...sec, section_no: +e.target.value })} /></label>
                        <label className="field"><span className="field-label">교수</span>
                          <select value={sec.professor_code} onChange={(e) => setSec({ ...sec, professor_code: e.target.value })}>
                            <option value="">교수 선택</option>{cat.professor.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
                          </select>
                        </label>
                      </div>
                      <button className="btn-add btn-block" onClick={() => run('set_section', { course_code: c.code, ...sec }, '분반 추가/수정')}>분반 추가</button>

                      <div className="section-label adm-sub-label">강의시간 추가 (위 분반에)</div>
                      <div className="adm-form-grid">
                        <label className="field"><span className="field-label">요일</span>
                          <select value={stForm.day_of_week} onChange={(e) => setStForm({ ...stForm, day_of_week: +e.target.value })}>{[1, 2, 3, 4, 5, 6, 7].map((d) => <option key={d} value={d}>{DAY_KO[d]}</option>)}</select>
                        </label>
                        <label className="field"><span className="field-label">시작교시</span><input type="number" value={stForm.start_period} onChange={(e) => setStForm({ ...stForm, start_period: +e.target.value })} /></label>
                        <label className="field"><span className="field-label">끝교시</span><input type="number" value={stForm.end_period} onChange={(e) => setStForm({ ...stForm, end_period: +e.target.value })} /></label>
                        <label className="field"><span className="field-label">강의실</span><input placeholder="예: 본관 201" value={stForm.room} onChange={(e) => setStForm({ ...stForm, room: e.target.value })} /></label>
                      </div>
                      <button className="btn-add btn-block" onClick={() => run('set_section_time', { course_code: c.code, year: sec.year, term: sec.term, section_no: sec.section_no, ...stForm }, '강의시간 추가')}>강의시간 추가</button>
                    </div>
                  )}
                </li>
              ))}
              {filtered.length === 0 && <li className="note adm-empty-row">검색 결과가 없습니다.</li>}
            </ul>

            <div className="divider adm-divider" />
            <div className="section-label adm-sub-label">{course.code ? `과목 수정 (${course.code})` : '새 과목 추가'}</div>
            <div className="adm-form-grid">
              <label className="field"><span className="field-label">과목명</span><input placeholder={course.code ? '과목명' : '새 과목명'} value={course.name} onChange={(e) => setCourse({ ...course, name: e.target.value })} /></label>
              <label className="field"><span className="field-label">학과</span><input placeholder="예: 전산학과" value={course.department} onChange={(e) => setCourse({ ...course, department: e.target.value })} /></label>
              <label className="field"><span className="field-label">학점</span><input type="number" value={course.credits} onChange={(e) => setCourse({ ...course, credits: +e.target.value })} /></label>
            </div>
            {course.code ? (
              <div className="adm-btn-row">
                <button className="btn-add" onClick={async () => { const r = await run('set_course', course, '과목 수정'); if (r.ok) setCourse({ code: '', name: '', department: '', credits: 3 }); }}>저장</button>
                <button className="rev-del-btn" onClick={() => setCourse({ code: '', name: '', department: '', credits: 3 })}>취소</button>
              </div>
            ) : (
              <button className="btn-add btn-block" onClick={async () => { if (!course.name.trim()) return; const r = await run('add_course', course, '과목 추가(코드 자동)'); if (r.ok) setCourse({ code: '', name: '', department: '', credits: 3 }); }}>과목 추가 (코드 자동)</button>
            )}
          </Card>
        )}

        {section === 'csv' && (
          <Card icon="📥" title="CSV 일괄 업로드" desc="과목과 분반을 한 번에 등록합니다. 한 행 = 한 분반, 같은 과목명은 하나로 묶이며 과목코드는 자동 부여됩니다.">
            <ol className="adm-steps">
              <li><b>① 양식 다운로드</b> — 아래 버튼으로 CSV 양식을 받습니다.</li>
              <li><b>② 엑셀에서 수정</b> — 과목·분반 정보를 채웁니다.</li>
              <li><b>③ 붙여넣기 / 업로드</b> — 파일을 선택하거나 내용을 붙여넣고 업로드합니다.</li>
            </ol>
            <p className="note">times는 <b>세미콜론(;)</b>으로 구분합니다. 예: <code>월1;수1</code>, 연강은 <code>금7-8</code>.</p>

            <div className="adm-btn-row">
              <button className="btn-add" onClick={downloadCsvTemplate}>📄 양식 CSV 다운로드</button>
              <label className="btn-ghost btn-sm adm-file-label">
                파일 선택
                <input type="file" accept=".csv" className="adm-file-input" onChange={(e) => {
                  const f = e.target.files?.[0]; if (!f) return;
                  const r = new FileReader(); r.onload = () => setCsv(String(r.result || '').replace(/^﻿/, '')); r.readAsText(f, 'utf-8');
                }} />
              </label>
            </div>

            <label className="field">
              <span className="field-label">CSV 내용</span>
              <textarea rows={5} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={CSV_HEADER + '\n컴퓨터구조,전산학과,3,P01,2026,1,1,월1;수1'} className="adm-csv-area" />
            </label>
            <button className="btn-add btn-block" onClick={async () => {
              const list = parseCsv(csv);
              if (!list.length) { setMsg('⚠️ CSV 파싱 결과 없음 (양식 확인)'); return; }
              const r = await run('bulk_catalog', { courses: list }, `${list.length}개 과목 일괄 등록`);
              if (r.ok) setCsv('');
            }}>업로드</button>
          </Card>
        )}

        {section === 'professors' && (
          <Card icon="👤" title="교수 관리" desc="교수를 검색해 수정/삭제하고, 아래에서 새 교수를 추가합니다. 교수코드는 자동 부여됩니다.">
            <div className="search-bar adm-inline-search">
              <input type="search" placeholder="교수 검색 (성명/학과/계급)" value={pq} onChange={(e) => setPq(e.target.value)} />
            </div>
            <ul className="list adm-list adm-list-scroll">
              {(cat?.professor ?? []).filter((p) => { const s = pq.trim().toLowerCase(); return !s || [p.name, p.department, p.title, p.code].some((v) => (v || '').toLowerCase().includes(s)); }).map((p) => (
                <li key={p.code} className="adm-item">
                  <div className="adm-item-row">
                    <div className="adm-item-body">
                      <div className="adm-item-title">{p.name}</div>
                      <div className="adm-item-sub">{[p.title, p.department, p.code].filter(Boolean).join(' · ')}</div>
                    </div>
                    <div className="adm-item-acts">
                      <button className="link-btn" onClick={() => setProf({ code: p.code, name: p.name || '', department: p.department || '', title: p.title || '' })}>수정</button>
                      <button className="rev-del-btn" onClick={() => run('delete_catalog', { table: 'professor', key: { code: p.code } }, '교수 삭제')}>삭제</button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>

            <div className="divider adm-divider" />
            <div className="section-label adm-sub-label">{prof.code ? `교수 수정 (${prof.code})` : '새 교수 추가'}</div>
            <div className="adm-form-grid">
              <label className="field"><span className="field-label">성명</span><input placeholder="성명" value={prof.name} onChange={(e) => setProf({ ...prof, name: e.target.value })} /></label>
              <label className="field"><span className="field-label">학과</span><input placeholder="학과" value={prof.department} onChange={(e) => setProf({ ...prof, department: e.target.value })} /></label>
              <label className="field"><span className="field-label">계급</span><input placeholder="예: 대령" value={prof.title} onChange={(e) => setProf({ ...prof, title: e.target.value })} /></label>
            </div>
            {prof.code ? (
              <div className="adm-btn-row">
                <button className="btn-add" onClick={async () => { const r = await run('set_professor', prof, '교수 수정'); if (r.ok) setProf({ code: '', name: '', department: '', title: '' }); }}>저장</button>
                <button className="rev-del-btn" onClick={() => setProf({ code: '', name: '', department: '', title: '' })}>취소</button>
              </div>
            ) : (
              <button className="btn-add btn-block" onClick={async () => { if (!prof.name.trim()) return; const r = await run('add_professor', prof, '교수 추가(코드 자동)'); if (r.ok) setProf({ code: '', name: '', department: '', title: '' }); }}>교수 추가</button>
            )}
          </Card>
        )}

        {section === 'semesters' && (
          <>
            <Card icon="🗓️" title="학기" desc="현재 학기를 설정합니다. 칩을 ×로 삭제하거나 아래에서 추가/수정하세요.">
              <div className="adm-tags">
                {cat?.semester?.length ? cat.semester.map((s) => (
                  <span key={s.year + '' + s.term} className="tag">{s.year}-{s.term}{s.is_current ? ' (현재)' : ''}
                    <button className="x" onClick={() => run('delete_catalog', { table: 'semester', key: { year: s.year, term: s.term } }, '학기 삭제')}>×</button>
                  </span>
                )) : <span className="note">등록된 학기가 없습니다.</span>}
              </div>
              <div className="adm-form-grid">
                <label className="field"><span className="field-label">연도</span><input type="number" value={sem.year} onChange={(e) => setSem({ ...sem, year: +e.target.value })} /></label>
                <label className="field"><span className="field-label">학기</span>
                  <select value={sem.term} onChange={(e) => setSem({ ...sem, term: +e.target.value })}><option value={1}>1</option><option value={2}>2</option></select>
                </label>
                <label className="field adm-check-field"><span className="field-label">현재 학기</span>
                  <label className="adm-check"><input type="checkbox" checked={sem.is_current} onChange={(e) => setSem({ ...sem, is_current: e.target.checked })} /> 현재로 지정</label>
                </label>
              </div>
              <button className="btn-add btn-block" onClick={() => run('set_semester', sem, '학기 저장')}>학기 추가 / 수정</button>
            </Card>

            <Card icon="⏰" title="교시" desc="각 교시의 시작·종료 시각을 정의합니다. 칩을 ×로 삭제하거나 아래에서 추가/수정하세요.">
              <div className="adm-tags">
                {cat?.period?.length ? cat.period.map((p) => (
                  <span key={p.no} className="tag">{p.no}교시 {String(p.start_time).slice(0, 5)}
                    <button className="x" onClick={() => run('delete_catalog', { table: 'period', key: { no: p.no } }, '교시 삭제')}>×</button>
                  </span>
                )) : <span className="note">등록된 교시가 없습니다.</span>}
              </div>
              <div className="adm-form-grid">
                <label className="field"><span className="field-label">교시</span><input type="number" value={per.no} onChange={(e) => setPer({ ...per, no: +e.target.value })} /></label>
                <label className="field"><span className="field-label">시작</span><input placeholder="09:00" value={per.start_time} onChange={(e) => setPer({ ...per, start_time: e.target.value })} /></label>
                <label className="field"><span className="field-label">끝</span><input placeholder="09:50" value={per.end_time} onChange={(e) => setPer({ ...per, end_time: e.target.value })} /></label>
              </div>
              <button className="btn-add btn-block" onClick={() => run('set_period', per, '교시 저장')}>교시 추가 / 수정</button>
            </Card>
          </>
        )}

        {section === 'signup' && (
          <Card icon="🔑" title="가입코드" desc="신규 가입 시 입력하는 코드입니다. 바꾸면 즉시 교체되고 이전 코드는 무효화됩니다.">
            <div className="adm-code-box">
              <span className="adm-code-label">현재 코드</span>
              <span className="adm-code-value">{currentCode || '—'}</span>
            </div>
            <label className="field"><span className="field-label">새 가입코드</span><input placeholder="새 가입코드 입력" value={newCode} onChange={(e) => setNewCode(e.target.value)} /></label>
            <button className="btn-add btn-block" onClick={async () => { if (!newCode.trim()) return; const r = await run('set_signup_code', { code: newCode.trim() }, `가입코드 변경`); if (r.ok) setNewCode(''); }}>변경</button>
          </Card>
        )}

        {section === 'settings' && (
          <Card icon="⚙️" title="설정 · 지오펜싱 / 기간" desc="강의평 자격·위치 인증·계정 삭제 대기 기간과 캠퍼스 위치·반경을 설정합니다. 항목별로 따로 저장합니다.">
            {[
              ['review_min_days', '강의평 작성 자격', '일'],
              ['geo_valid_days', '위치 재인증 유효기간', '일'],
              ['account_delete_days', '만료 후 계정삭제 대기', '일'],
              ['radius_m', '지오펜싱 반경', 'm'],
              ['campus_lat', '캠퍼스 위도', '위도'],
              ['campus_lng', '캠퍼스 경도', '경도'],
            ].map(([k, label, unit]) => (
              <div className="adm-setting-row" key={k}>
                <label className="field adm-setting-field">
                  <span className="field-label">{label} <span className="adm-unit">({unit})</span></span>
                  <input type="number" step="any" value={setting[k] ?? ''} onChange={(e) => setSetting({ ...setting, [k]: e.target.value })} />
                </label>
                <button className="btn-add btn-sm adm-setting-save" onClick={() => run('set_app_setting', { field: k, value: Number(setting[k]) }, `${label} 변경`)}>저장</button>
              </div>
            ))}
          </Card>
        )}

        {section === 'board' && (
          <Card icon="💬" title="익명게시판 관리" desc="게시판 기능을 켜고 끄거나, 전체 글을 삭제하고, 게시판별로 삭제합니다.">
            <div className="adm-toggle-row">
              <div className="adm-toggle-body">
                <span className="adm-toggle-label">게시판 활성화</span>
                <span className={`tag ${setting.board_enabled === false ? 'tag-warn' : 'tag-success'}`}>{setting.board_enabled === false ? '비활성' : '활성'}</span>
              </div>
              <button className="btn-ghost btn-sm" onClick={() => run('set_board_enabled', { value: !(setting.board_enabled !== false) }, '게시판 활성화 변경')}>
                {setting.board_enabled === false ? '활성화' : '비활성화'}
              </button>
            </div>

            <div className="section-label adm-sub-label">게시판별 삭제</div>
            <div className="adm-tags">
              {boardsList.length === 0 ? <span className="note">게시판이 없습니다.</span> : boardsList.map((b) => (
                <span key={b.id} className="tag tag-warn">{b.name}
                  <button className="x" onClick={() => { if (confirm(`'${b.name}' 게시판과 글을 삭제합니다.`)) run('delete_board', { id: b.id }, '게시판 삭제'); }}>×</button>
                </span>
              ))}
            </div>

            <div className="divider adm-divider" />
            <button className="btn-danger btn-block" onClick={() => { if (confirm('모든 게시글을 삭제합니다.')) run('purge_all_boards', {}, '전체 글 삭제'); }}>전체 글 삭제 (되돌릴 수 없음)</button>
          </Card>
        )}

        {section === 'admins' && (
          <Card icon="🛡️" title="관리자 관리" desc="관리자 권한을 부여하거나 취소합니다. 마지막 관리자는 취소할 수 없습니다.">
            <div className="section-label adm-sub-label">현재 관리자</div>
            <div className="adm-tags">
              {admins.length === 0 ? <span className="note">관리자가 없습니다.</span> : admins.map((a) => <span key={a.id} className="tag tag-primary">{a.username}</span>)}
            </div>

            <div className="section-label adm-sub-label">부여 / 취소</div>
            <label className="field"><span className="field-label">아이디</span><input placeholder="대상 아이디" value={adminUser} onChange={(e) => setAdminUser(e.target.value)} /></label>
            <div className="adm-btn-row">
              <button className="btn-add" onClick={async () => { const r = await run('grant_admin', { username: adminUser.trim() }, `${adminUser} 관리자 부여`); if (r.ok) setAdminUser(''); }}>부여</button>
              <button className="btn-remove" onClick={async () => { const r = await call('revoke_admin', { username: adminUser.trim() }); setMsg(r.ok ? `✅ ${adminUser} 취소` : r.status === 'LAST_ADMIN' ? '⚠️ 마지막 관리자' : `⚠️ 실패`); if (r.ok) { setAdminUser(''); loadAll(); } }}>취소</button>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
