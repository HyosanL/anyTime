// =====================================================================
//  모더레이션: 비속어 부분 마스킹 + 검출
//  - maskProfanity: 욕설 "부분 문자열"만 *로 치환 ("시발교수" -> "**교수").
//    한국어/초성/숫자삽입/키보드로마자(tlqkf 등) 변칙도 사전에 포함.
//  - 검출(대시보드): 위 사전 + korcen(신조어 보강).
//  ※ 단어는 운영하며 MASK_WORDS/NEGATIVE 에 계속 추가하세요.
// =====================================================================
import { check as korcenCheck } from 'korcen';
function kcheck(t) { try { return !!t && korcenCheck(t); } catch { return false; } }

// 마스킹 대상(부분 문자열). 길이만큼 *로 치환.
const MASK_WORDS = [
  // 시발 계열 + 변칙
  '시발', '씨발', '시바', '씨바', '시팔', '씨팔', '쉬발', '슈발', '시불', '씨불',
  '시1발', '씨1발', '시ㅂ', '씨ㅂ', 'ㅅ발', 'ㅅㅂ', 'ㅆㅂ', 'ㅅㅃ', 'tlqkf', 'tlqkn', 'siqkf', 'sibal', 'ㅅ1ㅂ',
  // 병신 계열
  '병신', '븅신', '빙신', 'ㅂㅅ', 'ㅄ', 'qudtls', 'byungsin',
  // 지랄
  '지랄', '지럴', 'ㅈㄹ', 'wlfkf',
  // 존나/졸라
  '존나', '졸라', '존내', '죤나', 'ㅈㄴ', 'whsk', 'jonna',
  // 좆 계열
  '좆', '좃', '좇', '좆같', '좆까', 'ㅈ같', 'ㅈ까',
  // 새끼/개새끼
  '개새끼', '개새', '개색', '새끼', '쌔끼', '쉐끼', 'ㅅㄲ', 'tofo',
  // 기타 욕설
  '미친놈', '미친년', '또라이', '등신', '멍청이', '꼴통', '빡대가리', 'ㅁㅊ',
  '닥쳐', '꺼져', '엿먹', '뒤져', '디져', '뒤질', '족까',
  '니미', '느금', '니애미', '엠창', '창녀', '걸레', '썅', '쌍놈',
  '좆밥', '개소리', '지랄',
  // 영문
  'fuck', 'shit', 'bitch', 'asshole',
];

export const NEGATIVE = [
  '최악', '쓰레기', '쓰렉', '극혐', '혐오', '토나', '재수없', '거지같',
  '노답', '답없', '갑질', '비하', '한심', '구리', '별로',
];

const ESC = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 긴 단어부터 매칭(부분 겹침 시 더 긴 욕설 우선)
const MASK_RE = new RegExp(
  `(${[...MASK_WORDS].sort((a, b) => b.length - a.length).map(ESC).join('|')})`, 'gi');
const NEGATIVE_RE = new RegExp(`(${NEGATIVE.map(ESC).join('|')})`, 'gi');
const MASK_RUN = /\*{2,}/;

// korcen 이 플래그한 토큰에서 "욕설 부분"만 찾아 마스킹(가장 짧은 비속어 substring부터).
function findBadSpan(w) {
  for (let len = 2; len <= w.length; len++) {
    for (let i = 0; i + len <= w.length; i++) {
      const s = w.slice(i, i + len);
      if (s.includes('*')) continue;
      if (kcheck(s)) return [i, len];
    }
  }
  return null;
}
function maskTokenByKorcen(tok) {
  let w = tok, guard = 0;
  while (kcheck(w) && guard++ < 12) {
    const span = findBadSpan(w);
    if (!span) break;
    w = w.slice(0, span[0]) + '*'.repeat(span[1]) + w.slice(span[0] + span[1]);
  }
  return w;
}

// 작성 시 욕설 "부분"만 마스킹.
//  1) 사전(빠르고 정확)  2) korcen 검출분(사전에 없어도 부분 마스킹: "싯팔교수" -> "**교수")
export function maskProfanity(text) {
  if (!text) return text;
  let out = text.replace(MASK_RE, (m) => '*'.repeat(m.length));
  if (!kcheck(out)) return out;
  return out
    .split(/(\s+)/)
    .map((tok) => (tok.trim() && kcheck(tok) ? maskTokenByKorcen(tok) : tok))
    .join('');
}

export function containsProfanity(text) {
  return MASK_RE.test(text) || kcheck(text);
}

// 관리자 대시보드 플래그
export function flagText(text) {
  if (!text) return [];
  const found = new Set();
  let m;
  MASK_RE.lastIndex = 0;
  while ((m = MASK_RE.exec(text))) found.add(m[0]);
  NEGATIVE_RE.lastIndex = 0;
  while ((m = NEGATIVE_RE.exec(text))) found.add(m[0]);
  if (kcheck(text)) found.add('비속어');
  if (MASK_RUN.test(text)) found.add('검열됨');
  return [...found];
}

// 대시보드 강조 조각(부정어 + 욕설 + 마스킹 흔적)
export function highlightParts(text) {
  if (!text) return [];
  const re = new RegExp(
    `(${[...MASK_WORDS, ...NEGATIVE].sort((a, b) => b.length - a.length).map(ESC).join('|')}|\\*{2,})`, 'gi');
  const parts = [];
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), bad: false });
    parts.push({ text: m[0], bad: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), bad: false });
  return parts;
}
