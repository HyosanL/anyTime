import { formatTimes } from './cache';

// 강의 정보 수정 제안(CorrectionModal)의 입력을 만드는 곳.
// 강의 검색·시간표 마법사가 함께 쓴다 — 어느 화면에서 🚩 를 눌러도 같은 항목·같은 대상 키가
// 나가야 하므로(대상 키가 어긋나면 관리자가 반영할 때 엉뚱한 분반이 고쳐진다) 한 군데에 둔다.

// 카탈로그 → 양식 빌더에 필요한 값. periods: 요일·교시 빌더의 교시 선택지, professors: 교수 검색 목록.
export function correctionMeta(catalog) {
  return {
    periods: [...(catalog?.period ?? [])].map((p) => p.no).sort((a, b) => a - b),
    professors: catalog?.professor ?? [],
  };
}

// 모달 머리에 뜨는 대상 이름 — "항공기상 3분반"
export const sectionSubject = (s) => `${s.course_name} ${s.section_no}분반`;

// 분반 하나에 대한 수정 제안 항목들(시간/강의실/교수/과목명).
// 시간·강의실은 section_time, 교수는 section, 과목명은 course 가 대상이다(schema.sql: correction).
export function sectionCorrectionOptions(s, meta) {
  const secKey = { course_code: s.course_code, year: s.year, term: s.term, section_no: s.section_no };
  return [
    { label: '요일·교시(시간)', target: 'section_time', targetKey: secKey, field: 'time', kind: 'time', periods: meta.periods, current: formatTimes(s.times) },
    { label: '강의실', target: 'section_time', targetKey: secKey, field: 'room', placeholder: '예: 302' },
    { label: '담당교수', target: 'section', targetKey: secKey, field: 'professor', kind: 'professor', professors: meta.professors, current: s.professor_name || '' },
    { label: '과목명', target: 'course', targetKey: { code: s.course_code }, field: 'name', current: s.course_name },
    // 이 과목에 '없는 분반'을 제안(분반번호·교수·시간·강의실). 승인/동일 3건↑ 자동반영 시 새 분반이 생성된다.
    // section_no 는 보내지 않는다(제안값 JSON 안에 분반번호가 들어간다) — 아직 없는 분반이므로 대상 키는 과목·학기까지만.
    { label: '＋ 없는 분반 추가 제안', target: 'section_add', targetKey: { course_code: s.course_code, year: s.year, term: s.term }, field: 'section', kind: 'sectionAdd', periods: meta.periods, professors: meta.professors },
  ];
}
