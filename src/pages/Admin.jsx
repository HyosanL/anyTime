import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase } from '../supabase';
import { getCatalog } from '../lib/cache';
import SyllabusUpload from '../components/SyllabusUpload';
import BackButton from '../components/BackButton';

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

// 카탈로그(professor/semester/course/period/section/section_time) 테이블을 바꾸는 액션들.
// 이 액션이 성공했을 때만 로컬 카탈로그 캐시를 강제로 다시 받는다(그 외 액션은 캐시 유지).
const CATALOG_ACTIONS = new Set([
  'set_period', 'delete_catalog', 'set_section', 'set_section_time',
  'set_course', 'add_course', 'set_professor', 'add_professor', 'set_semester',
  'set_common_block',
]);

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
      setMsg(`✅ 반영 완료 — 추가 ${r.data.added} · 학과변경 ${r.data.updated} · 연구실 ${r.data.officeUpdated ?? 0} · 유지 ${r.data.unchanged}`);
      onApplied?.();
    } else setMsg(r.status === 'NO_DATA'
      ? '⚠️ 명단을 가져오지 못해 반영하지 않았습니다.'
      : `⚠️ 실패: ${r.status}`);
  }

  const p = preview;
  return (
    <Card icon="🔄" title="교수 명단 동기화"
      desc="공군사관학교 공식 홈페이지(교수소개)에서 학과별 교수 명단을 가져와 대조합니다. 새 교수는 추가하고 학과가 바뀐 교수는 갱신하며, 기존 교수는 삭제하지 않습니다. 주기 자동 갱신은 pg_cron 으로 설정합니다(db/schema.sql 하단 크론 템플릿).">
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
            {busy === 'apply' ? '반영 중…' : `반영하기 (추가 ${p.add.length}·학과 ${p.deptChanges.length}·연구실 ${p.officeChanges?.length ?? 0})`}
          </button>
        )}
      </div>
      {msg && <p className={`admin-msg ${msg.startsWith('⚠️') ? 'is-fail' : 'is-ok'}`}>{msg}</p>}

      {p && (
        <div className="adm-expand">
          <p className="note">학과 {p.scanned.departments}개 · 교수 {p.scanned.professors}명 확인.
            {' '}추가 <b>{p.add.length}</b> · 학과변경 <b>{p.deptChanges.length}</b> · 연구실 <b>{p.officeChanges?.length ?? 0}</b> · 유지 {p.unchanged}
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

          {p.officeChanges?.length > 0 && <>
            <div className="section-label adm-sub-label">연구실 변경 ({p.officeChanges.length})</div>
            <div className="adm-tags">
              {p.officeChanges.map((c, i) => <span key={i} className="tag tag-primary">{c.name}: {c.from || '—'} → {c.to}</span>)}
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
        <p className="note">반영 결과 — 추가 {result.added} · 학과변경 {result.updated} · 연구실 {result.officeUpdated ?? 0} · 유지 {result.unchanged}
          {result.orphans > 0 && ` · 홈페이지에 없음 ${result.orphans}(유지)`}
          {result.ambiguous > 0 && ` · 동명이인 보류 ${result.ambiguous}`}
        </p>
      )}
    </Card>
  );
}

const DAY_KO = { 1: '월', 2: '화', 3: '수', 4: '목', 5: '금', 6: '토', 7: '일' };

// 교시 표의 한 행: 시작·종료 시각을 즉석에서 수정하고 저장.
function PeriodRow({ p, run }) {
  const s0 = String(p.start_time).slice(0, 5);
  const e0 = String(p.end_time).slice(0, 5);
  const [start, setStart] = useState(s0);
  const [end, setEnd] = useState(e0);
  const dirty = start !== s0 || end !== e0;
  return (
    <div className="adm-pt-row">
      <span className="adm-pt-no">{p.no}</span>
      <input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
      <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
      <div className="adm-pt-acts">
        <button className="btn-add btn-sm" disabled={!dirty || !start || !end}
          onClick={() => run('set_period', { no: p.no, start_time: start, end_time: end }, `${p.no}교시 저장`)}>저장</button>
        <button className="rev-del-btn" title="삭제"
          onClick={() => run('delete_catalog', { table: 'period', key: { no: p.no } }, '교시 삭제')}>×</button>
      </div>
    </div>
  );
}

// 교시 표 맨 아래: 새 교시 추가 행.
// ── 공통 비수업 시간(생도대·군사훈련·공통연구 …) ──────────────────────
// 시각(요일·교시)은 편람 격자에서 자동으로 읽어 오지만(AI 호출 0회), 여기서 학기별로
// 손보고 새 학기 것을 미리 넣을 수 있게 한다. 생도 시간표·마법사 격자에 회색으로 깔리고,
// 마법사는 이 시간을 '빈 시간(공강)'으로 세지 않는다.
const DAY_NAMES = { 1: '월', 2: '화', 3: '수', 4: '목', 5: '금', 6: '토', 7: '일' };
const BLOCK_NAMES = ['생도대', '군사훈련', '공통연구', '자율선택형교과', '전 생도 연구시간'];

