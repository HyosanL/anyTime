// =====================================================================
//  부팅 시 서버에서 한 번 읽는 값 묶음 (config/app 문서)
//  - geoValidDays  : 위치 재인증 유효기간
//  - catalogVersion: 카탈로그 변경 일련번호(관리자가 강의 정보를 고칠 때마다 +1)
//  - boardEnabled  : 익명게시판 전체 활성화(관리자 긴급 차단 스위치)
//  - reviewMinDays : 강의평 작성 자격 일수
//
//  요청을 새로 늘리지 않는 것이 요점이다. config/app 문서 하나에서 나오는 값은 전부 여기에 싣는다.
//  이 자리가 없을 때는 화면마다 board_enabled()·get_review_min_days() 를 따로 불러
//  홈·게시판·메모에 들어갈 때마다 RPC 가 한 번씩 더 나갔다(가장 자주 열리는 화면들이라 합이 크다).
//  get_boot_info() 는 Cloud Function 으로 포팅되지 않았다 — config/app 은 로그인 사용자면
//  누구나 읽을 수 있게 Rules 가 이미 열려 있어 직접 읽기로 충분하다(설계 문서 §3).
// =====================================================================
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';

// 서버 응답 전(그리고 오프라인)에 쓰는 기본값. 게시판은 '열림'이 기본이라 첫 화면이 깜빡이지 않는다.
export const BOOT_DEFAULTS = {
  geoValidDays: 90,
  catalogVersion: null,
  boardEnabled: true,
  reviewMinDays: 30,
};

// 부팅 직후엔 useAuth 와 cache(콜드 동기화)가 거의 동시에 부른다 → 한 번만 나가게 묶는다.
let inFlight = null;

export function fetchBootInfo() {
  if (inFlight) return inFlight;
  inFlight = getDoc(doc(db, 'config', 'app'))
    .then((snap) => {
      // 오프라인이면 getDoc 이 throw 한다 → 아래 catch 에서 기본값으로 계속 굴러간다.
      const data = snap.data();
      return {
        geoValidDays: data?.geoValidDays ?? BOOT_DEFAULTS.geoValidDays,
        catalogVersion: data?.catalogVersion ?? BOOT_DEFAULTS.catalogVersion,
        boardEnabled: data?.boardEnabled ?? BOOT_DEFAULTS.boardEnabled,
        reviewMinDays: data?.reviewMinDays ?? BOOT_DEFAULTS.reviewMinDays,
      };
    })
    .catch(() => BOOT_DEFAULTS)
    .finally(() => { inFlight = null; });
  return inFlight;
}
