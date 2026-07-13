// =====================================================================
//  카탈로그 IndexedDB 캐싱 (idb)
//  - 대상: professor / semester / course / period / common_block / section / section_time
//  - 정책: cache-first + 서버 버전 대조.
//      관리자가 강의 정보를 고치면 DB 트리거가 app_setting.catalog_version 을 +1 한다.
//      앱은 부팅·복귀 때 그 숫자만 확인하고(get_boot_info — 원래 부르던 RPC 자리),
//      기기에 찍힌 버전과 다를 때만 7개 테이블을 다시 받아 화면에 밀어 넣는다(subscribeCatalog).
//      → 관리자의 대규모 수정이 사용자 조작 없이 반영되고,
//        바뀐 게 없으면 아예 내려받지 않는다(예전엔 변경이 없어도 24시간마다 전원이 통째로 재다운로드).
//  - 오프라인: 서버 fetch 실패 시 캐시가 있으면 그대로 사용.
// =====================================================================
import { openDB } from 'idb';
import { supabase } from '../supabase';
import { fetchBootInfo } from './appInfo';

const DB_NAME = 'anytime-cache';
const DB_VERSION = 1;
const STORE = 'kv';
const SYNCED_KEY = '_syncedAt';
const SCHEMA_KEY = '_schema';
const CATVER_KEY = '_catalogVersion';   // 이 캐시가 어느 catalog_version 의 사본인가
// 캐시된 행의 모양이 바뀌면(또는 옛 캐시를 강제로 버려야 하면) 올린다 → 서버에서 다시 받는다.
//   2: section.id(대체키) 추가 — 시간표가 분반을 id 로 참조(2026-07-12)
//   3: common_block(전 생도 비수업 시간 이름) 추가 — 시간표 마법사(2026-07-13)
//   4: 강제 재동기화 — common_block 이 아직 비었을 때 캐시한 기기는 이름을 붙인 뒤에도
//      24시간(STALE_MS) 동안 공통 공강 시간이 격자에 안 떴다(2026-07-13)
const SCHEMA_VERSION = 4;
// 버전 대조가 실제 무효화를 맡으므로, 이 시한은 그 확인이 한 번도 못 닿은 기기를 위한 안전망일 뿐이다
// (예: 부팅 RPC 가 계속 실패). 24시간이던 것을 7일로 늘려 '변경 없는데도 전원이 매일 통째로
// 재다운로드' 하던 것을 없앤다 — 무료 요금제에서 유일한 제약인 egress 가 여기서 크게 준다.
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

// 캐시할 카탈로그 테이블 (공용 읽기 전용 데이터)
const TABLES = ['professor', 'semester', 'course', 'period', 'common_block', 'section', 'section_time'];

function getDB() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    },
  });
}

async function readCache() {
  const db = await getDB();
  const out = {};
  // 키들을 병렬로 읽는다(직렬 await → 1회).
  const [rows, synced, schema, ver] = await Promise.all([
    Promise.all(TABLES.map((t) => db.get(STORE, t))),
    db.get(STORE, SYNCED_KEY),
    db.get(STORE, SCHEMA_KEY),
    db.get(STORE, CATVER_KEY),
  ]);
  TABLES.forEach((t, i) => { out[t] = rows[i] ?? []; });
  // 스키마가 바뀌었으면 캐시를 없는 셈 친다(행 모양이 달라 조립이 깨진다).
  out[SYNCED_KEY] = schema === SCHEMA_VERSION ? (synced ?? 0) : 0;
  out[CATVER_KEY] = ver ?? null;
  return out;
}

// ---------------------------------------------------------------------
//  카탈로그 갱신 구독: 백그라운드 재동기화가 끝나면 화면에 바로 밀어 넣는다.
//  이게 없으면 갱신분은 '다음 실행'에나 보인다 — 관리자가 고친 카탈로그를
//  보려고 사용자가 앱을 한 번 더 켜야 하는 셈.
// ---------------------------------------------------------------------
const listeners = new Set();

export function subscribeCatalog(cb) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function emitCatalog(catalog) {
  for (const cb of listeners) {
    try { cb(catalog); } catch { /* 한 화면의 오류가 다른 화면 갱신을 막지 않게 */ }
  }
}

// PostgREST 는 한 요청에 최대 1000행만 준다(기본 max-rows). 한 학기 편람만 올려도 section_time 은
// 이 선을 넘는다 — 잘린 줄 모르고 쓰면 시간표에서 강의시간이 사라지고, 관리자 일괄등록의 기존 분반
// 대조(reconcile)가 조용히 빗나가 같은 분반이 두 벌로 들어간다. 그래서 끝까지 이어 받는다.
// 페이지 경계가 흔들리지 않도록 반드시 키 순서로 정렬해서 받는다(정렬 없는 range 는 행이 겹치거나 샌다).
const PAGE = 1000;
const ORDER_KEYS = {
  professor: ['code'],
  semester: ['year', 'term'],
  course: ['code'],
  period: ['no'],
  common_block: ['year', 'term', 'day_of_week', 'start_period'],
  section: ['id'],
  section_time: ['course_code', 'year', 'term', 'section_no', 'day_of_week', 'start_period'],
};

