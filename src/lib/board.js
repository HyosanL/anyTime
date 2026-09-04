import {
  collection, doc, getDoc, getDocs, query, where, orderBy, limit, startAfter, documentId,
  setDoc, deleteDoc, serverTimestamp,
} from 'firebase/firestore';
import { auth, db } from '../firebase';
import { callFn } from './functions';

// R2 이미지 서빙(/api/board-*)은 Cloudflare Pages Functions 로 남아 있다(설계 §7,
// R2 는 이관 대상 아님) — 그 함수들의 미들웨어만 Supabase 세션 대신 Firebase ID
// 토큰(RS256)을 검증하도록 바뀌었다(설계 §8). 그래서 여기 헤더도 Firebase 토큰으로.
async function authHeaders() {
  const user = auth.currentUser;
  if (!user) return {};
  return { Authorization: `Bearer ${await user.getIdToken()}` };
}

// 이미지를 모바일 최적화 크기로 리사이즈(jpeg). max/quality 조절 가능.
export async function resizeImage(file, max = 1080, quality = 0.85) {
  try {
    const img = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    return await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
  } catch {
    return file;
  }
}

// 원본(1080px/0.85)과 저화질 썸네일(480px/0.5)을 한 번에 올린다.
// 목록/상세는 평소 썸네일만 받아 보여주고(에그레스 절감), 탭하면 원본을 로드한다.
// 썸네일은 원본과 같은 key + '.thumb' 로 저장돼 별도 DB 컬럼이 필요 없다.
export async function uploadBoardImage(file) {
  const isImg = file.type?.startsWith('image/');
  const full = isImg ? await resizeImage(file, 1080, 0.85) : file;
  const thumb = isImg ? await resizeImage(file, 480, 0.5) : null;
  const fd = new FormData();
  fd.append('file', full, 'img.jpg');
  if (thumb) fd.append('thumb', thumb, 'thumb.jpg');
  const res = await fetch('/api/board-upload', { method: 'POST', headers: await authHeaders(), body: fd });
  if (!res.ok) throw new Error('이미지 업로드 실패');
  return (await res.json()).key;
}

// 여러 이미지를 순차 업로드 → key 배열
export async function uploadBoardImages(files) {
  const keys = [];
  for (const f of files) keys.push(await uploadBoardImage(f));
  return keys;
}

// 게시글의 이미지 key 배열. 예전엔 board_post_image 정규화 테이블을 embedded select 로
// 받았지만, Firestore 는 boardPosts 문서 자체에 images:[{seq, objectKey}] 로 임베드한다(설계 §3).
export function postImageKeys(post) {
  const rows = Array.isArray(post?.images) ? [...post.images] : [];
  rows.sort((a, b) => (a.seq || 0) - (b.seq || 0));
  return rows.map((i) => i.objectKey);
}

// 게시판 이미지를 blob URL 로. thumb=true 면 저화질 썸네일(key+'.thumb')을 받고,
// 썸네일이 없는 구버전 이미지는 원본으로 폴백한다. (원본은 클릭 시에만 로드해 에그레스 절감)
export async function boardImageObjectUrl(key, { thumb = false } = {}) {
  const h = await authHeaders();
  if (thumb) {
    const t = await fetch(`/api/board-image?key=${encodeURIComponent(key + '.thumb')}`, { headers: h });
    if (t.ok) return URL.createObjectURL(await t.blob());
    if (t.status !== 404) return null; // 진짜 오류면 폴백 없이 종료
    // 404 → 썸네일 없는 구버전 → 원본으로 폴백
  }
  const res = await fetch(`/api/board-image?key=${encodeURIComponent(key)}`, { headers: h });
  if (!res.ok) return null;
  return URL.createObjectURL(await res.blob());
}

// Cloud Function 응답(JSON 직렬화)에서 Firestore Timestamp 는 {_seconds,_nanoseconds}
// (또는 {seconds,nanoseconds})로 오고, 클라이언트 직접 읽기(getDocs)에서는 Timestamp
// 인스턴스(.toDate())로 온다 — 화면의 new Date(x)/timeAgo(iso) 호출부가 이 차이를
// 몰라도 되게 여기서 ISO 문자열로 통일한다.
function toIso(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === 'function') return ts.toDate().toISOString();
  const secs = ts._seconds ?? ts.seconds;
  if (typeof secs === 'number') return new Date(secs * 1000).toISOString();
  return ts; // 이미 문자열이거나 알 수 없는 형태 — 그대로 통과
}

