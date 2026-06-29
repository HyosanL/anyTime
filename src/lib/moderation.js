// =====================================================================
//  모더레이션: 비속어 필터(게임 등에서 쓰는 방식) + 마스킹
//  - PROFANITY: 욕설/슬러 → 글 작성 시 자동 마스킹(**) + 관리자 강조
//  - NEGATIVE : 비판성 부정어 → 마스킹 안 함(의견), 관리자 대시보드에서 강조만
//  - 초성/변형(ㅅㅂ, ㅈㄴ, ㅄ ...)도 잡는다. 표준 한국어엔 단독 자음열이
//    거의 없어 오탐이 낮다.
//  ※ 운영하며 단어를 추가/수정하세요.
// =====================================================================

// 마스킹 + 강조 대상 (욕설·슬러)
export const PROFANITY = [
  // 씨발 계열
  '씨발', '시발', '씨바', '시바', '씨팔', '시팔', '씨불', '시불', '쓰발', '슈발',
  'ㅅㅂ', 'ㅆㅂ', 'ㅅ발', '씨1발', 'ㅅㅃ',
  // 병신 계열
  '병신', '븅신', '빙신', 'ㅂㅅ', 'ㅄ',
  // 존나/졸라
  '존나', '졸라', '존내', '죤나', 'ㅈㄴ',
  // 좆 계열
  '좆', '좃', '좇', '좆같', '좆까', 'ㅈ같', 'ㅈ까',
  // 개새끼/새끼
  '개새끼', '개새', '개색', '새끼', '쌔끼', '쉐끼', 'ㅅㄲ', '개ㅅㄲ',
  // 지랄
  '지랄', '지럴', 'ㅈㄹ',
  // 기타 욕설
  '미친놈', '미친년', '또라이', '등신', '멍청이', '꼴통', '빡대가리',
  '닥쳐', '꺼져', '엿먹', '뒤져', '꺼지', '디져', '족까',
  '느금', '니애미', '니미', '엠창', '창녀', '걸레',
  'ㅁㅊ', 'ㄷㅈ', 'ㅗ',
];

// 강조만(마스킹 X) — 비판성 부정 표현
export const NEGATIVE = [
  '최악', '쓰레기', '쓰렉', '극혐', '혐오', '토나', '토할', '재수없', '거지같',
  '노답', '답없', '갑질', '비하', '한심', '구리', '별로',
];

const ESC = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const reFrom = (list) => new RegExp(`(${list.map(ESC).join('|')})`, 'gi');

const PROFANITY_RE = reFrom(PROFANITY);
const ALL_RE = reFrom([...PROFANITY, ...NEGATIVE]);
const MASK_RUN = /\*{2,}/;

// 글 작성 시 욕설을 같은 길이의 *로 마스킹 (예: "ㅅㅂ" → "**")
export function maskProfanity(text) {
  if (!text) return text;
  return text.replace(PROFANITY_RE, (m) => '*'.repeat(Math.max(2, m.length)));
}

// 관리자 대시보드용 플래그: 부정/욕설 매칭 or 이미 마스킹된(**) 흔적
export function flagText(text) {
  if (!text) return [];
  const found = new Set();
  let m;
  ALL_RE.lastIndex = 0;
  while ((m = ALL_RE.exec(text))) found.add(m[0]);
  if (MASK_RUN.test(text)) found.add('검열됨');
  return [...found];
}

// 관리자 대시보드 강조 렌더용 조각
export function highlightParts(text) {
  if (!text) return [];
  const re = new RegExp(`(${[...PROFANITY, ...NEGATIVE].map(ESC).join('|')}|\\*{2,})`, 'gi');
  const parts = [];
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), bad: false });
    parts.push({ text: m[0], bad: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), bad: false });
  return parts;
}
