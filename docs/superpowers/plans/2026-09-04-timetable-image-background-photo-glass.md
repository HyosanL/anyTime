# 시간표 이미지 — 배경 사진 + 글래스 패널

날짜: 2026-09-04
이어짐: `2026-09-04-timetable-image-save-revisions.md`

배경화면 모드에 (1) 사진 첨부, (2) iOS 폴더풍 글래스 패널을 더한다. 글래스는 사진·단색 배경 모두에 적용. schema·함수 변경 없음.

## 요구사항

| # | 내용 |
|---|---|
| A | 배경화면 모드에서 **사진 첨부**(파일 선택). 기기에 저장 안 함 — 시트 닫으면 사라짐. |
| B | 사진은 cover-fit 기본 + **드래그로 위치 조정**(항상 캔버스를 덮도록 클램프). 시트에 "배치 대상: 시간표 / 사진" 토글(사진 있을 때만). |
| C | 시간표 뒤 **글래스 패널** — 뒤 배경(사진/단색)을 블러 + 반투명 오버레이 + 옅은 테두리 + 상단 sheen. 사진·단색 **모두** 적용. |
| D | **글래스 톤 토글**(자동 / 밝은 / 어두운) — 사진·단색 모두. 자동 = 뒤 배경 밝기로 판정. |
| E | 수업/공강 타일은 **불투명**(팔레트 색). 빈 칸은 **투명**(글래스 비침) + 실선 테두리. 글자색은 글래스 톤 대비 자동. |
| F | 사진 있으면 저장 **JPEG**(q0.92), 파일명 `..._배경화면.jpg`. 없으면 PNG 유지. |
| G | 일반(plain) 모드는 그대로 — 글래스/사진 없음(뒤에 아무것도 없으므로). |

## 구현

### `src/lib/imageColor.js`
- 이미 `luminance`, `mixHex`, `overlayTint`, `contrastText` 있음. 추가 없음(재사용).

### `src/lib/timetableImage.js`
- `renderTimetableGrid({ ..., glass = false })` — `glass` 면 빈 칸 **채움 없음**(투명) + 테두리만. 나머지(타일·글자·공강색)는 `background`(=글래스 베이스색) 기준으로 지금과 동일.
- **신규** `export function paintWallpaper(ctx, S, opts)` — 배경화면 합성 한 곳. `ctx` 는 대상 캔버스 컨텍스트, `S` = 축소율(미리보기<1, 최종=1), 좌표는 전부 **최종 캔버스 px**(내부에서 ×S). `opts`:
  - `canvasW, canvasH` (최종 px), `bgColor`
  - `photo` (HTMLImageElement|null), `photoT` ({x,y,scale}|null)
  - `glassTone` ('light'|'dark'), `gridCanvas`, `gridT` ({x,y,scale}), `guides` ({v,h})
  - 순서: bgColor 채움 → 사진 → 글래스 패널(블러 backdrop→clip→drawImage, 오버레이, sheen 그라데이션, 테두리) → 그리드 → 가이드선.
- **신규** 내부 `blurredCopy(srcCanvas, canvasRefW)` — 다운스케일 블러(전 브라우저). `factor = max(6, round(canvasRefW/110))`.
- `composeTimetableImage` wallpaper 분기 → `paintWallpaper(ctx, 1, {...})` 호출로 교체. plain 분기는 그대로.
- `composeTimetableImage` 에 `photo`, `photoT`, `glassTone` 전달받아 넘김.
- `saveComposedImage(canvas, filename, mime = 'image/png')` — `mime`, jpeg 면 `toDataURL('image/jpeg', 0.92)`.
- `export function coverFitTransform({ imgW, imgH, canvasW, canvasH })` → `{x,y,scale}` (덮도록 최소 배율, 가운데).
- `export function clampCover(t, { imgW, imgH, canvasW, canvasH })` → 사진이 캔버스를 항상 덮도록 `x,y,scale` 클램프.

### `src/components/TimetableImageSheet.jsx`
- state: `photo`(Image|null), `photoLum`(0~1), `glassMode`('auto'|'light'|'dark' — `LS.glass`), `photoT`(ref+state), `dragTarget`('grid'|'photo').
- `glassTone` = `glassMode==='auto' ? ((photo?photoLum:luminance(bg)) < 0.5 ? 'dark':'light') : glassMode`.
- `glassBase` = `glassTone==='dark' ? '#1b1d23' : '#e9ebef'`.
- 격자 렌더: `background: mode==='wallpaper' ? glassBase : bg`, `glass: mode==='wallpaper'`. deps 에 `glassBase, mode` 추가.
- 사진: 숨은 `<input type=file accept="image/*">` + "사진 첨부"/"사진 제거" 버튼. 로드 시 `new Image()`, `photoLum` 은 32×32 다운스케일 후 평균휘도. `photoT` 기본 = `coverFitTransform`.
- 글래스 토글: `.tti-modes` 3버튼(자동/밝은/어두운), 배경화면 모드에서 항상.
- 배치 토글: `.tti-modes` 2버튼(시간표/사진), 사진 있을 때만.
- 색상 줄: 사진 없을 때만 표시(사진이 덮으므로).
- 포인터 핸들러: `dragTarget==='photo'` 면 `photoT` 이동/핀치( `clampCover` ), 아니면 지금처럼 `transform`.
- `paint()` → `paintWallpaper(ctx, S, {...})` 재사용(중복 제거). plain 분기는 유지.
- `onSave`: `composeTimetableImage({ ..., photo, photoT: photoTRef.current, glassTone })`, `mime = photo ? 'image/jpeg' : 'image/png'`, 파일명 확장자 맞춤.
- LS: `ttimg:glass` 추가. 사진·photoT 는 저장 안 함.

### `src/styles/timetableImage.css`
- `.tti-modes` 3버튼도 커버(현재 flex:1 이라 OK).
- 파일 첨부 버튼 `.tti-photo-btn`, 썸네일 행 `.tti-photo` 스타일.

## 검증
- `npm run build`, 순수 함수(coverFit/clampCover/blur factor) node 확인.
- 미리보기·최종이 `paintWallpaper` 한 함수라 어긋날 수 없음.
- 실기기: 사진 첨부 → 글래스 확인 → 배치 토글 → 저장(jpg) → 배경 설정.

## 범위 밖
사진 여러 장·필터·밝기, 사진 기기 저장, 블러 강도 조절, 글래스를 일반 모드에.
