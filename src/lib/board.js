import { supabase } from '../supabase';

async function authHeaders() {
  const { data: { session } } = await supabase.auth.getSession();
  return session ? { Authorization: `Bearer ${session.access_token}` } : {};
}

// 이미지를 모바일 최적화 크기로 리사이즈(최대 1080px, jpeg)
export async function resizeImage(file, max = 1080) {
  try {
    const img = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    return await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
  } catch {
    return file;
  }
}

export async function uploadBoardImage(file) {
  const blob = file.type?.startsWith('image/') ? await resizeImage(file) : file;
  const fd = new FormData();
  fd.append('file', blob, 'img.jpg');
  const res = await fetch('/api/board-upload', { method: 'POST', headers: await authHeaders(), body: fd });
  if (!res.ok) throw new Error('이미지 업로드 실패');
  return (await res.json()).key;
}

export async function boardImageObjectUrl(key) {
  const res = await fetch(`/api/board-image?key=${encodeURIComponent(key)}`, { headers: await authHeaders() });
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
export const listPosts = (boardId, page = 0) =>
  supabase.from('board_post').select('*').eq('board_id', boardId)
    .order('created_at', { ascending: false }).range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
    .then((r) => r.data || []);
export const listHot = (page = 0) =>
  supabase.from('board_post').select('*').eq('hot', true)
    .order('created_at', { ascending: false }).range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
    .then((r) => r.data || []);
export const createPost = (boardId, title, content, password, imageKey) =>
  supabase.rpc('create_post', { p_board_id: boardId, p_title: title, p_content: content, p_password: password, p_image_key: imageKey || null }).then((r) => r.data);

// 즐겨찾기 / 활성화
export const listFavoriteIds = () =>
  supabase.from('board_favorite').select('board_id').then((r) => (r.data || []).map((x) => x.board_id));
export const addFavorite = (boardId) => supabase.auth.getUser().then(({ data }) =>
  supabase.from('board_favorite').insert({ cadet_id: data.user.id, board_id: boardId }));
export const removeFavorite = (boardId) => supabase.auth.getUser().then(({ data }) =>
  supabase.from('board_favorite').delete().match({ cadet_id: data.user.id, board_id: boardId }));
export const boardEnabled = () => supabase.rpc('board_enabled').then((r) => r.data !== false);
export const getPost = (id) => supabase.from('board_post').select('*').eq('id', id).maybeSingle().then((r) => r.data);
export const listComments = (postId) =>
  supabase.from('board_comment').select('*').eq('post_id', postId).order('created_at').then((r) => r.data || []);
export const react = (postId, kind) => supabase.rpc('board_react', { p_post_id: postId, p_kind: kind }).then((r) => r.data);
export const addComment = (postId, parentId, content, password) =>
  supabase.rpc('create_comment_b', { p_post_id: postId, p_parent: parentId || null, p_content: content, p_password: password }).then((r) => r.data);
export const deletePost = (id, password) => supabase.rpc('delete_post', { p_id: id, p_password: password });
export const deleteComment = (id, password) => supabase.rpc('delete_comment_b', { p_id: id, p_password: password });
