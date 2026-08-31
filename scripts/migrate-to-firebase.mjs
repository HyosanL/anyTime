// Supabase(Postgres+Auth) → Firebase(Firestore+Auth) 1회성 컷오버 스크립트.
// docs/superpowers/specs/2026-08-31-firebase-migration-design.md §3(컬렉션 지도)·§6(이관 절차) 구현.
//
// ⚠️ 실사용자 PII(생도 계정·비밀번호 해시)를 다룬다. 사용자의 명시적 지시 없이 실행 금지.
//    반드시 --dry-run 으로 먼저 리허설 → 실제 실행은 컷오버 시점에만.
//
// 실행: node scripts/migrate-to-firebase.mjs [--only=cadet,timetable] [--dry-run]
// 필요 환경변수: DATABASE_URL, FIREBASE_SERVICE_ACCOUNT_PATH (scripts/README-migration.md 참고)
//
// 설계 원칙(코드 전체에 일관 적용, 표 어느 컬럼을 만나든 아래 규칙을 그대로 따른다):
//  · NULL 정책: Postgres NULL 은 필드를 생략하지 않고 Firestore 에 명시적 null 로 쓴다.
//    (생략하면 향후 Cloud Functions 가 `where('x','==',null)` 로 "미정" 을 쿼리할 수 없다 —
//     Firestore 는 필드가 아예 없는 문서를 null-equality 쿼리에 매칭하지 않는다.)
//  · 컬럼명: snake_case → camelCase. 복합키(연도·학기 등)는 문서ID 에 인코딩돼 있어도
//    쿼리 편의를 위해 필드로도 중복 저장한다. 단일 자연키(professor.code 등)는 문서ID 가
//    곧 그 값이므로 필드로 중복하지 않는다(설계문서 "대리키 제거" 원칙의 연장).
//  · 대체키 제거: BIGINT surrogate id(section.id 등)는 옮기지 않는다 — 문서ID(자연키 조합)가
//    그 역할을 겸한다. BIGINT id 만 있고 자연키가 없는 표(review.id 등)는 String(id) 를 문서ID 로.
//  · 멱등성: 전부 결정론적 문서ID + bulkWriter.set()(덮어쓰기) 사용. create() 는 쓰지 않는다 —
//    리허설을 여러 번 돌려도 중복이 생기지 않는다(요구사항 5).
//  · 비밀번호 해시(post_password_hash)는 절대 공개 문서 필드로 두지 않는다 — {doc}/_private/auth
//    서브컬렉션 문서로 물리 분리(설계문서 §4). 클라이언트 Rules 는 이 서브컬렉션을 항상 거부해야 한다.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const { Client } = pg;

const PROGRESS_EVERY = 500;     // 이 건수마다 진행상황 로그(장시간 실행 가시성용)
const AUTH_IMPORT_BATCH = 1000; // Firebase importUsers 1회 호출 상한

// ── 소소한 변환 헬퍼 ────────────────────────────────────────────────
// Postgres BIGINT/NUMERIC 은 node-postgres 가 정밀도 보존을 위해 문자열로 돌려준다 →
// Firestore 필드는 실제 number 여야 하므로 명시 변환한다(문서ID 로 쓸 String(id) 와는 별개).
const num = (v) => (v == null ? null : Number(v));
// TIMESTAMPTZ(JS Date) → Firestore Timestamp. TIME 컬럼(period.start_time 등)은 여기 넣지 않는다(문자열 그대로).
const ts = (v) => (v == null ? null : Timestamp.fromDate(v));

