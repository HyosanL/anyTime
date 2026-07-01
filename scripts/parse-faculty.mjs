// crawl/*.html (공사 통합포털 학과별 '교관소개' 저장본) → 교수 명단 추출.
// 각 교수 = <div id="contentsN"> 안의 table(thead: 이름/전공/E-mail/연구실/전화, tbody: 담당과목).
// 출력: crawl/professors.json (풍부한 원본) + db/seed_professors.sql (professor 테이블 시드).
// 의존성 없음(정규식). 실행: node scripts/parse-faculty.mjs
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRAWL = path.join(ROOT, 'crawl');

const deptFromFile = (fname) =>
  path.basename(fname, '.html').replace(/html$/i, '').replace(/[_\-\s]+$/, '').trim();

const decode = (s) =>
  String(s ?? '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
const stripTags = (s) => decode(String(s ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const clean = (s) => decode(String(s ?? '')).replace(/\s+/g, ' ').trim();

function firstField(block, re) {
  const m = block.match(re);
  return m ? clean(m[1]) : null;
}

// 이름 정규화: 괄호주석 제거 → 순수 한글이면 내부 공백 제거(외국인명은 공백 유지)
function normName(raw) {
  let s = clean(raw).split(/[(（]/)[0].trim();
  if (!s || /@|\.(?:jpg|jpeg|png|gif)|파일|그림/i.test(s)) return null; // alt/파일명 잔재 방어
  if (!/[A-Za-z]/.test(s)) s = s.replace(/\s+/g, '');
  return s || null;
}

function parseFile(rawHtml, dept) {
  const html = rawHtml
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<textarea[\s\S]*?<\/textarea>/gi, '') // 편집기 원본(이스케이프 중복) 제거
    .replace(/<img\b[^>]*>/gi, '') // 사진(base64/alt '파일 이름:') 제거
    .replace(/&nbsp;/g, ' '); // 콜론 앞 &nbsp; 제거(연구실 위치 : ...)
  const startRe = /<div id="contents(\d+)"[^>]*>/g;
  const starts = [];
  let m;
  while ((m = startRe.exec(html))) starts.push({ idx: m.index, n: Number(m[1]) });

  const out = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].idx;
    const to = i + 1 < starts.length ? starts[i + 1].idx : html.length;
    const block = html.slice(from, to); // contentsN (+뒤 editor은 이스케이프라 '첫 매치'가 항상 정답)

    // 라벨 '이름'/'이 름' 모두, 그리고 값 바로 뒤가 태그닫힘(</)이어야 함
    //  → VML 사진 alt("원본 그림의 이름: …(대위 임상민).jpg\r\n…")는 값 뒤가 \r 이라 제외됨
    const nameM = block.match(/이\s*름\s*[:：]\s*([^<\r\n]{1,40})<\//);
    const name = nameM ? normName(nameM[1]) : null;
    if (!name) continue;

    const emailM = block.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    const dutyM = block.match(/담당과목[\s\S]*?<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/);

    out.push({
      name,
      department: dept,
      major: firstField(block, /전공\s*[:：]\s*([^<\n]+)/),
      email: emailM ? emailM[0] : null,
      office: firstField(block, /연구실\s*위치[^:：<]*[:：]\s*([^<\n]+)/),
      phone: firstField(block, /전화번호\s*[:：]\s*([^<\n]+)/),
      courses: dutyM ? stripTags(dutyM[1]) : null,
      tab: starts[i].n,
    });
  }
  return out;
}

// ---- 실행 ----
const files = readdirSync(CRAWL).filter((f) => f.toLowerCase().endsWith('.html'));
const all = [];
const perDept = [];
for (const f of files.sort()) {
  const dept = deptFromFile(f);
  const rows = parseFile(readFileSync(path.join(CRAWL, f), 'utf8'), dept);
  perDept.push({ file: f, dept, count: rows.length });
  all.push(...rows);
}

// 중복 제거: (이름+학과) 기준
const seen = new Set();
const profs = [];
for (const p of all) {
  const key = `${p.name}|${p.department}`;
  if (seen.has(key)) continue;
  seen.add(key);
  profs.push(p);
}
// 정렬(학과→이름) 후 코드 P0001..
profs.sort((a, b) => a.department.localeCompare(b.department, 'ko') || a.name.localeCompare(b.name, 'ko'));
profs.forEach((p, i) => { p.code = `P${String(i + 1).padStart(4, '0')}`; });

// JSON
writeFileSync(path.join(CRAWL, 'professors.json'), JSON.stringify(profs, null, 2), 'utf8');

// SQL
const q = (s) => (s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
const values = profs.map((p) => `  (${q(p.code)}, ${q(p.name)}, ${q(p.department)})`).join(',\n');
const sql = `-- 자동 생성: scripts/parse-faculty.mjs  (crawl/*.html → professor 시드)
-- 실행: Supabase SQL Editor 에 통째로 Run.  ⚠️ db/schema.sql 전체 재실행 금지(cadet/auth 삭제됨).
BEGIN;

-- 1) 더미 강의 정보 제거.  course 삭제가 아래로 연쇄됨:
--    course → section → section_time / timetable / class_memo, 그리고 review(course_code)/exam_archive.
DELETE FROM course;
-- 더미 교수 제거(위 연쇄로 참조는 이미 정리됨)
DELETE FROM professor;

-- 2) 계급(title) 컬럼 삭제 (사용 안 함).  라이브: ALTER 만.
ALTER TABLE professor DROP COLUMN IF EXISTS title;

-- 3) 교수 ${profs.length}명 삽입 (code = P0001..)
INSERT INTO professor (code, name, department) VALUES
${values};

COMMIT;
`;
if (!existsSync(path.join(ROOT, 'db'))) mkdirSync(path.join(ROOT, 'db'));
writeFileSync(path.join(ROOT, 'db', 'seed_professors.sql'), sql, 'utf8');

// 리포트
console.log('=== 학과별 추출 수 ===');
for (const d of perDept) console.log(`${d.dept.padEnd(16)} ${d.count}  (${d.file})`);
console.log('---');
console.log(`총 rows=${all.length}, 중복제거 후=${profs.length}`);
console.log('빈 담당과목:', profs.filter((p) => !p.courses).length, '| 빈 이메일:', profs.filter((p) => !p.email).length);
console.log('출력: crawl/professors.json, db/seed_professors.sql');
