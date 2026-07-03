import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { signup, login, getPosition } from '../lib/auth';
import LocationHelp from '../components/LocationHelp';

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
  const [geoFailed, setGeoFailed] = useState(false); // 위치 실패 → 권한 안내 링크 노출
  const [showGeoHelp, setShowGeoHelp] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setGeoFailed(false);
    setSubmitting(true);
    try {
      // 위치 권한 → 좌표 (지오펜싱 필수)
      setStatus('📍 위치 확인 중… (권한 요청에 응답해 주세요)');
      const { lat, lng, error: geoErr } = await getPosition();
      if (lat == null || lng == null) {
        setGeoFailed(true);
        setError(
          geoErr === 'DENIED'
            ? '위치 권한이 거부되어 있어 확인할 수 없어요. 아래 방법대로 권한을 켠 뒤 다시 시도해주세요.'
            : '위치를 확인하지 못했어요. 기기의 위치(GPS)를 켜고 다시 시도해주세요.'
        );
        return;
      }

      setStatus('🔐 가입 처리 중…');
      const res = await signup({ username, password, code, lat, lng });
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
        <span className="onboarding-logo">애</span>
        <h1 className="onboarding-title">애타</h1>
        <p className="onboarding-subtitle">공군사관학교 강의정보 공유</p>
      </div>

      <form onSubmit={handleSubmit} className="card auth-card onboarding-form">
        <label className="field">
          <span className="field-label">아이디</span>
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

        <label className="field">
          <span className="field-label">비밀번호</span>
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

        <label className="field">
          <span className="field-label">가입코드</span>
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="발급받은 코드"
            required
          />
        </label>

        <div className="auth-actions">
          {status && <p className="status-msg">{status}</p>}
          {error && <p className="error-msg">{error}</p>}
          {geoFailed && (
            <button type="button" className="link-btn" onClick={() => setShowGeoHelp(true)}>
              📍 위치 권한 켜는 방법 보기
            </button>
          )}

          <button type="submit" className="btn-add btn-block btn-lg" disabled={submitting}>
            {submitting ? '진행 중…' : '가입하기'}
          </button>
        </div>
      </form>

      {showGeoHelp && <LocationHelp onClose={() => setShowGeoHelp(false)} />}

      <p className="auth-switch">
        이미 계정이 있나요? <Link to="/login">로그인</Link>
      </p>
    </div>
  );
}
