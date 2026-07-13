// =====================================================================
//  부팅 시 서버에서 한 번 읽는 값 묶음 (get_boot_info RPC)
//  - geo_valid_days  : 위치 재인증 유효기간
//  - catalog_version : 카탈로그 변경 일련번호(관리자가 강의 정보를 고칠 때마다 +1)
//  - board_enabled   : 익명게시판 전체 활성화(관리자 긴급 차단 스위치)
//  - share_enabled   : 공유링크 비회원 열람 허용
//  - review_min_days : 강의평 작성 자격 일수
//
//  요청을 새로 늘리지 않는 것이 요점이다. app_setting 한 행에서 나오는 값은 전부 여기에 싣는다.
//  이 자리가 없을 때는 화면마다 board_enabled()·get_review_min_days() 를 따로 불러
//  홈·게시판·메모에 들어갈 때마다 RPC 가 한 번씩 더 나갔다(가장 자주 열리는 화면들이라 합이 크다).
// =====================================================================
import { supabase } from '../supabase';

// 서버 응답 전(그리고 오프라인)에 쓰는 기본값. 게시판·공유는 '열림'이 기본이라 첫 화면이 깜빡이지 않는다.
export const BOOT_DEFAULTS = {
  geoValidDays: 90,
  catalogVersion: null,
  boardEnabled: true,
  shareEnabled: true,
  reviewMinDays: 30,
};

// 부팅 직후엔 useAuth 와 cache(콜드 동기화)가 거의 동시에 부른다 → 한 번만 나가게 묶는다.
let inFlight = null;

export function fetchBootInfo() {
  if (inFlight) return inFlight;
  inFlight = supabase
    .rpc('get_boot_info')
    .then(({ data }) => ({
      // 오프라인이면 supabase-js 가 throw 대신 data:null 을 준다 → 기본값으로 계속 굴러간다.
      geoValidDays: data?.geo_valid_days ?? BOOT_DEFAULTS.geoValidDays,
      catalogVersion: data?.catalog_version ?? BOOT_DEFAULTS.catalogVersion,
      boardEnabled: data?.board_enabled ?? BOOT_DEFAULTS.boardEnabled,
      shareEnabled: data?.share_enabled ?? BOOT_DEFAULTS.shareEnabled,
      reviewMinDays: data?.review_min_days ?? BOOT_DEFAULTS.reviewMinDays,
    }))
    .catch(() => BOOT_DEFAULTS)
    .finally(() => { inFlight = null; });
  return inFlight;
}
