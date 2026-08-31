// =====================================================================
//  학점계산기 — 성적 저장(users/{uid}/gradeEntries) + 평점 계산(순수)
//
//  학점(평점) 기록은 학기별 누적·추이라 계정에 묶어 기기 간 동기화한다(서버 저장).
//  Rules: 본인 서브컬렉션만(isOwner(uid)) — Cloud Function 없이 직접 R/W(설계 §1, 교차문서
//  불변조건이 없는 순수 소유 데이터).
//  평점은 4.3 만점(등급→평점 고정 매핑). 학점(credit)·등급 둘 다 있는 행만 집계한다.
// =====================================================================
import {
  addDoc, collection, deleteDoc, doc, getDocs, orderBy, query, updateDoc, writeBatch,
} from 'firebase/firestore';
import { auth, db } from '../firebase';

// 등급 → 평점(4.3 만점)
export const GRADE_POINTS = {
  'A+': 4.3, A0: 4.0, 'A-': 3.7,
  'B+': 3.3, B0: 3.0, 'B-': 2.7,
  'C+': 2.3, C0: 2.0, 'C-': 1.7,
  'D+': 1.3, D0: 1.0, 'D-': 0.7,
  F: 0.0,
};
// 셀렉트 옵션 순서(높은 등급 → 낮은 등급 → F)
export const GRADE_ORDER = ['A+', 'A0', 'A-', 'B+', 'B0', 'B-', 'C+', 'C0', 'C-', 'D+', 'D0', 'D-', 'F'];

function col(uid) {
  return collection(db, 'users', uid, 'gradeEntries');
}

// 성적행은 옛 COLS 가 created_at 을 아예 select 하지 않던 것과 마찬가지로 화면에 안 실어 보낸다.
function rowFromDoc(d) {
  const data = d.data();
  return {
    id: d.id,
    year: data.year,
    term: data.term,
    courseName: data.courseName,
    credit: data.credit ?? null,
    grade: data.grade ?? null,
    sortOrder: data.sortOrder ?? 0,
  };
}

// 내 전 학기 성적 행(최신 학기 → sortOrder). firestore.indexes.json 의 gradeEntries
// 복합색인(year DESC, term DESC, sortOrder ASC)과 정확히 맞춘 순서.
export async function listGrades() {
  const uid = auth.currentUser?.uid;
  if (!uid) return [];
  const snap = await getDocs(
    query(col(uid), orderBy('year', 'desc'), orderBy('term', 'desc'), orderBy('sortOrder', 'asc'))
  );
  return snap.docs.map(rowFromDoc);
}

function toEntryData(row) {
  return {
    year: row.year,
    term: row.term,
    courseName: row.courseName,
    credit: row.credit ?? null,
    grade: row.grade ?? null,
    sortOrder: row.sortOrder ?? 0,
  };
}

export async function addGrade(cadetId, row) {
  const uid = cadetId || auth.currentUser?.uid;
  if (!uid) throw new Error('로그인이 필요합니다.');
  const data = toEntryData(row);
  const ref = await addDoc(col(uid), data);
  return { id: ref.id, ...data };
}

// 시드 벌크(시간표 불러오기). 이름만 있는 행들을 한 번에 넣는다 — writeBatch 로 왕복 1회.
export async function addGrades(cadetId, rows) {
  if (!rows.length) return [];
  const uid = cadetId || auth.currentUser?.uid;
  if (!uid) throw new Error('로그인이 필요합니다.');
  const batch = writeBatch(db);
  const made = rows.map((r) => {
    const ref = doc(col(uid));
    const data = toEntryData(r);
    batch.set(ref, data);
    return { id: ref.id, ...data };
  });
  await batch.commit();
  return made;
}

export async function updateGrade(id, patch) {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('로그인이 필요합니다.');
  await updateDoc(doc(col(uid), id), patch);
}

export async function deleteGrade(id) {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('로그인이 필요합니다.');
  await deleteDoc(doc(col(uid), id));
}

// ── 순수 계산 ─────────────────────────────────────────────────────────
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 평점 집계 대상: 학점>0 이고 성적등급이 있는 행.
function counts(row) {
  const credit = num(row.credit);
  return credit != null && credit > 0 && row.grade != null && row.grade in GRADE_POINTS;
}

// 행 묶음의 평점 = Σ(평점×학점)/Σ(학점). 대상 없으면 null.
export function gpaOf(rows) {
  let qp = 0;
  let cr = 0;
  for (const r of rows) {
    if (!counts(r)) continue;
    const credit = num(r.credit);
    qp += GRADE_POINTS[r.grade] * credit;
    cr += credit;
  }
  if (cr === 0) return { gpa: null, credits: 0 };
  return { gpa: Math.round((qp / cr) * 100) / 100, credits: Math.round(cr * 10) / 10 };
}

// 학기별 묶음(최신순). [{ year, term, key, label, rows, gpa, credits }]
export function groupBySemester(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = `${r.year}-${r.term}`;
    if (!map.has(key)) map.set(key, { year: r.year, term: r.term, key, rows: [] });
    map.get(key).rows.push(r);
  }
  const groups = [...map.values()].map((g) => ({
    ...g,
    label: `${String(g.year).slice(2)}-${g.term}`,
    ...gpaOf(g.rows),
  }));
  groups.sort((a, b) => b.year - a.year || b.term - a.term);
  return groups;
}

// 누적 평점(전 학기 통합).
export function cumulativeGpa(rows) {
  return gpaOf(rows);
}

// 추이(오래된→최신). 평점이 산출된 학기만.
export function trendPoints(groups) {
  return [...groups]
    .filter((g) => g.gpa != null)
    .sort((a, b) => a.year - b.year || a.term - b.term)
    .map((g) => ({ label: g.label, gpa: g.gpa }));
}