function BlockRow({ b, run }) {
  const [end, setEnd] = useState(b.end_period);
  const [label, setLabel] = useState(b.label);
  const dirty = end !== b.end_period || label !== b.label;
  const key = { year: b.year, term: b.term, day_of_week: b.day_of_week, start_period: b.start_period };
  return (
    <div className="adm-pt-row">
      <span className="adm-pt-no">{DAY_NAMES[b.day_of_week]}{b.start_period}</span>
      <input className="adm-pt-no-input" type="number" min="1" max="12" value={end}
        onChange={(e) => setEnd(+e.target.value)} title="종료 교시" />
      <input list="adm-block-names" maxLength={20} value={label} onChange={(e) => setLabel(e.target.value)} />
      <div className="adm-pt-acts">
        <button className="btn-add btn-sm" disabled={!dirty || !label.trim() || end < b.start_period}
          onClick={() => run('set_common_block', { ...key, end_period: end, label: label.trim() },
            `${DAY_NAMES[b.day_of_week]}${b.start_period}교시 저장`)}>저장</button>
        <button className="rev-del-btn" title="삭제"
          onClick={() => run('delete_catalog', { table: 'common_block', key }, '비수업 시간 삭제')}>×</button>
      </div>
    </div>
  );
}

function NewBlockRow({ run, year, term }) {
  const [f, setF] = useState({ day_of_week: 1, start_period: 7, end_period: 8, label: '' });
  const ok = f.label.trim() && f.end_period >= f.start_period;
  return (
    <div className="adm-pt-row adm-pt-new">
      <select value={f.day_of_week} onChange={(e) => setF({ ...f, day_of_week: +e.target.value })}>
        {[1, 2, 3, 4, 5].map((d) => <option key={d} value={d}>{DAY_NAMES[d]}</option>)}
      </select>
      <input className="adm-pt-no-input" type="number" min="1" max="12" value={f.start_period}
        onChange={(e) => setF({ ...f, start_period: +e.target.value })} title="시작 교시" />
      <input className="adm-pt-no-input" type="number" min="1" max="12" value={f.end_period}
        onChange={(e) => setF({ ...f, end_period: +e.target.value })} title="종료 교시" />
      <input list="adm-block-names" maxLength={20} placeholder="이름 (예: 생도대)" value={f.label}
        onChange={(e) => setF({ ...f, label: e.target.value })} />
      <div className="adm-pt-acts">
        <button className="btn-add btn-sm" disabled={!ok}
          onClick={() => run('set_common_block', { year, term, ...f, label: f.label.trim() }, '비수업 시간 추가')}>추가</button>
      </div>
    </div>
  );
}

function NewPeriodRow({ run, nextNo }) {
  const [f, setF] = useState({ no: nextNo, start_time: '09:00', end_time: '09:50' });
  return (
    <div className="adm-pt-row adm-pt-new">
      <input className="adm-pt-no-input" type="number" value={f.no} onChange={(e) => setF({ ...f, no: +e.target.value })} />
      <input type="time" value={f.start_time} onChange={(e) => setF({ ...f, start_time: e.target.value })} />
      <input type="time" value={f.end_time} onChange={(e) => setF({ ...f, end_time: e.target.value })} />
      <div className="adm-pt-acts">
        <button className="btn-add btn-sm"
          onClick={() => run('set_period', f, `${f.no}교시 추가`)}>추가</button>
      </div>
    </div>
  );
}

