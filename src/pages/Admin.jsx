import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { httpsCallable } from 'firebase/functions';
import { collection, getDocs, orderBy, query } from 'firebase/firestore';
import { db, functions } from '../firebase';
import { getCatalog } from '../lib/cache';
import { useAuthContext } from '../contexts/AuthContext';
import { dupProfessorGroups, isPlaceholderProf } from '../lib/profname';
import { callAdmin as call, CATALOG_ACTIONS } from '../lib/admin';
import SyllabusUpload from '../components/SyllabusUpload';
import BackButton from '../components/BackButton';
import '../styles/admin.css';
import '../styles/course.css';
import '../styles/board.css';

// 화면9: 관리자. isAdmin 게이트. 작업은 adminAction Cloud Function(커스텀 클레임 admin 검증).
// 라우팅: '/admin'=허브, '/admin/:section'=기능 화면. '/admin/moderation'은 별도 페이지(Moderation.jsx),
// 과목 하나를 고치는 '/admin/courses/:code'도 별도 페이지(AdminCourse.jsx) — 여기서 새 탭으로 연다.

// 교수 명단 동기화(syncProfessors) 는 adminAction 게이트웨이가 아니라 별도 Cloud Function —
// 옛 admin-action 체계에서도 전용 Edge Function 이었던 것과 동일 구도. 설계 문서 §5/§10:
// 이 함수는 이번 이관 범위 밖(월간·비활성)이라 firebase/functions 에 아직 포팅되어 있지 않다 —
// 배포되기 전까지 이 버튼은 'not-found' 로 실패한다(기능 자체는 옛 스키마에서도 비활성이었다).
async function invokeSync(mode) {
  try {
    const { data } = await httpsCallable(functions, 'syncProfessors')({ mode });
    return { ok: data?.status === 'OK', status: data?.status ?? 'ERROR', data: data ?? {} };
  } catch (e) {
    return { ok: false, status: e.code || 'ERROR', data: {} };
  }
}

// Cloud Function 응답의 Firestore Timestamp 는 {_seconds,_nanoseconds}(또는 {seconds,nanoseconds})로
// 오고, ISO 문자열·Date 인스턴스로 오는 필드도 섞여 있다(board.js 의 toIso 와 같은 이유) — 화면
// 표시 직전에 여기서 한 번에 흡수한다.
function tsMillis(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts === 'string' || typeof ts === 'number') return new Date(ts).getTime() || 0;
  const secs = ts._seconds ?? ts.seconds;
  return typeof secs === 'number' ? secs * 1000 : 0;
}
const fmtDateTime = (ts) => {
  const ms = tsMillis(ts);
  if (!ms) return '없음';
  try { return new Date(ms).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return '없음'; }
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

// 교시 표의 한 행: 시작·종료 시각을 즉석에서 수정하고 저장.
function PeriodRow({ p, run }) {
  const s0 = String(p.startTime).slice(0, 5);
  const e0 = String(p.endTime).slice(0, 5);
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
          onClick={() => run('set_period', { no: p.no, startTime: start, endTime: end }, `${p.no}교시 저장`)}>저장</button>
        <button className="rev-del-btn" title="삭제"
          onClick={() => run('delete_catalog', { table: 'period', key: { no: p.no } }, '교시 삭제')}>×</button>
      </div>
    </div>
  );
}

// 교시 표 맨 아래: 새 교시 추가 행.
// ── 공통 공강 시간(생도대·군사훈련·공통연구 …) ────────────────────────
// 시각(요일·교시)은 편람 격자에서 자동으로 읽어 오지만(AI 호출 0회), 여기서 학기별로
// 손보고 새 학기 것을 미리 넣을 수 있게 한다. 생도 시간표·마법사 격자에 회색으로 깔리고,
// 마법사는 이 시간을 '빈 시간(낀 시간)'으로 세지 않는다.
//
// 모바일에서 쓰는 화면이다 — 좁은 표(4열 그리드)에 숫자 입력을 우겨넣으면 손가락으로
// 못 만진다. 한 블록을 카드 한 장으로 펼치고, 교시는 드롭다운으로 고른다.
const DAY_NAMES = { 1: '월', 2: '화', 3: '수', 4: '목', 5: '금', 6: '토', 7: '일' };
const BLOCK_NAMES = ['생도대', '군사훈련', '공통연구', '자율선택형교과', '전 생도 연구시간'];