function toPost(d) {
  const data = d.data();
  return { id: d.id, ...data, createdAt: toIso(data.createdAt) };
}

// 여러 게시판 글에 원 게시판 이름을 붙인다(HOT 목록처럼 여러 게시판이 섞일 때만 필요 —
// 일반 게시판 목록은 화면이 이미 게시판을 알고 있어 붙이지 않는다).
// Firestore 는 서버 조인이 없어 boardId 집합을 문서ID 'in' 쿼리(최대 30개)로 배치 조회한다.
async function attachBoardNames(posts) {
  const ids = [...new Set(posts.map((p) => p.boardId).filter(Boolean))];
  if (!ids.length) return posts;
  const names = new Map();
  for (let i = 0; i < ids.length; i += 30) {
    const chunk = ids.slice(i, i + 30);
    const snap = await getDocs(query(collection(db, 'boards'), where(documentId(), 'in', chunk)));
    snap.forEach((d) => names.set(d.id, d.get('name')));
  }
  return posts.map((p) => ({ ...p, board: { name: names.get(p.boardId) ?? null } }));
}

// 데이터 (읽기는 Firestore 직접, 쓰기는 Cloud Functions — 익명/공유 데이터 티어, 설계 §1)
// ⚠️ 게시글 비밀번호는 이제 클라이언트에 아예 오지 않는다 — boardPosts/{id}/_private/auth
// 서브컬렉션으로 물리적 격리(Rules: allow read,write: if false)돼 있고, 삭제 UI 분기는
// hasPassword(유도 필드)로 한다. 실제 비번 검증은 서버(deletePost/deleteComment CF)에서만.

// 게시판 목록은 최근 활동순. Firestore 는 ILIKE 가 없어 상위 100개를 받아 클라이언트에서
// 부분일치 필터링한다 — 옛 PostgREST ilike 와 완전히 동일하진 않다(최근 활동 100개 밖의
// 게시판은 검색에 안 걸릴 수 있음, 게시판 수가 이 한계를 넘으면 별도 검색 인덱스가 필요).
export async function listBoards(q) {
  const snap = await getDocs(query(collection(db, 'boards'), orderBy('lastActivityAt', 'desc'), limit(100)));
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const needle = (q || '').trim().toLowerCase();
  return needle ? rows.filter((b) => (b.name || '').toLowerCase().includes(needle)) : rows;
}
export const createBoard = (name) =>
  callFn('createBoard', { name }).then((r) => (r.ok ? r.data.id : null));
export async function getBoard(id) {
  const snap = await getDoc(doc(db, 'boards', id));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}
export const PAGE_SIZE = 15;

// 즐겨찾기 — 소유 데이터(설계 §1): Cloud Function 없이 Rules(isOwner)만으로 직접 R/W.
// currentUser 는 로컬 캐시라 네트워크 왕복이 없다(옛 getSession() 과 같은 이유로 getUser() 대신 사용하던 것과 동일 취지).
export async function listFavoriteIds() {
  const uid = auth.currentUser?.uid;
  if (!uid) return [];
  const snap = await getDocs(collection(db, 'users', uid, 'favoriteBoards'));
  return snap.docs.map((d) => d.id);
}
export function addFavorite(boardId) {
  const uid = auth.currentUser?.uid;
  if (!uid) return Promise.resolve();
  return setDoc(doc(db, 'users', uid, 'favoriteBoards', boardId), { createdAt: serverTimestamp() });
}
export function removeFavorite(boardId) {
  const uid = auth.currentUser?.uid;
  if (!uid) return Promise.resolve();
  return deleteDoc(doc(db, 'users', uid, 'favoriteBoards', boardId));
}
// (게시판 활성 여부는 부팅 시 이미 온다 — useAuthContext().settings.boardEnabled.
//  화면마다 따로 확인하지 않는다. 관리자가 잠그면 앱 복귀 확인에서 반영된다.)

