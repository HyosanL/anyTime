// 사용자가 직접 추가한 시간표 항목(DB에 없는 강의). 학기별로 분리.
// 계정 종속 데이터 → Supabase `custom_class` 테이블에 cadet_id(auth.uid)+학기 기준 저장(RLS 본인만).
// 오프라인/즉시 표시를 위해 localStorage 에 학기별 스냅샷을 write-through 캐시한다(원본은 DB).
// TimetableGrid 가 쓰는 항목 형태: { id, title, day(1~7), startMin, endMin, room }
import { supabase } from '../supabase';

const cacheKey = (uid, year, term) => `anytime:customClassCache:${uid || 'anon'}:${year}-${term}`;
const legacyKey = (uid) => `anytime:customClasses:${uid || 'anon'}`; // 구버전(기기 로컬 전용) 데이터

const rowToEntry = (r) => ({
  id: r.id,
  title: r.title,
  day: r.day_of_week,
  startMin: r.start_min,
  endMin: r.end_min,
  room: r.room || '',
});

function cacheWrite(uid, year, term, arr) {
  try { localStorage.setItem(cacheKey(uid, year, term), JSON.stringify(arr)); } catch { /* ignore */ }
}

// 즉시(동기) 캐시 읽기 — 홈에서 바로 그리기용
export function readCustomCache(uid, year, term) {
  if (!uid || year == null || term == null) return [];
  try {
    const raw = localStorage.getItem(cacheKey(uid, year, term));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

async function fetchFromDb(year, term) {
  const { data, error } = await supabase
    .from('custom_class')
    .select('id, title, day_of_week, start_min, end_min, room')
    .eq('year', year)
    .eq('term', term)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map(rowToEntry);
}

async function insertToDb(uid, entry) {
  const { data, error } = await supabase
    .from('custom_class')
    .insert({
      cadet_id: uid,
      year: entry.year,
      term: entry.term,
      title: entry.title,
      day_of_week: entry.day,
      start_min: entry.startMin,
      end_min: entry.endMin,
      room: entry.room || null,
    })
    .select('id, title, day_of_week, start_min, end_min, room')
    .single();
  if (error) throw error;
  return rowToEntry(data);
}

// 구버전 기기-로컬 데이터를 1회 DB(현재 학기)로 이전(온라인 + DB 비어있을 때만 → 중복 방지)
async function migrateLegacy(uid, year, term, currentRows) {
  const key = legacyKey(uid);
  let old;
  try { old = JSON.parse(localStorage.getItem(key) || '[]'); } catch { old = []; }
  if (!Array.isArray(old)) old = [];
  if (currentRows.length === 0 && old.length) {
    for (const e of old) {
      try { await insertToDb(uid, { ...e, year, term }); } catch { /* 겹침/실패는 무시 */ }
    }
  }
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

// 네트워크 우선, 실패 시 캐시(오프라인). 학기별.
export async function listCustomClasses(uid, year, term) {
  if (!uid || year == null || term == null) return [];
  let rows;
  try {
    rows = await fetchFromDb(year, term);
  } catch {
    return readCustomCache(uid, year, term); // 오프라인 → 마지막 스냅샷
  }
  try {
    if (localStorage.getItem(legacyKey(uid))) {
      await migrateLegacy(uid, year, term, rows);
      rows = await fetchFromDb(year, term);
    }
  } catch { /* ignore */ }
  cacheWrite(uid, year, term, rows);
  return rows;
}

// entry 는 { title, day, startMin, endMin, room, year, term } 를 포함해야 함.
export async function addCustomClass(uid, entry) {
  if (!uid) return null;
  return insertToDb(uid, entry); // 실패(겹침 등) 시 throw → 호출부에서 처리
}

export async function removeCustomClass(uid, id) {
  if (!uid) return;
  const { error } = await supabase.from('custom_class').delete().eq('id', id);
  if (error) throw error;
}

// "09:00" / "09:00:00" -> 자정부터의 분. 빈값이면 null.
export function hmToMin(s) {
  if (s == null || s === '') return null;
  const [h, m] = String(s).split(':').map(Number);
  if (Number.isNaN(h)) return null;
  return h * 60 + (m || 0);
}

// 분 -> "09:00"
export function minToHM(min) {
  if (min == null) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