// 요일·시작·끝·이름을 모두 고칠 수 있는 한 줄. periods = 교시 번호 목록.
function BlockFields({ f, setF, periods }) {
  const ps = periods.length ? periods : [1, 2, 3, 4, 5, 6, 7, 8];
  return (
    <>
      <div className="adm-blk-time">
        <select aria-label="요일" value={f.day} onChange={(e) => setF({ ...f, day: +e.target.value })}>
          {[1, 2, 3, 4, 5, 6, 7].map((d) => <option key={d} value={d}>{DAY_NAMES[d]}요일</option>)}
        </select>
        <select aria-label="시작 교시" value={f.start}
          onChange={(e) => {
            const start = +e.target.value;
            setF({ ...f, start, end: Math.max(start, f.end) });   // 끝이 시작보다 앞서지 않게
          }}>
          {ps.map((p) => <option key={p} value={p}>{p}교시</option>)}
        </select>
        <span className="adm-blk-tilde">~</span>
        <select aria-label="종료 교시" value={f.end} onChange={(e) => setF({ ...f, end: +e.target.value })}>
          {ps.filter((p) => p >= f.start).map((p) => <option key={p} value={p}>{p}교시</option>)}
        </select>
      </div>
      <input className="adm-blk-label" list="adm-block-names" maxLength={20}
        placeholder="이름 (예: 생도대)" value={f.label}
        onChange={(e) => setF({ ...f, label: e.target.value })} />
    </>
  );
}

function BlockRow({ b, run, periods }) {
  const [f, setF] = useState({ day: b.dayOfWeek, start: b.startPeriod, end: b.endPeriod, label: b.label });
  const dirty = f.day !== b.dayOfWeek || f.start !== b.startPeriod
    || f.end !== b.endPeriod || f.label !== b.label;
  const valid = f.label.trim() && f.end >= f.start;
  const when = `${DAY_NAMES[f.day]}${f.start}${f.end > f.start ? `~${f.end}` : ''}교시`;

  // 요일·시작교시는 PK 다 — 자리를 옮기면 옛 행을 지우고 새 자리에 넣어야 한다(old 로 알려준다).
  const save = () => run('set_common_block', {
    year: b.year, term: b.term,
    dayOfWeek: f.day, startPeriod: f.start, endPeriod: f.end, label: f.label.trim(),
    old: { dayOfWeek: b.dayOfWeek, startPeriod: b.startPeriod },
  }, `${when} 저장`);

  const remove = () => {
    if (!confirm(`${DAY_NAMES[b.dayOfWeek]}${b.startPeriod}교시 ‘${b.label}’ 을(를) 삭제할까요?`)) return;
    run('delete_catalog', {
      table: 'commonBlock',
      key: { year: b.year, term: b.term, dayOfWeek: b.dayOfWeek, startPeriod: b.startPeriod },
    }, '공통 공강 시간 삭제');
  };

  return (
    <div className={`adm-blk${dirty ? ' is-dirty' : ''}`}>
      <BlockFields f={f} setF={setF} periods={periods} />
      <div className="adm-blk-acts">
        <button className="btn-add btn-sm" disabled={!dirty || !valid} onClick={save}>
          {dirty ? '저장' : '저장됨'}
        </button>
        <button className="btn-remove btn-sm" onClick={remove}>삭제</button>
      </div>
    </div>
  );
}

function NewBlockRow({ run, year, term, periods }) {
  const [f, setF] = useState({ day: 1, start: 7, end: 8, label: '' });
  const valid = f.label.trim() && f.end >= f.start;
  return (
    <div className="adm-blk adm-blk-new">
      <BlockFields f={f} setF={setF} periods={periods} />
      <div className="adm-blk-acts">
        <button className="btn-add btn-sm btn-block" disabled={!valid}
          onClick={() => run('set_common_block', {
            year, term, dayOfWeek: f.day, startPeriod: f.start, endPeriod: f.end, label: f.label.trim(),
          }, '공통 공강 시간 추가')}>
          ＋ 추가
        </button>
      </div>
    </div>
  );
}

function NewPeriodRow({ run, nextNo }) {
  const [f, setF] = useState({ no: nextNo, startTime: '09:00', endTime: '09:50' });
  return (
    <div className="adm-pt-row adm-pt-new">
      <input className="adm-pt-no-input" type="number" value={f.no} onChange={(e) => setF({ ...f, no: +e.target.value })} />
      <input type="time" value={f.startTime} onChange={(e) => setF({ ...f, startTime: e.target.value })} />
      <input type="time" value={f.endTime} onChange={(e) => setF({ ...f, endTime: e.target.value })} />
      <div className="adm-pt-acts">
        <button className="btn-add btn-sm"
          onClick={() => run('set_period', f, `${f.no}교시 추가`)}>추가</button>
      </div>
    </div>
  );
}

// 분반 편집·추가는 과목 전용 화면(AdminCourse, /admin/courses/:code)에서 — 여기서는 새 탭으로 연다.

