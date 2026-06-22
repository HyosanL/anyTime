import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthContext } from '../contexts/AuthContext';

const DEPARTMENTS = [
  '전산학과', '전자공학과', '기계공학과', '항공우주공학과',
  '토목환경공학과', '기초과학과', '국방경영학과', '군사전략학과'
];

export default function Onboarding() {
  const { cadet, loading, redeemCode } = useAuthContext();
  const navigate = useNavigate();

  const [code, setCode] = useState('');
  const [nickname, setNickname] = useState('');
  const [classYear, setClassYear] = useState('');
  const [department, setDepartment] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (loading) return <div className="page-center">로딩 중...</div>;
  if (cadet) {
    navigate('/courses', { replace: true });
    return null;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await redeemCode(code.trim(), nickname.trim(), Number(classYear), department);
      navigate('/courses', { replace: true });
    } catch (err) {
      setError(err.message || '가입에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="onboarding">
      <div className="onboarding-header">
        <h1>애타</h1>
        <p>공군사관학교 수강평 · 수강신청 도움</p>
      </div>

      <form onSubmit={handleSubmit} className="onboarding-form">
        <label>
          인증코드
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="발급받은 코드 입력"
            required
          />
        </label>

        <label>
          닉네임
          <input
            type="text"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="익명 닉네임"
            maxLength={20}
            required
          />
        </label>

        <label>
          기수
          <input
            type="number"
            value={classYear}
            onChange={(e) => setClassYear(e.target.value)}
            placeholder="예: 82"
            min={70}
            max={90}
            required
          />
        </label>

        <label>
          학과
          <select value={department} onChange={(e) => setDepartment(e.target.value)} required>
            <option value="">선택</option>
            {DEPARTMENTS.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </label>

        {error && <p className="error-msg">{error}</p>}

        <button type="submit" disabled={submitting}>
          {submitting ? '가입 중...' : '가입하기'}
        </button>
      </form>
    </div>
  );
}
