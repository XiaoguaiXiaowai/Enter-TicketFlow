import { useState, type FormEvent } from 'react';

import { ApiError } from '../lib/api';
import { useAuth } from '../auth/AuthContext';

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'AUTH_INVALID_CREDENTIALS') {
      return '账号、密码或租户不匹配';
    }
    if (error.code === 'VALIDATION_FAILED') {
      return '请检查邮箱、密码与租户编码格式';
    }
    return `${error.message}（${error.code}）`;
  }
  return '网络异常，请稍后重试';
}

export function LoginPage() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tenantCode, setTenantCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signIn({ email: email.trim(), password, tenantCode: tenantCode.trim() });
    } catch (submitError: unknown) {
      setError(errorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="panel auth-panel">
      <h1>登录</h1>
      <p className="lead">使用企业邮箱登录，租户编码决定进入哪个租户。</p>

      <form className="form" onSubmit={(event) => void handleSubmit(event)} data-testid="login-form">
        <label className="form-field">
          <span>邮箱</span>
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            data-testid="login-email"
            required
          />
        </label>

        <label className="form-field">
          <span>密码</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            data-testid="login-password"
            required
          />
        </label>

        <label className="form-field">
          <span>租户编码</span>
          <input
            type="text"
            placeholder="例如 tenant-a"
            value={tenantCode}
            onChange={(event) => setTenantCode(event.target.value)}
            data-testid="login-tenant"
            required
          />
        </label>

        {error !== null ? (
          <p className="form-error" role="alert" data-testid="login-error">
            {error}
          </p>
        ) : null}

        <button type="submit" className="button" disabled={submitting} data-testid="login-submit">
          {submitting ? '登录中…' : '登录'}
        </button>
      </form>
    </section>
  );
}