// 허브 항목 정의 (key는 라우팅 section 과 일치). 검열(moderation)은 별도 페이지로 링크하며 최상단.
const SECTIONS = [
  { key: 'moderation', icon: '🧹', title: '검열', sub: '신고·자동필터 강의평·수정제안 검토', to: '/admin/moderation' },
  { key: 'banned-words', icon: '🚫', title: '금지어', sub: '작성 시 자동으로 가려질 금지어 추가·삭제' },
  { key: 'notices', icon: '📢', title: '공지사항', sub: '홈 화면 팝업 공지 작성·관리' },
  { key: 'courses', icon: '📚', title: '과목 · 분반', sub: '과목 검색 → 새 탭에서 분반·교수·시간 관리' },
  { key: 'ai', icon: '🤖', title: 'AI 강의 일괄등록', sub: 'PDF 업로드 → 자동 매칭 → 검토 후 적용' },
  { key: 'csv', icon: '📄', title: 'CSV 강의 일괄등록', sub: 'CSV 업로드/붙여넣기 → 자동 매칭 → 검토 후 적용' },
  { key: 'professors', icon: '👤', title: '교수', sub: '교수 검색·추가·수정·삭제' },
  { key: 'professors-sync', icon: '🔄', title: '교수 명단 동기화', sub: '공식 홈페이지에서 교수 명단 자동 갱신' },
  { key: 'semesters', icon: '🗓️', title: '학기 · 교시', sub: '현재 학기와 교시 시각 설정' },
  { key: 'blocks', icon: '⛔', title: '공통 공강 시간', sub: '학기별 생도대·군사훈련·공통연구 시간 관리' },
  { key: 'signup', icon: '🔑', title: '가입코드', sub: '신규 가입 코드 확인·변경' },
  { key: 'settings', icon: '⚙️', title: '계정 위치 인증 및 인증 기간', sub: '캠퍼스 위치·반경, 위치 재인증·자격 기간' },
  { key: 'thresholds', icon: '🎚️', title: '기준값 설정', sub: 'HOT 승격·신고 자동삭제·강의평 작성 자격 기준' },
  { key: 'board', icon: '💬', title: '게시판 관리', sub: '활성화·비회원 공유 열람·게시판별/전체 글 삭제' },
  { key: 'admins', icon: '🛡️', title: '관리자', sub: '관리자 권한 부여·취소' },
];
const TITLE_OF = Object.fromEntries(SECTIONS.map((s) => [s.key, s.title]));

