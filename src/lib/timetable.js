// =====================================================================
//  시간표 API 레이어
//  한 생도가 학기마다 시간표를 여러 개 갖는다(지난 학기 기록·다음 학기 미리짜기).
//  그중 학기별 1개가 '확정'(is_primary) — 강의평·메모 자격의 근거는 확정뿐이다.
//  홈에서 전환해 보며, 마지막으로 본 시간표는 기기(localStorage)에 기억한다.
//
//  DB: timetable(시간표) 1:N timetable_entry(담긴 분반, section_id 로 분반 참조)
//  캐시: IndexedDB 에 목록·항목 스냅샷 write-through(오프라인·즉시 표시).
// =====================================================================
import { supabase } from '../supabase';
import { kvGet, kvSet, kvDel } from './cache';

const LIST_KEY = 'timetables';
const entryKey = (id) => `tt-entries:${id}`;
const SELECTED_KEY = 'anytime:selectedTimetable';

// 겹침(트리거) 에러인지 — 사용자에게 다르게 안내한다.
export function isOverlapError(e) {
  return /overlap|23P01|exclusion|겹칩니다/i.test(`${e?.message || ''} ${e?.code || ''}`);
}

// ── 마지막으로 본 시간표(기기 기억) ──────────────────────────────────
export function readSelectedId() {
  const n = Number(localStorage.getItem(SELECTED_KEY));
  return Number.isFinite(n) && n > 0 ? n : null;
}
export function writeSelectedId(id) {
  try { localStorage.setItem(SELECTED_KEY, String(id)); } catch { /* ignore */ }
}

// 기억해 둔 시간표가 목록에 없으면(삭제됨·다른 기기) 현재 학기 확정 → 아무거나로 되돌린다.
export function pickTimetable(list, current, preferredId = null) {
  if (!list?.length) return null;
  const byId = preferredId && list.find((t) => t.id === preferredId);
  if (byId) return byId;
  const cur = current && list.find((t) => t.year === current.year && t.term === current.term && t.is_primary);
  return cur ?? list.find((t) => t.is_primary) ?? list[0];
}

// ── 목록 ─────────────────────────────────────────────────────────────
export async function readTimetablesCache() {
  return (await kvGet(LIST_KEY)) ?? [];
}

// 최신 학기 → 확정 → 만든 순
export async function listTimetables() {
  const { data, error } = await supabase
    .from('timetable')
    .select('id, year, term, name, is_primary, created_at')
    .order('year', { ascending: false })
    .order('term', { ascending: false })
    .order('is_primary', { ascending: false })
    .order('created_at', { ascending: true });
  if (error) throw error;
  const rows = data ?? [];
  kvSet(LIST_KEY, rows);
  return rows;
}

// 그 학기의 첫 시간표는 DB 트리거가 자동으로 확정 처리한다.
export async function createTimetable({ uid, year, term, name }) {
  const { data, error } = await supabase
    .from('timetable')
    .insert({ cadet_id: uid, year, term, name })
    .select('id, year, term, name, is_primary, created_at')
    .single();
  if (error) throw error;   // 학기당 5개 상한은 DB 트리거가 막는다
  return data;
}

export async function renameTimetable(id, name) {
  const { error } = await supabase.from('timetable').update({ name }).eq('id', id);
  if (error) throw error;
}

// 확정으로 지정 — 같은 학기의 다른 시간표는 DB 트리거가 자동으로 내린다.
export async function setPrimaryTimetable(id) {
  const { error } = await supabase.from('timetable').update({ is_primary: true }).eq('id', id);
  if (error) throw error;
}

export async function deleteTimetable(id) {
  const { error } = await supabase.from('timetable').delete().eq('id', id);
  if (error) throw error;   // 담긴 분반·직접추가는 CASCADE
  kvDel(entryKey(id));
}

// ── 담긴 분반 ────────────────────────────────────────────────────────
export async function readEntriesCache(timetableId) {
  if (!timetableId) return [];
  return (await kvGet(entryKey(timetableId))) ?? [];
}

export async function listEntries(timetableId) {
  if (!timetableId) return [];
  const { data, error } = await supabase
    .from('timetable_entry')
    .select('section_id, created_at')
    .eq('timetable_id', timetableId);
  if (error) throw error;
  const rows = data ?? [];
  kvSet(entryKey(timetableId), rows);
  return rows;
}

export async function addSection(timetableId, sectionId) {
  const { error } = await supabase
    .from('timetable_entry')
    .insert({ timetable_id: timetableId, section_id: sectionId });
  if (error) throw error;   // 겹침·학기 불일치는 DB 트리거가 막는다
}

export async function removeSection(timetableId, sectionId) {
  const { error } = await supabase
    .from('timetable_entry')
    .delete()
    .match({ timetable_id: timetableId, section_id: sectionId });
  if (error) throw error;
}

// 여러 분반을 한 번에 담는다(마법사가 후보를 저장할 때 — 분반 수만큼 왕복하지 않고 요청 1회).
// 겹침·학기 검사는 그대로 DB 트리거가 한다. 마법사는 겹치지 않는 조합만 만들어 오므로
// 여기서 걸리면 그 사이에 카탈로그가 바뀐 것(관리자 수정) — 호출부가 사유를 보여준다.
export async function addSections(timetableId, sectionIds) {
  const ids = [...new Set(sectionIds ?? [])];
  if (!ids.length) return;
  const { error } = await supabase
    .from('timetable_entry')
    .insert(ids.map((section_id) => ({ timetable_id: timetableId, section_id })));
  if (error) throw error;
  kvDel(entryKey(timetableId));   // 캐시 스냅샷 무효화 → 홈이 새로 읽는다
}

// 학기당 5개 상한 때문에, 마법사는 '비어 있는 시간표'(담긴 분반 0 + 직접추가 0)를 후보로 재사용한다.
// (신규 계정이 갖고 있는 빈 '내 시간표'가 대표적 — 그대로 두면 후보를 4개밖에 못 만든다)
// 시간표를 하나씩 열어보지 않고 두 번의 요청으로 학기 전체를 센다.
export async function findEmptyTimetables(ids) {
  const list = [...new Set(ids ?? [])];
  if (!list.length) return new Set();
  const [{ data: entries, error: e1 }, { data: customs, error: e2 }] = await Promise.all([
    supabase.from('timetable_entry').select('timetable_id').in('timetable_id', list),
    supabase.from('custom_class').select('timetable_id').in('timetable_id', list),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  const used = new Set([...(entries ?? []), ...(customs ?? [])].map((r) => r.timetable_id));
  return new Set(list.filter((id) => !used.has(id)));
}

// 확정 시간표들에 담긴 분반 id(모든 학기) — '내가 듣는 강의' 표시용(교수 검색 등)
export async function listPrimarySectionIds() {
  const { data, error } = await supabase
    .from('timetable_entry')
    .select('section_id, timetable!inner(is_primary)')
    .eq('timetable.is_primary', true);
  if (error) throw error;
  return new Set((data ?? []).map((r) => r.section_id));
}
