// 사용자가 직접 추가한 시간표 항목(DB에 없는 강의).
// 계정 종속 데이터 → Supabase `custom_class` 테이블에 cadet_id(auth.uid) 기준 저장(RLS 본인만).
// 오프라인 표시를 위해 localStorage 에 스냅샷을 write-through 캐시한다(원본은 DB).
// TimetableGrid 가 쓰는 항목 형태: { id, title, day(1~7), startMin, endMin, room }
import { supabase } from '../supabase';

const cacheKey = (uid) => `anytime:customClassCache:${uid || 'anon'}`;
const legacyKey = (uid) => `anytime:customClasses:${uid || 'anon'}`; // 구버전(기기 로컬 전용) 데이터

const rowToEntry = (r) => ({
  id: r.id,
  title: r.title,
  day: r.day_of_week,
  startMin: r.start_min,
  endMin: r.end_min,
  room: r.room || '',
});

function cacheWrite(uid, arr) {
  try { localStorage.setItem(cacheKey(uid), JSON.stringify(arr)); } catch { /* ignore */ }
}
function cacheRead(uid) {
  try {
    const raw = localStorage.getItem(cacheKey(uid));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

async function fetchFromDb() {
  const { data, error } = await supabase
    .from('custom_class')
    .select('id, title, day_of_week, start_min, end_min, room')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map(rowToEntry);
}

async function insertToDb(uid, entry) {
  const { data, error } = await supabase
    .from('custom_class')
    .insert({
      cadet_id: uid,
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

// 구버전 기기-로컬 데이터를 1회 DB로 이전(온라인 + DB가 비어있을 때만 → 중복 방지)
async function migrateLegacy(uid, currentRows) {
  const key = legacyKey(uid);
  let old;
  try { old = JSON.parse(localStorage.getItem(key) || '[]'); } catch { old = []; }
  if (!Array.isArray(old)) old = [];
  if (currentRows.length === 0 && old.length) {
    for (const e of old) {
      try { await insertToDb(uid, e); } catch { /* 일부 실패는 무시 */ }
    }
  }
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

// 네트워크 우선, 실패 시 캐시(오프라인). uid 없으면 빈 배열.
export async function listCustomClasses(uid) {
  if (!uid) return [];
  let rows;
  try {
    rows = await fetchFromDb();
  } catch {
    return cacheRead(uid); // 오프라인 → 마지막 스냅샷
  }
  // 온라인일 때만 구버전 데이터 이전 시도
  try {
    if (localStorage.getItem(legacyKey(uid))) {
      await migrateLegacy(uid, rows);
      rows = await fetchFromDb();
    }
  } catch { /* ignore */ }
  cacheWrite(uid, rows);
  return rows;
}

export async function addCustomClass(uid, entry) {
  if (!uid) return null;
  const item = await insertToDb(uid, entry); // 실패 시 throw → 호출부에서 처리
  return item;
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