export default function Admin() {
  const { section } = useParams();
  // 관리자 여부는 cadet 프로필에 이미 실려 온다(useAuth) — isAdmin 을 별도로 조회하지 않는다.
  // 프로필이 아직 없으면(null) '확인 중'. 모든 관리자 액션은 서버(adminAction)가 다시 검증한다.
  const { cadet } = useAuthContext();
  const isAdmin = cadet ? !!cadet.isAdmin : null;
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
  // 과목 검색어는 URL(?q=)에 함께 남긴다 — 과목 화면(하위)에서 뒤로 나오면 결과가 그대로 있어야 한다.
  const [sp, setSp] = useSearchParams();
  const [q, setQ] = useState(sp.get('q') ?? '');
  const searchCourse = (v) => { setQ(v); setSp(v.trim() ? { q: v } : {}, { replace: true }); };
  const [newCode, setNewCode] = useState('');
  const [adminUser, setAdminUser] = useState('');
  const [newCourse, setNewCourse] = useState('');   // 새 과목명 (수정은 /admin/courses/:code 에서)
  const [prof, setProf] = useState({ code: '', name: '', department: '' });
  const [pq, setPq] = useState('');
  // 교수 통합: 고른 교수들(pSel) 중 한 명(pKeep)만 남기고 나머지를 흡수시킨다.
  const [pSel, setPSel] = useState([]);      // 통합 대상 교수코드
  const [pKeep, setPKeep] = useState('');    // 남길 교수코드
  const [pUsage, setPUsage] = useState({});  // code → { sections, reviews }
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
    // 게시판 목록은 카탈로그가 아니지만 어느 로그인 사용자든 직접 읽을 수 있다(firestore.rules: /boards/{id}).
    getDocs(query(collection(db, 'boards'), orderBy('lastActivityAt', 'desc')))
      .then((snap) => setBoardsList(snap.docs.map((d) => ({ id: d.id, name: d.get('name') }))))
      .catch(() => setBoardsList([]));
  }
  async function loadCatalog(force = false) {
    setCat(await getCatalog({ force }).catch(() => null));
  }
  // 진입: 카탈로그는 캐시 우선(즉시). 매번 6테이블을 강제 재다운로드하지 않는다.
  function loadAll() { loadCatalog(false); loadMeta(); }
  // 카탈로그를 바꾸는 적용(편람 반영·교수 동기화)이 끝나면 최신 카탈로그를 강제로 다시 받는다.
  function reloadWithCatalog() { loadMeta(); loadCatalog(true); }

  useEffect(() => {
    if (isAdmin) loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  // 섹션이 바뀌면 메시지를 비워 깔끔하게 시작
  useEffect(() => { setMsg(''); }, [section]);

  // ── 공통 비수업 시간 탭 ──────────────────────────────────────────────
  // 기본 학기 = 현재 학기(없으면 가장 최근). 카탈로그가 늦게 와도 한 번은 잡아 준다.
  useEffect(() => {
    if (blockSem || !cat?.semesters?.length) return;
    const cur = cat.semesters.find((s) => s.isCurrent)
      ?? [...cat.semesters].sort((a, b) => b.year - a.year || b.term - a.term)[0];
    if (cur) setBlockSem(`${cur.year}-${cur.term}`);
  }, [cat, blockSem]);

  const blockSemYT = useMemo(() => {
    const [y, t] = blockSem.split('-').map(Number);
    return y && t ? { year: y, term: t } : null;
  }, [blockSem]);

  const blocksOfSem = useMemo(() => (
    (cat?.commonBlocks ?? [])
      .filter((b) => blockSemYT && b.year === blockSemYT.year && b.term === blockSemYT.term)
      .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startPeriod - b.startPeriod)
  ), [cat, blockSemYT]);

  // 교시 드롭다운의 선택지(등록된 교시 번호). 교시가 없으면 1~8 로 폴백한다.
  const periodNos = useMemo(
    () => [...(cat?.periods ?? [])].map((p) => p.no).sort((a, b) => a - b),
    [cat]
  );

  // ── 교수 통합 ────────────────────────────────────────────────────────
  // 같은 사람이 두 벌로 등록된 묶음(이름만 다르게 적혀 새로 생긴 것). 검색과 무관하게 항상 보여준다.
  const dupGroups = useMemo(() => dupProfessorGroups(cat?.professors ?? []), [cat]);
  // 사람이 아닌 교수("신임교수"·"미정" …). 옛 일괄등록이 담당교수 칸을 그대로 교수로 만든 흔적 —
  // 지우면 그 강의는 '교수 미정'이 된다(FK ON DELETE SET NULL). 지금은 파싱 단계에서 걸러진다.
  const fakeProfs = useMemo(
    () => (cat?.professors ?? []).filter((p) => isPlaceholderProf(p.name)),
    [cat]
  );
  const secCountOf = (code) => (cat?.sections ?? []).filter((s) => s.professorCode === code).length;

  function deleteFakeProf(p) {
    const n = secCountOf(p.code);
    const ok = confirm(
      `"${p.name}" 은(는) 사람 이름이 아니라 '아직 정해지지 않았다'는 표시로 보입니다.\n`
      + `교수 목록에서 지웁니다.\n\n`
      + (n > 0
        ? `· 이 교수로 등록된 분반 ${n}개는 '교수 미정'이 됩니다(강의는 지워지지 않습니다).\n`
        : `· 이 교수로 등록된 분반은 없습니다.\n`)
      + `\n진행할까요?`
    );
    if (!ok) return;
    run('delete_catalog', { table: 'professor', key: { code: p.code } }, `'${p.name}' 삭제 — 해당 분반은 교수 미정`);
  }
  const profByCode = useMemo(
    () => new Map((cat?.professors ?? []).map((p) => [p.code, p])),
    [cat]
  );
  const selProfs = useMemo(
    () => pSel.map((c) => profByCode.get(c)).filter(Boolean),
    [pSel, profByCode]
  );

  // 고른 교수들의 분반·강의평 수를 세어 온다(어느 쪽을 남길지 판단 근거).
  // 기본으로 남길 교수 = 참조가 가장 많은 쪽, 같으면 이름이 가장 완전한(긴) 쪽.
  useEffect(() => {
    if (pSel.length < 2) { setPUsage({}); return; }
    let alive = true;
    call('professor_usage', { codes: pSel }).then((r) => {
      if (!alive || !r.ok) return;
      const u = r.data.usage ?? {};
      setPUsage(u);
      setPKeep((cur) => {
        if (cur && pSel.includes(cur)) return cur;
        const refs = (c) => (u[c]?.sections ?? 0) + (u[c]?.reviews ?? 0);
        const nameLen = (c) => (profByCode.get(c)?.name || '').length;
        return [...pSel].sort((a, b) => refs(b) - refs(a) || nameLen(b) - nameLen(a))[0] ?? '';
      });
    });
    return () => { alive = false; };
  }, [pSel, profByCode]);

  // 선택에서 뺀 교수가 '남길 교수'였다면 그 선택도 지운다 — 안 그러면 목록에 없는 교수로 합쳐진다.
  const toggleSel = (code) => {
    setPSel((s) => (s.includes(code) ? s.filter((c) => c !== code) : [...s, code]));
    setPKeep((k) => (k === code ? '' : k));
  };
  const cancelMerge = () => { setPSel([]); setPKeep(''); setPUsage({}); };

  // 통합은 되돌릴 수 없다(흡수된 교수 행이 사라진다) — 무엇이 어디로 옮겨지는지 세어 보여주고 확인받는다.
  async function mergeProfs() {
    const keep = profByCode.get(pKeep);
    const gone = selProfs.filter((p) => p.code !== pKeep);
    if (!keep || !pSel.includes(pKeep) || !gone.length) return;
    const nSec = gone.reduce((a, p) => a + (pUsage[p.code]?.sections ?? 0), 0);
    const nRev = gone.reduce((a, p) => a + (pUsage[p.code]?.reviews ?? 0), 0);
    const ok = confirm(
      `${gone.map((p) => `${p.name} (${p.code})`).join('\n')}\n`
      + `→ ${keep.name} (${keep.code}) 로 통합합니다.\n\n`
      + `· 분반 ${nSec}개와 강의평 ${nRev}개가 ${keep.name} 에게 옮겨집니다.\n`
      + `· 흡수된 교수 ${gone.length}명은 목록에서 사라집니다.\n`
      + `· 학과·연구실은 ${keep.name} 쪽이 비어 있을 때만 채워집니다.\n\n`
      + `되돌릴 수 없습니다. 진행할까요?`
    );
    if (!ok) return;
    const r = await run('merge_professors', { into: pKeep, from: gone.map((p) => p.code) }, '교수 통합');
    if (r.ok) {
      const d = r.data ?? {};
      setMsg(`✅ ${keep.name} 로 통합 — 교수 ${d.merged}명 흡수, 분반 ${d.sections}개·강의평 ${d.reviews}개 이동.`);
      cancelMerge();
    }
  }

  // 학기 삭제는 이 앱에서 가장 파괴적인 버튼이다. (year,term) 은 section·common_block·timetable 이
  // 모두 ON DELETE CASCADE 로 물고 있어서, 칩의 × 한 번이 그 학기의 분반·강의시간은 물론
  // 생도들이 저장해 둔 시간표까지 통째로 지운다 — 실제로 2026-2 학기가 이렇게 날아갔다.
  // 되돌릴 방법이 없으므로(백업 복원뿐) 학기명을 그대로 입력해야만 실행한다.
  function deleteSemester(s) {
    const key = `${s.year}-${s.term}`;
    const n = (cat?.sections ?? []).filter((x) => x.year === s.year && x.term === s.term).length;
    const typed = prompt(
      `⚠️ ${key} 학기를 삭제하면 되돌릴 수 없습니다.\n\n`
      + `함께 사라지는 것:\n`
      + `  · 이 학기 분반 ${n}개와 강의시간 전부\n`
      + `  · 생도들이 저장한 ${key} 시간표 전부 (담긴 강의·직접추가 포함)\n`
      + `  · 이 학기의 공통 공강 시간 설정\n\n`
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

  const courses = cat?.courses ?? [];
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return courses.filter((c) => !s || c.name.toLowerCase().includes(s) || c.code.toLowerCase().includes(s));
  }, [courses, q]);
  const secOf = (code) => (cat?.sections ?? []).filter((x) => x.courseCode === code);

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
                  const live = n.isActive && tsMillis(n.expiresAt) > Date.now();
                  return (
                    <li key={n.id} className="adm-item">
                      <div className="adm-item-row">
                        <div className="adm-item-body">
                          <div className="adm-item-title">
                            <span className={`tag ${live ? 'tag-success' : 'tag-warn'}`}>{!n.isActive ? '내려짐' : live ? '게시 중' : '만료'}</span> {n.title}
                          </div>
                          <div className="adm-item-sub">{fmtDateTime(n.createdAt)}{live ? ` · ${fmtDateTime(n.expiresAt)} 까지` : ''}</div>
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
          <Card icon="📚" title="과목 · 분반 관리" desc="과목을 검색해 고르면 그 과목만 다루는 화면으로 들어갑니다 — 분반·담당 교수·강의시간은 거기서 고치고, 뒤로가기로 이 목록으로 돌아옵니다. 여기서는 새 과목만 추가합니다(과목코드 자동 부여).">
            <div className="search-bar adm-inline-search">
              <input type="search" placeholder="과목 검색 (이름 또는 코드)" value={q}
                onChange={(e) => searchCourse(e.target.value)} />
            </div>

            {q.trim() === '' ? (
              <p className="note adm-empty-row">과목명 또는 코드로 검색하세요.</p>
            ) : (
              <ul className="list adm-list">
                {filtered.map((c) => (
                  <li key={c.code} className="adm-item">
                    {/* 허브 → 기능 화면과 같은 결: 하위 화면으로 들어갔다 뒤로가기로 나온다.
                        검색어는 ?q= 에 담아 두어, 돌아왔을 때 결과가 그대로 있다. */}
                    <Link className="adm-item-row adm-course-link"
                      to={`/admin/courses/${encodeURIComponent(c.code)}`}>
                      <div className="adm-item-body">
                        <div className="adm-item-title">{c.name}</div>
                        <div className="adm-item-sub">
                          {[c.code, c.department].filter(Boolean).join(' · ')} · 분반 {secOf(c.code).length}개
                        </div>
                      </div>
                      <span className="row-chevron">›</span>
                    </Link>
                  </li>
                ))}
                {filtered.length === 0 && <li className="note adm-empty-row">검색 결과가 없습니다.</li>}
              </ul>
            )}

            <div className="divider adm-divider" />
            <div className="section-label adm-sub-label">새 과목 추가</div>
            <label className="field"><span className="field-label">과목명</span>
              <input placeholder="새 과목명" value={newCourse} onChange={(e) => setNewCourse(e.target.value)} />
            </label>
            <button className="btn-add btn-block" disabled={!newCourse.trim()}
              onClick={async () => {
                const r = await run('add_course', { name: newCourse.trim() }, '과목 추가(코드 자동)');
                if (r.ok) setNewCourse('');
              }}>과목 추가 (코드 자동)</button>
          </Card>
        )}

        {section === 'ai' && (
          <Card icon="🤖" title="AI 강의 일괄등록" desc="학기 강의 PDF(수강편람)를 올리면 AI가 과목·분반·교수·시간을 추출해 기존 DB와 대조하고, 검토 후 적용합니다. 교수코드를 몰라도 이름으로 자동 매칭됩니다.">
            <SyllabusUpload
              mode="ai"
              defaultYear={cat?.semesters?.find((s) => s.isCurrent)?.year || 2026}
              defaultTerm={cat?.semesters?.find((s) => s.isCurrent)?.term || 1}
              onApplied={reloadWithCatalog}
            />
          </Card>
        )}

        {section === 'csv' && (
          <Card icon="📄" title="CSV 강의 일괄등록" desc="과목·분반 표를 CSV로 올리거나 붙여넣으면 기존 DB와 대조 후 적용합니다. 결정적(고정)이라 AI보다 정확합니다. 양식을 내려받아 채우거나, 수강편람에서 추출한 CSV를 그대로 올리세요.">
            <SyllabusUpload
              mode="csv"
              defaultYear={cat?.semesters?.find((s) => s.isCurrent)?.year || 2026}
              defaultTerm={cat?.semesters?.find((s) => s.isCurrent)?.term || 1}
              onApplied={reloadWithCatalog}
            />
          </Card>
        )}

        {section === 'professors' && (
          <Card icon="👤" title="교수 관리" desc="교수를 검색해 수정/삭제하고, 아래에서 새 교수를 추가합니다. 교수코드는 자동 부여됩니다. 같은 사람이 두 번 등록됐다면 체크해서 한 명으로 통합하세요.">
            {/* 사람이 아닌 교수: 담당교수 칸의 "신임교수"·"미정" 이 그대로 교수가 된 것.
                지금은 파싱 단계에서 걸러지므로 새로 생기지 않는다 — 남아 있는 것만 지우면 된다. */}
            {fakeProfs.length > 0 && (
              <>
                <div className="section-label adm-sub-label">🧹 교수가 아닌 항목 ({fakeProfs.length})</div>
                <p className="note">
                  <b>신임교수 · 미정</b> 처럼 &lsquo;아직 정해지지 않았다&rsquo;는 표시가 교수로 등록돼 있습니다.
                  지우면 해당 분반은 <b>교수 미정</b>이 됩니다(강의는 그대로).
                </p>
                <ul className="list adm-list">
                  {fakeProfs.map((p) => (
                    <li key={p.code} className="adm-item">
                      <div className="adm-item-row">
                        <div className="adm-item-body">
                          <div className="adm-item-title">{p.name}</div>
                          <div className="adm-item-sub">
                            {[p.department, p.code].filter(Boolean).join(' · ')} · 분반 {secCountOf(p.code)}개
                          </div>
                        </div>
                        <div className="adm-item-acts">
                          <button className="rev-del-btn" onClick={() => deleteFakeProf(p)}>삭제</button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="divider adm-divider" />
              </>
            )}

            {/* 중복 의심: 일괄등록이 이름 문자열로만 매칭해 같은 교수가 새로 생긴 경우
                ("Justin"/"Justin Bunting", "유 훈"/"유훈"). 검색과 무관하게 항상 보여준다. */}
            {dupGroups.length > 0 && (
              <>
                <div className="section-label adm-sub-label">⚠️ 중복 의심 ({dupGroups.length})</div>
                <p className="note">
                  이름이 사실상 같은 교수가 따로 등록돼 있습니다. CSV·편람 일괄등록은 <b>이름 글자</b>로 기존 교수를 찾기 때문에,
                  파일에 성이 빠졌거나(<b>Justin</b> / Justin Bunting) 외자 이름이 띄어 적히면(<b>유 훈</b> / 유훈) 같은 사람이 새로 생깁니다.
                  아래에서 한 명으로 합치면 분반·강의평이 모두 남기는 교수에게 옮겨집니다.
                </p>
                <ul className="list adm-list">
                  {dupGroups.map((g) => (
                    <li key={g[0].code} className="adm-item">
                      <div className="adm-item-row">
                        <div className="adm-item-body">
                          <div className="adm-item-title">{g.map((p) => p.name).join('  ·  ')}</div>
                          <div className="adm-item-sub">{g.map((p) => [p.department, p.code].filter(Boolean).join(' ')).join(' / ')}</div>
                        </div>
                        <div className="adm-item-acts">
                          <button className="link-btn" onClick={() => { setPSel(g.map((p) => p.code)); setPKeep(''); }}>통합하기</button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="divider adm-divider" />
              </>
            )}

            {/* 통합 패널: 남길 교수 하나를 고르고 나머지를 흡수시킨다. */}
            {selProfs.length >= 2 && (
              <div className="prof-merge">
                <div className="section-label adm-sub-label">교수 통합 — 남길 교수를 고르세요 ({selProfs.length}명 선택)</div>
                <ul className="list adm-list">
                  {selProfs.map((p) => (
                    <li key={p.code} className={`adm-item ${pKeep === p.code ? 'open' : ''}`}>
                      <div className="adm-item-row">
                        {/* '빼기'는 label 밖에 둔다 — label 안에 있으면 누를 때 라디오(남길 교수)까지 켜진다 */}
                        <label className="prof-merge-pick">
                          <input type="radio" name="prof-keep" checked={pKeep === p.code} onChange={() => setPKeep(p.code)} />
                          <div className="adm-item-body">
                            <div className="adm-item-title">
                              {p.name} {pKeep === p.code && <span className="tag tag-success">남김</span>}
                            </div>
                            <div className="adm-item-sub">
                              {[p.department, p.code].filter(Boolean).join(' · ')}
                              {' · '}
                              {pUsage[p.code]
                                ? `분반 ${pUsage[p.code].sections} · 강의평 ${pUsage[p.code].reviews}`
                                : '세는 중…'}
                            </div>
                          </div>
                        </label>
                        <div className="adm-item-acts">
                          <button type="button" className="link-btn" onClick={() => toggleSel(p.code)}>빼기</button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="adm-btn-row">
                  <button className="btn-add" disabled={!pKeep} onClick={mergeProfs}>
                    {pKeep ? `${profByCode.get(pKeep)?.name} 로 통합` : '남길 교수를 고르세요'}
                  </button>
                  <button className="rev-del-btn" onClick={cancelMerge}>취소</button>
                </div>
                <div className="divider adm-divider" />
              </div>
            )}

            <div className="search-bar adm-inline-search">
              <input type="search" placeholder="교수 검색 (성명/학과)" value={pq} onChange={(e) => setPq(e.target.value)} />
            </div>
            {pq.trim() === '' ? (
              <p className="note adm-empty-row">성명 또는 학과로 검색하세요.</p>
            ) : (() => {
              const s = pq.trim().toLowerCase();
              const list = (cat?.professors ?? []).filter((p) => [p.name, p.department, p.code].some((v) => (v || '').toLowerCase().includes(s)));
              return (
                <ul className="list adm-list adm-list-scroll">
                  {list.length === 0 && <li className="note adm-empty-row">검색 결과가 없습니다.</li>}
                  {list.map((p) => (
                    <li key={p.code} className="adm-item">
                      <div className="adm-item-row">
                        {/* 검색으로 찾은 교수도 체크해서 통합할 수 있다(중복 의심으로 안 잡히는 경우) */}
                        <input type="checkbox" title="통합 대상으로 선택"
                          checked={pSel.includes(p.code)} onChange={() => toggleSel(p.code)} />
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
          <ProfessorSyncCard syncedAt={setting.professorsSyncedAt} onApplied={reloadWithCatalog} />
        )}

        {section === 'blocks' && (
          <Card icon="⛔" title="공통 공강 시간"
            desc="전 생도가 수업이 없는 시간(생도대·군사훈련·공통연구 …). 생도 시간표와 시간표 마법사 격자에 회색으로 깔리고, 마법사가 이 시간을 '낀 시간(공강)'으로 세지 않습니다. 편람(PDF) 일괄등록 시 주간 격자에서 자동으로 읽어 오므로 보통은 손댈 일이 없습니다 — 여기서는 학기별로 확인·수정하거나 새 학기 것을 미리 넣습니다.">
            <div className="adm-form-grid">
              <label className="field"><span className="field-label">학기</span>
                <select value={blockSem} onChange={(e) => setBlockSem(e.target.value)}>
                  {(cat?.semesters ?? []).length === 0 && <option value="">등록된 학기 없음</option>}
                  {[...(cat?.semesters ?? [])]
                    .sort((a, b) => b.year - a.year || b.term - a.term)
                    .map((s) => (
                      <option key={`${s.year}-${s.term}`} value={`${s.year}-${s.term}`}>
                        {s.year}-{s.term}{s.isCurrent ? ' (현재)' : ''}
                      </option>
                    ))}
                </select>
              </label>
            </div>

            {blockSemYT && blocksOfSem.length === 0 && (
              <p className="note">
                이 학기에 등록된 공통 공강 시간이 없습니다. 편람 PDF를 일괄등록하면 주간 격자에서
                자동으로 채워집니다(AI 호출 없음). 아래에서 직접 넣을 수도 있습니다.
              </p>
            )}
            {blockSemYT && (
              <div className="adm-blk-list">
                {blocksOfSem.map((b) => (
                  <BlockRow key={`${b.dayOfWeek}-${b.startPeriod}`} b={b} run={run} periods={periodNos} />
                ))}
                <NewBlockRow key={`new-${blockSem}-${blocksOfSem.length}`} run={run}
                  year={blockSemYT.year} term={blockSemYT.term} periods={periodNos} />
              </div>
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
                {cat?.semesters?.length ? cat.semesters.map((s) => (
                  <span key={s.year + '' + s.term} className={`tag ${s.isCurrent ? 'tag-primary' : ''}`}>{s.year}-{s.term}{s.isCurrent ? ' (현재)' : ''}
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
                <button className="btn-add" onClick={() => run('set_semester', { ...sem, isCurrent: false }, `${sem.year}-${sem.term} 학기 추가`)}>＋ 학기 추가</button>
                <button className="btn-ghost" onClick={() => run('set_semester', { ...sem, isCurrent: true }, '현재 학기 설정')}>현재 학기로 설정</button>
              </div>
            </Card>

            <Card icon="⏰" title="교시" desc="각 교시의 시작·종료 시각을 표에서 바로 수정합니다. 맨 아래 줄에서 새 교시를 추가하세요.">
              <div className="adm-period-table">
                <div className="adm-pt-head"><span>교시</span><span>시작</span><span>끝</span><span /></div>
                {(cat?.periods ? [...cat.periods].sort((a, b) => a.no - b.no) : []).map((p) => (
                  <PeriodRow key={p.no} p={p} run={run} />
                ))}
                <NewPeriodRow key={`new-${cat?.periods?.length ?? 0}`} run={run}
                  nextNo={(cat?.periods?.reduce((m, p) => Math.max(m, p.no), 0) ?? 0) + 1} />
              </div>
              {!cat?.periods?.length && <p className="note">등록된 교시가 없습니다. 아래 줄에서 추가하세요.</p>}
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
              ['geoValidDays', '위치 재인증 유효기간', '일'],
              ['accountDeleteDays', '만료 후 계정삭제 대기', '일'],
              ['radiusM', '지오펜싱 반경', 'm'],
              ['campusLat', '캠퍼스 위도', '위도'],
              ['campusLng', '캠퍼스 경도', '경도'],
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
              ['hotThreshold', 'HOT 게시판 승격 기준', '개', '30분 안에 좋아요·싫어요·댓글이 이 수 이상 달리면 HOT으로 올라갑니다.', 1],
              ['reportDeleteCount', '신고 누적 자동삭제', '건', '한 글의 누적 신고수가 이 값에 도달하면 자동으로 숨겨집니다(아카이브 후 삭제, 복구 가능). 강의평·강의메모·게시글 공통.', 1],
              ['reportBurstCount', '신고 급증 자동삭제 (15분)', '건', '15분 안에 신고가 이 수만큼 몰리면 담합·오신고로 보고 자동삭제합니다. 강의평·강의메모·게시글 공통.', 1],
              ['reviewMinDays', '강의평 작성 자격', '일', '해당 강의를 확정 시간표에 이 일수 이상 보유해야 강의평을 쓸 수 있습니다. 0으로 두면 담는 즉시 작성할 수 있습니다.', 0],
            ].map(([k, label, unit, hint, min]) => (
              <div className="adm-thr-item" key={k}>
                <p className="note adm-thr-hint">{hint}</p>
                <div className="adm-setting-row">
                  <label className="field adm-setting-field">
                    <span className="field-label">{label} <span className="adm-unit">({unit})</span></span>
                    <input type="number" min={min} step="1" value={setting[k] ?? ''}
                      onChange={(e) => setSetting({ ...setting, [k]: e.target.value })} />
                  </label>
                  <button className="btn-add btn-sm adm-setting-save"
                    onClick={() => { const v = Math.round(Number(setting[k])); if (!Number.isFinite(v) || v < min) { setMsg(`⚠️ ${min} 이상의 정수를 입력하세요.`); return; } run('set_app_setting', { field: k, value: v }, `${label} 변경`); }}>저장</button>
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
                <span className={`tag ${setting.boardEnabled === false ? 'tag-warn' : 'tag-success'}`}>{setting.boardEnabled === false ? '비활성' : '활성'}</span>
              </div>
              <button className="btn-ghost btn-sm" onClick={() => run('set_board_enabled', { value: !(setting.boardEnabled !== false) }, '게시판 활성화 변경')}>
                {setting.boardEnabled === false ? '활성화' : '비활성화'}
              </button>
            </div>

            {/* 공유 링크(/s/…)를 받은 비로그인 사용자가 그 글을 읽을 수 있는지. 차단해도 링크
                생성·공유와 회원의 링크 접속(앱 글 화면으로 이동)은 계속 동작한다. */}
            <div className="adm-toggle-row">
              <div className="adm-toggle-body">
                <span className="adm-toggle-label">비회원 공유 열람</span>
                <span className={`tag ${setting.shareEnabled === false ? 'tag-warn' : 'tag-success'}`}>{setting.shareEnabled === false ? '차단' : '허용'}</span>
              </div>
              <button className="btn-ghost btn-sm" onClick={() => run('set_share_enabled', { value: !(setting.shareEnabled !== false) }, '비회원 공유 열람 변경')}>
                {setting.shareEnabled === false ? '허용' : '차단'}
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
