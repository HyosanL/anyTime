import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../supabase';

// 화면9: 관리자. is_admin() 게이트. 작업은 admin-action Edge Function(service-role).
function randCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 8 }, () => A[Math.floor(Math.random() * A.length)]).join('');
}

async function call(action, payload) {
  const { data, error } = await supabase.functions.invoke('admin-action', {
    body: { action, payload },
  });
  let status = data?.status;
  if (error) {
    try { status = (await error.context?.json?.())?.status; } catch { /* ignore */ }
  }
  return { ok: status === 'OK', status, data };
}

function Section({ title, children }) {
  return (
    <section className="admin-sec">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export default function Admin() {
  const [isAdmin, setIsAdmin] = useState(null);
  const [msg, setMsg] = useState('');

  const [admins, setAdmins] = useState([]);
  const [adminUser, setAdminUser] = useState('');

  async function loadAdmins() {
    const r = await call('list_admins', {});
    if (r.ok) setAdmins(r.data.admins ?? []);
  }

  useEffect(() => {
    supabase.rpc('is_admin').then(({ data }) => {
      setIsAdmin(!!data);
      if (data) loadAdmins();
    });
  }, []);

  // 폼 상태
  const [codeCount, setCodeCount] = useState(5);
  const [codeLabel, setCodeLabel] = useState('');
  const [generated, setGenerated] = useState([]);
  const [sem, setSem] = useState({ year: 2026, term: 1, is_current: true });
  const [prof, setProf] = useState({ code: '', name: '' });
  const [course, setCourse] = useState({ code: '', name: '', department: '', credits: 3 });
  const [sec, setSec] = useState({ course_code: '', year: 2026, term: 1, section_no: 1, professor_code: '', capacity: 40 });
  const [st, setSt] = useState({ course_code: '', year: 2026, term: 1, section_no: 1, day_of_week: 1, start_period: 1, end_period: 1, room: '' });
  const [del, setDel] = useState({ table: 'review', id: '' });

  async function run(action, payload, okMsg) {
    setMsg('');
    const r = await call(action, payload);
    setMsg(r.ok ? `✅ ${okMsg}` : `⚠️ 실패: ${r.status ?? '오류'}`);
    return r;
  }

  if (isAdmin === null) return <div className="page-center">확인 중…</div>;
  if (!isAdmin) {
    return (
      <div className="page">
        <header className="page-header row">
          <Link to="/" className="link-btn">← 홈</Link>
          <h2>관리자</h2>
          <span style={{ width: '2.5rem' }} />
        </header>
        <p className="muted center">관리자 권한이 없습니다.</p>
      </div>
    );
  }

  return (
    <div className="page admin">
      <header className="page-header row">
        <Link to="/" className="link-btn">← 홈</Link>
        <h2>관리자</h2>
        <span style={{ width: '2.5rem' }} />
      </header>

      <Link to="/admin/moderation" className="nav-tile nav-tile-admin" style={{ margin: '0 1.5rem 1rem' }}>
        <span className="nav-tile-title">실시간 모더레이션 대시보드</span>
        <span className="nav-tile-sub">모든 게시글 최신순 · 부정어 강조 · 즉시 수정/삭제</span>
      </Link>

      {msg && <p className="admin-msg">{msg}</p>}

      <Section title="관리자 관리">
        <div className="admin-row">
          {admins.length === 0 ? <span className="muted">관리자 없음</span>
            : admins.map((a) => <span key={a.id} className="tag">{a.username}</span>)}
        </div>
        <div className="admin-row" style={{ marginTop: '0.5rem' }}>
          <input placeholder="아이디" value={adminUser} onChange={(e) => setAdminUser(e.target.value)} />
          <button className="btn-add" onClick={async () => {
            const r = await run('grant_admin', { username: adminUser.trim() }, `${adminUser} 관리자 부여`);
            if (r.ok) { setAdminUser(''); loadAdmins(); }
          }}>부여</button>
          <button className="btn-remove" onClick={async () => {
            const r = await call('revoke_admin', { username: adminUser.trim() });
            setMsg(r.ok ? `✅ ${adminUser} 관리자 취소` : r.status === 'LAST_ADMIN' ? '⚠️ 마지막 관리자는 취소할 수 없습니다' : `⚠️ 실패: ${r.status}`);
            if (r.ok) { setAdminUser(''); loadAdmins(); }
          }}>취소</button>
        </div>
      </Section>

      <Section title="가입코드 발급">
        <div className="admin-row">
          <input type="number" min={1} max={100} value={codeCount} onChange={(e) => setCodeCount(Number(e.target.value))} />
          <input placeholder="라벨(예: 78기)" value={codeLabel} onChange={(e) => setCodeLabel(e.target.value)} />
          <button className="btn-add" onClick={async () => {
            const codes = Array.from({ length: codeCount }, randCode);
            const r = await run('add_codes', { codes, label: codeLabel || null }, `${codes.length}개 발급`);
            if (r.ok) setGenerated(codes);
          }}>발급</button>
        </div>
        {generated.length > 0 && (
          <pre className="admin-codes">{generated.join('\n')}</pre>
        )}
      </Section>

      <Section title="현재 학기 설정">
        <div className="admin-row">
          <input type="number" value={sem.year} onChange={(e) => setSem({ ...sem, year: Number(e.target.value) })} />
          <select value={sem.term} onChange={(e) => setSem({ ...sem, term: Number(e.target.value) })}>
            <option value={1}>1학기</option><option value={2}>2학기</option>
          </select>
          <label className="admin-check"><input type="checkbox" checked={sem.is_current} onChange={(e) => setSem({ ...sem, is_current: e.target.checked })} /> 현재학기</label>
          <button className="btn-add" onClick={() => run('set_semester', sem, '학기 설정됨')}>저장</button>
        </div>
      </Section>

      <Section title="교수 추가/수정">
        <div className="admin-row">
          <input placeholder="코드(P06)" value={prof.code} onChange={(e) => setProf({ ...prof, code: e.target.value })} />
          <input placeholder="이름" value={prof.name} onChange={(e) => setProf({ ...prof, name: e.target.value })} />
          <button className="btn-add" onClick={() => run('set_professor', prof, '교수 저장됨')}>저장</button>
        </div>
      </Section>

      <Section title="과목 추가/수정">
        <div className="admin-grid">
          <input placeholder="코드(CS201)" value={course.code} onChange={(e) => setCourse({ ...course, code: e.target.value })} />
          <input placeholder="과목명" value={course.name} onChange={(e) => setCourse({ ...course, name: e.target.value })} />
          <input placeholder="학과" value={course.department} onChange={(e) => setCourse({ ...course, department: e.target.value })} />
          <input type="number" placeholder="학점" value={course.credits} onChange={(e) => setCourse({ ...course, credits: Number(e.target.value) })} />
        </div>
        <button className="btn-add" onClick={() => run('set_course', course, '과목 저장됨')}>저장</button>
      </Section>

      <Section title="분반 추가/수정">
        <div className="admin-grid">
          <input placeholder="과목코드" value={sec.course_code} onChange={(e) => setSec({ ...sec, course_code: e.target.value })} />
          <input type="number" placeholder="연도" value={sec.year} onChange={(e) => setSec({ ...sec, year: Number(e.target.value) })} />
          <input type="number" placeholder="학기" value={sec.term} onChange={(e) => setSec({ ...sec, term: Number(e.target.value) })} />
          <input type="number" placeholder="분반" value={sec.section_no} onChange={(e) => setSec({ ...sec, section_no: Number(e.target.value) })} />
          <input placeholder="교수코드" value={sec.professor_code} onChange={(e) => setSec({ ...sec, professor_code: e.target.value })} />
          <input type="number" placeholder="정원" value={sec.capacity} onChange={(e) => setSec({ ...sec, capacity: Number(e.target.value) })} />
        </div>
        <button className="btn-add" onClick={() => run('set_section', sec, '분반 저장됨')}>저장</button>
      </Section>

      <Section title="강의시간 추가/수정">
        <div className="admin-grid">
          <input placeholder="과목코드" value={st.course_code} onChange={(e) => setSt({ ...st, course_code: e.target.value })} />
          <input type="number" placeholder="연도" value={st.year} onChange={(e) => setSt({ ...st, year: Number(e.target.value) })} />
          <input type="number" placeholder="학기" value={st.term} onChange={(e) => setSt({ ...st, term: Number(e.target.value) })} />
          <input type="number" placeholder="분반" value={st.section_no} onChange={(e) => setSt({ ...st, section_no: Number(e.target.value) })} />
          <select value={st.day_of_week} onChange={(e) => setSt({ ...st, day_of_week: Number(e.target.value) })}>
            {['월', '화', '수', '목', '금', '토', '일'].map((d, i) => <option key={i} value={i + 1}>{d}</option>)}
          </select>
          <input type="number" placeholder="시작교시" value={st.start_period} onChange={(e) => setSt({ ...st, start_period: Number(e.target.value) })} />
          <input type="number" placeholder="끝교시" value={st.end_period} onChange={(e) => setSt({ ...st, end_period: Number(e.target.value) })} />
          <input placeholder="강의실" value={st.room} onChange={(e) => setSt({ ...st, room: e.target.value })} />
        </div>
        <button className="btn-add" onClick={() => run('set_section_time', st, '강의시간 저장됨')}>저장</button>
      </Section>

      <Section title="게시글 강제 삭제">
        <div className="admin-row">
          <select value={del.table} onChange={(e) => setDel({ ...del, table: e.target.value })}>
            <option value="review">강의평</option>
            <option value="exam_archive">족보</option>
            <option value="class_memo">수업메모</option>
          </select>
          <input placeholder="id" value={del.id} onChange={(e) => setDel({ ...del, id: e.target.value })} />
          <button className="btn-remove" onClick={() => run('delete_post', { table: del.table, id: Number(del.id) }, '삭제됨')}>삭제</button>
        </div>
      </Section>
    </div>
  );
}
