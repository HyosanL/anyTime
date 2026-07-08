import { supabase } from '../supabase';

async function authHeaders() {
  const { data: { session } } = await supabase.auth.getSession();
  return session ? { Authorization: `Bearer ${session.access_token}` } : {};
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

// 게시글의 이미지 key 배열. 이미지는 board_post_image 릴레이션(정규화)에 있고,
// 조회 시 embedded select 로 함께 온다: .select('*, board_post_image(seq, object_key)')
export function postImageKeys(post) {
  const rows = Array.isArray(post?.board_post_image) ? [...post.board_post_image] : [];
  rows.sort((a, b) => (a.seq || 0) - (b.seq || 0));
  return rows.map((i) => i.object_key);
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

// 공유 화면(비회원)용 이미지 로드 — 인증 헤더 대신 공유 토큰으로 /api/share-image 를 탄다.
// 썸네일 우선 + 404 시 원본 폴백은 위 boardImageObjectUrl 과 동일한 규약.
export async function shareImageObjectUrl(token, key, { thumb = false } = {}) {
  const url = (k) => `/api/share-image?share=${encodeURIComponent(token)}&key=${encodeURIComponent(k)}`;
  if (thumb) {
    const t = await fetch(url(key + '.thumb'));
    if (t.ok) return URL.createObjectURL(await t.blob());
    if (t.status !== 404) return null; // 진짜 오류(차단·토큰 불일치 등)면 폴백 없이 종료
  }
  const res = await fetch(url(key));
  if (!res.ok) return null;
  return URL.createObjectURL(await res.blob());
}

// 데이터 (읽기는 RLS, 쓰기는 RPC)
export const listBoards = (q) =>
  supabase.from('board').select('*').ilike('name', `%${q || ''}%`)
    .order('last_activity_at', { ascending: false }).limit(100).then((r) => r.data || []);
export const createBoard = (name) => supabase.rpc('create_board', { p_name: name }).then((r) => r.data);
export const getBoard = (id) => supabase.from('board').select('*').eq('id', id).maybeSingle().then((r) => r.data);
export const PAGE_SIZE = 15;
const POST_SELECT = '*, board_post_image(seq, object_key)';
// HOT 목록·상세는 원 게시판 이름을 함께 붙인다(여러 게시판이 섞이므로 출처 표시용).
// board_post.board_id → board(FK) 임베드. authenticated 는 read_board 정책으로 board 읽기 가능.
const POST_SELECT_B = '*, board_post_image(seq, object_key), board(name)';
export const listPosts = (boardId, page = 0) =>
  supabase.from('board_post').select(POST_SELECT).eq('board_id', boardId)
    .order('created_at', { ascending: false }).range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
    .then((r) => r.data || []);
export const listHot = (page = 0) =>
  supabase.from('board_post').select(POST_SELECT_B).eq('hot', true)
    .order('created_at', { ascending: false }).range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
    .then((r) => r.data || []);
export const createPost = (boardId, title, content, password, imageKeys) =>
  supabase.rpc('create_post', {
    p_board_id: boardId, p_title: title, p_content: content, p_password: password,
    p_image_keys: imageKeys && imageKeys.length ? imageKeys : null,
  }).then((r) => r.data);

// 즐겨찾기 / 활성화
export const listFavoriteIds = () =>
  supabase.from('board_favorite').select('board_id').then((r) => (r.data || []).map((x) => x.board_id));
// getUser()는 Auth 서버에 토큰을 재검증하는 네트워크 왕복 → 별 탭마다 지연. 세션은 로컬(getSession)에서 즉시 얻는다.
export const addFavorite = (boardId) => supabase.auth.getSession().then(({ data }) =>
  supabase.from('board_favorite').insert({ cadet_id: data.session.user.id, board_id: boardId }));
export const removeFavorite = (boardId) => supabase.auth.getSession().then(({ data }) =>
  supabase.from('board_favorite').delete().match({ cadet_id: data.session.user.id, board_id: boardId }));
// 게시판 활성 여부(관리자 긴급 차단 스위치) — 즉시 반영돼야 하므로 세션 캐시하지 않는다.
// 진입마다의 재요청은 호출부(Board 는 마운트당 1회 [] 이펙트)에서 이미 최소화돼 있다.
export const boardEnabled = () => supabase.rpc('board_enabled').then((r) => r.data !== false);
// 게시글 상세: get_post_b RPC(SETOF board_post)라 기존 SELECT 와 동일한 1요청·같은 응답 형태.
// view=true 면 서버가 조회수 +1 — 호출부(Post 화면)가 기기 세션당 1회만 넘긴다.
export const getPost = (id, view = false) =>
  supabase.rpc('get_post_b', { p_id: Number(id), p_view: !!view })
    .select(POST_SELECT_B).maybeSingle().then((r) => r.data);
export const listComments = (postId) =>
  supabase.from('board_comment').select('*').eq('post_id', postId).order('created_at').then((r) => r.data || []);
export const react = (postId, kind) => supabase.rpc('board_react', { p_post_id: postId, p_kind: kind }).then((r) => r.data);
export const addComment = (postId, parentId, content, password) =>
  supabase.rpc('create_comment_b', { p_post_id: postId, p_parent: parentId || null, p_content: content, p_password: password }).then((r) => r.data);
// 게시글 삭제는 R2 이미지까지 함께 지우도록 /api/board-delete(Pages Functions) 경유.
// (내부에서 delete_post RPC 로 비번 검증·행 삭제 후 R2 객체 제거)
export const deletePost = async (id, password) => {
  const res = await fetch('/api/board-delete', {
    method: 'POST',
    headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (body.status === 'OK') return { data: true, error: null };
  if (body.status === 'BAD_PASSWORD' || body.status === 'NOT_FOUND') return { data: false, error: null };
  return { data: null, error: new Error(body.status || 'ERROR') };
};
export const deleteComment = (id, password) => supabase.rpc('delete_comment_b', { p_id: id, p_password: password });

// ── 공유 링크 ─────────────────────────────────────────────────────────
// 공유 토큰 발급(회원 전용, 글당 1개 고정 — 재호출 시 기존 토큰 반환)
export const createShare = (postId) =>
  supabase.rpc('create_share', { p_post: Number(postId) }).then((r) => {
    if (r.error) throw r.error;
    return r.data;
  });
// 공유 글 읽기(비회원 가능). view=true 면 서버가 비회원 열람만 조회수 +1(기기 세션당 1회는 호출부가 보장).
// 반환: { data: { post_id, post, images, comments } | { disabled: true } | null, error }
export const getSharedPost = (token, view = false) =>
  supabase.rpc('get_shared_post', { p_token: token, p_view: !!view });
