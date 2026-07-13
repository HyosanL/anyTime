import { supabase } from '../supabase';

// 관리자 작업은 모두 admin-action Edge Function(service-role)이 수행하고, 서버가 권한을 다시 검증한다.
// 관리자 허브(Admin)와 과목 전용 화면(AdminCourse)이 함께 쓴다.
export async function callAdmin(action, payload = {}) {
  const { data, error } = await supabase.functions.invoke('admin-action', { body: { action, payload } });
  let status = data?.status;
  if (error) { try { status = (await error.context?.json?.())?.status; } catch { /* ignore */ } }
  return { ok: status === 'OK', status, data };
}

// 카탈로그(professor/semester/course/period/section/section_time) 테이블을 바꾸는 액션들.
// 이 액션이 성공했을 때만 로컬 카탈로그 캐시를 강제로 다시 받는다(그 외 액션은 캐시 유지).
export const CATALOG_ACTIONS = new Set([
  'set_period', 'delete_catalog', 'set_section', 'set_section_time',
  'set_course', 'add_course', 'set_professor', 'add_professor', 'set_semester',
  'set_common_block', 'merge_professors',
]);
