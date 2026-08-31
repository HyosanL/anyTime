// 시간표 공유(친구) — opt-in 공개 토글 + 팔로우 + 별칭.
// 조회(검색·갤러리)는 Cloud Function(공개 여부·본인 여부를 서버가 강제, 설계 §1 익명/공유 데이터
// 급이 아니라 순수 소유 데이터지만 남의 데이터를 넘나보는 교차-사용자 조회라 Admin SDK 가 필요하다).
// 팔로우/별칭/재정렬 쓰기는 users/{uid}/follows Rules(isOwner)로 직접.
import {
  collection, doc, deleteDoc, setDoc, updateDoc, writeBatch,
} from 'firebase/firestore';
import { auth, db } from '../firebase';
import { callFn } from './functions';

function followsCol(uid) {
  return collection(db, 'users', uid, 'follows');
}

// 내 확정시간표 공개 on/off → 적용된 값 반환. Rules 가 users/{uid} 문서에서 이 필드 하나만
// 자기수정 허용(allowlist) — 그 외 필드는 여전히 Cloud Function 경유.
export async function setTtPublic(on) {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('로그인이 필요합니다.');
  await updateDoc(doc(db, 'users', uid), { ttPublic: !!on });
  return !!on;
}

// 공개한 사용자 아이디 검색 → [{ id, username, public, following }]
export async function searchSharedUsers(q) {
  const res = await callFn('searchSharedUsers', { q: q || '' });
  return res.ok ? (res.data || []) : [];
}

// 팔로우한 사람들의 확정시간표(공개인 경우만) → 갤러리 배열.
// [{ followeeId, username, nickname, public, timetable:{id,year,term,name}|null,
//    entries:[{sectionId}], customs:[{id,title,day,startMin,endMin,room}] }]
// getSharedGallery 함수는 entries 를 { sectionKey } 로 돌려준다(sections 문서ID 필드명과
// 맞춘 서버 쪽 이름) — cache.js 의 buildMyTimetable 은 entries[].sectionId 를 읽으므로
// 여기서 sectionId 로 맞춰 돌려준다(그대로 넘기면 내 시간표 조립이 조용히 빈 격자가 된다).
export async function getGallery() {
  const res = await callFn('getSharedGallery');
  if (!res.ok) return [];
  return (res.data || []).map((row) => ({
    ...row,
    entries: (row.entries || []).map((e) => ({ sectionId: e.sectionKey })),
  }));
}

// 팔로우 / 언팔로우 / 별칭 — follows(내 서브컬렉션만). uid = 내 세션 유저 id.
export function followUser(uid, followeeId, nickname) {
  // merge:true — 이미 팔로우 중인데 다시 눌려도(중복 클릭) 기존 sortOrder 를 지우지 않는다.
  return setDoc(doc(followsCol(uid), followeeId), { nickname: nickname?.trim() || null }, { merge: true });
}
export function unfollowUser(uid, followeeId) {
  return deleteDoc(doc(followsCol(uid), followeeId));
}
export function setNickname(uid, followeeId, nickname) {
  return updateDoc(doc(followsCol(uid), followeeId), { nickname: nickname?.trim() || null });
}

// 넘긴 followeeId 배열 순서대로 갤러리 표시 순서를 재부여. 교차-문서 불변조건이 없는 순수
// 소유 데이터 쓰기라 Cloud Function 없이 batched write 로 충분하다(설계 §1).
export async function reorderFollows(ids) {
  const uid = auth.currentUser?.uid;
  if (!uid || !ids?.length) return;
  const batch = writeBatch(db);
  ids.forEach((id, i) => batch.update(doc(followsCol(uid), id), { sortOrder: i }));
  await batch.commit();
}
