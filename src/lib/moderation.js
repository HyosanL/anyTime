// =====================================================================
//  모더레이션: korcen(한국어 비속어 라이브러리) 위에 얹는 얇은 층.
//  역할 분담 ─ 검출은 korcen, 나머지는 여기:
//   • korcen.check()      : 비속어 검출(신조어·우회까지). 사전 관리는 korcen 몫.
//   • maskProfanity()     : 작성 시 ** 마스킹 (korcen은 마스킹 기능이 없음)
//   • NEGATIVE            : 비판성 부정어(최악 등) — 마스킹 X, 대시보드 강조만
//   • flagText/highlight  : 관리자 대시보드 표시
//  참고: https://github.com/KR-korcen/korcen.ts (Apache-2.0)
// =====================================================================
import { check as korcenCheck } from 'korcen';

function check(t) {
  try { return !!t && korcenCheck(t); } catch { return false; }
}

// 인라인 정밀 마스킹용 최소 셋(초성 등 붙여쓰기 형태). korcen은 위치를 안 주므로
// 정확히 그 부분만 가리려면 짧은 정규식이 필요. 그 외 신조어는 토큰검사가 보완.
const PROFANITY = ['ㅅㅂ', 'ㅆㅂ', 'ㅂㅅ', 'ㅄ', 'ㅈㄴ', 'ㅈㄹ', 'ㅁㅊ', 'ㅅㄲ', 'ㅗ'];
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