// 한 분반의 교수·정원·강의시간을 한 곳에서 인라인 편집.
function SectionEditor({ s, cat, run }) {
  const [profCode, setProfCode] = useState(s.professor_code || '');
  const [capacity, setCapacity] = useState(s.capacity ?? '');
  const [nt, setNt] = useState({ day_of_week: 1, start_period: 1, end_period: 1, room: '' });
  const base = { course_code: s.course_code, year: s.year, term: s.term, section_no: s.section_no };
  const times = (cat.section_time ?? [])
    .filter((t) => t.course_code === s.course_code && t.year === s.year && t.term === s.term && t.section_no === s.section_no)
    .sort((a, b) => a.day_of_week - b.day_of_week || a.start_period - b.start_period);
  return (
    <div className="adm-sec-editor">
      <div className="adm-form-grid">
        <label className="field"><span className="field-label">교수</span>
          <select value={profCode} onChange={(e) => setProfCode(e.target.value)}>
            <option value="">교수 미정</option>{(cat.professor ?? []).map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
          </select>
        </label>
        <label className="field"><span className="field-label">정원</span><input type="number" value={capacity} onChange={(e) => setCapacity(e.target.value)} /></label>
      </div>
      <button className="btn-add btn-block btn-sm"
        onClick={() => run('set_section', { ...base, professor_code: profCode || null, capacity: capacity === '' ? null : +capacity }, '분반 저장')}>분반 저장</button>

      <div className="section-label adm-sub-label">강의시간</div>
      {times.length === 0 && <p className="note">등록된 강의시간이 없습니다. 아래에서 추가하세요.</p>}
      {times.map((t) => (
        <div key={t.day_of_week + '-' + t.start_period} className="adm-chip-row">
          <span className="adm-chip-text">{DAY_KO[t.day_of_week]} {t.start_period}{t.end_period !== t.start_period ? `-${t.end_period}` : ''}교시{t.room ? ` · ${t.room}` : ''}</span>
          <button className="rev-del-btn" onClick={() => run('delete_catalog', { table: 'section_time', key: { ...base, day_of_week: t.day_of_week, start_period: t.start_period } }, '강의시간 삭제')}>삭제</button>
        </div>
      ))}
      <div className="adm-form-grid">
        <label className="field"><span className="field-label">요일</span>
          <select value={nt.day_of_week} onChange={(e) => setNt({ ...nt, day_of_week: +e.target.value })}>{[1, 2, 3, 4, 5, 6, 7].map((d) => <option key={d} value={d}>{DAY_KO[d]}</option>)}</select>
        </label>
        <label className="field"><span className="field-label">강의실</span><input placeholder="예: 본관 201" value={nt.room} onChange={(e) => setNt({ ...nt, room: e.target.value })} /></label>
        <label className="field"><span className="field-label">시작교시</span><input type="number" value={nt.start_period} onChange={(e) => setNt({ ...nt, start_period: +e.target.value })} /></label>
        <label className="field"><span className="field-label">끝교시</span><input type="number" value={nt.end_period} onChange={(e) => setNt({ ...nt, end_period: +e.target.value })} /></label>
      </div>
      <button className="btn-add btn-block btn-sm" onClick={() => run('set_section_time', { ...base, ...nt }, '강의시간 추가')}>강의시간 추가</button>
    </div>
  );
}

// 선택한 과목에 새 분반 추가.
function NewSectionForm({ courseCode, cat, run, defYear, defTerm }) {
  const [f, setF] = useState({ year: defYear, term: defTerm, section_no: 1, professor_code: '', capacity: '' });
  return (
    <div className="adm-sec-new">
      <div className="section-label adm-sub-label">새 분반 추가</div>
      <div className="adm-form-grid">
        <label className="field"><span className="field-label">연도</span><input type="number" value={f.year} onChange={(e) => setF({ ...f, year: +e.target.value })} /></label>
        <label className="field"><span className="field-label">학기</span>
          <select value={f.term} onChange={(e) => setF({ ...f, term: +e.target.value })}><option value={1}>1</option><option value={2}>2</option></select>
        </label>
        <label className="field"><span className="field-label">분반</span><input type="number" value={f.section_no} onChange={(e) => setF({ ...f, section_no: +e.target.value })} /></label>
        <label className="field"><span className="field-label">교수</span>
          <select value={f.professor_code} onChange={(e) => setF({ ...f, professor_code: e.target.value })}>
            <option value="">교수 미정</option>{(cat.professor ?? []).map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
          </select>
        </label>
      </div>
      <button className="btn-add btn-block"
        onClick={() => run('set_section', { course_code: courseCode, year: f.year, term: f.term, section_no: f.section_no, professor_code: f.professor_code || null, capacity: f.capacity === '' ? null : +f.capacity }, '분반 추가')}>분반 추가</button>
    </div>
  );
}

// 허브 항목 정의 (key는 라우팅 section 과 일치). 검열(moderation)은 별도 페이지로 링크하며 최상단.
const SECTIONS = [
  { key: 'moderation', icon: '🧹', title: '검열', sub: '신고·자동필터 강의평·수정제안 검토', to: '/admin/moderation' },
  { key: 'banned-words', icon: '🚫', title: '금지어', sub: '작성 시 자동으로 가려질 금지어 추가·삭제' },
  { key: 'notices', icon: '📢', title: '공지사항', sub: '홈 화면 팝업 공지 작성·관리' },
  { key: 'courses', icon: '📚', title: '과목 · 분반', sub: '과목 검색 → 분반 하나씩 관리' },
  { key: 'ai', icon: '🤖', title: 'AI 강의 일괄등록', sub: 'PDF 업로드 → 자동 매칭 → 검토 후 적용' },
  { key: 'csv', icon: '📄', title: 'CSV 강의 일괄등록', sub: 'CSV 업로드/붙여넣기 → 자동 매칭 → 검토 후 적용' },
  { key: 'professors', icon: '👤', title: '교수', sub: '교수 검색·추가·수정·삭제' },
  { key: 'professors-sync', icon: '🔄', title: '교수 명단 동기화', sub: '공식 홈페이지에서 교수 명단 자동 갱신' },
  { key: 'semesters', icon: '🗓️', title: '학기 · 교시', sub: '현재 학기와 교시 시각 설정' },
  { key: 'blocks', icon: '⛔', title: '공통 비수업 시간', sub: '학기별 생도대·군사훈련·공통연구 시간 관리' },
  { key: 'signup', icon: '🔑', title: '가입코드', sub: '신규 가입 코드 확인·변경' },
  { key: 'settings', icon: '⚙️', title: '계정 위치 인증 및 인증 기간', sub: '캠퍼스 위치·반경, 위치 재인증·자격 기간' },
  { key: 'thresholds', icon: '🎚️', title: '기준값 설정', sub: 'HOT 승격·신고 자동삭제·강의평 작성 자격 기준' },
  { key: 'board', icon: '💬', title: '게시판 관리', sub: '활성화·비회원 공유 열람·게시판별/전체 글 삭제' },
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
  const [notices, setNotices] = useState([]);
  const [ntc, setNtc] = useState({ id: null, title: '', content: '' });
  const [bannedWords, setBannedWords] = useState([]);
  const [newWord, setNewWord] = useState('');

  // 폼 상태
  const [q, setQ] = useState('');
  const [selCourse, setSelCourse] = useState('');
  const [selSection, setSelSection] = useState('');   // 편집 중인 분반 키 (year-term-no)
  const [newCode, setNewCode] = useState('');
  const [adminUser, setAdminUser] = useState('');
  const [course, setCourse] = useState({ code: '', name: '' });
  const [prof, setProf] = useState({ code: '', name: '', department: '' });
  const [pq, setPq] = useState('');
  const [sem, setSem] = useState({ year: 2026, term: 1 });
  // 공통 비수업 시간 탭에서 보고 있는 학기 ("2026-2")
  const [blockSem, setBlockSem] = useState('');

  // 카탈로그가 아닌 관리 데이터(관리자·가입코드·설정·공지·금지어·게시판 목록)만 새로고침.
  function loadMeta() {
    call('list_admins').then((r) => r.ok && setAdmins(r.data.admins ?? []));
    call('get_signup_code').then((r) => r.ok && setCurrentCode(r.data.code ?? ''));
    call('get_app_setting').then((r) => r.ok && setSetting(r.data.setting ?? {}));
    call('list_notices').then((r) => r.ok && setNotices(r.data.items ?? []));
    call('list_banned_words').then((r) => r.ok && setBannedWords(r.data.words ?? []));
    supabase.from('board').select('id, name').order('last_activity_at', { ascending: false }).then(({ data }) => setBoardsList(data || []));
  }
  async function loadCatalog(force = false) {
    setCat(await getCatalog({ force }).catch(() => null));
  }
  // 진입: 카탈로그는 캐시 우선(즉시). 매번 6테이블을 강제 재다운로드하지 않는다.
  function loadAll() { loadCatalog(false); loadMeta(); }
  // 카탈로그를 바꾸는 적용(편람 반영·교수 동기화)이 끝나면 최신 카탈로그를 강제로 다시 받는다.
  function reloadWithCatalog() { loadMeta(); loadCatalog(true); }

  useEffect(() => {
    supabase.rpc('is_admin').then(({ data }) => { setIsAdmin(!!data); if (data) loadAll(); });
  }, []);

  // 섹션이 바뀌면 메시지를 비워 깔끔하게 시작
  useEffect(() => { setMsg(''); }, [section]);

  // ── 공통 비수업 시간 탭 ──────────────────────────────────────────────
  // 기본 학기 = 현재 학기(없으면 가장 최근). 카탈로그가 늦게 와도 한 번은 잡아 준다.
  useEffect(() => {
    if (blockSem || !cat?.semester?.length) return;
    const cur = cat.semester.find((s) => s.is_current)
      ?? [...cat.semester].sort((a, b) => b.year - a.year || b.term - a.term)[0];
    if (cur) setBlockSem(`${cur.year}-${cur.term}`);
  }, [cat, blockSem]);

  const blockSemYT = useMemo(() => {
    const [y, t] = blockSem.split('-').map(Number);
    return y && t ? { year: y, term: t } : null;
  }, [blockSem]);

  const blocksOfSem = useMemo(() => (
    (cat?.common_block ?? [])
      .filter((b) => blockSemYT && b.year === blockSemYT.year && b.term === blockSemYT.term)
      .sort((a, b) => a.day_of_week - b.day_of_week || a.start_period - b.start_period)
  ), [cat, blockSemYT]);

  // 학기 삭제는 이 앱에서 가장 파괴적인 버튼이다. (year,term) 은 section·common_block·timetable 이
  // 모두 ON DELETE CASCADE 로 물고 있어서, 칩의 × 한 번이 그 학기의 분반·강의시간은 물론
  // 생도들이 저장해 둔 시간표까지 통째로 지운다 — 실제로 2026-2 학기가 이렇게 날아갔다.
  // 되돌릴 방법이 없으므로(백업 복원뿐) 학기명을 그대로 입력해야만 실행한다.
  function deleteSemester(s) {
    const key = `${s.year}-${s.term}`;
    const n = (cat?.section ?? []).filter((x) => x.year === s.year && x.term === s.term).length;
    const typed = prompt(
      `⚠️ ${key} 학기를 삭제하면 되돌릴 수 없습니다.\n\n`
      + `함께 사라지는 것:\n`
      + `  · 이 학기 분반 ${n}개와 강의시간 전부\n`
      + `  · 생도들이 저장한 ${key} 시간표 전부 (담긴 강의·직접추가 포함)\n`
      + `  · 이 학기의 비수업 시간 설정\n\n`
      + `강의 정보만 다시 올리고 싶은 것이라면 학기를 지울 필요가 없습니다 —\n`
      + `CSV·편람 일괄등록이 기존 분반을 대조해 갱신합니다.\n\n`
      + `정말 지우려면 "${key}" 를 그대로 입력하세요.`
    );
    if (typed?.trim() !== key) return;
    run('delete_catalog', { table: 'semester', key: { year: s.year, term: s.term } }, `${key} 학기 삭제`);
  }

  async function run(action, payload, okMsg) {
    setMsg('');
    const r = await call(action, payload);
    setMsg(r.ok ? `✅ ${okMsg}` : `⚠️ 실패: ${r.status ?? '오류'}`);
    if (r.ok) {
      loadMeta();
      // 카탈로그를 바꾼 액션만 카탈로그 강제 재조회 — 그 외(금지어·공지·설정 등)는
      // 캐시를 유지해 불필요한 6테이블 재다운로드를 없앤다.
      if (CATALOG_ACTIONS.has(action)) loadCatalog(true);
    }
    return r;
  }

  async function addBannedWord() {
    const w = newWord.trim();
    if (!w) return;
    if (w.length > 40) { setMsg('⚠️ 금지어는 40자 이내로 입력하세요.'); return; }
    const r = await run('add_banned_word', { word: w }, `금지어 '${w}' 추가`);
    if (r.ok) setNewWord('');
  }

  const courses = cat?.course ?? [];
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return courses.filter((c) => !s || c.name.toLowerCase().includes(s) || c.code.toLowerCase().includes(s));
  }, [courses, q]);
  const curSem = cat?.semester?.find((s) => s.is_current) || cat?.semester?.[0] || { year: 2026, term: 1 };
  const secOf = (code) => (cat?.section ?? []).filter((x) => x.course_code === code);
  const timesOf = (s) => (cat?.section_time ?? [])
    .filter((t) => t.course_code === s.course_code && t.year === s.year && t.term === s.term && t.section_no === s.section_no)
    .map((t) => (t.start_period === t.end_period ? `${DAY_KO[t.day_of_week]}${t.start_period}` : `${DAY_KO[t.day_of_week]}${t.start_period}-${t.end_period}`)).join(', ');

  if (isAdmin === null) return <div className="page-center">확인 중…</div>;
  if (!isAdmin) return (
    <div className="page">
      <header className="page-header">
        <BackButton />
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
          <BackButton />
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
          <BackButton />
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
        <BackButton fallback="/admin" />
        <h2>{TITLE_OF[section]}</h2>
      </header>

      {banner}

      <div className="cards admin-cards">
        {section === 'notices' && (
          <Card icon="📢" title="공지사항" desc="사용자가 앱에 접속하면 홈 화면에서 게시 중인 공지를 팝업으로 봅니다. 게시 후 48시간이 지나면 자동으로 내려가고, 한 번 본 사용자에게는 다시 표시되지 않습니다(수정·재게시하면 다시 표시).">
            {notices.length === 0 ? (
              <p className="note adm-empty-row">등록된 공지가 없습니다. 아래에서 작성하세요.</p>
            ) : (
              <ul className="list adm-list">
                {notices.map((n) => {
                  const live = n.is_active && new Date(n.expires_at) > new Date();
                  return (
                    <li key={n.id} className="adm-item">
                      <div className="adm-item-row">
                        <div className="adm-item-body">
                          <div className="adm-item-title">
                            <span className={`tag ${live ? 'tag-success' : 'tag-warn'}`}>{!n.is_active ? '내려짐' : live ? '게시 중' : '만료'}</span> {n.title}
                          </div>
                          <div className="adm-item-sub">{fmtDateTime(n.created_at)}{live ? ` · ${fmtDateTime(n.expires_at)} 까지` : ''}</div>
                        </div>
                        <div className="adm-item-acts">
                          <button className="btn-ghost btn-sm" onClick={() => run('set_notice_active', { id: n.id, value: !live }, live ? '공지 내림' : '공지 게시(48시간)')}>{live ? '내리기' : '게시(48h)'}</button>
                          <button className="link-btn" onClick={() => setNtc({ id: n.id, title: n.title, content: n.content })}>수정</button>
                          <button className="rev-del-btn" onClick={() => { if (confirm(`'${n.title}' 공지를 삭제합니다.`)) run('delete_notice', { id: n.id }, '공지 삭제'); }}>삭제</button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="divider adm-divider" />
            <div className="section-label adm-sub-label">{ntc.id ? '공지 수정' : '새 공지 작성'}</div>
            <label className="field"><span className="field-label">제목</span><input placeholder="공지 제목" value={ntc.title} onChange={(e) => setNtc({ ...ntc, title: e.target.value })} /></label>
            <label className="field"><span className="field-label">내용</span><textarea placeholder="공지 내용 (줄바꿈이 그대로 표시됩니다)" value={ntc.content} onChange={(e) => setNtc({ ...ntc, content: e.target.value })} /></label>
            {ntc.id ? (
              <div className="adm-btn-row">
                <button className="btn-add" onClick={async () => { if (!ntc.title.trim() || !ntc.content.trim()) return; const r = await run('set_notice', ntc, '공지 수정 (본 사람에게도 다시 표시)'); if (r.ok) setNtc({ id: null, title: '', content: '' }); }}>저장</button>
                <button className="rev-del-btn" onClick={() => setNtc({ id: null, title: '', content: '' })}>취소</button>
              </div>
            ) : (
              <button className="btn-add btn-block" onClick={async () => { if (!ntc.title.trim() || !ntc.content.trim()) return; const r = await run('set_notice', ntc, '공지 등록 (48시간 게시)'); if (r.ok) setNtc({ id: null, title: '', content: '' }); }}>공지 등록 (48시간 게시)</button>
            )}
          </Card>
        )}

        {section === 'banned-words' && (
          <Card icon="🚫" title="금지어" desc="여기에 등록한 단어는 강의평·강의메모·게시글·댓글·족보를 작성할 때 자동으로 *로 가려집니다(단어 일부만 포함돼도 그 부분이 가려짐). 기본 비속어는 이미 내장되어 있어, 새로 문제 되는 단어만 추가하면 됩니다. 대소문자는 구분하지 않으며, 이미 작성된 글에는 소급 적용되지 않습니다.">
            <label className="field"><span className="field-label">새 금지어</span>
              <input placeholder="가릴 단어 입력" value={newWord}
                onChange={(e) => setNewWord(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addBannedWord(); } }} />
            </label>
            <button className="btn-add btn-block" onClick={addBannedWord}>금지어 추가</button>

            <div className="divider adm-divider" />
            <div className="section-label adm-sub-label">등록된 금지어 ({bannedWords.length})</div>
            <div className="adm-tags">
              {bannedWords.length === 0
                ? <span className="note">등록된 금지어가 없습니다. 위에서 추가하세요.</span>
                : bannedWords.map((w) => (
                  <span key={w.word} className="tag tag-warn">{w.word}
                    <button className="x" onClick={() => run('delete_banned_word', { word: w.word }, `금지어 '${w.word}' 삭제`)}>×</button>
                  </span>
                ))}
            </div>
          </Card>
        )}

        {section === 'courses' && (
          <Card icon="📚" title="과목 · 분반 관리" desc="과목을 검색해 선택하면 분반을 하나씩 관리합니다. 아래에서 과목을 추가/수정하며, 과목코드는 자동 부여됩니다.">
            <div className="search-bar adm-inline-search">
              <input type="search" placeholder="과목 검색 (이름 또는 코드)" value={q}
                onChange={(e) => { setQ(e.target.value); setSelCourse(''); setSelSection(''); }} />
            </div>

            {q.trim() === '' ? (
              <p className="note adm-empty-row">과목명 또는 코드로 검색하세요.</p>
            ) : (
              <ul className="list adm-list">
                {filtered.map((c) => (
                  <li key={c.code} className={`adm-item ${selCourse === c.code ? 'open' : ''}`}>
                    <div className="adm-item-row">
                      <div className="adm-item-body">
                        <div className="adm-item-title">{c.name}</div>
                        <div className="adm-item-sub">{[c.code, c.department].filter(Boolean).join(' · ')}</div>
                      </div>
                      <div className="adm-item-acts">
                        <button className="btn-ghost btn-sm" onClick={() => { setSelCourse(selCourse === c.code ? '' : c.code); setSelSection(''); }}>{selCourse === c.code ? '닫기' : '분반'}</button>
                        <button className="link-btn" onClick={() => setCourse({ code: c.code, name: c.name || '' })}>수정</button>
                        <button className="rev-del-btn" onClick={() => { if (confirm(`'${c.name}' 과목과 분반·강의시간이 모두 삭제됩니다.`)) run('delete_catalog', { table: 'course', key: { code: c.code } }, '과목 삭제'); }}>삭제</button>
                      </div>
                    </div>

                    {selCourse === c.code && (
                      <div className="adm-expand">
                        <div className="section-label adm-sub-label">이 과목의 분반</div>
                        {secOf(c.code).length === 0 && <p className="note">등록된 분반이 없습니다. 아래에서 추가하세요.</p>}
                        {secOf(c.code).map((s) => {
                          const skey = `${s.year}-${s.term}-${s.section_no}`;
                          const open = selSection === skey;
                          const pname = (cat.professor.find((p) => p.code === s.professor_code) || {}).name || '교수미정';
                          return (
                            <div key={skey} className={`adm-sec-block ${open ? 'open' : ''}`}>
                              <div className="adm-chip-row">
                                <span className="adm-chip-text">{s.year}-{s.term} · {s.section_no}분반 · {pname} · {timesOf(s) || '시간미정'}</span>
                                <button className="btn-ghost btn-sm" onClick={() => setSelSection(open ? '' : skey)}>{open ? '닫기' : '편집'}</button>
                                <button className="rev-del-btn" onClick={() => run('delete_catalog', { table: 'section', key: { course_code: s.course_code, year: s.year, term: s.term, section_no: s.section_no } }, '분반 삭제')}>삭제</button>
                              </div>
                              {open && <SectionEditor s={s} cat={cat} run={run} />}
                            </div>
                          );
                        })}

                        <NewSectionForm courseCode={c.code} cat={cat} run={run} defYear={curSem.year} defTerm={curSem.term} />
                      </div>
                    )}
                  </li>
                ))}
                {filtered.length === 0 && <li className="note adm-empty-row">검색 결과가 없습니다.</li>}
              </ul>
            )}

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
              onApplied={reloadWithCatalog}
            />
          </Card>
        )}

        {section === 'csv' && (
          <Card icon="📄" title="CSV 강의 일괄등록" desc="과목·분반 표를 CSV로 올리거나 붙여넣으면 기존 DB와 대조 후 적용합니다. 결정적(고정)이라 AI보다 정확합니다. 양식을 내려받아 채우거나, 수강편람에서 추출한 CSV를 그대로 올리세요.">
            <SyllabusUpload
              mode="csv"
              defaultYear={cat?.semester?.find((s) => s.is_current)?.year || 2026}
              defaultTerm={cat?.semester?.find((s) => s.is_current)?.term || 1}
              onApplied={reloadWithCatalog}
            />
          </Card>
        )}

        {section === 'professors' && (
          <Card icon="👤" title="교수 관리" desc="교수를 검색해 수정/삭제하고, 아래에서 새 교수를 추가합니다. 교수코드는 자동 부여됩니다.">
            <div className="search-bar adm-inline-search">
              <input type="search" placeholder="교수 검색 (성명/학과)" value={pq} onChange={(e) => setPq(e.target.value)} />
            </div>
            {pq.trim() === '' ? (
              <p className="note adm-empty-row">성명 또는 학과로 검색하세요.</p>
            ) : (() => {
              const s = pq.trim().toLowerCase();
              const list = (cat?.professor ?? []).filter((p) => [p.name, p.department, p.code].some((v) => (v || '').toLowerCase().includes(s)));
              return (
                <ul className="list adm-list adm-list-scroll">
                  {list.length === 0 && <li className="note adm-empty-row">검색 결과가 없습니다.</li>}
                  {list.map((p) => (
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
              );
            })()}

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
          <ProfessorSyncCard syncedAt={setting.professors_synced_at} onApplied={reloadWithCatalog} />
        )}

        {section === 'blocks' && (
          <Card icon="⛔" title="공통 비수업 시간"
            desc="전 생도가 수업이 없는 시간(생도대·군사훈련·공통연구 …). 생도 시간표와 시간표 마법사 격자에 회색으로 깔리고, 마법사가 이 시간을 '빈 시간(공강)'으로 세지 않습니다. 편람(PDF) 일괄등록 시 주간 격자에서 자동으로 읽어 오므로 보통은 손댈 일이 없습니다 — 여기서는 학기별로 확인·수정하거나 새 학기 것을 미리 넣습니다.">
            <div className="adm-form-grid">
              <label className="field"><span className="field-label">학기</span>
                <select value={blockSem} onChange={(e) => setBlockSem(e.target.value)}>
                  {(cat?.semester ?? []).length === 0 && <option value="">등록된 학기 없음</option>}
                  {[...(cat?.semester ?? [])]
                    .sort((a, b) => b.year - a.year || b.term - a.term)
                    .map((s) => (
                      <option key={`${s.year}-${s.term}`} value={`${s.year}-${s.term}`}>
                        {s.year}-{s.term}{s.is_current ? ' (현재)' : ''}
                      </option>
                    ))}
                </select>
              </label>
            </div>

            {blockSemYT && (
              <div className="adm-period-table">
                <div className="adm-pt-head"><span>요일·시작</span><span>끝</span><span>이름</span><span /></div>
                {blocksOfSem.map((b) => (
                  <BlockRow key={`${b.day_of_week}-${b.start_period}`} b={b} run={run} />
                ))}
                <NewBlockRow key={`new-${blockSem}-${blocksOfSem.length}`} run={run}
                  year={blockSemYT.year} term={blockSemYT.term} />
              </div>
            )}
            {blockSemYT && blocksOfSem.length === 0 && (
              <p className="note">
                이 학기에 등록된 비수업 시간이 없습니다. 편람 PDF를 일괄등록하면 주간 격자에서
                자동으로 채워집니다(AI 호출 없음). 아래 줄에서 직접 넣을 수도 있습니다.
              </p>
            )}
            <datalist id="adm-block-names">
              {BLOCK_NAMES.map((n) => <option key={n} value={n} />)}
            </datalist>
          </Card>
        )}

        {section === 'semesters' && (
          <>
            <Card icon="🗓️" title="학기" desc="학기를 추가하거나 현재 학기를 지정합니다. 다음 학기를 미리 열려면 '학기 추가'만 하세요 — 생도가 그 학기 시간표를 미리 짤 수 있고, 현재 학기는 그대로 유지됩니다. ⚠️ 학기 삭제는 그 학기의 분반·강의시간과 생도들이 저장한 시간표까지 전부 지웁니다(되돌릴 수 없음).">
              <div className="adm-tags">
                {cat?.semester?.length ? cat.semester.map((s) => (
                  <span key={s.year + '' + s.term} className={`tag ${s.is_current ? 'tag-primary' : ''}`}>{s.year}-{s.term}{s.is_current ? ' (현재)' : ''}
                    <button className="x" title="이 학기 삭제 (분반·생도 시간표까지 연쇄 삭제)"
                      onClick={() => deleteSemester(s)}>×</button>
                  </span>
                )) : <span className="note">등록된 학기가 없습니다.</span>}
              </div>
              <div className="adm-form-grid">
                <label className="field"><span className="field-label">연도</span><input type="number" value={sem.year} onChange={(e) => setSem({ ...sem, year: +e.target.value })} /></label>
                <label className="field"><span className="field-label">학기</span>
                  <select value={sem.term} onChange={(e) => setSem({ ...sem, term: +e.target.value })}><option value={1}>1</option><option value={2}>2</option></select>
                </label>
              </div>
              <div className="adm-btn-row">
                <button className="btn-add" onClick={() => run('set_semester', { ...sem, is_current: false }, `${sem.year}-${sem.term} 학기 추가`)}>＋ 학기 추가</button>
                <button className="btn-ghost" onClick={() => run('set_semester', { ...sem, is_current: true }, '현재 학기 설정')}>현재 학기로 설정</button>
              </div>
            </Card>

            <Card icon="⏰" title="교시" desc="각 교시의 시작·종료 시각을 표에서 바로 수정합니다. 맨 아래 줄에서 새 교시를 추가하세요.">
              <div className="adm-period-table">
                <div className="adm-pt-head"><span>교시</span><span>시작</span><span>끝</span><span /></div>
                {(cat?.period ? [...cat.period].sort((a, b) => a.no - b.no) : []).map((p) => (
                  <PeriodRow key={p.no} p={p} run={run} />
                ))}
                <NewPeriodRow key={`new-${cat?.period?.length ?? 0}`} run={run}
                  nextNo={(cat?.period?.reduce((m, p) => Math.max(m, p.no), 0) ?? 0) + 1} />
              </div>
              {!cat?.period?.length && <p className="note">등록된 교시가 없습니다. 아래 줄에서 추가하세요.</p>}
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
          <Card icon="⚙️" title="계정 위치 인증 및 인증 기간" desc="위치 인증·계정 삭제 대기 기간과 캠퍼스 위치·반경을 설정합니다. 항목별로 따로 저장합니다. (강의평 작성 자격 일수는 ‘기준값 설정’에서 관리합니다.)">
            {[
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

        {section === 'thresholds' && (
          <Card icon="🎚️" title="기준값 설정" desc="자동화 기준을 관리자가 직접 정합니다. 값을 바꾸면 즉시 반영됩니다(이미 쌓인 신고/반응에도 다음 이벤트부터 새 기준 적용). 항목별로 따로 저장하세요.">
            {[
              ['hot_threshold', 'HOT 게시판 승격 기준', '개', '30분 안에 좋아요·싫어요·댓글이 이 수 이상 달리면 HOT으로 올라갑니다.'],
              ['report_delete_count', '신고 누적 자동삭제', '건', '한 글의 누적 신고수가 이 값에 도달하면 자동으로 숨겨집니다(아카이브 후 삭제, 복구 가능). 강의평·강의메모·게시글 공통.'],
              ['report_burst_count', '신고 급증 자동삭제 (15분)', '건', '15분 안에 신고가 이 수만큼 몰리면 담합·오신고로 보고 자동삭제합니다. 강의평·강의메모·게시글 공통.'],
              ['review_min_days', '강의평 작성 자격', '일', '해당 강의를 확정 시간표에 이 일수 이상 보유해야 강의평을 쓸 수 있습니다.'],
            ].map(([k, label, unit, hint]) => (
              <div className="adm-thr-item" key={k}>
                <p className="note adm-thr-hint">{hint}</p>
                <div className="adm-setting-row">
                  <label className="field adm-setting-field">
                    <span className="field-label">{label} <span className="adm-unit">({unit})</span></span>
                    <input type="number" min="1" step="1" value={setting[k] ?? ''}
                      onChange={(e) => setSetting({ ...setting, [k]: e.target.value })} />
                  </label>
                  <button className="btn-add btn-sm adm-setting-save"
                    onClick={() => { const v = Math.round(Number(setting[k])); if (!Number.isFinite(v) || v < 1) { setMsg('⚠️ 1 이상의 정수를 입력하세요.'); return; } run('set_app_setting', { field: k, value: v }, `${label} 변경`); }}>저장</button>
                </div>
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

            {/* 공유 링크(/s/…)를 받은 비로그인 사용자가 그 글을 읽을 수 있는지. 차단해도 링크
                생성·공유와 회원의 링크 접속(앱 글 화면으로 이동)은 계속 동작한다. */}
            <div className="adm-toggle-row">
              <div className="adm-toggle-body">
                <span className="adm-toggle-label">비회원 공유 열람</span>
                <span className={`tag ${setting.share_enabled === false ? 'tag-warn' : 'tag-success'}`}>{setting.share_enabled === false ? '차단' : '허용'}</span>
              </div>
              <button className="btn-ghost btn-sm" onClick={() => run('set_share_enabled', { value: !(setting.share_enabled !== false) }, '비회원 공유 열람 변경')}>
                {setting.share_enabled === false ? '허용' : '차단'}
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
