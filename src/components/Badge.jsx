// 유튜브 크리에이터 어워드(실버 버튼) 스타일의 사각 메탈 뱃지.
// 등급: gray < 10 ≤ silver < 50 ≤ gold < 100 ≤ rainbow
const TIERS = {
  gray:    { label: '그레이' },
  silver:  { label: '실버' },
  gold:    { label: '골드' },
  rainbow: { label: '레인보우' },
};

export function badgeOf(count) {
  if (count >= 100) return 'rainbow';
  if (count >= 50) return 'gold';
  if (count >= 10) return 'silver';
  return 'gray';
}

// size: 픽셀 한 변 길이
export default function Badge({ tier = 'gray', size = 56, showLabel = false }) {
  const t = TIERS[tier] ?? TIERS.gray;
  return (
    <span className="badge-wrap">
      <span
        className={`badge badge-${tier}`}
        style={{ width: size, height: size }}
        role="img"
        aria-label={`${t.label} 뱃지`}
        title={`${t.label} 뱃지`}
      >
        <span className="badge-play" />
      </span>
      {showLabel && <span className="badge-label">{t.label}</span>}
    </span>
  );
}
