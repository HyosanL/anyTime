# 시간표 이미지 저장 옵션 — 배경화면 채우기 · 배경색 — 설계

작성: 2026-09-03

## 배경 — 요청

> 시간표를 이미지 저장할 때, **배경화면으로 쓸 수 있도록 화면에 꽉 채워서 저장하는 옵션**과,
> **배경색을 지정할 수 있는 옵션**이 있었으면 해.

지금은 홈의 🖼️ 버튼을 누르면 옵션 없이 곧바로 저장된다
([Home.jsx:172-178](../../../src/pages/Home.jsx#L172-L178)). `saveTimetableImage()`가
`renderTimetableCanvas()`로 내용맞춤 크기(흰 배경)의 PNG를 만들고, 모바일은 공유 시트,
데스크톱은 다운로드로 넘긴다 ([timetableImage.js](../../../src/lib/timetableImage.js)).

캔버스 렌더러는 화면(`TimetableGrid`)과 같은 격자 계산(`lib/timetableLayout`)을 공유해
"화면과 똑같은 그림"을 canvas 2D로 직접 그린다 — DOM→이미지 라이브러리가 iOS에서
자주 깨지기 때문. 이 canvas 직접 렌더 방식은 유지한다.

## 핵심 통찰

두 요청은 **하나의 "저장 옵션 시트"** 로 묶인다. 즉시저장을 옵션 단계가 있는 흐름으로
바꾼다. 저장 결과는 두 모드로 갈린다:

- **일반**: 지금처럼 내용맞춤 크기. 배경색만 고를 수 있게.
- **배경화면**: 이 기기 화면 비율의 세로 이미지. 시간표를 드래그·핀치로 배치하고
  배경색을 깐다. 배경화면은 "정확히 맞는 한 장"이 사람마다 다르므로(잠금화면 시계,
  홈 아이콘 위치) 고정 레이아웃이 아니라 **직접 맞추는 인터랙티브 편집기**여야 한다.

배경색이 흰색이 아니게 되면 격자의 흰 부분(빈 칸, 제목/축 글자)이 배경과 충돌한다.
그래서 격자 렌더러가 **배경색을 인지**해 빈 칸은 틴트로, 글자는 자동 대비로 그린다.

---

## Ⅰ. 진입 · 시트 UI

### 흐름 변경

홈 🖼️ 버튼 → (즉시저장 대신) **`TimetableImageSheet` 바텀시트**를 연다.

- `PaletteSheet` 패턴 그대로: `.pal-overlay` / `.pal-sheet`, ✕·Esc·바깥탭 닫기,
  `lockScroll()`/`unlockScroll()` ([PalettePicker.jsx:87-114](../../../src/components/PalettePicker.jsx#L87-L114)).
- 🖼️ 버튼 노출 조건은 지금과 동일(`mine.length > 0 || customClasses.length > 0`).

### 시트 구성

```
┌─────────────────────────────────┐
│ 🖼️ 시간표 이미지        ✕      │
│                                 │
│  [ 일반 ] [ 배경화면 ]   ← 모드 토글  │
│                                 │
│  ┌───────────────────────────┐  │
│  │      미리보기 영역          │  │  일반: 축소 이미지
│  │  (배경화면: 드래그·핀치)    │  │  배경화면: 인터랙티브 캔버스
│  └───────────────────────────┘  │
│                                 │
│  배경색                          │
│  ⬜ ⬜ ⬜ ⬛ ⬛ 🟦 🟩 🟨  🎨    │  ← 프리셋 8 + 스포이트
│                                 │
│  [        저장        ]          │
└─────────────────────────────────┘
```

### 상태 · 영속

시트가 여는 로컬 상태: `{ mode, background, transform }`.

`localStorage`에 마지막 선택을 기억한다(앱 관례 — 색 테마·숨김도 기기 저장):

| 키 | 값 |
|---|---|
| `ttimg:mode` | `'plain'` \| `'wallpaper'` |
| `ttimg:bg` | `#rrggbb` |
| `ttimg:wp` | `{ scaleRel, cxFrac, cyFrac }` — 아래 Ⅲ 참고 |

없으면 기본값: `mode='plain'`, `bg='#ffffff'`, `transform=` fit-width 정중앙.

---

## Ⅱ. 일반 모드

지금의 `renderTimetableCanvas` 출력(내용맞춤 크기)을 유지하되 **배경색을 받는다**.

- 이미지 전체를 배경색으로 채운다(기존 `C.bg = '#ffffff'` 고정 → 인자).
- **빈 칸**: 흰 채움+회색 테두리 대신 → 배경색 위 `overlayTint(bg, 0.06)` 채움 +
  `overlayTint(bg, 0.14)` 테두리. 배경이 뭐든 격자감이 남는다.
- **공통 공강 칸**: `overlayTint(bg, 0.10)` 채움(지금의 `#e5eaf1` 대체), 글자는 대비색.
- **제목 · 요일 헤더 · 좌축(시각/교시)**: `contrastText(bg)` — 배경이 밝으면 짙은 회색
  계열, 어두우면 밝은 회색 계열(2~3단계 톤).
- **수업 타일**: 팔레트 색·`cell.fg` 그대로(사용자가 고른 테마 유지).

미리보기: 렌더된 canvas를 `<img>` 또는 축소 `<canvas>`로 표시. 배경색 바꾸면 재렌더.

---

## Ⅲ. 배경화면 모드

### 캔버스 크기

이 기기 화면 비율·해상도:

```
const s = Math.min(window.screen.width, window.screen.height);   // 세로 기준 짧은 변
const l = Math.max(window.screen.width, window.screen.height);
const dpr = Math.min(window.devicePixelRatio || 1, 2);
let W = s * dpr, H = l * dpr;                 // 항상 세로(portrait)
const cap = 2600;                             // 긴 변 상한 — 파일 크기·메모리
if (H > cap) { const k = cap / H; W *= k; H *= k; }
```

데스크톱은 `window.screen`이 모니터 크기(가로가 길다) → 위 min/max로 세로로 정규화.
데스크톱 사용자도 세로 배경화면(폰) 용도가 대부분이므로 세로 고정.

### 합성

1. 캔버스 전체를 **배경색**으로 채운다.
2. 시간표 뒤에 **iOS17 홈화면 폴더 스타일 패널**: 둥근 사각형(반지름 ≈ 캔버스 짧은
   변의 6%), `overlayTint(bg, 0.12)` 채움 + `overlayTint(bg, 0.18)` 1px 테두리.
   그리드 바깥으로 여백(≈ 그리드 짧은 변의 4%)을 둬서 패널이 시간표를 감싼다.
3. 그리드 canvas(투명 바깥, 빈 칸·글자는 배경색 인지 — Ⅱ와 같은 규칙)를
   `transform`대로 그린다.

빈 칸·틈으로 패널색이 비쳐 시간표가 배경과 구분되면서 벽지에 녹아든다.

### 인터랙션 (미리보기 캔버스)

미리보기는 최종 캔버스를 시트 폭에 맞춰 축소해 그린 `<canvas>`. `touch-action: none`.

| 제스처 | 동작 |
|---|---|
| 한 손가락 / 마우스 드래그 | 시간표 이동(x·y). 세로 위치 자유 조정 포함. |
| 두 손가락 핀치 | 확대·축소. 핀치 중심 기준. |
| 마우스 휠 | 확대·축소. 커서 기준. |

- **스냅**: 시간표 중심이 캔버스 **세로중앙선 / 가로중앙선 / 정중앙**의 ±2.5%(캔버스
  해당 변 기준) 안이면 그 축으로 달라붙고, 드래그 중 해당 가이드선(1px, 대비색 40%)을
  표시. 놓으면 가이드선 사라짐.
- **줌 클램프**: `scale ∈ [0.4, 3] × fitWidthBaseline`. `fitWidthBaseline` = 그리드가
  양옆 6% 여백으로 캔버스 폭에 딱 맞는 배율.
- **기본값**: `scale = fitWidthBaseline`, 정중앙.

### transform 모델 · 영속

내부 상태는 픽셀(`{ x, y, scale }`, x·y는 그리드 좌상단의 캔버스 좌표).
저장은 그리드/화면 크기가 달라져도 대략 살아남도록 정규화:

```
scaleRel = scale / fitWidthBaseline
cxFrac   = (그리드 중심 x) / W      // 0~1
cyFrac   = (그리드 중심 y) / H
```

시트를 다시 열 때 현재 W·H·baseline·그리드크기로 역산해 복원하고, 화면 밖으로 너무
많이 나갔으면 살짝 당겨 넣는다(완전 클램프는 안 함 — 의도적 크롭 허용).

### 성능

그리드 canvas는 **한 번만** 렌더한다. 배경색이 바뀔 때만 재렌더(빈 칸 틴트·글자 대비가
배경색에 종속). 드래그/핀치 프레임마다는 `fillRect` + 패널 `roundRect` + `drawImage` +
가이드선만 — `requestAnimationFrame`으로 묶는다.

---

## Ⅳ. 배경색 선택

`CustomThemeEditor`의 `Swatch`(투명 `<input type="color">`를 스와치 위에 덮는) 패턴 재사용.

- **프리셋 8종**(가로 스크롤 없이 한 줄): 화이트 `#ffffff` · 오프화이트 `#f7f5f0` ·
  라이트그레이 `#e8eaed` · 차콜 `#2b2f36` · 블랙 `#0b0d10` · 소프트블루 `#dbe8f7` ·
  소프트그린 `#dcefe0` · 소프트핑크 `#f6e0e6`.
- **맨 끝 🎨**: 네이티브 컬러피커(스펙트럼/스포이트/HEX). 고른 값이 프리셋에 없으면
  9번째 "선택됨" 스와치로 표시.
- 두 모드 공통 적용. 선택 즉시 미리보기 갱신.

---

## Ⅴ. 저장

[저장] → 현재 모드·배경색·transform으로 **풀 해상도 최종 캔버스**를 합성 →
기존 `saveTimetableImage`의 공유/다운로드 로직 재사용:

- `navigator.canShare({ files })` 가능 → 공유 시트(iOS=사진에 저장, Android=공유/저장)
- 아니면 → `<a download>` 다운로드
- 반환값(`'shared'|'cancelled'|'downloaded'|'empty'`)은 그대로. 저장 후 시트는 닫는다
  (공유 취소 `'cancelled'`면 열어 둠).

파일명: `2026-2 내시간표.png`. 배경화면 모드는 `2026-2 내시간표_배경화면.png`.

사용자 제스처(클릭) 안에서 동기적으로 canvas·blob을 만드는 현재 규칙 유지(iOS 공유
활성화). [저장] 핸들러 안에서 합성까지 끝낸다.

---

## Ⅵ. 코드 구조

### `src/lib/imageColor.js` (신규 — 순수 함수)

```
luminance(hex)         → 0~1 (상대 휘도)
contrastText(hex)      → { strong, mid, soft }  배경 대비 글자색 3톤
overlayTint(hex, amt)  → hex   배경 위 흰/검 오버레이를 amt(0~1)만큼 섞은 불투명색
```

### `src/lib/wallpaperTransform.js` (신규 — 순수 함수)

```
fitWidthBaseline({ gridW, canvasW, marginFrac })      → number
clampScale(scale, baseline, [min, max])               → number
snapCenter({ gridRect, canvasW, canvasH, thresholdFrac }) → { x, y, guides:{v,h} }
toStored({ x, y, scale }, { W, H, baseline, gridW, gridH })   → { scaleRel, cxFrac, cyFrac }
fromStored(stored, { W, H, baseline, gridW, gridH })          → { x, y, scale }
```

### `src/lib/timetableImage.js` (리팩터)

- `renderTimetableGrid({ mine, periods, customClasses, commonBlocks, title, background })`
  → `{ canvas, gridW, gridH }`. 그리드만. 바깥 투명. 빈 칸·공강·글자는 `background`
  인지(Ⅱ 규칙). 제목 포함. — 지금 `renderTimetableCanvas`의 그리기 로직 이관.
- `composeTimetableImage({ gridCanvas, gridW, gridH, mode, background, screen, transform })`
  → `HTMLCanvasElement`. 일반=여백+배경색, 배경화면=화면비율 캔버스+패널+transform.
- `saveComposedImage(canvas, filename)` → `'shared'|'cancelled'|'downloaded'`.
  현 `saveTimetableImage`의 blob/File/share/download 부분.
- `renderTimetableCanvas` / `saveTimetableImage`는 제거(유일 호출처 Home.jsx의
  `handleSaveImage`도 함께 제거되므로 dangling 참조 없음). `dataURLtoBlob` 헬퍼는
  `saveComposedImage`가 계속 사용.

### `src/components/TimetableImageSheet.jsx` (신규)

시트 UI + 미리보기 canvas + 포인터(드래그/핀치/휠) 핸들러 + 스냅. props:
`{ mine, periods, customClasses, commonBlocks, title, onClose }`.

### `src/styles/` 파셜 (신규, 토큰 기반)

시트/토글/미리보기 프레임/스와치 줄. `palette.css`의 `.pal-overlay`/`.pal-sheet`/
`.cte-swatch` 재사용 가능한 만큼 재사용, 신규 클래스는 파셜로.

### `src/pages/Home.jsx` (최소 변경 — 다른 세션이 피드백 답변 기능 편집 중)

- `handleSaveImage`(동적 import 즉시저장) 콜백 삭제 → `const [imgSheetOpen, setImgSheetOpen] = useState(false)`.
- 🖼️ 버튼 `onClick={() => setImgSheetOpen(true)}`(노출 조건은 그대로).
- 시트는 `const TimetableImageSheet = lazy(() => import('../components/TimetableImageSheet'))`.
  첫 화면 번들에서 canvas 렌더러(`lib/timetableImage`)를 빼는 현재 의도를 유지 —
  무거운 렌더러는 시트 모듈이 정적으로 import하고, 시트 자체를 lazy 로드한다.
- 렌더 하단: `{imgSheetOpen && <Suspense fallback={null}><TimetableImageSheet …props… onClose={() => setImgSheetOpen(false)} /></Suspense>}`.
  (App에 이미 `Suspense`가 있으면 로컬 래핑 생략 가능 — 구현 시 확인.)
- 피드백 관련 파일(FeedbackPopup, lib/feedback, AppReportModal, CorrectionModal, SW)은
  건드리지 않는다.

---

## Ⅶ. 테스트

프로젝트에 테스트 인프라 없음. 이번 작업은 **관례대로 테스트 없이** 진행(사용자 결정).
순수 함수(`imageColor`, `wallpaperTransform`)는 나중에 vitest 도입 시 우선 대상.

수동 확인 항목:
- 일반 모드: 흰/차콜/소프트블루 배경 각각 — 빈 칸·글자 대비 OK, 수업 색 유지
- 배경화면 모드: 드래그 이동, 휠 줌, (모바일) 핀치 줌, 세 스냅 가이드 각각 붙음
- 저장: iOS 공유 시트=사진에 저장, Android 공유, 데스크톱 다운로드
- 재진입: 마지막 모드·배경색·배치 복원
- 시간표 0칸: 🖼️ 버튼 자체가 안 보임(기존 조건)

---

## Ⅷ. 범위 밖 (YAGNI)

- 가로(landscape) 배경화면 / 태블릿 전용 레이아웃
- 여러 장 일괄 저장, 위젯·라이브 배경
- 이미지에 텍스트·로고·날짜 커스텀 추가
- 그리드 글꼴 크기·요일 범위 수동 조절
- 배경 그라디언트·이미지 업로드(단색만)
- 저장본을 서버에 올리거나 공유 링크 생성
