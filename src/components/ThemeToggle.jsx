import { useTheme } from '../lib/theme';

// 라이트 / 시스템 / 다크 3단 세그먼트 토글.
const OPTS = [
  ['light', '☀️', '라이트'],
  ['system', '🖥️', '시스템'],
  ['dark', '🌙', '다크'],
];

export default function ThemeToggle() {
  const [pref, setPref] = useTheme();
  return (
    <div className="theme-toggle" role="group" aria-label="테마 전환">
      {OPTS.map(([val, icon, label]) => (
        <button
          key={val}
          type="button"
          className={pref === val ? 'on' : ''}
          aria-pressed={pref === val}
          title={label}
          onClick={() => setPref(val)}
        >
          {icon}
        </button>
      ))}
    </div>
  );
}
