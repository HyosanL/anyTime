import { formatTimes } from './cache';

// 강의 정보 수정 제안(CorrectionModal)의 입력을 만드는 곳.
// 강의 검색·시간표 마법사가 함께 쓴다 — 어느 화면에서 🚩 를 눌러도 같은 항목·같은 대상 키가
// 나가야 하므로(대상 키가 어긋나면 관리자가 반영할 때 엉뚱한 분반이 고쳐진다) 한 군데에 둔다.

// 카탈로그 → 양식 빌더에 필요한 값. periods: 요일·교시 빌더의 교시 선택지, professors: 교수 검색 목록,
// sections: 분반추가 제안에서 '이미 있는 분반번호'를 제외하는 데 쓴다.
export function correctionMeta(catalog) {
  return {
    periods: [...(catalog?.periods ?? [])].map((p) => p.no).sort((a, b) => a - b),
    professors: catalog?.professors ?? [],
    sections: catalog?.sections ?? [],
  };
}

// 모달 머리에 뜨는 대상 이름 — "항공기상 3분반"
export const sectionSubject = (s) => `${s.courseName} ${s.sectionNo}분반`;

// 분반 하나에 대한 수정 제안 항목들(시간/강의실/교수/과목명).
// 시간·강의실은 section_time, 교수는 section, 과목명은 course 가 대상이다
// (submitCorrection Cloud Function 의 target 분기 — firebase/functions/src/corrections.js).
// targetKey 는 그 함수가 그대로 읽는 필드명(courseCode/year/term/sectionNo)과 정확히 일치해야
// 한다 — 어긋나면 대상 키가 undefined 로 넘어가 제출이 조용히 실패(대상 키 오류)한다.
export function sectionCorrectionOptions(s, meta) {
  const secKey = { courseCode: s.courseCode, year: s.year, term: s.term, sectionNo: s.sectionNo };
  // 이 과목·학기에 이미 있는 분반번호 — 분반추가 제안에서 선택 못 하게 제외한다.
  const existingNos = (meta.sections ?? [])
    .filter((x) => x.courseCode === s.courseCode && x.year === s.year && x.term === s.term)
    .map((x) => x.sectionNo);
  return [
    // currentBlocks: 지금 등록된 시간(section 문서의 sectionTimes 원본, s.times 는 cache.js
    // buildSections 가 day/start 순으로 정렬해 붙여 둔 것) — 빌더가 이걸로 미리 채워야
    // 사람이 '틀린 한 줄'만 고치고 나머지는 그대로 제출한다. 안 채우면 매번 빈 칸에서
    // 새로 적어야 해서, 원래 맞던 요일·교시가 제안에서 통째로 빠지는 일이 잦았다.
    // CorrectionModal.rowsFromOption 은 이 배열 원소를 day_of_week/start_period/end_period 로
    // 읽는다(컴포넌트 쪽 계약, 이 파일 담당이 아니다) — 소스는 camelCase(dayOfWeek 등)라
    // 여기서 그 모양으로 변환해 건넨다.
    {
      label: '요일·교시(시간)', target: 'section_time', targetKey: secKey, field: 'time', kind: 'time',
      periods: meta.periods, current: formatTimes(s.times),
      currentBlocks: [...(s.times ?? [])]
        .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startPeriod - b.startPeriod)
        .map((t) => ({ day_of_week: t.dayOfWeek, start_period: t.startPeriod, end_period: t.endPeriod })),
    },
    { label: '강의실', target: 'section_time', targetKey: secKey, field: 'room', placeholder: '예: 302' },
    { label: '담당교수', target: 'section', targetKey: secKey, field: 'professor', kind: 'professor', professors: meta.professors, current: s.professorName || '' },
    { label: '과목명', target: 'course', targetKey: { code: s.courseCode }, field: 'name', current: s.courseName },
    // 이 과목에 '없는 분반'을 제안(분반번호·교수·시간 필수, 강의실 선택). 승인/동일 3건↑ 자동반영 시 새 분반 생성.
    // sectionNo 는 보내지 않는다(제안값 JSON 안에 분반번호가 들어간다) — 아직 없는 분반이므로 대상 키는 과목·학기까지만.
    { label: '＋ 없는 분반 추가 제안', target: 'section_add', targetKey: { courseCode: s.courseCode, year: s.year, term: s.term }, field: 'section', kind: 'sectionAdd', periods: meta.periods, professors: meta.professors, existingNos },
  ];
}
