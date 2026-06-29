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
      // Supabase 는 잘못된 자격증명에 invalid_login_credentials 류 메시지를 준다.
      setError(/credential|invalid/i.test(err.message)
        ? '아이디 또는 비밀번호가 올바르지 않습니다.'
        : err.message || '로그인에 실패했습니다.');
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
    </div>
  );
}