function sectionKey(courseCode, year, term, sectionNo) {
  return `${courseCode}_${year}_${term}_${sectionNo}`;
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

// Firestore 문서ID 로 쓰기 위험한 값 방어(banned_word.word 처럼 자연문자열을 ID 로 쓰는 경우만 해당).
function isUnsafeDocId(id) {
  return !id || id === '.' || id === '..' || id.includes('/') || /^__.*__$/.test(id)
    || Buffer.byteLength(id, 'utf8') > 1500;
}

// section.id(BIGINT surrogate) → sectionKey 역방향 맵. timetable_entry.section_id 를
// users/{uid}/timetables/{id}/entries/{sectionKey} 로 재작성하는 데 필요.
// 'section' 테이블 그룹 자체가 이번 실행(--only)에 없어도 항상 새로 조회한다(디커플링).
async function loadSectionIdMap(pgc) {
  const { rows } = await pgc.query('SELECT id, course_code, year, term, section_no FROM section');
  const map = new Map();
  for (const r of rows) map.set(String(r.id), sectionKey(r.course_code, r.year, r.term, r.section_no));
  return map;
}

// 테이블별 migrate() 안에서 공통으로 쓰는 쓰기 래퍼: dry-run 이면 카운트만, 아니면 bulkWriter 로 위임.
// (실제 bulkWriter 에러 수집은 main() 에서 onWriteError 로 전역 처리 — 여기선 진행률만 책임진다.)
function makeWriter(name, { bulkWriter, dryRun, counts }) {
  return {
    set(ref, data) {
      counts[name] = (counts[name] || 0) + 1;
      if (counts[name] % PROGRESS_EVERY === 0) console.log(`  [${name}] ${counts[name]}건 처리 중...`);
      if (!dryRun) bulkWriter.set(ref, data).catch(() => { /* onWriteError 에서 이미 로그됨 */ });
    },
  };
}


// =====================================================================
//  Auth 이관 — auth.users → Firebase Auth (uid 보존 + bcrypt 해시 그대로)
//  설계문서 §6-1,2 / §2 "UID 보존"·"비밀번호 이전".
// =====================================================================
async function migrateAuthUsers(pgc, auth, dryRun) {
  console.log(`\n--- [auth] auth.users → Firebase Auth ${dryRun ? '(dry-run)' : ''} ---`);
  // auth 스키마는 public 이 아니라 직접 SELECT(raw SQL) 로만 읽힌다.
  const { rows } = await pgc.query('SELECT id, email, encrypted_password, banned_until FROM auth.users');
  console.log(`[auth] Postgres 에서 ${rows.length}명 조회`);

  let imported = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i += AUTH_IMPORT_BATCH) {
    const batch = rows.slice(i, i + AUTH_IMPORT_BATCH);
    const batchNo = Math.floor(i / AUTH_IMPORT_BATCH) + 1;
    if (dryRun) {
      console.log(`[auth] (dry-run) 배치 ${batchNo}: ${batch.length}명 import 예정`);
      continue;
    }
    const users = batch.map((r) => ({
      uid: r.id,                                             // Supabase auth.users.id(UUID) 그대로 재사용
      email: r.email,
      passwordHash: Buffer.from(r.encrypted_password, 'utf8'), // GoTrue bcrypt 해시를 그대로
      emailVerified: true,                                    // 합성 이메일이라 이미 검증된 것으로 취급
      disabled: !!(r.banned_until && new Date(r.banned_until) > new Date()),
    }));
    const result = await auth.importUsers(users, { hash: { algorithm: 'BCRYPT' } });
    imported += result.successCount;
    // 배치 하나가 실패해도 전체를 중단하지 않는다 — 실패 건만 모아 마지막에 보고.
    for (const e of result.errors) {
      const row = batch[e.index];
      errors.push({ batch: batchNo, uid: row?.id, email: row?.email, message: e.error?.message });
    }
    console.log(`[auth] 배치 ${batchNo}: 성공 ${result.successCount} / 실패 ${result.errors.length}`);
  }
  if (!dryRun) console.log(`[auth] 총 ${imported}/${rows.length}명 이관 완료`);
  if (errors.length) {
    console.log(`[auth] ⚠️ 실패 ${errors.length}건:`);
    errors.forEach((e) => console.log(`  - batch${e.batch} uid=${e.uid} email=${e.email}: ${e.message}`));
  }
}


