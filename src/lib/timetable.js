// =====================================================================
//  시간표 API 레이어
//  한 생도가 학기마다 시간표를 여러 개 갖는다(지난 학기 기록·다음 학기 미리짜기).
//  그중 학기별 1개가 '확정'(isPrimary) — 강의평·메모 자격의 근거는 확정뿐이다.
//  홈에서 전환해 보며, 마지막으로 본 시간표는 기기(localStorage)에 기억한다.
//
//  Firestore: users/{uid}/timetables/{id} 1:N entries/{sectionKey}(담긴 분반, 문서ID 가
//  곧 sections/{sectionKey} 를 가리키는 자연키). 5개 제한·자동 대표 승격·시간 겹침 검사는
//  문서 하나만 보는 Rules 로 표현할 수 없어(설계 §1) firestore.rules 가 이 서브트리 전체를
//  allow write:if false 로 잠그고, 모든 쓰기가 Cloud Functions(firebase/functions/src/timetable.js)
//  트랜잭션을 거친다 — 읽기만 여기서 직접.
//  캐시: IndexedDB 에 목록·항목 스냅샷 write-through(오프라인·즉시 표시).
// =====================================================================
import { collection, getDocs, query, where } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { callFn } from './functions';
import { kvGet, kvSet, kvDel } from './cache';

const LIST_KEY = 'timetables';
const entryKey = (id) => `tt-entries:${id}`;
const SELECTED_KEY = 'anytime:selectedTimetable';

function requireUid() {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('로그인이 필요합니다.');
  return uid;
}

// Cloud Function 실패를 옛 `if (error) throw error` 흐름과 같은 모양으로 되돌린다.
// err.code 에 HttpsError.code(예: 'invalid-argument')를 실어 isOverlapError 등 분기가 계속 되게 한다.
async function callFnOrThrow(name, payload) {
  const res = await callFn(name, payload);
  if (!res.ok) {
    const err = new Error(res.message || '요청을 처리하지 못했습니다.');
    err.code = res.status;
    throw err;
  }
  return res.data;
}

// 겹침(Cloud Function invalid()) 에러인지 — 사용자에게 다르게 안내한다.
// 옛 Postgres 트리거 에러코드(23P01/exclusion)는 이제 나오지 않는다 — CF 는 고정 한국어
// 메시지로만 실패를 구분시킨다(설계상 코드가 아닌 메시지 매칭이 유일한 방법).
export function isOverlapError(e) {
  return /겹칩니다/.test(e?.message || '');
}

// ── 마지막으로 본 시간표(기기 기억) ──────────────────────────────────
// 옛 시간표 id 는 BIGINT 라 숫자로 저장했지만 Firestore 문서ID 는 문자열이다 — 그대로 저장·비교.
export function readSelectedId() {
  try { return localStorage.getItem(SELECTED_KEY) || null; } catch { return null; }
}
export function writeSelectedId(id) {
  try { localStorage.setItem(SELECTED_KEY, String(id)); } catch { /* ignore */ }
}

// 기억해 둔 시간표가 목록에 없으면(삭제됨·다른 기기) 현재 학기 확정 → 아무거나로 되돌린다.
export function pickTimetable(list, current, preferredId = null) {
  if (!list?.length) return null;
  const byId = preferredId && list.find((t) => t.id === preferredId);
  if (byId) return byId;
  const cur = current && list.find((t) => t.year === current.year && t.term === current.term && t.isPrimary);
  return cur ?? list.find((t) => t.isPrimary) ?? list[0];
}

// ── 목록 ─────────────────────────────────────────────────────────────
export async function readTimetablesCache() {
  return (await kvGet(LIST_KEY)) ?? [];
}

// 최신 학기 → 확정 → 만든 순. firestore.indexes.json 에는 이 4중 정렬(연도desc·학기desc·
// 확정desc·생성asc)에 맞는 복합색인이 없다(기존 색인은 연도asc/학기asc 뿐) — 계정당
// 시간표 수가 작아(학기당 5개 상한) 색인 추가 없이 클라이언트 정렬로 충분하다.
export async function listTimetables() {
  const uid = requireUid();
  const snap = await getDocs(collection(db, 'users', uid, 'timetables'));
  const rows = snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      year: data.year,
      term: data.term,
      name: data.name,
      isPrimary: !!data.isPrimary,
      createdAt: data.createdAt?.toDate?.() ?? null,
    };
  });
  rows.sort((a, b) =>
    b.year - a.year || b.term - a.term ||
    Number(b.isPrimary) - Number(a.isPrimary) ||
    (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0)
  );
  kvSet(LIST_KEY, rows);
  return rows;
}

// 그 학기의 첫 시간표는 Cloud Function 이 자동으로 확정 처리한다. uid 는 더 이상 쓰이지
// 않는다(CF 가 ID 토큰에서 직접 인증한다) — 옛 호출부가 넘기던 자리를 그대로 둬도 무해하다.
export async function createTimetable({ uid, year, term, name } = {}) {
  return callFnOrThrow('createTimetable', { year, term, name });
}

