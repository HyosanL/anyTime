// 작은 사각 레벨 뱃지 (디시 등 커뮤니티 스타일) — 질감만 유튜브 버튼처럼 금속.
// 색 등급: gray < 10 ≤ silver < 50 ≤ gold < 100 ≤ rainbow
// 안의 숫자 = 레벨(= 누적 작성수 post_count).
const TIER_LABEL = {
  gray: '그레이',
  silver: '실버',
  gold: '골드',
  rainbow: '레인보우',
};

export function badgeOf(count) {
  if (count >= 100) return 'rainbow';
  if (count >= 50) return 'gold';
  if (count >= 10) return 'silver';
  return 'gray';
}

// tier: 색 등급, level: 안에 표시할 숫자, size: 한 변(px)
export default function Badge({ tier = 'gray', level = 0, size = 34 }) {
  const label = TIER_LABEL[tier] ?? TIER_LABEL.gray;
  return (
    <span
      className={`badge badge-${tier}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      role="img"
      aria-label={`${label} 레벨 ${level}`}
      title={`${label} · Lv.${level}`}
    >
      <span className="badge-num">{level}</span>
    </span>
  );
}