async function fetchTable(table) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(table).select('*');
    for (const col of ORDER_KEYS[table] ?? []) q = q.order(col);
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if ((data?.length ?? 0) < PAGE) return out;
  }
}

async function fetchFromServer() {
  // 6개 카탈로그 테이블을 병렬로 받는다(직렬 왕복 6회 → 1회 배치). 하나라도 실패하면 throw.
  const tables = await Promise.all(TABLES.map(fetchTable));
  const result = {};
  TABLES.forEach((t, i) => { result[t] = tables[i]; });
  return result;
}

// 이번 세션에서 서버가 알려준 최신 카탈로그 버전. 부팅 RPC(useAuth)·복귀 확인(App)이 채운다.
let serverVersion = null;
// 같은 동기화가 겹쳐 도는 것을 막는다(부팅 확인과 화면 진입이 동시에 걸릴 수 있다).
let syncing = null;

// 서버에서 받아 IndexedDB 에 통째로 저장하고 반환.
// version: 방금 서버에서 확인한 버전(있으면 그대로 찍고, 없으면 본문과 함께 받아 온다).
//   본문과 버전을 반드시 같이 찍어야 한다 — 따로 찍으면 방금 받은 데이터에 옛 버전이 남아
//   다음 부팅에서 바뀐 게 없는데도 7개 테이블을 한 번 더 통째로 받는다.
export function syncCatalog({ version = null, notify = false } = {}) {
  if (syncing) return syncing;
  syncing = (async () => {
    const [fresh, ver] = await Promise.all([
      fetchFromServer(),
      version != null ? Promise.resolve(version) : fetchBootInfo().then((i) => i.catalogVersion),
    ]);
    const db = await getDB();
    const tx = db.transaction(STORE, 'readwrite');
    for (const t of TABLES) tx.store.put(fresh[t], t);
    const now = Date.now();
    tx.store.put(now, SYNCED_KEY);
    tx.store.put(SCHEMA_VERSION, SCHEMA_KEY);
    tx.store.put(ver, CATVER_KEY);
    await tx.done;
    if (ver != null) serverVersion = ver;
    const result = { ...fresh, [SYNCED_KEY]: now, [CATVER_KEY]: ver };
    if (notify) emitCatalog({ ...result, fromCache: false });
    return result;
  })().finally(() => { syncing = null; });
  return syncing;
}

// 서버가 알려준 카탈로그 버전을 반영한다(부팅 RPC / 앱 복귀 확인).
// 기기에 찍힌 버전과 다르면 그 자리에서 다시 받아 열려 있는 화면에 밀어 넣는다
// → 관리자가 편람을 대규모로 고쳐도 사용자는 아무것도 하지 않는다.
export async function noteCatalogVersion(v) {
  if (v == null) return;
  const seen = serverVersion;
  if (seen === v) return;                       // 이번 세션에서 이미 확인·처리한 버전
  serverVersion = v;
  const [stored, synced] = await Promise.all([kvGet(CATVER_KEY), kvGet(SYNCED_KEY)]);
  if (synced == null) return;                   // 캐시 자체가 없다 → getCatalog 가 어차피 받는다
  if (stored === v) return;                     // 캐시가 이미 최신
  try {
    await syncCatalog({ version: v, notify: true });
  } catch {
    // 오프라인 → 캐시 유지. '확인했다'는 표시를 되돌려 놔야 다음 복귀 때 다시 시도한다
    // (안 되돌리면 같은 버전이라는 이유로 영영 건너뛰어, 온라인이 돼도 옛 강의 정보에 머문다).
    serverVersion = seen;
  }
}

// cache-first 로 카탈로그를 반환. { ...tables, _syncedAt, _catalogVersion, fromCache }
// 갱신분은 subscribeCatalog 로 화면에 밀려 온다(버전이 바뀌었을 때 + 안전망 시한이 지났을 때).
export async function getCatalog({ force = false } = {}) {
  const cached = await readCache();
  const hasCache = cached[SYNCED_KEY] > 0;
  const stale = Date.now() - cached[SYNCED_KEY] > STALE_MS;

  // 강제 새로고침(당겨서 새로고침·관리자 반영 직후): 서버 우선, 실패하면 캐시로 폴백.
  if (force) {
    try {
      return { ...(await syncCatalog()), fromCache: false };
    } catch (e) {
      if (hasCache) return { ...cached, fromCache: true, error: e };
      throw e;
    }
  }

  // 캐시 없음: 반드시 서버에서.
  if (!hasCache) {
    return { ...(await syncCatalog()), fromCache: false };
  }

  // 버전 확인이 한 번도 못 닿은 기기(부팅 RPC 실패 등)를 위한 안전망:
  // 즉시 캐시를 반환하고 뒤에서 갱신한다.
  if (stale) {
    syncCatalog({ notify: true }).catch(() => {});
  }
  return { ...cached, fromCache: true };
}

