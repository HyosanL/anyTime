import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';

// 관리자 작업은 모두 adminAction Cloud Function(커스텀 클레임 admin 검증)이 수행하고, 서버가 권한을 다시 검증한다.
// 관리자 허브(Admin)와 과목 전용 화면(AdminCourse)이 함께 쓴다.
export async function callAdmin(action, payload = {}) {
  try {
    const { data } = await httpsCallable(functions, 'adminAction')({ action, payload });
    return { ok: data?.status === 'OK', status: data?.status, data };
  } catch (e) {
    return { ok: false, status: e.code || 'ERROR', data: null };
  }
}

// 카탈로그(professor/semester/course/period/section/section_time) 테이블을 바꾸는 액션들.
// 이 액션이 성공했을 때만 로컬 카탈로그 캐시를 강제로 다시 받는다(그 외 액션은 캐시 유지).
export const CATALOG_ACTIONS = new Set([
  'set_period', 'delete_catalog', 'set_section', 'set_section_time',
  'set_course', 'add_course', 'set_professor', 'add_professor', 'set_semester',
  'set_common_block', 'merge_professors',
]);
