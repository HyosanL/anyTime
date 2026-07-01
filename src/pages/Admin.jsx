import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase } from '../supabase';
import { getCatalog } from '../lib/cache';
import SyllabusUpload from '../components/SyllabusUpload';

// 화면9: 관리자. is_admin 게이트. 작업은 admin-action Edge Function(service-role).
// 라우팅: '/admin'=허브, '/admin/:section'=기능 화면. '/admin/moderation'은 별도 페이지(Moderation.jsx).
async function call(action, payload = {}) {
  const { data, error } = await supabase.functions.invoke('admin-action', { body: { action, payload } });
  let status = data?.status;
  if (error) { try { status = (await error.context?.json?.())?.status; } catch { /* ignore */ } }
  return { ok: status === 'OK', status, data };
}

// 교수 명단 동기화(sync-professors) 는 admin-action 이 아니라 전용 Edge Function.
async function invokeSync(mode) {
  let { data, error } = await supabase.functions.invoke('sync-professors', { body: { mode } });
  if (error) { try { data = await error.context?.json?.(); } catch { data = null; } }
  return { ok: data?.status === 'OK', status: data?.status ?? 'ERROR', data: data ?? {} };
}

const fmtDateTime = (iso) => {
  if (!iso) return '없음';
  try { return new Date(iso).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return iso; }
};

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

// 교수 명단 동기화 카드: 공식 홈페이지 크롤 → 미리보기(diff) → 반영.
function ProfessorSyncCard({ syncedAt, onApplied }) {
  const [busy, setBusy] = useState('');        // '' | 'preview' | 'apply'
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [msg, setMsg] = useState('');

  async function doPreview() {
    setBusy('preview'); setMsg(''); setResult(null); setPreview(null);
    const r = await invokeSync('preview');
    setBusy('');
    if (r.ok) setPreview(r.data);
    else setMsg(r.status === 'NO_DATA'
      ? '⚠️ 공사 홈페이지에서 명단을 가져오지 못했습니다. (서버에서 사이트 접속이 차단되었을 수 있습니다)'
      : `⚠️ 실패: ${r.status}`);
  }
  async function doApply() {
    if (!confirm('크롤한 명단을 반영합니다. 새 교수 추가와 학과 변경만 적용되며, 기존 교수는 삭제되지 않습니다.')) return;
    setBusy('apply'); setMsg('');
    const r = await invokeSync('apply');
    setBusy('');
    if (r.ok) {
      setResult(r.data); setPreview(null);
      setMsg(`✅ 반영 완료 — 추가 ${r.data.added} · 학과변경 ${r.data.updated} · 유지 ${r.data.unchanged}`);
      onApplied?.();
    } else setMsg(r.status === 'NO_DATA'
      ? '⚠️ 명단을 가져오지 못해 반영하지 않았습니다.'
      : `⚠️ 실패: ${r.status}`);
  }

  const p = preview;
  return (
    <Card icon="🔄" title="교수 명단 동기화"
      desc="공군사관학교 공식 홈페이지(교수소개)에서 학과별 교수 명단을 가져와 대조합니다. 새 교수는 추가하고 학과가 바뀐 교수는 갱신하며, 기존 교수는 삭제하지 않습니다. 주기 자동 갱신은 pg_cron 으로 설정합니다(db/sync_professors_cron.sql).">
      <div className="adm-code-box">
        <span className="adm-code-label">마지막 동기화</span>
        <span className="adm-code-value">{fmtDateTime(syncedAt)}</span>
      </div>

      <div className="adm-btn-row">
        <button className="btn-add" disabled={!!busy} onClick={doPreview}>
          {busy === 'preview' ? '불러오는 중…' : '미리보기 불러오기'}
        </button>
        {p && (
          <button className="btn-add" disabled={!!busy}
            onClick={doApply} title="추가/학과변경 반영">
            {busy === 'apply' ? '반영 중…' : `반영하기 (추가 ${p.add.length}·변경 ${p.deptChanges.length})`}
          </button>
        )}
      </div>
      {msg && <p className={`admin-msg ${msg.startsWith('⚠️') ? 'is-fail' : 'is-ok'}`}>{msg}</p>}

      {p && (
        <div className="adm-expand">
          <p className="note">학과 {p.scanned.departments}개 · 교수 {p.scanned.professors}명 확인.
            {' '}추가 <b>{p.add.length}</b> · 학과변경 <b>{p.deptChanges.length}</b> · 유지 {p.unchanged}
            {p.ambiguous.length > 0 && <> · 동명이인 보류 {p.ambiguous.length}</>}
            {p.orphans.length > 0 && <> · 홈페이지에 없음 {p.orphans.length}</>}
          </p>

          {p.add.length > 0 && <>
            <div className="section-label adm-sub-label">추가될 교수 ({p.add.length})</div>
            <div className="adm-tags">
              {p.add.map((a, i) => <span key={i} className="tag tag-success">{a.name} · {a.department}</span>)}
            </div>
          </>}

          {p.deptChanges.length > 0 && <>
            <div className="section-label adm-sub-label">학과 변경 ({p.deptChanges.length})</div>
            <div className="adm-tags">
              {p.deptChanges.map((c, i) => <span key={i} className="tag tag-primary">{c.name}: {c.from || '—'} → {c.to}</span>)}
            </div>
          </>}

          {p.orphans.length > 0 && <>
            <div className="section-label adm-sub-label">홈페이지에 없는 기존 교수 ({p.orphans.length}) — 자동 삭제되지 않음. 필요 시 교수 관리에서 수동 삭제</div>
            <div className="adm-tags">
              {p.orphans.map((o) => <span key={o.code} className="tag tag-warn">{o.name}{o.department ? ` · ${o.department}` : ''}</span>)}
            </div>
          </>}

          {p.ambiguous.length > 0 && <>
            <div className="section-label adm-sub-label">동명이인 보류 ({p.ambiguous.length}) — 교수 관리에서 직접 확인</div>
            <div className="adm-tags">
              {p.ambiguous.map((a, i) => <span key={i} className="tag">{a.name} · {a.dept}</span>)}
            </div>
          </>}

          {p.errors?.length > 0 && (
            <p className="note">일부 페이지를 읽지 못했습니다: {p.errors.join(' / ')}</p>
          )}
        </div>
      )}

      {result && (
        <p className="note">반영 결과 — 추가 {result.added} · 학과변경 {result.updated} · 유지 {result.unchanged}
          {result.orphans > 0 && ` · 홈페이지에 없음 ${result.orphans}(유지)`}
          {result.ambiguous > 0 && ` · 동명이인 보류 ${result.ambiguous}`}
        </p>
      )}
    </Card>
  );
}

