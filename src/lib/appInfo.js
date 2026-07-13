// =====================================================================
//  부팅 시 서버에서 한 번 읽는 값 묶음 (get_boot_info RPC)
//  - geo_valid_days  : 위치 재인증 유효기간
//  - catalog_version : 카탈로그 변경 일련번호(관리자가 강의 정보를 고칠 때마다 +1)
//
//  요청을 새로 늘리지 않는 것이 요점이다. 앱이 켜질 때 useAuth 가 어차피 부르던
//  get_geo_valid_days 자리를 그대로 쓰고, 응답에 숫자 하나(catalog_version)만 더 실었다.
// =====================================================================
import { supabase } from '../supabase';

const DEFAULTS = { geoValidDays: 90, catalogVersion: null };

// 부팅 직후엔 useAuth 와 cache(콜드 동기화)가 거의 동시에 부른다 → 한 번만 나가게 묶는다.
let inFlight = null;

export function fetchBootInfo() {
  if (inFlight) return inFlight;
  inFlight = supabase
    .rpc('get_boot_info')
    .then(({ data }) => ({
      // 오프라인이면 supabase-js 가 throw 대신 data:null 을 준다 → 기본값으로 계속 굴러간다.
      geoValidDays: data?.geo_valid_days ?? DEFAULTS.geoValidDays,
      catalogVersion: data?.catalog_version ?? DEFAULTS.catalogVersion,
    }))
    .catch(() => DEFAULTS)
    .finally(() => { inFlight = null; });
  return inFlight;
}
