import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../supabase';
import { getCatalog, formatTimes } from '../lib/cache';

// 화면9: 관리자. is_admin 게이트. 작업은 admin-action Edge Function(service-role).
async function call(action, payload = {}) {
  const { data, error } = await supabase.functions.invoke('admin-action', { body: { action, payload } });
  let status = data?.status;
  if (error) { try { status = (await error.context?.json?.())?.status; } catch { /* ignore */ } }
  return { ok: status === 'OK', status, data };
}

function Section({ title, children }) {
  return <section className="admin-sec"><h3>{title}</h3>{children}</section>;
}

const DAY_KO = { 1: '월', 2: '화', 3: '수', 4: '목', 5: '금', 6: '토', 7: '일' };

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
  const [isAdmin, setIsAdmin] = useState(null);
  const [cat, setCat] = useState(null);
  const [msg, setMsg] = useState('');

  const [admins, setAdmins] = useState([]);
  const [blocks, setBlocks] = useState([]);
  const [currentCode, setCurrentCode] = useState('');
  const [setting, setSetting] = useState({});
  const [boardsList, setBoardsList] = useState([]);

  // 폼 상태
  const [q, setQ] = useState('');
  const [selCourse, setSelCourse] = useState('');
  const [newCode, setNewCode] = useState('');
  const [adminUser, setAdminUser] = useState('');
  const [blk, setBlk] = useState({ username: '', days: 7, reason: '' });
  const [course, setCourse] = useState({ code: '', name: '', department: '', credits: 3 });
  const [prof, setProf] = useState({ code: '', name: '', department: '', title: '' });
  const [pq, setPq] = useState('');
  const [sem, setSem] = useState({ year: 2026, term: 1, is_current: true });
  const [per, setPer] = useState({ no: 1, start_time: '09:00', end_time: '09:50' });
  const [sec, setSec] = useState({ year: 2026, term: 1, section_no: 1, professor_code: '', capacity: 40 });
  const [st, setSt] = useState({ day_of_week: 1, start_period: 1, end_period: 1, room: '' });
  const [csv, setCsv] = useState('');

  async function loadAll() {
    setCat(await getCatalog({ force: true }).catch(() => null));
    call('list_admins').then((r) => r.ok && setAdmins(r.data.admins ?? []));
    call('list_blocks').then((r) => r.ok && setBlocks(r.data.blocks ?? []));
    call('get_signup_code').then((r) => r.ok && setCurrentCode(r.data.code ?? ''));
    call('get_app_setting').then((r) => r.ok && setSetting(r.data.setting ?? {}));
    supabase.from('board').select('id, name').order('last_activity_at', { ascending: false }).then(({ data }) => setBoardsList(data || []));
  }
  useEffect(() => {
    supabase.rpc('is_admin').then(({ data }) => { setIsAdmin(!!data); if (data) loadAll(); });
  }, []);

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
    <div className="page"><header className="page-header row"><Link to="/" className="link-btn">← 홈</Link><h2>관리자</h2><span style={{ width: '2.5rem' }} /></header>
      <p className="muted center">관리자 권한이 없습니다.</p></div>
  );

  return (
    <div className="page admin">
      <header className="page-header row">
        <Link to="/" className="link-btn">← 홈</Link><h2>관리자</h2>
        <Link to="/admin/moderation" className="link-btn">모더레이션</Link>
      </header>
      {msg && <p className="admin-msg">{msg}</p>}

      <Section title="과목 · 분반 (검색 → 수정/삭제/추가)">
        <div className="admin-row"><input placeholder="과목 검색(이름/코드)" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <ul className="adm-courselist">
          {filtered.map((c) => (
            <li key={c.code} className="adm-course">
              <div className="adm-course-top">
                <span><strong>{c.name}</strong> <span className="muted">{c.code}{c.department ? ` · ${c.department}` : ''}{c.credits ? ` · ${c.credits}학점` : ''}</span></span>
                <span>
                  <button className="link-btn" onClick={() => setSelCourse(selCourse === c.code ? '' : c.code)}>{selCourse === c.code ? '닫기' : '분반'}</button>
                  <button className="link-btn" onClick={() => setCourse({ code: c.code, name: c.name || '', department: c.department || '', credits: c.credits || 3 })}>수정</button>
                  <button className="rev-del-btn" onClick={() => { if (confirm(`'${c.name}' 과목과 분반·강의시간이 모두 삭제됩니다.`)) run('delete_catalog', { table: 'course', key: { code: c.code } }, '과목 삭제'); }}>삭제</button>
                </span>
              </div>
              {selCourse === c.code && (
                <div className="adm-sections">
                  {secOf(c.code).map((s) => (
                    <div key={s.section_no + '-' + s.year + s.term} className="adm-sec-row">
                      <span>{s.year}-{s.term} · {s.section_no}분반 · {(cat.professor.find((p) => p.code === s.professor_code) || {}).name || '교수미정'} · {timesOf(s) || '시간미정'}</span>
                      <button className="rev-del-btn" onClick={() => run('delete_catalog', { table: 'section', key: { course_code: s.course_code, year: s.year, term: s.term, section_no: s.section_no } }, '분반 삭제')}>삭제</button>
                    </div>
                  ))}
                  <div className="admin-grid">
                    <input type="number" placeholder="연도" value={sec.year} onChange={(e) => setSec({ ...sec, year: +e.target.value })} />
                    <input type="number" placeholder="학기" value={sec.term} onChange={(e) => setSec({ ...sec, term: +e.target.value })} />
                    <input type="number" placeholder="분반" value={sec.section_no} onChange={(e) => setSec({ ...sec, section_no: +e.target.value })} />
                    <select value={sec.professor_code} onChange={(e) => setSec({ ...sec, professor_code: e.target.value })}>
                      <option value="">교수</option>{cat.professor.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
                    </select>
                  </div>
                  <button className="btn-add" onClick={() => run('set_section', { course_code: c.code, ...sec }, '분반 추가/수정')}>분반 추가</button>
                  <div className="admin-grid" style={{ marginTop: '0.4rem' }}>
                    <select value={st.day_of_week} onChange={(e) => setSt({ ...st, day_of_week: +e.target.value })}>{[1, 2, 3, 4, 5, 6, 7].map((d) => <option key={d} value={d}>{DAY_KO[d]}</option>)}</select>
                    <input type="number" placeholder="시작교시" value={st.start_period} onChange={(e) => setSt({ ...st, start_period: +e.target.value })} />
                    <input type="number" placeholder="끝교시" value={st.end_period} onChange={(e) => setSt({ ...st, end_period: +e.target.value })} />
                    <input placeholder="강의실" value={st.room} onChange={(e) => setSt({ ...st, room: e.target.value })} />
                  </div>
                  <button className="btn-add" onClick={() => run('set_section_time', { course_code: c.code, year: sec.year, term: sec.term, section_no: sec.section_no, ...st }, '강의시간 추가')}>강의시간 추가(위 분반에)</button>
                </div>
              )}
            </li>
          ))}
        </ul>
        <div className="admin-grid" style={{ marginTop: '0.6rem' }}>
          <input placeholder={course.code ? '과목명' : '새 과목명'} value={course.name} onChange={(e) => setCourse({ ...course, name: e.target.value })} />
          <input placeholder="학과" value={course.department} onChange={(e) => setCourse({ ...course, department: e.target.value })} />
          <input type="number" placeholder="학점" value={course.credits} onChange={(e) => setCourse({ ...course, credits: +e.target.value })} />
        </div>
        <div className="admin-row" style={{ marginTop: '0.3rem' }}>
          {course.code ? (
            <>
              <span className="muted" style={{ fontSize: '0.8rem' }}>수정 중: {course.code}</span>
              <button className="btn-add" onClick={async () => { const r = await run('set_course', course, '과목 수정'); if (r.ok) setCourse({ code: '', name: '', department: '', credits: 3 }); }}>저장</button>
              <button className="rev-del-btn" onClick={() => setCourse({ code: '', name: '', department: '', credits: 3 })}>취소</button>
            </>
          ) : (
            <button className="btn-add" onClick={async () => { if (!course.name.trim()) return; const r = await run('add_course', course, '과목 추가(코드 자동)'); if (r.ok) setCourse({ code: '', name: '', department: '', credits: 3 }); }}>과목 추가 (코드 자동)</button>
          )}
        </div>
      </Section>

      <Section title="CSV 일괄 업로드 (과목+분반)">
        <p className="account-note" style={{ margin: '0 0 0.4rem' }}>
          <b>① 양식 다운로드 → ② 엑셀 등에서 수정 → ③ 내용 붙여넣기/업로드.</b><br />
          한 행 = 한 분반. 같은 과목명은 한 과목으로 묶입니다. 과목코드는 자동 부여.<br />
          times는 <b>세미콜론(;)</b>으로 구분: <code>월1;수1</code>, 연강은 <code>금7-8</code>.
        </p>
        <div className="admin-row" style={{ marginBottom: '0.4rem' }}>
          <button className="btn-add" onClick={downloadCsvTemplate}>📄 양식 CSV 다운로드</button>
          <label className="link-btn" style={{ cursor: 'pointer' }}>
            파일 선택
            <input type="file" accept=".csv" style={{ display: 'none' }} onChange={(e) => {
              const f = e.target.files?.[0]; if (!f) return;
              const r = new FileReader(); r.onload = () => setCsv(String(r.result || '').replace(/^﻿/, '')); r.readAsText(f, 'utf-8');
            }} />
          </label>
        </div>
        <textarea rows={4} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={CSV_HEADER + '\n컴퓨터구조,전산학과,3,P01,2026,1,1,월1;수1'} style={{ width: '100%', fontSize: '0.8rem' }} />
        <button className="btn-add" onClick={async () => {
          const list = parseCsv(csv);
          if (!list.length) { setMsg('⚠️ CSV 파싱 결과 없음 (양식 확인)'); return; }
          const r = await run('bulk_catalog', { courses: list }, `${list.length}개 과목 일괄 등록`);
          if (r.ok) setCsv('');
        }}>업로드</button>
      </Section>

      <Section title="교수 (코드 자동)">
        <div className="admin-row"><input placeholder="교수 검색(성명/학과/계급)" value={pq} onChange={(e) => setPq(e.target.value)} /></div>
        <ul className="adm-courselist" style={{ maxHeight: 220 }}>
          {(cat?.professor ?? []).filter((p) => { const s = pq.trim().toLowerCase(); return !s || [p.name, p.department, p.title, p.code].some((v) => (v || '').toLowerCase().includes(s)); }).map((p) => (
            <li key={p.code} className="adm-course">
              <div className="adm-course-top">
                <span><strong>{p.name}</strong> <span className="muted">{[p.title, p.department, p.code].filter(Boolean).join(' · ')}</span></span>
                <span>
                  <button className="link-btn" onClick={() => setProf({ code: p.code, name: p.name || '', department: p.department || '', title: p.title || '' })}>수정</button>
                  <button className="rev-del-btn" onClick={() => run('delete_catalog', { table: 'professor', key: { code: p.code } }, '교수 삭제')}>삭제</button>
                </span>
              </div>
            </li>
          ))}
        </ul>
        <div className="admin-grid" style={{ marginTop: '0.5rem' }}>
          <input placeholder="성명" value={prof.name} onChange={(e) => setProf({ ...prof, name: e.target.value })} />
          <input placeholder="학과" value={prof.department} onChange={(e) => setProf({ ...prof, department: e.target.value })} />
          <input placeholder="계급" value={prof.title} onChange={(e) => setProf({ ...prof, title: e.target.value })} />
        </div>
        <div className="admin-row" style={{ marginTop: '0.3rem' }}>
          {prof.code ? (
            <>
              <span className="muted" style={{ fontSize: '0.8rem' }}>수정 중: {prof.code}</span>
              <button className="btn-add" onClick={async () => { const r = await run('set_professor', prof, '교수 수정'); if (r.ok) setProf({ code: '', name: '', department: '', title: '' }); }}>저장</button>
              <button className="rev-del-btn" onClick={() => setProf({ code: '', name: '', department: '', title: '' })}>취소</button>
            </>
          ) : (
            <button className="btn-add" onClick={async () => { if (!prof.name.trim()) return; const r = await run('add_professor', prof, '교수 추가(코드 자동)'); if (r.ok) setProf({ code: '', name: '', department: '', title: '' }); }}>교수 추가</button>
          )}
        </div>
      </Section>

      <Section title="학기 / 교시">
        <div className="admin-row">{cat?.semester?.map((s) => <span key={s.year + '' + s.term} className="tag">{s.year}-{s.term}{s.is_current ? '(현재)' : ''}<button className="link-btn" onClick={() => run('delete_catalog', { table: 'semester', key: { year: s.year, term: s.term } }, '학기 삭제')}>×</button></span>)}</div>
        <div className="admin-row" style={{ marginTop: '0.4rem' }}>
          <input type="number" value={sem.year} onChange={(e) => setSem({ ...sem, year: +e.target.value })} />
          <select value={sem.term} onChange={(e) => setSem({ ...sem, term: +e.target.value })}><option value={1}>1</option><option value={2}>2</option></select>
          <label className="admin-check"><input type="checkbox" checked={sem.is_current} onChange={(e) => setSem({ ...sem, is_current: e.target.checked })} />현재</label>
          <button className="btn-add" onClick={() => run('set_semester', sem, '학기 저장')}>학기 추가/수정</button>
        </div>
        <div className="admin-row" style={{ marginTop: '0.6rem' }}>{cat?.period?.map((p) => <span key={p.no} className="tag">{p.no}교시 {String(p.start_time).slice(0, 5)}<button className="link-btn" onClick={() => run('delete_catalog', { table: 'period', key: { no: p.no } }, '교시 삭제')}>×</button></span>)}</div>
        <div className="admin-row" style={{ marginTop: '0.4rem' }}>
          <input type="number" placeholder="교시" value={per.no} onChange={(e) => setPer({ ...per, no: +e.target.value })} />
          <input placeholder="시작 09:00" value={per.start_time} onChange={(e) => setPer({ ...per, start_time: e.target.value })} />
          <input placeholder="끝 09:50" value={per.end_time} onChange={(e) => setPer({ ...per, end_time: e.target.value })} />
          <button className="btn-add" onClick={() => run('set_period', per, '교시 저장')}>교시 추가/수정</button>
        </div>
      </Section>

      <Section title="가입코드">
        <p className="account-note" style={{ margin: '0 0 0.5rem' }}>현재 코드: <strong style={{ fontSize: '1rem', color: '#1e40af' }}>{currentCode || '—'}</strong><br />바꾸면 즉시 교체되고 이전 코드는 무효화됩니다.</p>
        <div className="admin-row">
          <input placeholder="새 가입코드" value={newCode} onChange={(e) => setNewCode(e.target.value)} />
          <button className="btn-add" onClick={async () => { if (!newCode.trim()) return; const r = await run('set_signup_code', { code: newCode.trim() }, `가입코드 변경`); if (r.ok) setNewCode(''); }}>변경</button>
        </div>
      </Section>

      <Section title="설정 (지오펜싱 · 기간)">
        {[
          ['review_min_days', '강의평 작성 자격(일)'],
          ['geo_valid_days', '위치 재인증 유효기간(일)'],
          ['account_delete_days', '만료 후 계정삭제 대기(일)'],
          ['radius_m', '지오펜싱 반경(m)'],
          ['campus_lat', '캠퍼스 위도'],
          ['campus_lng', '캠퍼스 경도'],
        ].map(([k, label]) => (
          <div className="admin-row" key={k} style={{ marginBottom: '0.3rem' }}>
            <span style={{ flex: 1, fontSize: '0.82rem' }}>{label}</span>
            <input type="number" step="any" value={setting[k] ?? ''} onChange={(e) => setSetting({ ...setting, [k]: e.target.value })} />
            <button className="btn-add" onClick={() => run('set_app_setting', { field: k, value: Number(setting[k]) }, `${label} 변경`)}>저장</button>
          </div>
        ))}
      </Section>

      <Section title="익명게시판 관리">
        <div className="admin-row" style={{ marginBottom: '0.5rem' }}>
          <span style={{ flex: 1, fontSize: '0.85rem' }}>게시판 활성화: <b>{setting.board_enabled === false ? '비활성' : '활성'}</b></span>
          <button className="btn-add" onClick={() => run('set_board_enabled', { value: !(setting.board_enabled !== false) }, '게시판 활성화 변경')}>
            {setting.board_enabled === false ? '활성화' : '비활성화'}
          </button>
          <button className="btn-danger" onClick={() => { if (confirm('모든 게시글을 삭제합니다.')) run('purge_all_boards', {}, '전체 글 삭제'); }}>전체 글 삭제</button>
        </div>
        <div className="admin-row">
          {boardsList.length === 0 ? <span className="muted">게시판 없음</span> : boardsList.map((b) => (
            <span key={b.id} className="tag">{b.name}<button className="link-btn" onClick={() => { if (confirm(`'${b.name}' 게시판과 글을 삭제합니다.`)) run('delete_board', { id: b.id }, '게시판 삭제'); }}>×</button></span>
          ))}
        </div>
      </Section>

      <Section title="아이디 / 기기 차단">
        <div className="admin-row">{blocks.length === 0 ? <span className="muted">차단 없음</span> : blocks.map((b) => <span key={b.id} className="tag tag-warn">{b.username} ~{new Date(b.blocked_until).toLocaleDateString('ko-KR')}<button className="link-btn" onClick={() => run('unblock', { username: b.username }, '차단 해제')}>해제</button></span>)}</div>
        <div className="admin-grid" style={{ marginTop: '0.4rem' }}>
          <input placeholder="아이디" value={blk.username} onChange={(e) => setBlk({ ...blk, username: e.target.value })} />
          <input type="number" placeholder="일수" value={blk.days} onChange={(e) => setBlk({ ...blk, days: +e.target.value })} />
          <input placeholder="사유(선택)" value={blk.reason} onChange={(e) => setBlk({ ...blk, reason: e.target.value })} />
        </div>
        <button className="btn-danger" onClick={async () => { if (!blk.username.trim()) return; const r = await run('block_user', blk, `${blk.username} ${blk.days}일 차단`); if (r.ok) setBlk({ username: '', days: 7, reason: '' }); }}>차단 (계정+기기)</button>
      </Section>

      <Section title="관리자 관리">
        <div className="admin-row">{admins.map((a) => <span key={a.id} className="tag">{a.username}</span>)}</div>
        <div className="admin-row" style={{ marginTop: '0.4rem' }}>
          <input placeholder="아이디" value={adminUser} onChange={(e) => setAdminUser(e.target.value)} />
          <button className="btn-add" onClick={async () => { const r = await run('grant_admin', { username: adminUser.trim() }, `${adminUser} 관리자 부여`); if (r.ok) setAdminUser(''); }}>부여</button>
          <button className="btn-remove" onClick={async () => { const r = await call('revoke_admin', { username: adminUser.trim() }); setMsg(r.ok ? `✅ ${adminUser} 취소` : r.status === 'LAST_ADMIN' ? '⚠️ 마지막 관리자' : `⚠️ 실패`); if (r.ok) { setAdminUser(''); loadAll(); } }}>취소</button>
        </div>
      </Section>
    </div>
  );
}
