// =====================================================================
//  모더레이션: 비속어 부분 마스킹 + 검출
//  - maskProfanity: 욕설 "부분 문자열"만 *로 치환 ("시발교수" -> "**교수").
//    한국어/초성/숫자삽입/키보드로마자(tlqkf 등) 변칙도 사전에 포함.
//  - 검출(대시보드): 위 사전 + korcen(신조어 보강).
//  ※ 상시 금지어는 아래 MASK_WORDS/NEGATIVE, 운영 중 추가하는 금지어는
//    관리자 화면(관리자 > 금지어)에서 banned_word 테이블로 관리한다(loadBannedWords 로 병합).
// =====================================================================
import { check as korcenCheck } from 'korcen';
import { supabase } from '../supabase';
import { kvGet, kvSet } from './cache';
function kcheck(t) { try { return !!t && korcenCheck(t); } catch { return false; } }

// 마스킹 대상(부분 문자열). 길이만큼 *로 치환.
const MASK_WORDS = [
  // 시발 계열 + 변칙
  '시발', '씨발', '시바', '씨바', '시팔', '씨팔', '쉬발', '슈발', '시불', '씨불',
  '시1발', '씨1발', '시ㅂ', '씨ㅂ', 'ㅅ발', 'ㅅㅂ', 'ㅆㅂ', 'ㅅㅃ', 'tlqkf', 'tlqkn', 'siqkf', 'sibal', 'ㅅ1ㅂ',
  // 병신 계열
  '병신', '븅신', '빙신', 'ㅂㅅ', 'ㅄ', 'qudtls', 'byungsin',
  // 지랄
  '지랄', '지럴', 'ㅈㄹ',
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

// 관리자 금지어(banned_word). 런타임에 loadBannedWords 로 채워지며 마스킹 정규식에 병합된다.
let CUSTOM_WORDS = [];
// 긴 단어부터 매칭(부분 겹침 시 더 긴 욕설 우선). 내장 + 관리자 금지어를 합쳐 컴파일.
function buildMaskRe() {
  return new RegExp(
    `(${[...MASK_WORDS, ...CUSTOM_WORDS].sort((a, b) => b.length - a.length).map(ESC).join('|')})`, 'gi');
}
let MASK_RE = buildMaskRe();
const NEGATIVE_RE = new RegExp(`(${NEGATIVE.map(ESC).join('|')})`, 'gi');
const MASK_RUN = /\*{2,}/;

const CACHE_KEY = 'banned_words';

// 관리자 금지어를 반영(중복·공백 제거 후 정규식 재컴파일). 관리자 화면 편집 직후에도 호출 가능.
export function setBannedWords(words) {
  CUSTOM_WORDS = [...new Set((words || []).map((w) => String(w).trim()).filter(Boolean))];
  MASK_RE = buildMaskRe();
}

// 서버(banned_word)에서 금지어를 받아 마스킹에 반영. kv 캐시로 즉시(오프라인 포함) 적용 후 서버로 갱신.
// 작성 페이지(강의평·게시판·메모 등)가 로드될 때 이 모듈과 함께 자동 실행된다(하단 참조).
export async function loadBannedWords() {
  try {
    const cached = await kvGet(CACHE_KEY);
    if (Array.isArray(cached)) setBannedWords(cached);
  } catch { /* 캐시 실패 무시 */ }
  try {
    const { data, error } = await supabase.from('banned_word').select('word');
    if (!error && Array.isArray(data)) {
      const words = data.map((r) => r.word);
      setBannedWords(words);
      kvSet(CACHE_KEY, words);
    }
  } catch { /* 오프라인 등: 캐시/내장 목록으로 동작 */ }
}

// 이 모듈이 로드되는 시점(=작성 화면 진입)에 관리자 금지어를 미리 당겨온다.
// maskProfanity 는 제출 시 동기 호출되므로, 화면 진입~제출 사이에 로드가 끝나 반영된다.
loadBannedWords();

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
    `(${[...MASK_WORDS, ...CUSTOM_WORDS, ...NEGATIVE].sort((a, b) => b.length - a.length).map(ESC).join('|')}|\\*{2,})`, 'gi');
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
