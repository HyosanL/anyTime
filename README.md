# 애타 (AnyTime)

> **공군사관학교 강의정보 공유 PWA** — 생도가 **완전 익명**으로 강의평·확정시간표·족보·수업메모·익명게시판을 이용하는 모바일 우선 웹앱.

[![PWA](https://img.shields.io/badge/PWA-installable-5A0FC8)](https://web.dev/progressive-web-apps/)
[![React](https://img.shields.io/badge/React-19-61DAFB)](https://react.dev)
[![Vite](https://img.shields.io/badge/Vite-6-646CFF)](https://vitejs.dev)
[![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL%20%2B%20RLS-3ECF8E)](https://supabase.com)
[![Cloudflare](https://img.shields.io/badge/Cloudflare-Pages%20%2B%20R2-F38020)](https://pages.cloudflare.com)

도메인: **anytime.rokafa.app** · 저장소: `HyosanL/anyTime`

---

## ✨ 핵심 기능

| 기능 | 설명 |
|---|---|
| 🔐 **위치 기반 가입** | 가입코드 + 지오펜싱(하버사인)을 서버(Edge Function)에서 검증. 교내 인원만 가입·재인증. |
| 🗓 **확정시간표** | 본인만 접근(RLS). 주간 그리드·연강 셀 병합. DB에 없는 강의는 직접추가. 요일·교시 겹침 자동 차단. |
| ⭐ **강의평** | 별점 5항목 + 과락/팀플/발표 · 과목×교수 평점·**과락률** 집계. 익명 다건, 게시글 비밀번호로 삭제. |
| 📚 **족보** | 기출자료 업로드/다운로드. 파일은 Cloudflare R2, 서버가 JWT 게이트로 중계(다중첨부). |
| 📝 **수업메모** | 분반 종속·휘발성. 해당 분반을 확정시간표에 등록한 생도만 열람·작성. |
| 💬 **익명게시판** | 게시판 검색/생성·즐겨찾기 · 글/댓글/대댓글 · 좋아요·싫어요 · 이미지(인라인) · HOT 고정. |
| 🏅 **레벨/뱃지** | 누적 작성수 기준 — 브론즈(<20)·실버(<100)·골드(<200)·레인보우(≥200). |
| ✏️ **정보 수정 제안** | 잘못된 교수/시간/강의실 등을 익명 제안(요일·교시 빌더·교수 선택). 동일 3건↑ 분반 항목은 자동 반영. |
| 🛠 **관리자** | 카탈로그 CRUD·CSV 일괄 · 교수 명단 동기화 · 설정 · **검열(신고·비속어·수정 제안 3탭)** · 아이디 차단. |

## 🕵️ 완전 익명 모델

- **게시물**(강의평·족보·메모·게시판 글/댓글)에는 **작성자 컬럼이 없다.** 작성은 로그인 사용자만(서버가 `auth.uid()`만 확인), **수정·삭제는 게시글 비밀번호**로만.
- **계정 종속 데이터**(시간표·프로필·즐겨찾기)만 `auth.uid()` + **RLS로 본인만**.
- **신고도 익명**: 횟수만 집계해 임계치(15분 10건 / 누적 30건) 도달 시 **글 자동삭제**. 신고자 차단·식별 없음.
- **기기지문·IP·작성자 매핑을 어디에도 저장하지 않는다.** 차단은 관리자 수동(아이디 기준)만.

## 🧱 기술 스택

```
프론트   Vite 6 + React 19 + react-router 7  →  정적 빌드(dist)  →  Cloudflare Pages
PWA      vite-plugin-pwa(Workbox) · IndexedDB(idb) 캐시
백엔드   Supabase = PostgreSQL + Auth + RLS + SECURITY DEFINER RPC + Edge Functions(Deno)
서버함수 Cloudflare Pages Functions(functions/api/*) — JWT 게이트 · R2 중계 · Workers AI
스토리지 Cloudflare R2 (버킷 anytime-exams) — 족보 파일 · 게시판 이미지
스케줄   pg_cron + pg_net (DB 내부) — 정리(purge)·계정만료·keep-alive
```

## 🏗 아키텍처

```
VSCode ──push──▶ GitHub ──연동──▶ Cloudflare Pages(자동배포 · anytime.rokafa.app)
브라우저(PWA) ──supabase-js──▶ Supabase (Auth · PostgreSQL · RLS · RPC · Edge Functions)
브라우저(PWA) ──fetch(JWT)───▶ Cloudflare Pages Functions ──바인딩──▶ R2 / Workers AI
```

접근 제어는 **RLS(`auth.uid()`) + SECURITY DEFINER RPC**로 강제한다. anon 키 공개는 안전(보안 = RLS + RPC), **service-role 키는 Edge Function 전용**, R2는 Pages Functions 바인딩 전용.

## 🚀 시작하기

```bash
npm install
npm run dev        # 로컬 개발 서버
npm run build      # 정적 빌드(dist)
npm run deploy     # 빌드 후 Cloudflare Pages 배포(wrangler)
```

**사전 준비**

1. **Supabase**(Seoul): `.env`에 `VITE_SUPABASE_URL`·`VITE_SUPABASE_ANON_KEY`. SQL Editor에서 `db/schema.sql` → `db/comments.sql` 실행. Auth ▸ Email 공급자 활성화.
2. **Edge Functions 배포**: `supabase functions deploy signup --no-verify-jwt`(및 `admin-action`·`delete-account`·`sync-professors --no-verify-jwt`).
3. **관리자 지정**: `UPDATE cadet SET is_admin=TRUE WHERE username='<아이디>';` · 운영 전 `app_setting` 좌표·반경·가입코드 교체.
4. **Cloudflare**: Pages에 repo 연결(빌드 `dist`), R2 버킷 `anytime-exams` + 바인딩 `EXAM_FILES`, `[vars]`에 URL·anon 키, 도메인 DNS.
5. 카탈로그(교수·과목·분반)는 **관리자 화면**에서 등록(CSV 일괄. 원본: `docs/2026-1-lectures.csv`).

> ⚠️ **운영 DB에 `db/schema.sql`을 통째로 재실행하지 말 것** — 상단 정리 블록이 `cadet`/auth 데이터를 삭제한다. 운영 반영은 증분 `ALTER`로만.

## 📁 프로젝트 구조

```
db/                 스키마 단일 원본(schema.sql) · 한글 주석(comments.sql)
supabase/functions/ Edge Functions(signup · admin-action · sync-professors · delete-account)
functions/api/      Pages Functions(_middleware · exam-* · board-* · parse-syllabus)
src/                React 앱(pages · components · lib · contexts · styles)
docs/               (요구사항·ERD·릴레이션·DDL·개발환경) + 생성기(build/)
```

## 📄 문서

`docs/` 폴더에 다음 (PDF)가 있으며, 생성기는 `docs/build/`에 있다(`node docs/build/gen.mjs`).

| 문서 | 내용 |
|---|---|
| `애타_요구사항명세서.pdf` | 기능(FR-1~46)·비기능 요구사항, 요구사항 추적표 |
| `애타_ERD_피터첸표기법.pdf` | 개체-관계 다이어그램(Peter Chen 표기법) |
| `애타_릴레이션테이블.pdf` | 관계형 스키마(PK/FK/카디널리티) |
| `애타_DDL_SQL.pdf` | 테이블 생성 SQL(DDL) |
| `애타_개발도구_환경_라이브러리.pdf` | 개발 도구·환경·라이브러리 |

설계 원본: [`PROJECT.md`](PROJECT.md) · [`db/schema.sql`](db/schema.sql) · [`db/README.md`](db/README.md)

## 🗄 데이터 모델(요약)

22개 테이블 + 2개 뷰. 상세는 ERD·릴레이션 문서 참조.

- **회원·기준정보**: `cadet` · `professor` · `course` · `semester` · `period`
- **분반·시간표**: `section` · `section_time` · `timetable` · `custom_class`
- **게시물(익명)**: `review`(+`review_report`) · `exam_archive` · `class_memo`(+`memo_report`)
- **익명게시판**: `board` · `board_post` · `board_comment` · `board_event` · `board_favorite`
- **운영·설정**: `app_setting` · `block` · `correction`

## 🔒 보안·프라이버시

- 모든 테이블 `ENABLE ROW LEVEL SECURITY`. 쓰기·민감 조회는 SECURITY DEFINER RPC.
- 게시글 비밀번호는 **bcrypt 해시**로만 저장. 비속어는 클라이언트에서 부분 마스킹.
- 작성자·기기지문·IP를 수집·저장하지 않아 사후에 작성자/이용자를 특정할 기록이 남지 않는다.

---

<sub>모든 텍스트·날짜는 한국어·KST. 키·좌표·가입코드 하드코딩 금지, service-role 키는 프론트 번들 금지.</sub>
