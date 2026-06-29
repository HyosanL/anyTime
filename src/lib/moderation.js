// =====================================================================
//  모더레이션: 부정/욕설 언어 탐지 (관리자 대시보드용)
//  - flagText(text): 매칭된 금지어 배열 반환(없으면 [])
//  - highlightParts(text): [{ text, bad }] 조각 배열 → <mark> 렌더용
//  ※ 운영하며 단어를 추가/수정하세요. 과탐을 줄이려고 보수적으로 시작.
// =====================================================================
export const BAD_WORDS = [
  // 욕설
  '씨발', '씨바', '시발', '시바', '병신', '븅신', '지랄', '개새', '개색', '새끼',
  '좆', '좃', '꺼져', '닥쳐', '엿먹', '미친', '또라이', '등신', '멍청', '죽어',
  '꼴통', '빡대가리', '한심', '쓰레기', '존나', '존내', '졸라',
  // 강한 부정/공격
  '최악', '쓰렉', '극혐', '혐오', '토나', '재수없', '거지같', '노답', '답없',
  '갑질', '무시', '비하',
];

const ESC = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RE = new RegExp(`(${BAD_WORDS.map(ESC).join('|')})`, 'gi');

export function flagText(text) {
  if (!text) return [];
  const found = new Set();
  let m;
  RE.lastIndex = 0;
  while ((m = RE.exec(text))) found.add(m[0]);
  return [...found];
}

// 텍스트를 [{text, bad}] 조각으로 분해 (강조 렌더용)
export function highlightParts(text) {
  if (!text) return [];
  const parts = [];
  let last = 0;
  let m;
  RE.lastIndex = 0;
  while ((m = RE.exec(text))) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), bad: false });
    parts.push({ text: m[0], bad: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), bad: false });
  return parts;
}