// 목록 페이지네이션: Firestore 웹 SDK 에는 offset 이 없어(옛 .range() 오프셋 방식은
// 포팅 불가) 커서(마지막 문서 스냅샷) 기반으로 바뀐다 — page 번호 대신 cursor 를 받고
// 다음 페이지를 위한 cursor 를 함께 돌려준다. 호출부는 순차 스크롤이라 커서로 충분하다.
export async function listPosts(boardId, cursor = null) {
  const constraints = [where('boardId', '==', boardId), orderBy('createdAt', 'desc'), limit(PAGE_SIZE)];
  if (cursor) constraints.push(startAfter(cursor));
  const snap = await getDocs(query(collection(db, 'boardPosts'), ...constraints));
  return { items: snap.docs.map(toPost), cursor: snap.docs.at(-1) ?? null };
}
export async function listHot(cursor = null) {
  const constraints = [where('hot', '==', true), orderBy('createdAt', 'desc'), limit(PAGE_SIZE)];
  if (cursor) constraints.push(startAfter(cursor));
  const snap = await getDocs(query(collection(db, 'boardPosts'), ...constraints));
  const items = await attachBoardNames(snap.docs.map(toPost));
  return { items, cursor: snap.docs.at(-1) ?? null };
}
export const createPost = (boardId, title, content, password, imageKeys) =>
  callFn('createPost', {
    boardId, title, content, postPassword: password,
    imageKeys: imageKeys && imageKeys.length ? imageKeys : null,
  }).then((r) => (r.ok ? r.data.id : null));

// 게시글 상세: getPost 는 view=true 일 때 조회수 +1 부수효과가 있어(옛 get_post_b(id,view)
// RPC 와 동일 계약) 목록 읽기와 달리 CF 로 남는다 — 호출부(Post 화면)가 기기당 1회만 넘긴다.
// 원 게시판 이름은 getPost 응답에 없어(설계상 boardPosts 문서엔 boardId 만 있음) 별도
// 조회 후 옛 post.board.name 모양으로 붙여 호출부 변경을 최소화한다.
export async function getPost(id, view = false) {
  const r = await callFn('getPost', { postId: id, view: !!view });
  if (!r.ok || !r.data) return null;
  const post = { ...r.data, createdAt: toIso(r.data.createdAt) };
  const board = await getBoard(post.boardId);
  return { ...post, board: board ? { name: board.name } : null };
}
export async function listComments(postId) {
  const snap = await getDocs(query(collection(db, 'boardPosts', postId, 'comments'), orderBy('createdAt')));
  return snap.docs.map((d) => { const data = d.data(); return { id: d.id, ...data, createdAt: toIso(data.createdAt) }; });
}
export const react = (postId, kind, endpoint) =>
  callFn('boardReact', { postId, kind, ...(endpoint ? { endpoint } : {}) }).then((r) => (r.ok ? r.data.status : 'ERROR'));
export const addComment = (postId, parentId, content, password) =>
  callFn('createComment', { postId, parentId: parentId || null, content, postPassword: password })
    .then((r) => (r.ok ? r.data.id : null));
// 게시글 삭제. R2 이미지 정리는 더 이상 이 호출에 동기로 묶여 있지 않다 — 참조 안 되는
// 키는 board-sweep(boardReferencedKeys 를 도는 별도 크론)이 나중에 정리한다.
export async function deletePost(id, password) {
  const r = await callFn('deletePost', { postId: id, postPassword: password });
  if (!r.ok) return { data: null, error: new Error(r.message || r.status) };
  return { data: r.data.deleted, error: null };
}
// 댓글은 boardPosts/{postId}/comments 서브컬렉션에 있어 삭제하려면 postId 도 함께 필요하다
// (옛 delete_comment_b 는 댓글 한 행만으로 부모 글을 찾을 수 있었지만, 서브컬렉션 경로엔
// 부모 문서ID가 그 자체로 필요 — CF 페이로드가 postId 를 요구하도록 바뀌었다).
export async function deleteComment(postId, commentId, password) {
  const r = await callFn('deleteComment', { postId, commentId, postPassword: password });
  if (!r.ok) return { data: null, error: new Error(r.message || r.status) };
  return { data: r.data.deleted, error: null };
}