// =====================================================================
//  테이블 그룹 (설계문서 §3 순서 그대로) — 각 항목이 Postgres 원본 표 이름을
//  CLI --only 값으로 쓴다. 부모(cadet/section)가 --only 에서 빠져도 자식(timetable 등)이
//  단독 실행될 수 있도록, FK 조회가 필요한 곳은 매번 Postgres 에서 새로 읽는다(캐시 공유 안 함).
// =====================================================================
const TABLES = [
  // ── config: app_setting(공개/비공개 분리) + push_config(팬아웃 시크릿) ──
  {
    name: 'config',
    migrate: async ({ pg: pgc, db, writer }) => {
      const [{ rows: settingRows }, { rows: pushRows }] = await Promise.all([
        pgc.query('SELECT * FROM app_setting WHERE id = 1'),
        pgc.query('SELECT * FROM push_config WHERE id = 1'),
      ]);
      const s = settingRows[0];
      const pc = pushRows[0];
      if (!s) { console.log('  [config] app_setting 행이 없어 건너뜀'); return; }
      // 공개 설정 — 설계문서에 명시된 6개 필드만(§3).
      writer.set(db.collection('config').doc('app'), {
        catalogVersion: num(s.catalog_version),
        boardEnabled: s.board_enabled,
        shareEnabled: s.share_enabled,
        reviewMinDays: num(s.review_min_days),
        hotThreshold: num(s.hot_threshold),
        geoValidDays: num(s.geo_valid_days),
      });
      // 비공개 — 가입코드·지오펜싱 좌표·신고 임계치·솔트·푸시 팬아웃 시크릿 등 나머지 전부.
      // 클라이언트 Rules: allow read,write: if false (Cloud Functions 만 접근).
      writer.set(db.collection('config').doc('secrets'), {
        signupCode: s.signup_code,
        campusLat: s.campus_lat,
        campusLng: s.campus_lng,
        radiusM: num(s.radius_m),
        accountDeleteDays: num(s.account_delete_days),
        reportDeleteCount: num(s.report_delete_count),
        reportBurstCount: num(s.report_burst_count),
        reportSalt: s.report_salt,
        modReviewedAt: ts(s.mod_reviewed_at),
        professorsSyncedAt: ts(s.professors_synced_at),
        pushFanoutSecret: pc ? pc.fanout_secret : null,
      });
    },
  },

  // ── 2장 기준정보 ──
  {
    name: 'professor',
    migrate: async ({ pg: pgc, db, writer }) => {
      const { rows } = await pgc.query('SELECT code, name, department, office FROM professor');
      for (const r of rows) {
        writer.set(db.collection('professors').doc(r.code), {
          name: r.name, department: r.department, office: r.office,
        });
      }
    },
  },
  {
    name: 'semester',
    migrate: async ({ pg: pgc, db, writer }) => {
      const { rows } = await pgc.query('SELECT year, term, is_current FROM semester');
      for (const r of rows) {
        writer.set(db.collection('semesters').doc(`${r.year}_${r.term}`), {
          year: r.year, term: r.term, isCurrent: r.is_current,
        });
      }
    },
  },
  {
    name: 'course',
    migrate: async ({ pg: pgc, db, writer }) => {
      const { rows } = await pgc.query('SELECT code, name, department FROM course');
      for (const r of rows) {
        writer.set(db.collection('courses').doc(r.code), { name: r.name, department: r.department });
      }
    },
  },
  {
    name: 'period',
    migrate: async ({ pg: pgc, db, writer }) => {
      const { rows } = await pgc.query('SELECT no, start_time, end_time FROM period');
      for (const r of rows) {
        // TIME 컬럼은 pg 가 'HH:MM:SS' 문자열로 돌려준다 — 그대로 저장(Firestore 엔 TIME 전용 타입이 없음).
        writer.set(db.collection('periods').doc(String(r.no)), {
          no: r.no, startTime: r.start_time, endTime: r.end_time,
        });
      }
    },
  },
  {
    name: 'common_block',
    migrate: async ({ pg: pgc, db, writer }) => {
      const { rows } = await pgc.query(
        'SELECT year, term, day_of_week, start_period, end_period, label FROM common_block'
      );
      for (const r of rows) {
        const id = `${r.year}_${r.term}_${r.day_of_week}_${r.start_period}`;
        writer.set(db.collection('commonBlocks').doc(id), {
          year: r.year, term: r.term, dayOfWeek: r.day_of_week,
          startPeriod: r.start_period, endPeriod: r.end_period, label: r.label,
        });
      }
    },
  },

  // ── 3장 분반·강의시간: section_time 은 별도 컬렉션이 아니라 sectionTimes 배열 필드로 임베드 ──
  {
    name: 'section',
    migrate: async ({ pg: pgc, db, writer }) => {
      const [{ rows: sections }, { rows: times }] = await Promise.all([
        pgc.query('SELECT id, course_code, year, term, section_no, professor_code FROM section'),
        pgc.query(
          `SELECT course_code, year, term, section_no, day_of_week, start_period, end_period, room
             FROM section_time ORDER BY course_code, year, term, section_no, day_of_week, start_period`
        ),
      ]);
      const timesByKey = groupBy(times, (t) => sectionKey(t.course_code, t.year, t.term, t.section_no));
      for (const s of sections) {
        const key = sectionKey(s.course_code, s.year, s.term, s.section_no);
        const sectionTimes = (timesByKey.get(key) || []).map((t) => ({
          dayOfWeek: t.day_of_week, startPeriod: t.start_period, endPeriod: t.end_period, room: t.room,
        }));
        writer.set(db.collection('sections').doc(key), {
          courseCode: s.course_code, year: s.year, term: s.term, sectionNo: s.section_no,
          professorCode: s.professor_code, sectionTimes,
        });
      }
    },
  },

  // ── 1장 회원: cadet → /users/{uid}. 관리자 커스텀 클레임도 여기서 함께(요구사항 3). ──
  {
    name: 'cadet',
    migrate: async ({ pg: pgc, db, writer, auth, dryRun }) => {
      const { rows } = await pgc.query(
        'SELECT id, username, post_count, is_admin, tt_public, geo_verified_at, created_at FROM cadet'
      );
      for (const r of rows) {
        writer.set(db.collection('users').doc(r.id), {
          username: r.username,
          postCount: num(r.post_count),
          isAdmin: r.is_admin,
          ttPublic: r.tt_public,
          geoVerifiedAt: ts(r.geo_verified_at),
          createdAt: ts(r.created_at),
        });
      }
      // 관리자 커스텀 클레임 — Firestore isAdmin 필드와 별개로 Auth 토큰(request.auth.token.admin)에도
      // 심어야 Cloud Functions 의 requireAdmin() 이 동작한다. is_admin=true 인 계정만, Postgres 값을 그대로.
      const admins = rows.filter((r) => r.is_admin);
      if (dryRun) {
        console.log(`  [cadet] (dry-run) 관리자 커스텀 클레임 ${admins.length}건 설정 예정`);
        return;
      }
      let claimErrors = 0;
      for (const r of admins) {
        try {
          await auth.setCustomUserClaims(r.id, { admin: true });
        } catch (err) {
          claimErrors += 1;
          console.error(`  [cadet] ⚠️ 커스텀 클레임 실패 uid=${r.id}: ${err.message}`);
        }
      }
      console.log(`  [cadet] 관리자 커스텀 클레임 ${admins.length - claimErrors}/${admins.length}건 설정 완료`);
    },
  },

  // ── 4장 시간표: timetable + timetable_entry + custom_class → users/{uid}/timetables/{id}/... ──
  {
    name: 'timetable',
    migrate: async ({ pg: pgc, db, writer }) => {
      const sectionIdMap = await loadSectionIdMap(pgc);

      const { rows: timetables } = await pgc.query(
        'SELECT id, cadet_id, year, term, name, is_primary, created_at FROM timetable'
      );
      for (const t of timetables) {
        writer.set(db.collection('users').doc(t.cadet_id).collection('timetables').doc(String(t.id)), {
          year: t.year, term: t.term, name: t.name, isPrimary: t.is_primary, createdAt: ts(t.created_at),
        });
      }

      const { rows: entries } = await pgc.query(
        `SELECT te.timetable_id, te.section_id, te.created_at, t.cadet_id
           FROM timetable_entry te JOIN timetable t ON t.id = te.timetable_id`
      );
      for (const e of entries) {
        const key = sectionIdMap.get(String(e.section_id));
        if (!key) { console.warn(`  [timetable] ⚠️ section_id=${e.section_id} 를 찾을 수 없어 entry 건너뜀`); continue; }
        writer.set(
          db.collection('users').doc(e.cadet_id).collection('timetables').doc(String(e.timetable_id))
            .collection('entries').doc(key),
          { createdAt: ts(e.created_at) }   // 강의평 자격(N일 보유) 판정 기준
        );
      }

      const { rows: customs } = await pgc.query(
        `SELECT cc.id, cc.timetable_id, cc.title, cc.day_of_week, cc.start_min, cc.end_min, cc.room,
                cc.created_at, t.cadet_id
           FROM custom_class cc JOIN timetable t ON t.id = cc.timetable_id`
      );
      for (const c of customs) {
        writer.set(
          db.collection('users').doc(c.cadet_id).collection('timetables').doc(String(c.timetable_id))
            .collection('customClasses').doc(String(c.id)),
          {
            title: c.title, dayOfWeek: c.day_of_week, startMin: c.start_min, endMin: c.end_min,
            room: c.room, createdAt: ts(c.created_at),
          }
        );
      }
    },
  },
  {
    name: 'grade_entry',
    migrate: async ({ pg: pgc, db, writer }) => {
      const { rows } = await pgc.query(
        'SELECT id, cadet_id, year, term, course_name, credit, grade, sort_order, created_at FROM grade_entry'
      );
      for (const r of rows) {
        writer.set(db.collection('users').doc(r.cadet_id).collection('gradeEntries').doc(String(r.id)), {
          year: r.year, term: r.term, courseName: r.course_name,
          credit: num(r.credit),        // NULL=미입력(원본 주석 그대로 유지)
          grade: r.grade,               // NULL=미입력
          sortOrder: r.sort_order, createdAt: ts(r.created_at),
        });
      }
    },
  },
  {
    name: 'rank_entry',
    migrate: async ({ pg: pgc, db, writer }) => {
      const { rows } = await pgc.query(
        `SELECT cadet_id, year, term, academic_rank, academic_total, training_rank, training_total, created_at
           FROM rank_entry`
      );
      for (const r of rows) {
        writer.set(db.collection('users').doc(r.cadet_id).collection('rankEntries').doc(`${r.year}_${r.term}`), {
          year: r.year, term: r.term,
          academicRank: r.academic_rank, academicTotal: r.academic_total,
          trainingRank: r.training_rank, trainingTotal: r.training_total,
          createdAt: ts(r.created_at),
        });
      }
    },
  },
  {
    name: 'tt_follow',
    migrate: async ({ pg: pgc, db, writer }) => {
      const { rows } = await pgc.query(
        'SELECT follower_id, followee_id, nickname, sort_order, created_at FROM tt_follow'
      );
      for (const r of rows) {
        writer.set(db.collection('users').doc(r.follower_id).collection('follows').doc(r.followee_id), {
          nickname: r.nickname, sortOrder: r.sort_order, createdAt: ts(r.created_at),
        });
      }
    },
  },
  {
    name: 'board_favorite',
    migrate: async ({ pg: pgc, db, writer }) => {
      const { rows } = await pgc.query('SELECT cadet_id, board_id FROM board_favorite');
      // 원본 표엔 (cadet_id, board_id) 복합PK 뿐, 추가 컬럼 없음 — 문서 존재 자체가 신호.
      for (const r of rows) {
        writer.set(
          db.collection('users').doc(r.cadet_id).collection('favoriteBoards').doc(String(r.board_id)),
          { favorited: true }
        );
      }
    },
  },

  // ── 5장 강의평: review + review_report → reviews/{id} (+_private/auth, +reactions) ──
  {
    name: 'review',
    migrate: async ({ pg: pgc, db, writer }) => {
      const { rows } = await pgc.query(
        `SELECT id, course_code, professor_code, overall, workload, progress, difficulty, class_time,
                prof_comment, course_comment, fail, teamplay, presentation, like_count, report_count,
                report_reviewed_count, post_password_hash, created_at
           FROM review`
      );
      for (const r of rows) {
        const ref = db.collection('reviews').doc(String(r.id));
        writer.set(ref, {
          courseCode: r.course_code, professorCode: r.professor_code,
          overall: r.overall, workload: r.workload, progress: r.progress,
          difficulty: r.difficulty, classTime: r.class_time,
          profComment: r.prof_comment, courseComment: r.course_comment,
          fail: r.fail, teamplay: r.teamplay, presentation: r.presentation,
          likeCount: num(r.like_count), reportCount: num(r.report_count),
          reportReviewedCount: num(r.report_reviewed_count),
          hasPassword: r.post_password_hash != null,
          createdAt: ts(r.created_at),
        });
        writer.set(ref.collection('_private').doc('auth'), { postPasswordHash: r.post_password_hash });
      }

      const { rows: reports } = await pgc.query('SELECT review_id, reporter_hash, created_at FROM review_report');
      for (const r of reports) {
        writer.set(
          db.collection('reviews').doc(String(r.review_id)).collection('reactions').doc(r.reporter_hash),
          { kind: 'report', createdAt: ts(r.created_at) }
        );
      }
    },
  },

  // ── 6장 족보: exam_archive + exam_file → examArchive/{id} (files 배열 임베드) ──
  {
    name: 'exam_archive',
    migrate: async ({ pg: pgc, db, writer }) => {
      const [{ rows: exams }, { rows: files }] = await Promise.all([
        pgc.query(
          `SELECT id, course_code, src_year, src_term, title, exam_type, description,
                  post_password_hash, created_at
             FROM exam_archive`
        ),
        pgc.query(
          'SELECT exam_id, seq, object_key, file_name, file_size, mime_type FROM exam_file ORDER BY exam_id, seq'
        ),
      ]);
      const filesByExam = groupBy(files, (f) => String(f.exam_id));
      for (const e of exams) {
        const ref = db.collection('examArchive').doc(String(e.id));
        const fileList = (filesByExam.get(String(e.id)) || []).map((f) => ({
          seq: f.seq, objectKey: f.object_key, fileName: f.file_name,
          fileSize: num(f.file_size), mimeType: f.mime_type,
        }));
        writer.set(ref, {
          courseCode: e.course_code, srcYear: e.src_year, srcTerm: e.src_term,
          title: e.title, examType: e.exam_type, description: e.description,
          hasPassword: e.post_password_hash != null, createdAt: ts(e.created_at),
          files: fileList,
        });
        writer.set(ref.collection('_private').doc('auth'), { postPasswordHash: e.post_password_hash });
      }
    },
  },

  // ── 7장 강의메모: class_memo + memo_report → classMemos/{id} ──
  {
    name: 'class_memo',
    migrate: async ({ pg: pgc, db, writer }) => {
      const { rows } = await pgc.query(
        `SELECT id, course_code, year, term, section_no, content, report_count,
                report_reviewed_count, post_password_hash, created_at
           FROM class_memo`
      );
      for (const r of rows) {
        const ref = db.collection('classMemos').doc(String(r.id));
        writer.set(ref, {
          courseCode: r.course_code, year: r.year, term: r.term, sectionNo: r.section_no,
          content: r.content, reportCount: num(r.report_count),
          reportReviewedCount: num(r.report_reviewed_count),
          hasPassword: r.post_password_hash != null, createdAt: ts(r.created_at),
        });
        writer.set(ref.collection('_private').doc('auth'), { postPasswordHash: r.post_password_hash });
      }

      const { rows: reports } = await pgc.query('SELECT memo_id, reporter_hash, created_at FROM memo_report');
      for (const r of reports) {
        writer.set(
          db.collection('classMemos').doc(String(r.memo_id)).collection('reactions').doc(r.reporter_hash),
          { kind: 'report', createdAt: ts(r.created_at) }
        );
      }
    },
  },

  // ── 수정 제안: correction → corrections/{id} (전부 Rules 로 차단, Cloud Functions 전용) ──
  {
    name: 'correction',
    migrate: async ({ pg: pgc, db, writer }) => {
      const { rows } = await pgc.query(
        `SELECT id, target, professor_code, course_code, year, term, section_no, label, field,
                suggested, note, status, auto_applied, prev_value, created_at
           FROM correction`
      );
      for (const r of rows) {
        writer.set(db.collection('corrections').doc(String(r.id)), {
          target: r.target, professorCode: r.professor_code, courseCode: r.course_code,
          year: r.year, term: r.term, sectionNo: r.section_no, label: r.label, field: r.field,
          suggested: r.suggested, note: r.note, status: r.status, autoApplied: r.auto_applied,
          prevValue: r.prev_value, createdAt: ts(r.created_at),
        });
      }
    },
  },

  // ── 익명게시판 ──
  {
    name: 'board',
    migrate: async ({ pg: pgc, db, writer }) => {
      const { rows } = await pgc.query('SELECT id, name, created_at, last_activity_at FROM board');
      for (const r of rows) {
        writer.set(db.collection('boards').doc(String(r.id)), {
          name: r.name, createdAt: ts(r.created_at), lastActivityAt: ts(r.last_activity_at),
        });
      }
    },
  },
  {
    // board_post + board_post_image(임베드 배열) + board_share(shareToken 필드)
    name: 'board_post',
    migrate: async ({ pg: pgc, db, writer }) => {
      const [{ rows: posts }, { rows: images }, { rows: shares }] = await Promise.all([
        pgc.query(
          `SELECT id, board_id, title, content, post_password_hash, like_count, dislike_count,
                  comment_count, report_count, report_reviewed_count, view_count, hot, created_at
             FROM board_post`
        ),
        pgc.query('SELECT post_id, seq, object_key FROM board_post_image ORDER BY post_id, seq'),
        pgc.query('SELECT post_id, token FROM board_share'),
      ]);
      const imagesByPost = groupBy(images, (i) => String(i.post_id));
      const tokenByPost = new Map(shares.map((s) => [String(s.post_id), s.token]));
      for (const p of posts) {
        const ref = db.collection('boardPosts').doc(String(p.id));
        const imageList = (imagesByPost.get(String(p.id)) || []).map((i) => ({
          seq: i.seq, objectKey: i.object_key,
        }));
        writer.set(ref, {
          boardId: String(p.board_id), title: p.title, content: p.content,
          likeCount: num(p.like_count), dislikeCount: num(p.dislike_count),
          commentCount: num(p.comment_count), reportCount: num(p.report_count),
          reportReviewedCount: num(p.report_reviewed_count), viewCount: num(p.view_count),
          hot: p.hot, hasPassword: p.post_password_hash != null, createdAt: ts(p.created_at),
          images: imageList,
          shareToken: tokenByPost.get(String(p.id)) ?? null,
        });
        writer.set(ref.collection('_private').doc('auth'), { postPasswordHash: p.post_password_hash });
      }
    },
  },
  {
    name: 'board_comment',
    migrate: async ({ pg: pgc, db, writer }) => {
      const { rows } = await pgc.query(
        'SELECT id, post_id, parent_id, content, post_password_hash, created_at FROM board_comment'
      );
      for (const r of rows) {
        const ref = db.collection('boardPosts').doc(String(r.post_id)).collection('comments').doc(String(r.id));
        writer.set(ref, {
          parentId: r.parent_id != null ? String(r.parent_id) : null,
          content: r.content, hasPassword: r.post_password_hash != null, createdAt: ts(r.created_at),
        });
        writer.set(ref.collection('_private').doc('auth'), { postPasswordHash: r.post_password_hash });
      }
    },
  },
  {
    // board_event 는 두 용도로 쓰인다(원본 표 하나가 겸함, 설계문서 §3 그대로 분리):
    //  · events/{id}     — HOT 30분 시간창 재계산용 전체 로그(댓글 포함).
    //  · reactions/{actorHash} — 좋아요/싫어요/신고 1인1회 중복방지(댓글 제외, actor 별로 병합).
    name: 'board_event',
    migrate: async ({ pg: pgc, db, writer }) => {
      const { rows } = await pgc.query(
        'SELECT id, post_id, kind, actor_hash, created_at FROM board_event ORDER BY post_id'
      );
      for (const r of rows) {
        writer.set(
          db.collection('boardPosts').doc(String(r.post_id)).collection('events').doc(String(r.id)),
          { kind: r.kind, actorHash: r.actor_hash ?? null, createdAt: ts(r.created_at) }
        );
      }

      const reactionRows = rows.filter((r) => r.kind !== 'comment' && r.actor_hash);
      // (post_id, kind) 당 최대 1행 뿐(원본 UNIQUE 제약) → actor 별로 kind 플래그만 병합하면 된다.
      const grouped = groupBy(reactionRows, (r) => `${r.post_id} ${r.actor_hash}`);
      for (const [key, evs] of grouped) {
        const [postId, actorHash] = key.split(' ');
        const data = {};
        for (const e of evs) {
          if (e.kind === 'like') { data.liked = true; data.likedAt = ts(e.created_at); }
          else if (e.kind === 'dislike') { data.disliked = true; data.dislikedAt = ts(e.created_at); }
          else if (e.kind === 'report') { data.reported = true; data.reportedAt = ts(e.created_at); }
        }
        writer.set(
          db.collection('boardPosts').doc(postId).collection('reactions').doc(actorHash), data
        );
      }
    },
  },
  {
    // push_subscription → pushSubscriptions/{id}. post_watch(댓글 알림 워처)는
    // boardPosts/{id}/watchers/{subscriptionId} 서브컬렉션으로(설계문서 §3 명시).
    name: 'push_subscription',
    migrate: async ({ pg: pgc, db, writer }) => {
      const { rows } = await pgc.query('SELECT id, endpoint, p256dh, auth, hot_alerts FROM push_subscription');
      for (const r of rows) {
        writer.set(db.collection('pushSubscriptions').doc(String(r.id)), {
          endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth, hotAlerts: r.hot_alerts,
        });
      }

      const { rows: watches } = await pgc.query('SELECT post_id, subscription_id FROM post_watch');
      for (const w of watches) {
        writer.set(
          db.collection('boardPosts').doc(String(w.post_id))
            .collection('watchers').doc(String(w.subscription_id)),
          { watching: true }   // 원본 표엔 복합PK 외 컬럼 없음(board_favorite 와 동일 패턴)
        );
      }
    },
  },
  {
    // admin_push_subscription → adminPushSubscriptions/{uid}_{endpointHash}(설계문서 §3 문서ID 규약).
    name: 'admin_push_subscription',
    migrate: async ({ pg: pgc, db, writer }) => {
      const { rows } = await pgc.query('SELECT cadet_id, endpoint, p256dh, auth FROM admin_push_subscription');
      for (const r of rows) {
        const endpointHash = createHash('sha256').update(r.endpoint).digest('hex');
        writer.set(db.collection('adminPushSubscriptions').doc(`${r.cadet_id}_${endpointHash}`), {
          uid: r.cadet_id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth,
        });
      }
    },
  },

  // ── 검열 아카이브: deleted_content → deletedContent/{id}, expiresAt 는 Firestore 네이티브 TTL 필드 ──
  {
    name: 'deleted_content',
    migrate: async ({ pg: pgc, db, writer }) => {
      const { rows } = await pgc.query(
        `SELECT id, type, orig_id, label, text, report_count, reason, snapshot, reviewed, deleted_at
           FROM deleted_content`
      );
      for (const r of rows) {
        const deletedAt = r.deleted_at;
        const expiresAt = deletedAt ? new Date(deletedAt.getTime() + 30 * 24 * 3600 * 1000) : null;
        writer.set(db.collection('deletedContent').doc(String(r.id)), {
          type: r.type, origId: String(r.orig_id), label: r.label, text: r.text,
          reportCount: num(r.report_count), reason: r.reason,
          snapshot: r.snapshot,   // jsonb → pg 가 이미 JS 객체로 파싱해 줌. 그대로 저장.
          reviewed: r.reviewed, deletedAt: ts(deletedAt), expiresAt: ts(expiresAt),
        });
      }
    },
  },

  // ── 평점 집계 (파생 데이터) — course_professor_rating/professor_rating 뷰를 그대로 읽어 시드.
  //    컷오버 이후엔 review 쓰기 Cloud Function 트리거가 이 문서들을 갱신한다(설계문서 §3 주석).
  {
    name: 'ratings',
    migrate: async ({ pg: pgc, db, writer }) => {
      const { rows: courseProf } = await pgc.query('SELECT * FROM course_professor_rating');
      for (const r of courseProf) {
        const key = `${r.course_code}_${r.professor_code ?? 'none'}`;
        writer.set(db.collection('courseProfessorRatings').doc(key), {
          courseCode: r.course_code, courseName: r.course_name,
          professorCode: r.professor_code, professorName: r.professor_name,
          reviewCount: num(r.review_count), avgOverall: num(r.avg_overall),
          avgWorkload: num(r.avg_workload), avgProgress: num(r.avg_progress),
          avgDifficulty: num(r.avg_difficulty), avgClassTime: num(r.avg_class_time),
          failRatio: num(r.fail_ratio),
        });
      }

      const { rows: profOnly } = await pgc.query('SELECT * FROM professor_rating');
      for (const r of profOnly) {
        writer.set(db.collection('professorRatings').doc(r.professor_code), {
          professorCode: r.professor_code, professorName: r.professor_name,
          reviewCount: num(r.review_count), avgOverall: num(r.avg_overall), failRatio: num(r.fail_ratio),
        });
      }
    },
  },

  // ── 구현 보조 (설계문서 §3 명시 밖 — 완전성을 위해 별도 추론: notices/bannedWords 컬렉션) ──
  {
    name: 'notice',
    migrate: async ({ pg: pgc, db, writer }) => {
      const { rows } = await pgc.query(
        'SELECT id, title, content, is_active, expires_at, created_at, updated_at FROM notice'
      );
      for (const r of rows) {
        writer.set(db.collection('notices').doc(String(r.id)), {
          title: r.title, content: r.content, isActive: r.is_active,
          expiresAt: ts(r.expires_at), createdAt: ts(r.created_at), updatedAt: ts(r.updated_at),
        });
      }
    },
  },
  {
    name: 'banned_word',
    migrate: async ({ pg: pgc, db, writer }) => {
      const { rows } = await pgc.query('SELECT word, created_at FROM banned_word');
      for (const r of rows) {
        if (isUnsafeDocId(r.word)) { console.warn(`  [banned_word] ⚠️ 건너뜀(문서ID 부적합): "${r.word}"`); continue; }
        writer.set(db.collection('bannedWords').doc(r.word), { createdAt: ts(r.created_at) });
      }
    },
  },
];


