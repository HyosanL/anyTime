// lib/syllabus.js(무거움 — pdfjs 등을 동적 import 하는 화면에서만 로드됨)와
// components/SyllabusUpload.jsx(항상 로드됨) 양쪽이 함께 쓰는 가벼운 순수 함수만 모아 둔다.
// 여기서 lib/syllabus.js 를 (역)import 하면 정적 import 경로가 생겨 무거운 의존성이
// 관리자 화면 밖으로 새어나가므로 절대 하지 않는다.

// '빈 칸만 채우기' 대상 판정 — DB 에 이미 없던 값(교수/강의실)을 이 편람이 채울 수 있는 분반.
// reconcile() 의 통계와 SyllabusUpload 의 "미입력만 보기" 필터가 같은 기준을 쓰도록 여기서 하나로 둔다.
export function isFillableSection(s) {
  return !!s.reused && ((!!s.professorName && !s.dbHasProfessor) || (!!s.room && !s.dbHasRoom));
}
