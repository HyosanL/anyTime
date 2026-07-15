// 시간표 공유(친구) — opt-in 공개 토글 + 팔로우 + 별칭.
// 조회는 SECURITY DEFINER RPC(공개 여부를 서버가 강제). 팔로우/별칭 쓰기는 tt_follow RLS(내 행만).
// 시간표 데이터는 텍스트라 작고, 갤러리는 한 번에 받아 캐시한다(무료 티어 egress 절감).
import { supabase } from '../supabase';

// 내 확정시간표 공개 on/off → 적용된 값 반환
export const setTtPublic = (on) =>
  supabase.rpc('set_tt_public', { p_on: !!on }).then((r) => { if (r.error) throw r.error; return r.data; });

// 공개한 사용자 아이디 검색 → [{ id, username, following }]
export const searchSharedUsers = (q) =>
  supabase.rpc('search_shared_users', { p_q: q || '' }).then((r) => r.data || []);

// 팔로우한 사람들의 확정시간표(공개인 경우만) → 갤러리 배열
// [{ followee_id, username, nickname, public, timetable:{id,year,term,name}|null, entries:[{section_id}], customs:[{id,title,day,startMin,endMin,room}] }]
export const getGallery = () =>
  supabase.rpc('get_shared_gallery').then((r) => r.data || []);

// 팔로우 / 언팔로우 / 별칭 — tt_follow(내 행만). uid = 내 세션 유저 id.
export const followUser = (uid, followeeId, nickname) =>
  supabase.from('tt_follow').insert({ follower_id: uid, followee_id: followeeId, nickname: nickname?.trim() || null });
export const unfollowUser = (uid, followeeId) =>
  supabase.from('tt_follow').delete().match({ follower_id: uid, followee_id: followeeId });
export const setNickname = (uid, followeeId, nickname) =>
  supabase.from('tt_follow').update({ nickname: nickname?.trim() || null }).match({ follower_id: uid, followee_id: followeeId });
// 넘긴 followee_id 배열 순서대로 갤러리 표시 순서를 재부여
export const reorderFollows = (ids) => supabase.rpc('reorder_follows', { p_ids: ids });
