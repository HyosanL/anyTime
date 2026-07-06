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

// 데이터 (읽기는 RLS, 쓰기는 RPC)
export const listBoards = (q) =>
  supabase.from('board').select('*').ilike('name', `%${q || ''}%`)
    .order('last_activity_at', { ascending: false }).limit(100).then((r) => r.data || []);
export const createBoard = (name) => supabase.rpc('create_board', { p_name: name }).then((r) => r.data);
export const getBoard = (id) => supabase.from('board').select('*').eq('id', id).maybeSingle().then((r) => r.data);
export const PAGE_SIZE = 15;
const POST_SELECT = '*, board_post_image(seq, object_key)';
export const listPosts = (boardId, page = 0) =>
  supabase.from('board_post').select(POST_SELECT).eq('board_id', boardId)
    .order('created_at', { ascending: false }).range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
    .then((r) => r.data || []);
export const listHot = (page = 0) =>
  supabase.from('board_post').select(POST_SELECT).eq('hot', true)
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
export const addFavorite = (boardId) => supabase.auth.getUser().then(({ data }) =>
  supabase.from('board_favorite').insert({ cadet_id: data.user.id, board_id: boardId }));
export const removeFavorite = (boardId) => supabase.auth.getUser().then(({ data }) =>
  supabase.from('board_favorite').delete().match({ cadet_id: data.user.id, board_id: boardId }));
export const boardEnabled = () => supabase.rpc('board_enabled').then((r) => r.data !== false);
export const getPost = (id) => supabase.from('board_post').select(POST_SELECT).eq('id', id).maybeSingle().then((r) => r.data);
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
