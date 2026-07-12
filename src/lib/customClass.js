// 사용자가 직접 추가한 시간표 항목(DB에 없는 강의). 시간표(timetable)마다 따로.
// 계정 종속 데이터 → Supabase `custom_class` 테이블에 timetable_id 기준 저장(RLS: 그 시간표가 내 것일 때만).
// 오프라인/즉시 표시를 위해 localStorage 에 시간표별 스냅샷을 write-through 캐시한다(원본은 DB).
// TimetableGrid 가 쓰는 항목 형태: { id, title, day(1~7), startMin, endMin, room }
import { supabase } from '../supabase';

const cacheKey = (timetableId) => `anytime:customClassCache:tt:${timetableId}`;
const legacyKey = (uid) => `anytime:customClasses:${uid || 'anon'}`; // 구버전(기기 로컬 전용) 데이터

const rowToEntry = (r) => ({
  id: r.id,
  title: r.title,
  day: r.day_of_week,
  startMin: r.start_min,
  endMin: r.end_min,
  room: r.room || '',
});

function cacheWrite(timetableId, arr) {
  try { localStorage.setItem(cacheKey(timetableId), JSON.stringify(arr)); } catch { /* ignore */ }
}

// 즉시(동기) 캐시 읽기 — 홈에서 바로 그리기용
export function readCustomCache(timetableId) {
  if (!timetableId) return [];
  try {
    const raw = localStorage.getItem(cacheKey(timetableId));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

async function fetchFromDb(timetableId) {
  const { data, error } = await supabase
    .from('custom_class')
    .select('id, title, day_of_week, start_min, end_min, room')
    .eq('timetable_id', timetableId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map(rowToEntry);
}

async function insertToDb(timetableId, entry) {
  const { data, error } = await supabase
    .from('custom_class')
    .insert({
      timetable_id: timetableId,
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

// 구버전 기기-로컬 데이터를 1회 DB로 이전(온라인 + 그 시간표가 비어있을 때만 → 중복 방지)
async function migrateLegacy(uid, timetableId, currentRows) {
  const key = legacyKey(uid);
  let old;
  try { old = JSON.parse(localStorage.getItem(key) || '[]'); } catch { old = []; }
  if (!Array.isArray(old)) old = [];
  if (currentRows.length === 0 && old.length) {
    for (const e of old) {
      try { await insertToDb(timetableId, e); } catch { /* 겹침/실패는 무시 */ }
    }
  }
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

// 네트워크 우선, 실패 시 캐시(오프라인). 시간표별.
export async function listCustomClasses(uid, timetableId) {
  if (!timetableId) return [];
  let rows;
  try {
    rows = await fetchFromDb(timetableId);
  } catch {
    return readCustomCache(timetableId); // 오프라인 → 마지막 스냅샷
  }
  try {
    if (uid && localStorage.getItem(legacyKey(uid))) {
      await migrateLegacy(uid, timetableId, rows);
      rows = await fetchFromDb(timetableId);
    }
  } catch { /* ignore */ }
  cacheWrite(timetableId, rows);
  return rows;
}

// entry 는 { title, day, startMin, endMin, room } 를 포함해야 함.
export async function addCustomClass(timetableId, entry) {
  if (!timetableId) return null;
  return insertToDb(timetableId, entry); // 실패(겹침 등) 시 throw → 호출부에서 처리
}

export async function removeCustomClass(id) {
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
