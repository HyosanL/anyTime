import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { signup, login, getPosition } from '../lib/auth';
import { getDeviceFp } from '../lib/device';

const STATUS_MSG = {
  INVALID_CODE: '가입코드가 올바르지 않습니다.',
  OUT_OF_AREA: '캠퍼스 범위 밖입니다. 위치 권한을 켜고 교내에서 다시 시도하세요.',
  USERNAME_TAKEN: '이미 사용 중인 아이디입니다.',
  WEAK_PASSWORD: '비밀번호는 6자 이상이어야 합니다.',
  BAD_REQUEST: '입력값을 확인하세요. (아이디는 영문/숫자 3~20자)',
  BLOCKED: '차단된 사용자/기기입니다. 관리자에게 문의하세요.',
  ERROR: '가입 처리 중 오류가 발생했습니다. 잠시 후 다시 시도하세요.',
};

export default function Onboarding() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      // 위치 권한 → 좌표 (지오펜싱 서버검증용)
      setStatus('📍 위치 확인 중… (권한 요청에 응답해 주세요)');
      const { lat, lng, error: posError } = await getPosition();
      if (posError === 'DENIED') {
        setError('위치 권한이 필요합니다. 권한을 허용하고 다시 시도하세요.');
        return;
      }
      if (posError === 'UNAVAILABLE') {
        setStatus('⚠️ 위치를 가져오지 못해 코드로만 확인합니다…');
      }

      setStatus('🔐 가입 처리 중…');
      const deviceFp = await getDeviceFp();
      const res = await signup({ username, password, code, lat, lng, deviceFp });
      if (res.status !== 'OK') {
        setError(STATUS_MSG[res.status] || STATUS_MSG.ERROR);
        return;
      }

      // 가입 성공 → 곧바로 로그인 → 홈
      setStatus('✅ 가입 완료, 로그인 중…');
      await login(username, password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err.message || STATUS_MSG.ERROR);
    } finally {
      setSubmitting(false);
      setStatus('');
    }
  }

  return (
    <div className="onboarding">
      <div className="onboarding-header">
        <h1>애타</h1>
        <p>공군사관학교 강의정보 공유</p>
      </div>

      <form onSubmit={handleSubmit} className="onboarding-form">
        <label>
          아이디
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="영문/숫자 3~20자"
            autoCapitalize="none"
            autoComplete="username"
            required
          />
        </label>

        <label>
          비밀번호
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="6자 이상"
            autoComplete="new-password"
            minLength={6}
            required
          />
        </label>

        <label>
          가입코드
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="발급받은 코드"
            required
          />
        </label>

        {status && <p className="status-msg">{status}</p>}
        {error && <p className="error-msg">{error}</p>}

        <button type="submit" disabled={submitting}>
          {submitting ? '진행 중…' : '가입하기'}
        </button>
      </form>

      <p className="auth-switch">
        이미 계정이 있나요? <Link to="/login">로그인</Link>
      </p>
    </div>
  );
}