// 캐시 비우기 (학기 변경 등). 버전 도장도 함께 지운다 — 안 지우면 다음 확인에서
// '버전 같음'으로 보여 빈 캐시를 다시 채우지 않는다.
export async function clearCatalog() {
  const db = await getDB();
  const tx = db.transaction(STORE, 'readwrite');
  for (const t of TABLES) tx.store.delete(t);
  tx.store.delete(SYNCED_KEY);
  tx.store.delete(CATVER_KEY);
  await tx.done;
  serverVersion = null;
}

// ---------------------------------------------------------------------
//  범용 SWR 캐시(stale-while-revalidate): 캐시가 있으면 즉시 화면에 띄우고
//  서버 응답이 오면 교체. 게시판 목록·글 목록·게시글·검열 등 재방문 화면용.
// ---------------------------------------------------------------------
export async function kvGet(key) {
  try { return await (await getDB()).get(STORE, key); } catch { return undefined; }
}
export async function kvSet(key, value) {
  try { await (await getDB()).put(STORE, value, key); } catch { /* 캐시 실패는 무시 */ }
}
export async function kvDel(key) {
  try { await (await getDB()).delete(STORE, key); } catch { /* 캐시 실패는 무시 */ }
}

// ---------------------------------------------------------------------
//  조회 헬퍼: 분반(section)을 화면용으로 조립 (과목명·교수명·강의시간 조인)
// ---------------------------------------------------------------------
const DAY_KO = { 1: '월', 2: '화', 3: '수', 4: '목', 5: '금', 6: '토', 7: '일' };

export function dayLabel(n) {
  return DAY_KO[n] ?? '?';
}

function sectionKey(s) {
  return `${s.course_code}-${s.year}-${s.term}-${s.section_no}`;
}

export { sectionKey };

// is_current 학기. 없으면 가장 최근 학기.
export function currentSemester(catalog) {
  const semesters = catalog.semester ?? [];
  return (
    semesters.find((s) => s.is_current) ??
    [...semesters].sort((a, b) => b.year - a.year || b.term - a.term)[0] ??
    null
  );
}

// 최신순 학기 목록(시간표 만들 때 고르는 후보)
export function semesterList(catalog) {
  return [...(catalog.semester ?? [])].sort((a, b) => b.year - a.year || b.term - a.term);
}

// 한 학기의 분반 목록(과목명·교수명·강의시간 조인). sem 을 주지 않으면 현재 학기.
export function buildSections(catalog, sem = null) {
  const courseByCode = Object.fromEntries((catalog.course ?? []).map((c) => [c.code, c]));
  const profByCode = Object.fromEntries((catalog.professor ?? []).map((p) => [p.code, p]));

  const current = sem ?? currentSemester(catalog);
  if (!current) return { current: null, sections: [] };

  // 강의시간을 분반키로 묶기
  const timesByKey = {};
  for (const t of catalog.section_time ?? []) {
    const k = sectionKey(t);
    (timesByKey[k] ??= []).push(t);
  }

  const sections = (catalog.section ?? [])
    .filter((s) => s.year === current.year && s.term === current.term)
    .map((s) => {
      const times = (timesByKey[sectionKey(s)] ?? []).sort(
        (a, b) => a.day_of_week - b.day_of_week || a.start_period - b.start_period
      );
      return {
        key: sectionKey(s),
        ...s,
        course_name: courseByCode[s.course_code]?.name ?? s.course_code,
        department: courseByCode[s.course_code]?.department ?? null,
        professor_name: profByCode[s.professor_code]?.name ?? null,
        times,
      };
    })
    .sort((a, b) => a.course_name.localeCompare(b.course_name, 'ko'));

  return { current, sections };
}

// 한 시간표에 담긴 분반(시간 조인) + 교시 목록.
// entries = timetable_entry 행([{ section_id }]), sem = 그 시간표의 학기.
export function buildMyTimetable(catalog, entries, sem = null) {
  const { current, sections } = buildSections(catalog, sem);
  const ids = new Set((entries ?? []).map((e) => e.section_id));
  const mine = sections.filter((s) => ids.has(s.id));
  const periods = [...(catalog.period ?? [])].sort((a, b) => a.no - b.no);
  return { current, mine, periods };
}

// (전 생도 공통 비수업 시간 조립은 lib/commonBlock.js — 숨김 상태까지 함께 다룬다)

// "월1, 수1" 같은 강의시간 요약 문자열
export function formatTimes(times) {
  if (!times?.length) return '시간 미정';
  return times
    .map((t) =>
      t.start_period === t.end_period
        ? `${dayLabel(t.day_of_week)}${t.start_period}`
        : `${dayLabel(t.day_of_week)}${t.start_period}~${t.end_period}`
    )
    .join(', ');
}