const DAY_KO = { 1: '월', 2: '화', 3: '수', 4: '목', 5: '금', 6: '토', 7: '일' };

// 허브 항목 정의 (key는 라우팅 section 과 일치). moderation 은 별도 페이지로 링크.
const SECTIONS = [
  { key: 'courses', icon: '📚', title: '과목 · 분반', sub: '과목 검색·추가, 분반·강의시간 관리' },
  { key: 'ai', icon: '🤖', title: 'AI 강의 일괄등록', sub: 'PDF 업로드 → 자동 매칭 → 검토 후 적용' },
  { key: 'csv', icon: '📄', title: 'CSV 강의 일괄등록', sub: 'CSV 업로드/붙여넣기 → 자동 매칭 → 검토 후 적용' },
  { key: 'professors', icon: '👤', title: '교수', sub: '교수 검색·추가·수정·삭제' },
  { key: 'professors-sync', icon: '🔄', title: '교수 명단 동기화', sub: '공식 홈페이지에서 교수 명단 자동 갱신' },
  { key: 'semesters', icon: '🗓️', title: '학기 · 교시', sub: '현재 학기와 교시 시각 설정' },
  { key: 'signup', icon: '🔑', title: '가입코드', sub: '신규 가입 코드 확인·변경' },
  { key: 'settings', icon: '⚙️', title: '지오펜싱 · 기간', sub: '캠퍼스 위치·반경·각종 기간' },
  { key: 'board', icon: '💬', title: '게시판 관리', sub: '활성화·게시판별/전체 글 삭제' },
  { key: 'moderation', icon: '🧹', title: '모더레이션', sub: '신고·자동필터 강의평 검토', to: '/admin/moderation' },
  { key: 'admins', icon: '🛡️', title: '관리자', sub: '관리자 권한 부여·취소' },
];
const TITLE_OF = Object.fromEntries(SECTIONS.map((s) => [s.key, s.title]));

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
  const [course, setCourse] = useState({ code: '', name: '' });
  const [prof, setProf] = useState({ code: '', name: '', department: '' });
  const [pq, setPq] = useState('');
  const [sem, setSem] = useState({ year: 2026, term: 1, is_current: true });
  const [per, setPer] = useState({ no: 1, start_time: '09:00', end_time: '09:50' });
  const [sec, setSec] = useState({ year: 2026, term: 1, section_no: 1, professor_code: '', capacity: 40 });
  const [stForm, setStForm] = useState({ day_of_week: 1, start_period: 1, end_period: 1, room: '' });

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
                      <div className="adm-item-sub">{[c.code, c.department].filter(Boolean).join(' · ')}</div>
                    </div>
                    <div className="adm-item-acts">
                      <button className="btn-ghost btn-sm" onClick={() => setSelCourse(selCourse === c.code ? '' : c.code)}>{selCourse === c.code ? '닫기' : '분반'}</button>
                      <button className="link-btn" onClick={() => setCourse({ code: c.code, name: c.name || '' })}>수정</button>
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
            </div>
            {course.code ? (
              <div className="adm-btn-row">
                <button className="btn-add" onClick={async () => { const r = await run('set_course', { code: course.code, name: course.name }, '과목 수정'); if (r.ok) setCourse({ code: '', name: '' }); }}>저장</button>
                <button className="rev-del-btn" onClick={() => setCourse({ code: '', name: '' })}>취소</button>
              </div>
            ) : (
              <button className="btn-add btn-block" onClick={async () => { if (!course.name.trim()) return; const r = await run('add_course', { name: course.name }, '과목 추가(코드 자동)'); if (r.ok) setCourse({ code: '', name: '' }); }}>과목 추가 (코드 자동)</button>
            )}
          </Card>
        )}

        {section === 'ai' && (
          <Card icon="🤖" title="AI 강의 일괄등록" desc="학기 강의 PDF(수강편람)를 올리면 AI가 과목·분반·교수·시간을 추출해 기존 DB와 대조하고, 검토 후 적용합니다. 교수코드를 몰라도 이름으로 자동 매칭됩니다.">
            <SyllabusUpload
              mode="ai"
              defaultYear={cat?.semester?.find((s) => s.is_current)?.year || 2026}
              defaultTerm={cat?.semester?.find((s) => s.is_current)?.term || 1}
              onApplied={loadAll}
            />
          </Card>
        )}

        {section === 'csv' && (
          <Card icon="📄" title="CSV 강의 일괄등록" desc="과목·분반 표를 CSV로 올리거나 붙여넣으면 기존 DB와 대조 후 적용합니다. 결정적(고정)이라 AI보다 정확합니다. 양식을 내려받아 채우거나, 수강편람에서 추출한 CSV를 그대로 올리세요.">
            <SyllabusUpload
              mode="csv"
              defaultYear={cat?.semester?.find((s) => s.is_current)?.year || 2026}
              defaultTerm={cat?.semester?.find((s) => s.is_current)?.term || 1}
              onApplied={loadAll}
            />
          </Card>
        )}

        {section === 'professors' && (
          <Card icon="👤" title="교수 관리" desc="교수를 검색해 수정/삭제하고, 아래에서 새 교수를 추가합니다. 교수코드는 자동 부여됩니다.">
            <div className="search-bar adm-inline-search">
              <input type="search" placeholder="교수 검색 (성명/학과)" value={pq} onChange={(e) => setPq(e.target.value)} />
            </div>
            <ul className="list adm-list adm-list-scroll">
              {(cat?.professor ?? []).filter((p) => { const s = pq.trim().toLowerCase(); return !s || [p.name, p.department, p.code].some((v) => (v || '').toLowerCase().includes(s)); }).map((p) => (
                <li key={p.code} className="adm-item">
                  <div className="adm-item-row">
                    <div className="adm-item-body">
                      <div className="adm-item-title">{p.name}</div>
                      <div className="adm-item-sub">{[p.department, p.code].filter(Boolean).join(' · ')}</div>
                    </div>
                    <div className="adm-item-acts">
                      <button className="link-btn" onClick={() => setProf({ code: p.code, name: p.name || '', department: p.department || '' })}>수정</button>
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
            </div>
            {prof.code ? (
              <div className="adm-btn-row">
                <button className="btn-add" onClick={async () => { const r = await run('set_professor', prof, '교수 수정'); if (r.ok) setProf({ code: '', name: '', department: '' }); }}>저장</button>
                <button className="rev-del-btn" onClick={() => setProf({ code: '', name: '', department: '' })}>취소</button>
              </div>
            ) : (
              <button className="btn-add btn-block" onClick={async () => { if (!prof.name.trim()) return; const r = await run('add_professor', prof, '교수 추가(코드 자동)'); if (r.ok) setProf({ code: '', name: '', department: '' }); }}>교수 추가</button>
            )}
          </Card>
        )}

        {section === 'professors-sync' && (
          <ProfessorSyncCard syncedAt={setting.professors_synced_at} onApplied={loadAll} />
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
