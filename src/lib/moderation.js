// =====================================================================
//  모더레이션: korcen(신조어·우회까지 잡는 한국어 비속어 라이브러리) 기반
//  - 검출: korcen.check() — 게임/디스코드 봇 등에서 쓰는 최신 사전(우회·신조어 대응)
//  - 마스킹: 알려진 욕설 정규식 + 띄어쓰기 토큰별 korcen 검사 → ** 치환
//  - NEGATIVE: 비판성 부정어(최악 등)는 마스킹 안 함, 관리자 대시보드 강조만
//  참고: https://github.com/KR-korcen/korcen.ts (Apache-2.0)
// =====================================================================
import { check as korcenCheck } from 'korcen';

function check(t) {
  try { return !!t && korcenCheck(t); } catch { return false; }
}

// 빠른 인라인 마스킹용 대표 욕설(초성 포함). 세밀한 신조어는 korcen 토큰검사가 보완.
const PROFANITY = [
  '씨발', '시발', '씨바', '시바', '씨팔', '시팔', 'ㅅㅂ', 'ㅆㅂ',
  '병신', '븅신', 'ㅂㅅ', 'ㅄ', '존나', '졸라', 'ㅈㄴ', '좆', '좃', 'ㅈ같',
  '개새끼', '개새', '새끼', 'ㅅㄲ', '지랄', 'ㅈㄹ', '닥쳐', '꺼져', '엿먹',
  '미친놈', '미친년', '또라이', '등신', 'ㅁㅊ', 'ㅗ',
];
// 강조만(마스킹 X) — 비판성 부정 표현
export const NEGATIVE = [
  '최악', '쓰레기', '쓰렉', '극혐', '혐오', '토나', '재수없', '거지같',
  '노답', '답없', '갑질', '비하', '한심', '구리', '별로',
];

const ESC = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PROFANITY_RE = new RegExp(`(${PROFANITY.map(ESC).join('|')})`, 'gi');
const NEGATIVE_RE = new RegExp(`(${NEGATIVE.map(ESC).join('|')})`, 'gi');
const MASK_RUN = /\*{2,}/;
const star = (s) => '*'.repeat(Math.max(2, s.length));

// 글 작성 시 욕설 마스킹: 1) 알려진 욕설 정규식, 2) 공백 토큰별 korcen 검사
export function maskProfanity(text) {
  if (!text) return text;
  let out = text.replace(PROFANITY_RE, (m) => star(m));
  out = out
    .split(/(\s+)/)
    .map((tok) => (tok.trim() && !MASK_RUN.test(tok) && check(tok) ? star(tok) : tok))
    .join('');
  return out;
}

// 비속어 포함 여부 (korcen)
export function containsProfanity(text) {
  return check(text);
}

// 관리자 대시보드 플래그: 비속어(korcen) / 비판성 부정어 / 마스킹 흔적
export function flagText(text) {
  if (!text) return [];
  const found = new Set();
  let m;
  NEGATIVE_RE.lastIndex = 0;
  while ((m = NEGATIVE_RE.exec(text))) found.add(m[0]);
  if (check(text)) found.add('비속어');
  if (MASK_RUN.test(text)) found.add('검열됨');
  return [...found];
}

// 관리자 대시보드 강조 렌더용 조각 (부정어 + 마스킹 흔적)
export function highlightParts(text) {
  if (!text) return [];
  const re = new RegExp(`(${NEGATIVE.map(ESC).join('|')}|\\*{2,})`, 'gi');
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
