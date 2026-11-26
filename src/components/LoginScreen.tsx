import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { DISABLE_EMAIL_SUGGEST, apiRequestToken, apiVerifyToken } from '../api';
import type { AppMeta } from '../types';
import { ErrorBanner } from './ErrorBanner';

const COMPANY_LOGO_URL =
  'https://res.cloudinary.com/dorqvdstv/image/upload/v1785116299/AN_Logo_Color_xzz9l2.png';

interface LoginScreenProps {
  onLoginSuccess: (session: string, meta?: AppMeta) => void;
  isOverlay?: boolean;
}

function formatCountdown(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const mins = Math.floor(clamped / 60);
  const secs = clamped % 60;
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

export function LoginScreen({
  onLoginSuccess,
  isOverlay = false,
}: LoginScreenProps) {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [codeFocused, setCodeFocused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logoFailed, setLogoFailed] = useState(false);

  // Timers for Step 2: 3:00 validity countdown & 30s resend cooldown
  const [validSeconds, setValidSeconds] = useState(180);
  const [resendCooldown, setResendCooldown] = useState(30);

  const codeInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (step !== 'code') return;
    const interval = window.setInterval(() => {
      setValidSeconds((prev) => (prev > 0 ? prev - 1 : 0));
      setResendCooldown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [step]);

  useEffect(() => {
    if (step === 'code') {
      requestAnimationFrame(() => {
        codeInputRef.current?.focus();
      });
    }
  }, [step]);

  async function handleSendCode(e: FormEvent) {
    e.preventDefault();
    if (loading) return;
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError('Please enter your email address.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await apiRequestToken(trimmedEmail);
      setEmail(trimmedEmail);
      setCode('');
      setValidSeconds(180);
      setResendCooldown(30);
      setStep('code');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send code.');
    } finally {
      setLoading(false);
    }
  }

  async function handleResendCode() {
    if (resending || loading || resendCooldown > 0) return;
    setResending(true);
    setError(null);
    try {
      await apiRequestToken(email.trim());
      setValidSeconds(180);
      setResendCooldown(30);
      requestAnimationFrame(() => {
        codeInputRef.current?.focus();
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to send a new code.'
      );
    } finally {
      setResending(false);
    }
  }

  async function handleVerifyCode(e: FormEvent) {
    e.preventDefault();
    if (loading || code.length !== 6) return;

    setLoading(true);
    setError(null);
    try {
      const res = await apiVerifyToken(email.trim(), code);
      if (!res.session) {
        setError('Server did not return a session.');
        return;
      }
      if (!isOverlay && (!res.meta || !Array.isArray(res.meta.order) || !res.meta.blocks)) {
        setError('Server returned incomplete metadata.');
        return;
      }
      onLoginSuccess(res.session, res.meta);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed.');
    } finally {
      setLoading(false);
    }
  }

  function handleCodeChange(raw: string) {
    const digitsOnly = raw.replace(/\D/g, '').slice(0, 6);
    setCode(digitsOnly);
  }

  function handleUseAnotherEmail() {
    setError(null);
    setCode('');
    setStep('email');
  }

  const activeBoxIndex = Math.min(code.length, 5);

  const card = (
    <div className="glass-panel relative z-10 w-full max-w-sm p-6 sm:p-8">
      <div className="mb-6 flex flex-col items-center text-center">
        {!logoFailed && (
          <img
            src={COMPANY_LOGO_URL}
            alt="Company logo"
            referrerPolicy="no-referrer"
            onError={() => setLogoFailed(true)}
            className="mb-3 h-[28px] sm:h-[32px] w-auto object-contain"
          />
        )}
        <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-[#1d1d1f]">
          Testing Report
        </h1>
        {isOverlay && (
          <p className="mt-1.5 text-[12px] leading-relaxed text-[#525257]">
            Your session expired. Sign in to continue without losing your work.
          </p>
        )}
      </div>

      {error && (
        <div className="mb-4">
          <ErrorBanner message={error} onDismiss={() => setError(null)} />
        </div>
      )}

      {step === 'email' ? (
        <form
          onSubmit={handleSendCode}
          autoComplete={DISABLE_EMAIL_SUGGEST ? 'off' : undefined}
          className="space-y-4"
        >
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="login-email"
              className="px-1 text-[11px] font-medium uppercase tracking-[0.04em] text-[#86868b]"
            >
              Email
            </label>
            <input
              id="login-email"
              name={DISABLE_EMAIL_SUGGEST ? 'tr-login-id-x1' : undefined}
              type={DISABLE_EMAIL_SUGGEST ? 'text' : 'email'}
              inputMode="email"
              autoComplete={DISABLE_EMAIL_SUGGEST ? 'off' : 'email'}
              autoCapitalize={DISABLE_EMAIL_SUGGEST ? 'none' : undefined}
              autoCorrect={DISABLE_EMAIL_SUGGEST ? 'off' : undefined}
              spellCheck={DISABLE_EMAIL_SUGGEST ? false : undefined}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Enter your email"
              autoFocus
              disabled={loading}
              className="glass-input h-11 w-full px-3.5 text-[16px] sm:text-[13px] placeholder:text-[#86868b] disabled:opacity-60"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="glass-btn-primary flex h-10 w-full items-center justify-center gap-2 px-5 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading && (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            )}
            <span>{loading ? 'Sending...' : 'Send code'}</span>
          </button>
        </form>
      ) : (
        <form onSubmit={handleVerifyCode} className="space-y-4">
          <p className="text-center text-[13px] text-[#525257] leading-relaxed break-words">
            We sent a 6-digit code to{' '}
            <span className="font-semibold text-[#1d1d1f]">{email}</span>
          </p>

          {/* 6 digit boxes driven by ONE real text input stretched over them */}
          <div className="relative">
            <div
              className="grid grid-cols-6 gap-2"
              aria-hidden="true"
            >
              {[0, 1, 2, 3, 4, 5].map((idx) => {
                const digit = code[idx] ?? '';
                const isActive = codeFocused && activeBoxIndex === idx;
                return (
                  <div
                    key={idx}
                    className={`flex h-12 items-center justify-center rounded-[12px] border text-[18px] font-semibold text-[#1d1d1f] font-mono-num transition-all ${
                      isActive
                        ? 'border-[#00227A] bg-white/[0.94] shadow-[0_0_0_3px_rgba(0,34,122,0.14)]'
                        : digit
                          ? 'border-[#00227A]/45 bg-white/80'
                          : 'border-black/[0.08] bg-white/65'
                    }`}
                  >
                    {digit}
                  </div>
                );
              })}
            </div>

            <input
              ref={codeInputRef}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => handleCodeChange(e.target.value)}
              onFocus={() => setCodeFocused(true)}
              onBlur={() => setCodeFocused(false)}
              disabled={loading}
              aria-label="6-digit verification code"
              className="absolute inset-0 z-10 h-full w-full cursor-text bg-transparent text-transparent caret-transparent selection:bg-transparent focus:outline-none"
            />
          </div>

          <p className="text-center text-[12px] font-medium text-[#86868b] font-mono-num">
            Code valid for {formatCountdown(validSeconds)}
          </p>

          <button
            type="submit"
            disabled={loading || code.length !== 6}
            className="glass-btn-primary flex h-10 w-full items-center justify-center gap-2 px-5 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading && (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            )}
            <span>{loading ? 'Logging in...' : 'Log in'}</span>
          </button>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[13px]">
            <button
              type="button"
              onClick={handleResendCode}
              disabled={resendCooldown > 0 || resending || loading}
              className="min-h-[36px] font-medium text-[#00227A] hover:text-[#0a35a3] hover:underline underline-offset-2 transition-colors disabled:cursor-not-allowed disabled:text-[#86868b] disabled:no-underline font-mono-num"
            >
              {resending
                ? 'Sending...'
                : resendCooldown > 0
                  ? `Send a new code (${resendCooldown}s)`
                  : 'Send a new code'}
            </button>

            <button
              type="button"
              onClick={handleUseAnotherEmail}
              disabled={loading || resending}
              className="min-h-[36px] font-medium text-[#525257] hover:text-[#1d1d1f] hover:underline underline-offset-2 transition-colors disabled:opacity-50"
            >
              Use another email
            </button>
          </div>
        </form>
      )}
    </div>
  );

  if (isOverlay) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
        role="dialog"
        aria-modal="true"
        aria-label="Session expired login"
      >
        {card}
      </div>
    );
  }

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-between px-4 py-8">
      <div className="flex w-full flex-1 items-center justify-center py-4">
        {card}
      </div>

      <footer className="relative z-10 py-4 text-center text-[12px] text-[#86868b]">
        Developed by Zack Lu
      </footer>
    </div>
  );
}
