// 작은 사각 레벨 뱃지 (디시 등 커뮤니티 스타일) — 질감만 유튜브 버튼처럼 금속.
// 색 등급: bronze < 20 ≤ silver < 100 ≤ gold < 200 ≤ rainbow
// 안의 숫자 = 레벨(= 누적 작성수 post_count).
const TIER_LABEL = {
  bronze: '브론즈',
  silver: '실버',
  gold: '골드',
  rainbow: '레인보우',
};

export function badgeOf(count) {
  if (count >= 200) return 'rainbow';
  if (count >= 100) return 'gold';
  if (count >= 20) return 'silver';
  return 'bronze';
}

// tier: 색 등급, level: 안에 표시할 숫자, size: 한 변(px)
export default function Badge({ tier = 'bronze', level = 0, size = 34 }) {
  const label = TIER_LABEL[tier] ?? TIER_LABEL.bronze;
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
