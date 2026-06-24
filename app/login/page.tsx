"use client";

import { useState, useEffect, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { Button } from "@/components/ui/button";

type Tab  = "otp" | "password";
type View = "login" | "register" | "forgot" | "reset-sent" | "registered";

function EyeIcon({ open }: { open: boolean }) {
  return open ? (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
    </svg>
  ) : (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
    </svg>
  );
}

function LoginForm() {
  const searchParams = useSearchParams();
  const [tab,  setTab]  = useState<Tab>("otp");
  const [view, setView] = useState<View>("login");

  // 通用字段
  const [email,           setEmail]           = useState("");
  const [password,        setPassword]        = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPwd,         setShowPwd]         = useState(false);
  const [showConfirm,     setShowConfirm]     = useState(false);
  const [loading,         setLoading]         = useState(false);
  const [error,           setError]           = useState("");
  const [cooldown,        setCooldown]        = useState(0);
  const [unverifiedEmail, setUnverifiedEmail] = useState("");

  // OTP 专用
  const [otpStep, setOtpStep] = useState<"email" | "code">("email");
  const [digits,  setDigits]  = useState<string[]>(Array(8).fill(""));
  const digitRefs = useRef<(HTMLInputElement | null)[]>(Array(8).fill(null));

  // URL 里带了 error=auth_failed
  useEffect(() => {
    if (searchParams.get("error") === "auth_failed") {
      setError("链接已失效，请用验证码重新登录");
    }
  }, [searchParams]);

  // 60 秒倒计时
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  function getRedirectTarget() {
    const next = searchParams.get("next");
    return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  }

  function resetFields() {
    setPassword(""); setConfirmPassword(""); setError(""); setUnverifiedEmail("");
  }

  function switchTab(t: Tab) {
    setTab(t); setView("login"); setOtpStep("email");
    setDigits(Array(8).fill("")); setCooldown(0); resetFields();
  }

  // ── 重发注册验证邮件（密码注册流程）────────────────────────────────────
  async function resendVerification(emailToSend: string) {
    if (cooldown > 0 || loading) return;
    setLoading(true); setError("");
    const supabase = getSupabaseBrowserClient();
    const { error: err } = await supabase.auth.resend({ type: "signup", email: emailToSend });
    setLoading(false);
    if (err) setError(err.message); else setCooldown(60);
  }

  // ── OTP：发送验证码 ──────────────────────────────────────────────────────
  async function handleSendOtp(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || loading) return;
    setLoading(true); setError("");
    const supabase = getSupabaseBrowserClient();
    const { error: err } = await supabase.auth.signInWithOtp({ email: email.trim() });
    setLoading(false);
    if (err) {
      setError(err.message.includes("rate") ? "发送太频繁，请稍后再试" : "发送失败：" + err.message);
    } else {
      setOtpStep("code");
      setCooldown(60);
      setDigits(Array(8).fill(""));
      setTimeout(() => digitRefs.current[0]?.focus(), 150);
    }
  }

  // ── OTP：重新发送 ────────────────────────────────────────────────────────
  async function handleResendOtp() {
    if (cooldown > 0 || loading) return;
    setLoading(true); setError("");
    const supabase = getSupabaseBrowserClient();
    const { error: err } = await supabase.auth.signInWithOtp({ email: email.trim() });
    setLoading(false);
    if (err) {
      setError(err.message.includes("rate") ? "发送太频繁，请稍后再试" : "发送失败：" + err.message);
    } else {
      setCooldown(60);
      setDigits(Array(8).fill(""));
      setError("");
      setTimeout(() => digitRefs.current[0]?.focus(), 150);
    }
  }

  // ── OTP：校验验证码（接收 token 字符串，避免 state 陈旧）───────────────
  async function verifyOtpToken(token: string) {
    if (token.length !== 8 || loading) return;
    setLoading(true); setError("");
    const supabase = getSupabaseBrowserClient();
    const { error: err } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token,
      type: "email",
    });
    setLoading(false);
    if (err) {
      setError("验证码错误或已过期，请重新发送");
      setDigits(Array(8).fill(""));
      setTimeout(() => digitRefs.current[0]?.focus(), 50);
    } else {
      window.location.href = getRedirectTarget();
    }
  }

  // ── OTP：格子输入 ────────────────────────────────────────────────────────
  function handleDigitChange(index: number, value: string) {
    // 整段粘贴（如从短信复制 6 位）
    if (value.length > 1) {
      const pasted = value.replace(/\D/g, "").slice(0, 8);
      const next   = Array(8).fill("").map((_, i) => pasted[i] ?? "");
      setDigits(next);
      digitRefs.current[Math.min(pasted.length, 7)]?.focus();
      if (pasted.length === 8) verifyOtpToken(pasted);
      return;
    }
    const digit = value.replace(/\D/g, "");
    const next  = [...digits];
    next[index] = digit;
    setDigits(next);
    if (digit && index < 7) digitRefs.current[index + 1]?.focus();
    if (digit && index === 7) {
      const full = next.join("");
      if (full.length === 6) verifyOtpToken(full);
    }
  }

  function handleDigitKeyDown(index: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !digits[index] && index > 0) digitRefs.current[index - 1]?.focus();
    if (e.key === "ArrowLeft"  && index > 0) digitRefs.current[index - 1]?.focus();
    if (e.key === "ArrowRight" && index < 7) digitRefs.current[index + 1]?.focus();
  }

  // ── 邮箱密码登录 ──────────────────────────────────────────────────────────
  async function handlePasswordLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setLoading(true); setError(""); setUnverifiedEmail("");
    const supabase = getSupabaseBrowserClient();
    const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setLoading(false);
    if (err) {
      if (err.message.includes("Invalid login credentials")) {
        setError("邮箱或密码错误");
      } else if (err.message.toLowerCase().includes("email not confirmed")) {
        setUnverifiedEmail(email.trim());
      } else {
        setError(err.message);
      }
    } else {
      window.location.href = getRedirectTarget();
    }
  }

  // ── 注册 ──────────────────────────────────────────────────────────────────
  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password || !confirmPassword) return;
    if (password.length < 8)        { setError("密码至少需要 8 位"); return; }
    if (password !== confirmPassword) { setError("两次输入的密码不一致"); return; }
    setLoading(true); setError("");
    const supabase = getSupabaseBrowserClient();
    const { data, error: err } = await supabase.auth.signUp({
      email: email.trim(), password,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    setLoading(false);
    if (err) {
      setError(err.message);
    } else if (data.session) {
      window.location.href = getRedirectTarget();
    } else {
      setCooldown(60); setView("registered");
    }
  }

  // ── 忘记密码 ──────────────────────────────────────────────────────────────
  async function handleForgotPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true); setError("");
    const supabase = getSupabaseBrowserClient();
    const { error: err } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/auth/callback?redirectTo=/reset-password`,
    });
    setLoading(false);
    if (err) setError(err.message); else setView("reset-sent");
  }

  // ── 全屏特殊状态 ──────────────────────────────────────────────────────────
  if (view === "reset-sent") return (
    <div className="bg-white rounded-2xl p-8 shadow-sm text-center">
      <div className="text-5xl mb-4">📨</div>
      <h2 className="text-lg font-semibold text-gray-800 mb-2">重置链接已发送</h2>
      <p className="text-sm text-gray-500">已向 <strong className="text-gray-700">{email}</strong> 发送了密码重置链接</p>
      <p className="text-xs text-gray-400 mt-3">没收到？检查垃圾邮件，或</p>
      <button className="mt-1 text-sm text-blue-500 hover:underline"
        onClick={() => { setView("forgot"); setError(""); }}>重新发送</button>
    </div>
  );

  if (view === "registered") return (
    <div className="bg-white rounded-2xl p-8 shadow-sm text-center">
      <div className="text-5xl mb-4">📧</div>
      <h2 className="text-lg font-semibold text-gray-800 mb-2">验证邮件已发送</h2>
      <p className="text-sm text-gray-500 mb-1">
        已向 <strong className="text-gray-700">{email}</strong> 发送了验证邮件
      </p>
      <p className="text-sm text-gray-400 mb-5">请查收邮件并点击验证链接</p>
      {error && (
        <p className="text-sm text-red-500 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">❌ {error}</p>
      )}
      <div className="space-y-2">
        <button
          onClick={() => resendVerification(email)}
          disabled={cooldown > 0 || loading}
          className="w-full px-4 py-2.5 text-sm rounded-xl bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {cooldown > 0 ? `重新发送（${cooldown}s）` : loading ? "发送中…" : "重新发送验证邮件"}
        </button>
        <button
          onClick={() => { setView("login"); resetFields(); setCooldown(0); }}
          className="w-full px-4 py-2.5 text-sm rounded-xl border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
        >
          返回登录
        </button>
      </div>
    </div>
  );

  const inputCls = "w-full rounded-xl border border-gray-200 px-4 py-3 text-base outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:opacity-50";
  const errEl = error && (
    <p className="text-sm text-red-500 bg-red-50 border border-red-200 rounded-lg px-3 py-2">❌ {error}</p>
  );

  return (
    <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
      {/* Tab 切换 */}
      <div className="flex border-b border-gray-100">
        {(["otp", "password"] as Tab[]).map(t => (
          <button key={t} onClick={() => switchTab(t)}
            className={`flex-1 py-3.5 text-sm font-medium transition-colors ${
              tab === t ? "text-blue-600 border-b-2 border-blue-600 bg-white"
                        : "text-gray-500 hover:text-gray-700"}`}>
            {t === "otp" ? "验证码登录" : "邮箱密码登录"}
          </button>
        ))}
      </div>

      <div className="p-6">

        {/* ── 验证码登录 ── */}
        {tab === "otp" && otpStep === "email" && (
          <form onSubmit={handleSendOtp} className="space-y-3">
            <h2 className="text-base font-semibold text-gray-800 mb-1">验证码登录</h2>
            <p className="text-sm text-gray-500 mb-4">
              输入邮箱，我们将发送 8 位验证码，无需密码即可登录
            </p>
            <input
              type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="your@email.com" required disabled={loading}
              className={inputCls}
            />
            {errEl}
            <Button type="submit" size="lg" className="w-full" disabled={loading || !email.trim()}>
              {loading ? "发送中…" : "发送验证码"}
            </Button>
            <p className="text-xs text-center text-gray-400 pt-1">
              没有账号？输入邮箱发送验证码后会自动创建
            </p>
          </form>
        )}

        {tab === "otp" && otpStep === "code" && (
          <div className="space-y-5">
            <div>
              <h2 className="text-base font-semibold text-gray-800 mb-1">输入验证码</h2>
              <p className="text-sm text-gray-500">
                已发送到 <strong className="text-gray-700">{email}</strong>，10 分钟内有效
              </p>
            </div>

            {/* 6 个独立格子 */}
            <div className="flex gap-2 justify-center">
              {digits.map((d, i) => (
                <input
                  key={i}
                  ref={el => { digitRefs.current[i] = el; }}
                  type="text"
                  inputMode="numeric"
                  maxLength={8}
                  value={d}
                  onChange={e => handleDigitChange(i, e.target.value)}
                  onKeyDown={e => handleDigitKeyDown(i, e)}
                  onFocus={e => e.target.select()}
                  disabled={loading}
                  className={`w-11 h-14 text-center text-2xl font-bold border-2 rounded-xl outline-none transition-colors disabled:opacity-50
                    ${d ? "border-blue-400 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-800"}
                    focus:border-blue-500 focus:ring-2 focus:ring-blue-100`}
                />
              ))}
            </div>

            {loading && (
              <p className="text-center text-sm text-gray-400 animate-pulse">验证中…</p>
            )}
            {errEl}

            <div className="flex flex-col items-center gap-2.5 text-sm pt-1">
              <button
                type="button"
                onClick={handleResendOtp}
                disabled={cooldown > 0 || loading}
                className="text-blue-500 hover:text-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {cooldown > 0 ? `重新发送（${cooldown}s）` : "重新发送验证码"}
              </button>
              <button
                type="button"
                onClick={() => { setOtpStep("email"); setDigits(Array(8).fill("")); setError(""); setCooldown(0); }}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                修改邮箱
              </button>
            </div>
          </div>
        )}

        {/* ── 邮箱密码登录 ── */}
        {tab === "password" && view === "login" && (
          <form onSubmit={handlePasswordLogin} className="space-y-3">
            <h2 className="text-base font-semibold text-gray-800 mb-4">登录账号</h2>
            <input type="email" value={email}
              onChange={e => { setEmail(e.target.value); setUnverifiedEmail(""); }}
              placeholder="your@email.com" required disabled={loading} className={inputCls} />
            <div className="relative">
              <input type={showPwd ? "text" : "password"} value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="密码" required disabled={loading} className={inputCls + " pr-12"} />
              <button type="button" onClick={() => setShowPwd(!showPwd)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                <EyeIcon open={showPwd} />
              </button>
            </div>
            {errEl}
            {unverifiedEmail && (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm">
                <p className="text-amber-700 mb-2">
                  📧 请先验证邮箱，验证邮件已发送到 <strong>{unverifiedEmail}</strong>
                </p>
                <button type="button" onClick={() => resendVerification(unverifiedEmail)}
                  disabled={cooldown > 0 || loading}
                  className="text-blue-500 hover:underline disabled:opacity-50">
                  {cooldown > 0 ? `重新发送（${cooldown}s）` : "没收到？点击重新发送"}
                </button>
              </div>
            )}
            <Button type="submit" size="lg" className="w-full"
              disabled={loading || !email.trim() || !password}>
              {loading ? "登录中…" : "登录"}
            </Button>
            <div className="flex justify-between text-sm pt-1">
              <button type="button" onClick={() => { setView("forgot"); setError(""); }}
                className="text-gray-400 hover:text-blue-500 transition-colors">忘记密码？</button>
              <button type="button" onClick={() => { setView("register"); resetFields(); }}
                className="text-blue-500 hover:text-blue-600 transition-colors">没有账号？点击注册</button>
            </div>
          </form>
        )}

        {/* ── 注册 ── */}
        {tab === "password" && view === "register" && (
          <form onSubmit={handleRegister} className="space-y-3">
            <h2 className="text-base font-semibold text-gray-800 mb-4">创建账号</h2>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="your@email.com" required disabled={loading} className={inputCls} />
            <div className="relative">
              <input type={showPwd ? "text" : "password"} value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="密码（至少 8 位）" required disabled={loading}
                className={inputCls + " pr-12"} />
              <button type="button" onClick={() => setShowPwd(!showPwd)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                <EyeIcon open={showPwd} />
              </button>
            </div>
            <div className="relative">
              <input type={showConfirm ? "text" : "password"} value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                placeholder="再次输入密码" required disabled={loading}
                className={inputCls + " pr-12"} />
              <button type="button" onClick={() => setShowConfirm(!showConfirm)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                <EyeIcon open={showConfirm} />
              </button>
            </div>
            {errEl}
            <Button type="submit" size="lg" className="w-full"
              disabled={loading || !email.trim() || !password || !confirmPassword}>
              {loading ? "注册中…" : "注册"}
            </Button>
            <div className="text-center pt-1">
              <button type="button" onClick={() => { setView("login"); resetFields(); }}
                className="text-sm text-gray-400 hover:text-blue-500 transition-colors">已有账号？返回登录</button>
            </div>
          </form>
        )}

        {/* ── 忘记密码 ── */}
        {tab === "password" && view === "forgot" && (
          <form onSubmit={handleForgotPassword} className="space-y-3">
            <h2 className="text-base font-semibold text-gray-800 mb-1">重置密码</h2>
            <p className="text-sm text-gray-500 mb-4">输入注册邮箱，我们会发送重置链接</p>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="your@email.com" required disabled={loading} className={inputCls} />
            {errEl}
            <Button type="submit" size="lg" className="w-full" disabled={loading || !email.trim()}>
              {loading ? "发送中…" : "发送重置链接"}
            </Button>
            <div className="text-center pt-1">
              <button type="button" onClick={() => { setView("login"); setError(""); }}
                className="text-sm text-gray-400 hover:text-blue-500 transition-colors">返回登录</button>
            </div>
          </form>
        )}

      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <span className="text-5xl">🔬</span>
          <h1 className="mt-3 text-2xl font-bold text-gray-800">AI 科研助手</h1>
          <p className="mt-1 text-sm text-gray-500">帮你更高效地读论文</p>
        </div>
        <Suspense fallback={<div className="bg-white rounded-2xl p-8 shadow-sm text-center text-gray-400">加载中…</div>}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
