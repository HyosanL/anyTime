import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { login } from '../lib/auth';

export default function Login() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await login(username, password);
      navigate('/', { replace: true });
    } catch (err) {
      // 실패 사유는 구분하지 않는다 — 아이디 존재 여부를 노출하지 않기 위해(이메일 열거
      // 보호를 켜면 Firebase 도 no-such-user / wrong-password 를 auth/invalid-credential
      // 하나로 합친다). rate limit / 네트워크만 별도 안내.
      const code = err.code || '';
      if (code === 'auth/too-many-requests') {
        setError('시도가 너무 많습니다. 잠시 후 다시 시도하세요.');
      } else if (code === 'auth/network-request-failed') {
        setError('네트워크 오류입니다. 연결을 확인하고 다시 시도하세요.');
      } else {
        setError('아이디 또는 비밀번호가 올바르지 않습니다.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="onboarding">
      <div className="onboarding-header">
        <span className="onboarding-logo">애</span>
        <h1 className="onboarding-title">애타</h1>
        <p className="onboarding-subtitle">다시 만나서 반가워요. 로그인하세요.</p>
      </div>

      <form onSubmit={handleSubmit} className="card auth-card onboarding-form">
        <label className="field">
          <span className="field-label">아이디</span>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="아이디"
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
            placeholder="비밀번호"
            autoComplete="current-password"
            required
          />
        </label>

        <div className="auth-actions">
          {error && <p className="error-msg">{error}</p>}

          <button type="submit" className="btn-add btn-block btn-lg" disabled={submitting}>
            {submitting ? '로그인 중...' : '로그인'}
          </button>
        </div>
      </form>

      <p className="auth-switch">
        계정이 없나요? <Link to="/signup">가입하기</Link>
      </p>

      <Link to="/about" className="btn-ghost btn-block auth-about">
        📖 애타는 어떤 앱인가요?
      </Link>
    </div>
  );
}
