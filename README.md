# 애타 (AnyTime)

> **공군사관학교 강의정보 공유 PWA** — 생도가 **완전 익명**으로 강의평·확정시간표·족보·수업메모·익명게시판을 이용하는 모바일 우선 웹앱.

[![PWA](https://img.shields.io/badge/PWA-installable-5A0FC8)](https://web.dev/progressive-web-apps/)
[![React](https://img.shields.io/badge/React-19-61DAFB)](https://react.dev)
[![Vite](https://img.shields.io/badge/Vite-6-646CFF)](https://vitejs.dev)
[![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL%20%2B%20RLS-3ECF8E)](https://supabase.com)
[![Cloudflare](https://img.shields.io/badge/Cloudflare-Pages%20%2B%20R2-F38020)](https://pages.cloudflare.com)

**🔗 라이브 · [anytime.rokafa.app](https://anytime.rokafa.app)** — 브라우저로 접속해 홈 화면에 추가하면 앱처럼 쓸 수 있습니다.

---

## ✨ 핵심 기능

| 기능 | 설명 |
|---|---|
| 🔐 **위치 기반 가입** | 가입코드 + 지오펜싱을 서버에서 검증. 교내 인원만 가입·재인증. |
| 🗓 **확정시간표** | 본인만 접근. 주간 그리드·연강 셀 병합. 편람에 없는 강의는 직접추가. 요일·교시 겹침 자동 차단. |
| ⭐ **강의평** | 별점 5항목 + 과락/팀플/발표 · 과목×교수 평점·**과락률** 집계. 익명 다건 작성. |
| 📚 **족보** | 기출자료 업로드/다운로드. 파일은 서버가 안전하게 중계(다중첨부 지원). |
| 📝 **수업메모** | 분반 종속·휘발성. 해당 분반을 시간표에 등록한 생도만 열람·작성. |
| 💬 **익명게시판** | 게시판 검색/생성·즐겨찾기 · 글/댓글/대댓글 · 좋아요·싫어요 · 이미지 · HOT 고정. |
| 🔔 **웹푸시 알림** | 지켜보는 글의 댓글·HOT 승격 알림(표준 Web Push). iOS는 홈 화면 설치 시 지원. |
| 🏅 **레벨/뱃지** | 누적 작성수 기준 — 브론즈·실버·골드·레인보우. |
| ✏️ **정보 수정 제안** | 잘못된 교수/시간/강의실을 익명 제안. 동일 제안이 모이면 자동 반영. |

## 🕵️ 완전 익명 · 프라이버시

애타는 **누가 무엇을 썼는지 추적할 수 없도록** 설계되었습니다.

- **게시물에 작성자 정보가 없습니다.** 강의평·족보·메모·게시판 글/댓글에는 작성자 컬럼 자체가 없고, 수정·삭제는 게시글 비밀번호로만 합니다.
- **기기지문·IP·작성자 매핑을 어디에도 저장하지 않습니다.** 사후에 작성자나 이용자를 특정할 기록이 남지 않습니다.
- **신고도 익명입니다.** 횟수만 집계해 임계치에 도달하면 글이 자동 삭제되며, 신고자를 식별·차단하지 않습니다.
- **푸시 알림도 익명입니다.** 구독·글 지켜보기에 사용자 ID나 시각을 저장하지 않고, 브라우저가 발급한 endpoint만 등록됩니다.
- 게시글 비밀번호는 **bcrypt 해시**로만 저장하고, 모든 데이터 접근은 행 수준 보안(RLS)으로 통제됩니다.

## 📱 설치

별도 설치 없이 브라우저에서 바로 쓰거나, 홈 화면에 추가해 앱처럼 사용할 수 있습니다(PWA).

- **Android · 데스크톱**: [anytime.rokafa.app](https://anytime.rokafa.app) 접속 → 주소창의 **설치 / 홈 화면에 추가**
- **iOS**: Safari로 접속 → 공유 → **홈 화면에 추가**

## 🧱 기술 스택

```
프론트   Vite + React + react-router  ·  PWA(vite-plugin-pwa / Workbox)
백엔드   Supabase (PostgreSQL · Auth · 행 수준 보안 · Edge Functions)
서버함수 Cloudflare Pages Functions  ·  스토리지 Cloudflare R2
푸시     표준 Web Push(VAPID) — 외부 푸시 서비스 불필요
```

---

<sub>공군사관학교 생도 프로젝트 · 모든 텍스트·시각은 한국어·KST 기준.</sub>