// 이름 변경 — ⚠️ firebase/functions 에 대응하는 Cloud Function 이 아직 없다(아래 파일
// 하단 주석·마이그레이션 보고서 참고). firestore.rules 가 timetables/{id} 서브트리 전체를
// write:false 로 잠가 두어 직접 쓰기도 불가능 — 지금은 백엔드가 추가되기 전까지 항상 실패한다.
export async function renameTimetable(id, name) {
  await callFnOrThrow('renameTimetable', { timetableId: id, name });
}

// 확정으로 지정 — 같은 학기의 다른 시간표는 Cloud Function 트랜잭션이 자동으로 내린다.
export async function setPrimaryTimetable(id) {
  await callFnOrThrow('setPrimaryTimetable', { timetableId: id });
}

export async function deleteTimetable(id) {
  await callFnOrThrow('deleteTimetable', { timetableId: id });   // 담긴 분반·직접추가는 recursiveDelete
  kvDel(entryKey(id));
}

// ── 담긴 분반 ────────────────────────────────────────────────────────
export async function readEntriesCache(timetableId) {
  if (!timetableId) return [];
  return (await kvGet(entryKey(timetableId))) ?? [];
}

// entries 문서ID = sections/{sectionKey} 와 같은 자연키(sectionKeyOf, 설계 §3) — cache.js
// 의 buildMyTimetable 이 entries[].sectionId 로 sections 목록과 맞춰 조립한다.
export async function listEntries(timetableId) {
  if (!timetableId) return [];
  const uid = requireUid();
  const snap = await getDocs(collection(db, 'users', uid, 'timetables', timetableId, 'entries'));
  const rows = snap.docs.map((d) => {
    const data = d.data();
    return { sectionId: d.id, createdAt: data.createdAt?.toDate?.() ?? null };
  });
  kvSet(entryKey(timetableId), rows);
  return rows;
}

// section 은 { courseCode, year, term, sectionNo } 를 가진 분반 객체(cache.js buildSections
// 의 원소 그대로 넘기면 된다) — 옛 section.id(BIGINT) 는 사라졌고, 자연키 4필드로 CF 를 부른다.
export async function addSection(timetableId, section) {
  const { courseCode, year, term, sectionNo } = section;
  await callFnOrThrow('addTimetableEntry', { timetableId, courseCode, year, term, sectionNo });
}

export async function removeSection(timetableId, section) {
  const { courseCode, year, term, sectionNo } = section;
  await callFnOrThrow('removeTimetableEntry', { timetableId, courseCode, year, term, sectionNo });
}

// 여러 분반을 한 번에 담는다(마법사가 후보를 저장할 때). 옛 벌크 INSERT 는 트리거 실패 시
// 문 전체가 원자적으로 되돌아갔지만, CF 호출은 건별이라 그 원자성이 없다 — 실패하면 이미
// 담은 것만 되돌려(보상 롤백) 같은 결과를 흉내낸다. 겹침·학기 검사는 그대로 CF 가 한다.
export async function addSections(timetableId, sections) {
  const list = sections ?? [];
  if (!list.length) return;
  const added = [];
  try {
    for (const s of list) {
      await addSection(timetableId, s);
      added.push(s);
    }
  } catch (e) {
    await Promise.all(added.map((s) => removeSection(timetableId, s).catch(() => {})));
    throw e;
  }
  kvDel(entryKey(timetableId));   // 캐시 스냅샷 무효화 → 홈이 새로 읽는다
}

// 학기당 5개 상한 때문에, 마법사는 '비어 있는 시간표'(담긴 분반 0 + 직접추가 0)를 후보로 재사용한다.
// Firestore 는 여러 부모의 서브컬렉션을 한 번에 세는 쿼리가 없어(옛 .in() 배치 select 불가)
// 시간표별로 entries·customClasses 존재 여부를 병렬 조회한다 — 학기당 최대 5개라 비용 작다.
export async function findEmptyTimetables(ids) {
  const list = [...new Set(ids ?? [])];
  if (!list.length) return new Set();
  const uid = requireUid();
  const results = await Promise.all(
    list.map(async (id) => {
      const [entriesSnap, customsSnap] = await Promise.all([
        getDocs(collection(db, 'users', uid, 'timetables', id, 'entries')),
        getDocs(collection(db, 'users', uid, 'timetables', id, 'customClasses')),
      ]);
      return entriesSnap.empty && customsSnap.empty ? id : null;
    })
  );
  return new Set(results.filter(Boolean));
}

// 확정 시간표들에 담긴 분반 id(모든 학기) — '내가 듣는 강의' 표시용(교수 검색 등).
// entries 문서ID가 곧 sections 문서ID 이므로 그대로 모으면 된다(옛 timetable!inner 조인 불필요).
export async function listPrimarySectionIds() {
  const uid = auth.currentUser?.uid;
  if (!uid) return new Set();
  const ttSnap = await getDocs(query(collection(db, 'users', uid, 'timetables'), where('isPrimary', '==', true)));
  const entrySnaps = await Promise.all(ttSnap.docs.map((d) => getDocs(collection(d.ref, 'entries'))));
  return new Set(entrySnaps.flatMap((s) => s.docs.map((e) => e.id)));
}
