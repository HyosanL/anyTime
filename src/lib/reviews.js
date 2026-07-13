// =====================================================================
//  강의평 조회 공통 (Reviews · ProfessorDetail)
//
//  예전엔 두 화면 모두 강의평 목록과 집계뷰(course_professor_rating)를 따로따로 받았다.
//  그런데 그 뷰가 계산하는 값(평점 5종·후기수·과락률)은 이미 받아 온 강의평 행들로 전부 나온다.
//  → 화면마다 요청 1회와 서버의 GROUP BY + 조인 2개가 통째로 없어진다.
//    (강의평은 가장 자주 열리는 화면이라 이 왕복이 그대로 비용이었다.)
// =====================================================================

// ⚠️ '*' 를 쓰지 않는다. 게시글 비밀번호(bcrypt)는 컬럼 권한으로 회수돼 있어 '*' 는 권한 오류가 나고,
//    무엇보다 해시를 목록마다 뿌리면 오프라인 크래킹으로 남의 글을 지울 수 있다.
//    삭제 UI 분기는 has_password(유도 컬럼)로 한다.
export const REVIEW_COLS = 'id, course_code, professor_code, overall, workload, progress, difficulty, '
  + 'class_time, prof_comment, course_comment, fail, teamplay, presentation, like_count, '
  + 'report_count, created_at, has_password';

// 한 과목·한 교수의 강의평을 무한정 받지 않는다(인기 과목은 계속 쌓인다).
// 최신 N개면 평점·과락률은 충분히 안정적이고, 응답 크기가 인기도에 비례해 커지지 않는다.
export const REVIEW_LIMIT = 200;

const avg = (rows, col) => {
  const vals = rows.map((r) => r[col]).filter((v) => v != null);   // 무응답(NULL)은 분모에서 뺀다
  return vals.length ? vals.reduce((a, b) => a + Number(b), 0) / vals.length : null;
};

// 강의평 행들을 keyOf(교수코드 또는 과목코드) 기준으로 묶어 집계.
// 서버 뷰(course_professor_rating)와 같은 값을 낸다 — fail 은 boolean 이라 평균이 곧 과락률.
export function summarize(reviews, keyOf) {
  const groups = new Map();
  for (const r of reviews) {
    const k = keyOf(r) ?? null;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.entries()]
    .map(([key, rows]) => ({
      key,
      review_count: rows.length,
      avg_overall: avg(rows, 'overall'),
      avg_workload: avg(rows, 'workload'),
      avg_progress: avg(rows, 'progress'),
      avg_difficulty: avg(rows, 'difficulty'),
      avg_class_time: avg(rows, 'class_time'),
      fail_ratio: avg(rows, 'fail') ?? 0,
    }))
    .sort((a, b) => b.review_count - a.review_count);
}
