// 배경화면 모드에서 시간표 배치(이동/확대)와 중앙 스냅을 계산하는 순수 함수.
// 좌표계는 '최종 캔버스의 픽셀'. transform = { x, y, scale }
//   x,y   = 그리드(원본 크기 gridW×gridH) 좌상단의 캔버스 좌표
//   scale = 그리드 원본 대비 배율

// 그리드를 좌우 여백 marginFrac 만큼 두고 캔버스 폭에 맞추는 기준 배율.
// 여백 3%(예전 6%의 절반) — 배경화면에서 시간표를 되도록 크게.
export function fitWidthBaseline({ gridW, canvasW, marginFrac = 0.03 }) {
  if (!gridW || !canvasW) return 1;
  return (canvasW * (1 - 2 * marginFrac)) / gridW;
}

// 줌 한계: 기준 배율의 min~max 배.
export function clampScale(scale, baseline, min = 0.4, max = 3) {
  const b = baseline || 1;
  return Math.max(b * min, Math.min(b * max, scale));
}

// 그리드를 캔버스 정중앙에 놓는 transform.
export function centeredTransform({ gridW, gridH, canvasW, canvasH, scale }) {
  return {
    x: (canvasW - gridW * scale) / 2,
    y: (canvasH - gridH * scale) / 2,
    scale,
  };
}

// 그리드 중심이 캔버스의 세로중앙선/가로중앙선 근처면 그 축으로 스냅.
// guides.v = 세로 가이드선(= x축이 중앙에 붙음), guides.h = 가로 가이드선(= y축).
export function snapCenter({ transform, gridW, gridH, canvasW, canvasH, thresholdFrac = 0.025 }) {
  const cx = transform.x + (gridW * transform.scale) / 2;
  const cy = transform.y + (gridH * transform.scale) / 2;
  const tx = canvasW / 2;
  const ty = canvasH / 2;
  const v = Math.abs(cx - tx) <= canvasW * thresholdFrac;
  const h = Math.abs(cy - ty) <= canvasH * thresholdFrac;
  return {
    x: v ? transform.x + (tx - cx) : transform.x,
    y: h ? transform.y + (ty - cy) : transform.y,
    guides: { v, h },
  };
}

// 화면/그리드 크기가 달라져도 대략 살아남도록 정규화해 저장.
export function toStored({ transform, canvasW, canvasH, gridW, gridH, baseline }) {
  const cx = transform.x + (gridW * transform.scale) / 2;
  const cy = transform.y + (gridH * transform.scale) / 2;
  return {
    scaleRel: baseline ? transform.scale / baseline : 1,
    cxFrac: canvasW ? cx / canvasW : 0.5,
    cyFrac: canvasH ? cy / canvasH : 0.5,
  };
}

export function fromStored(stored, { canvasW, canvasH, gridW, gridH, baseline }) {
  const b = baseline || 1;
  const scaleRel = stored && typeof stored.scaleRel === 'number' ? stored.scaleRel : 1;
  const scale = clampScale(b * scaleRel, b);
  const cxFrac = stored && typeof stored.cxFrac === 'number' ? stored.cxFrac : 0.5;
  const cyFrac = stored && typeof stored.cyFrac === 'number' ? stored.cyFrac : 0.5;
  return {
    x: canvasW * cxFrac - (gridW * scale) / 2,
    y: canvasH * cyFrac - (gridH * scale) / 2,
    scale,
  };
}

// 그리드가 캔버스 밖으로 과하게 벗어났으면 최소 keepFrac 만큼은 겹치게 당겨 넣는다.
// (완전 클램프는 안 함 — 의도적 크롭 허용.)
export function nudgeIntoView({ transform, gridW, gridH, canvasW, canvasH, keepFrac = 0.25 }) {
  const w = gridW * transform.scale;
  const h = gridH * transform.scale;
  const minVisX = Math.min(w, canvasW) * keepFrac;
  const minVisY = Math.min(h, canvasH) * keepFrac;
  let { x, y } = transform;
  if (x + w < minVisX) x = minVisX - w;
  if (x > canvasW - minVisX) x = canvasW - minVisX;
  if (y + h < minVisY) y = minVisY - h;
  if (y > canvasH - minVisY) y = canvasH - minVisY;
  return { x, y, scale: transform.scale };
}
