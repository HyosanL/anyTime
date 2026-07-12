// =====================================================================
//  카탈로그 IndexedDB 캐싱 (idb)
//  - 대상: professor / semester / course / period / section / section_time
//  - 정책: cache-first. 캐시가 없으면 서버에서 받아오고,
//          6시간 이상 지났으면(stale) 백그라운드로 갱신하며 캐시를 즉시 반환.
//  - 오프라인: 서버 fetch 실패 시 캐시가 있으면 그대로 사용.
// =====================================================================
import { openDB } from 'idb';
import { supabase } from '../supabase';

const DB_NAME = 'anytime-cache';
const DB_VERSION = 1;
const STORE = 'kv';
const SYNCED_KEY = '_syncedAt';
const SCHEMA_KEY = '_schema';
// 캐시된 행의 모양이 바뀌면 올린다 → 옛 캐시를 무시하고 서버에서 다시 받는다.
//   2: section.id(대체키) 추가 — 시간표가 분반을 id 로 참조(2026-07-12)
const SCHEMA_VERSION = 2;
const STALE_MS = 24 * 60 * 60 * 1000; // 24시간 (강의 데이터는 학기당 거의 불변 → egress 절감. 관리자 수정 시 당겨서 새로고침으로 즉시 반영)

// 캐시할 카탈로그 테이블 (공용 읽기 전용 데이터)
const TABLES = ['professor', 'semester', 'course', 'period', 'section', 'section_time'];

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
  // 8개 키를 병렬로 읽는다(직렬 await → 1회).
  const [rows, synced, schema] = await Promise.all([
    Promise.all(TABLES.map((t) => db.get(STORE, t))),
    db.get(STORE, SYNCED_KEY),
    db.get(STORE, SCHEMA_KEY),
  ]);
  TABLES.forEach((t, i) => { out[t] = rows[i] ?? []; });
  // 스키마가 바뀌었으면 캐시를 없는 셈 친다(행 모양이 달라 조립이 깨진다).
  out[SYNCED_KEY] = schema === SCHEMA_VERSION ? (synced ?? 0) : 0;
  return out;
}

async function fetchFromServer() {
  // 6개 카탈로그 테이블을 병렬로 받는다(직렬 왕복 6회 → 1회 배치). 하나라도 실패하면 throw.
  const responses = await Promise.all(TABLES.map((t) => supabase.from(t).select('*')));
  const result = {};
  TABLES.forEach((t, i) => {
    if (responses[i].error) throw responses[i].error;
    result[t] = responses[i].data ?? [];
  });
  return result;
}

// 서버에서 받아 IndexedDB 에 통째로 저장하고 반환.
export async function syncCatalog() {
  const fresh = await fetchFromServer();
  const db = await getDB();
  const tx = db.transaction(STORE, 'readwrite');
  for (const t of TABLES) tx.store.put(fresh[t], t);
  const now = Date.now();
  tx.store.put(now, SYNCED_KEY);
  tx.store.put(SCHEMA_VERSION, SCHEMA_KEY);
  await tx.done;
  return { ...fresh, [SYNCED_KEY]: now };
}

// cache-first 로 카탈로그를 반환. { ...tables, _syncedAt, fromCache }
export async function getCatalog({ force = false } = {}) {
  const cached = await readCache();
  const hasCache = cached[SYNCED_KEY] > 0;
  const stale = Date.now() - cached[SYNCED_KEY] > STALE_MS;

  // 강제 새로고침: 서버 우선, 실패하면 캐시로 폴백.
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

  // 캐시 오래됨: 즉시 캐시 반환 + 백그라운드 갱신.
  if (stale) syncCatalog().catch(() => {});
  return { ...cached, fromCache: true };
}

// 캐시 비우기 (학기 변경 등).
export async function clearCatalog() {
  const db = await getDB();
  const tx = db.transaction(STORE, 'readwrite');
  for (const t of TABLES) tx.store.delete(t);
  tx.store.delete(SYNCED_KEY);
  await tx.done;
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