// =====================================================================
//  CLI 진입점
// =====================================================================
function parseArgs(argv) {
  const args = { only: null, dryRun: false };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--only=')) args.only = a.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
    else console.warn(`⚠️ 알 수 없는 인자 무시: ${a}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { dryRun, only } = args;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('❌ DATABASE_URL 환경변수가 필요합니다 (Supabase Postgres 연결 문자열).');
    console.error('   scripts/README-migration.md 의 "DATABASE_URL 구하기" 참고.');
    process.exit(1);
  }
  const saPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!saPath) {
    console.error('❌ FIREBASE_SERVICE_ACCOUNT_PATH 환경변수가 필요합니다 (서비스 계정 JSON 파일 경로).');
    console.error('   scripts/README-migration.md 의 "Firebase 서비스 계정 구하기" 참고.');
    process.exit(1);
  }

  if (only) {
    const validNames = ['auth', ...TABLES.map((t) => t.name)];
    const unknown = only.filter((n) => !validNames.includes(n));
    if (unknown.length) {
      console.warn(`⚠️ --only 에 알 수 없는 이름: ${unknown.join(', ')}`);
      console.warn(`   사용 가능: ${validNames.join(', ')}`);
    }
  }

  const pgc = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  await pgc.connect();

  // service account 는 initializeApp/getFirestore 단계에선 네트워크 호출이 없다(자격증명 셋업만) —
  // dry-run 에서도 항상 초기화해 실제 실행과 코드경로를 동일하게 유지한다(문서ref 구성 등).
  const serviceAccount = JSON.parse(readFileSync(saPath, 'utf8'));
  const app = initializeApp({ credential: cert(serviceAccount) });
  const auth = getAuth(app);
  const db = getFirestore(app);
  const bulkWriter = db.bulkWriter();
  const bulkErrors = [];
  bulkWriter.onWriteError((error) => {
    if (error.failedAttempts < 5) return true;   // 일시적 오류는 자동 재시도(최대 5회)
    bulkErrors.push({ path: error.documentRef.path, message: error.message });
    return false;
  });

  console.log(`=== anyTime Supabase → Firebase 이관 ${dryRun ? '[DRY-RUN — Firestore 쓰기 없음]' : '[실제 실행]'} ===`);
  if (only) console.log(`대상 한정(--only): ${only.join(', ')}`);

  const counts = {};
  try {
    if (!only || only.includes('auth')) {
      await migrateAuthUsers(pgc, auth, dryRun);
    } else {
      console.log('\n[auth] --only 에 없어 건너뜀');
    }

    for (const table of TABLES) {
      if (only && !only.includes(table.name)) continue;
      console.log(`\n--- [${table.name}] 시작 ---`);
      const writer = makeWriter(table.name, { bulkWriter, dryRun, counts });
      await table.migrate({ pg: pgc, db, writer, auth, dryRun });
      console.log(`[${table.name}] 완료 (${counts[table.name] || 0}건 ${dryRun ? '기록 예정' : '기록'})`);
    }

    if (!dryRun) {
      console.log('\nFirestore 대기 쓰기 flush 중...');
      await bulkWriter.close();
    }

    console.log('\n=== 요약 ===');
    let total = 0;
    for (const [name, n] of Object.entries(counts)) { console.log(`  ${name}: ${n}건`); total += n; }
    console.log(`  합계: ${total}건`);
    if (bulkErrors.length) {
      console.log(`\n⚠️ 쓰기 오류 ${bulkErrors.length}건(재시도 5회 초과로 포기):`);
      bulkErrors.forEach((e) => console.log(`  - ${e.path}: ${e.message}`));
    }
    console.log(dryRun ? '\ndry-run 종료 — 실제 쓰기는 없었습니다.' : '\n이관 완료.');
  } finally {
    await pgc.end();
  }
}

main().catch((err) => {
  console.error('❌ 이관 실패:', err);
  process.exit(1);
});
