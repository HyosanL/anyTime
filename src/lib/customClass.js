// 사용자가 직접 추가한 시간표 항목(카탈로그에 없는 강의). 시간표(timetable)마다 따로.
// 계정 종속 데이터 → users/{uid}/timetables/{ttId}/customClasses 에 저장. 5개 제한과 같은
// 교차-문서 검사는 없지만, 담긴 분반·다른 직접추가와의 시간 겹침 검사(옛 custom_class_no_overlap
// 트리거)가 있어 timetable.js 의 entries 처럼 Cloud Function(addCustomClass/updateCustomClass/
// deleteCustomClass) 경유로 쓴다(설계 §1) — 읽기만 여기서 직접.
// 오프라인/즉시 표시를 위해 localStorage 에 시간표별 스냅샷을 write-through 캐시한다(원본은 서버).
// TimetableGrid 가 쓰는 항목 형태: { id, title, day(1~7), startMin, endMin, room }
import { collection, getDocs, orderBy, query } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { callFn } from './functions';

const cacheKey = (timetableId) => `anytime:customClassCache:tt:${timetableId}`;
const legacyKey = (uid) => `anytime:customClasses:${uid || 'anon'}`; // 구버전(기기 로컬 전용) 데이터

// Cloud Function 이 저장하는 필드(title/day/startMin/endMin/room)가 이미 TimetableGrid 형태와
// 같아 옛 rowToEntry 같은 스네이크→카멜 변환이 필요 없다 — room 만 null 을 '' 로 다듬는다.
function rowFromDoc(d) {
  const data = d.data();
  return {
    id: d.id,
    title: data.title,
    day: data.day,
    startMin: data.startMin,
    endMin: data.endMin,
    room: data.room || '',
  };
}

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
  const uid = auth.currentUser?.uid;
  if (!uid) return [];
  const col = collection(db, 'users', uid, 'timetables', timetableId, 'customClasses');
  const snap = await getDocs(query(col, orderBy('createdAt', 'asc')));
  return snap.docs.map(rowFromDoc);
}

// Cloud Function 은 새 문서 id 만 돌려준다({id}) — 화면이 곧바로 쓸 항목은 보낸 값 그대로 조립한다
// (서버가 저장하는 title.trim()/room||null 과 맞춘다).
async function insertToDb(timetableId, entry) {
  const res = await callFn('addCustomClass', {
    timetableId,
    title: entry.title,
    day: entry.day,
    startMin: entry.startMin,
    endMin: entry.endMin,
    room: entry.room || null,
  });
  if (!res.ok) {
    const err = new Error(res.message || '추가하지 못했습니다.');
    err.code = res.status;
    throw err;
  }
  return {
    id: res.data.id,
    title: String(entry.title).trim(),
    day: entry.day,
    startMin: entry.startMin,
    endMin: entry.endMin,
    room: entry.room || '',
  };
}

// 구버전 기기-로컬 데이터를 1회 서버로 이전(온라인 + 그 시간표가 비어있을 때만 → 중복 방지)
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
// uid 는 구버전 데이터 이전 키에만 쓰인다 — 넘기지 않아도(또는 잘못돼도) auth.currentUser 로
// 보완해 이전이 조용히 건너뛰어지지 않게 한다.
export async function listCustomClasses(uid, timetableId) {
  if (!timetableId) return [];
  const realUid = uid || auth.currentUser?.uid;
  let rows;
  try {
    rows = await fetchFromDb(timetableId);
  } catch {
    return readCustomCache(timetableId); // 오프라인 → 마지막 스냅샷
  }
  try {
    if (realUid && localStorage.getItem(legacyKey(realUid))) {
      await migrateLegacy(realUid, timetableId, rows);
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

// 지금 화면에는 편집 UI 가 없지만(추가·삭제만) CF 는 존재한다 — 겹침 재검사까지 포함해
// 그대로 노출해 둔다(옛 화면에도 없던 기능이라 호출부 없음, 나중에 편집 UI 가 붙을 때를 대비).
export async function updateCustomClass(timetableId, id, entry) {
  const res = await callFn('updateCustomClass', {
    timetableId,
    customClassId: id,
    title: entry.title,
    day: entry.day,
    startMin: entry.startMin,
    endMin: entry.endMin,
    room: entry.room || null,
  });
  if (!res.ok) {
    const err = new Error(res.message || '수정하지 못했습니다.');
    err.code = res.status;
    throw err;
  }
  return {
    id,
    title: String(entry.title).trim(),
    day: entry.day,
    startMin: entry.startMin,
    endMin: entry.endMin,
    room: entry.room || '',
  };
}

// timetableId 가 필요해졌다 — 문서 경로가 users/{uid}/timetables/{timetableId}/customClasses/{id}
// 라 시간표를 모르면 지울 문서를 찾을 수 없다(옛 custom_class.id 는 전역 유일이라 안 받아도 됐다).
export async function removeCustomClass(timetableId, id) {
  const res = await callFn('deleteCustomClass', { timetableId, customClassId: id });
  if (!res.ok) {
    const err = new Error(res.message || '삭제하지 못했습니다.');
    err.code = res.status;
    throw err;
  }
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
