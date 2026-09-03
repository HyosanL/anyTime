# 시간표 이미지 저장 — 1차 배포 후 수정

날짜: 2026-09-04
원본: `2026-09-03-timetable-image-save-options-design.md` / `2026-09-03-timetable-image-save-options.md`

사용자 피드백 6건. 파일 5개 수정, schema·함수 변경 없음 → `main` push 시 Cloudflare Pages 자동 배포.

| # | 피드백 | 조치 | 파일 |
|---|---|---|---|
| 1 | 저장 시트가 작아 배경화면 배치가 불편 | 시트 `max-height` 82vh→94vh(`.tti-sheet`), 배경화면 미리보기 높이 `0.46·innerHeight`→`0.60`, `max-height` 46vh→62vh, 프레임 패딩 축소 | `timetableImage.css`, `TimetableImageSheet.jsx` |
| 2 | 화질이 나쁨(특히 배경화면) | **핵심 원인**: `screenDims`가 `CSS px × min(dpr,2)` 라 실해상도의 절반 이하(예 iPhone 15 Pro 786px) → 배경화면으로 깔면 OS 가 2배 확대. 이제 `window.screen.w × devicePixelRatio` = 실제 물리 픽셀(1179px). 상한도 짧은 변 1500px로. 격자 픽셀밀도 `PIX` 3→3.5(확대 여유) | `TimetableImageSheet.jsx`, `timetableImage.js` |
| 3 | 시간표 주변 여백을 반으로 | 배경화면 기본 좌우 여백 `fitWidthBaseline` marginFrac 0.06→0.03, 패널 여백 `PANEL_PAD_FRAC` 0.03→0.02, 일반 모드 여백 `g.width·0.05`→`0.025` | `wallpaperTransform.js`, `timetableImage.js` |
| 4 | 공통공강 색이 배경색에 묻힘 | 공통공강 칸도 팔레트 색으로(예전엔 `overlayTint(bg,0.11)` = 배경색 틴트). 색은 팔레트 **뒤에서부터** 배정(과목은 앞에서부터 → 충돌 최소), 글자색은 팔레트 통일 `fg` | `timetableImage.js` |
| 5 | 테마에 맞는 배경색 추천 | `recommendBackground({colors,fg})` — 팔레트 첫 색을 라이트 테마는 흰색쪽 0.82, 다크 테마는 검정쪽 0.80으로 밀어 옅은/깊은 동일 색조. 시트에 **✦ 추천 스와치** + 사용자가 색을 직접 안 골랐으면(`ttimg:bg` 미저장) 추천색이 기본. 테마 바뀌면 자동 추적 | `imageColor.js`, `TimetableImageSheet.jsx` |
| 6 | 저장 이미지 폰트가 화면보다 작음 | 원인: 이미지 칸이 화면보다 ~1.6배 큰데 폰트는 거의 같은 절대 px. 이미지 폰트를 홈 화면 비율에 맞춰 상향(course 12→18 등) + **작게/보통/크게** 토글(`TEXT_SCALES` 0.82/1/1.18, `ttimg:textsize`). '보통'이 홈 화면과 같은 비율. 줄 간격도 폰트 비례로(예전엔 15px 고정) | `timetableImage.js`, `TimetableImageSheet.jsx` |

## 새 localStorage 키

- `ttimg:textsize` = `S` | `M` | `L` (기본 `M`)
- `ttimg:bg` — 이제 미저장이면 "추천색 자동"(예전엔 `#ffffff` 고정)

## 새 export (`lib/timetableImage.js`)

- `PANEL_PAD_FRAC = 0.02`
- `TEXT_SCALES = { S: 0.82, M: 1, L: 1.18 }`
- `renderTimetableGrid({ ..., textScale })` 인자 추가

## 검증

- `npm run build` 통과, 순수 함수(recommendBackground·fitWidthBaseline) node 확인
- 배경화면 기본 배치: 폭 94%, 세로 중앙(iPhone 15 Pro 기준 x≈35 y≈644)
- 실기기 확인 필요: 배경화면 저장→잠금/홈 화면 배경 설정 시 선명도, 글자 크기 3단계, 다크 테마 추천색
