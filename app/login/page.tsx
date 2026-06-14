"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { Button } from "@/components/ui/button";

type Tab  = "password" | "magic";
type View = "login" | "register" | "forgot" | "reset-sent" | "magic-sent" | "registered";

// 眼睛图标
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
  const [tab,  setTab]  = useState<Tab>("password");
  const [view, setView] = useState<View>("login");

  const [email,           setEmail]           = useState("");
  const [password,        setPassword]        = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPwd,         setShowPwd]         = useState(false);
  const [showConfirm,     setShowConfirm]     = useState(false);
  const [loading,         setLoading]         = useState(false);
  const [error,           setError]           = useState("");

  // URL 里带了 error=auth_failed 时显示提示
  useEffect(() => {
    if (searchParams.get("error") === "auth_failed") {
      setError("登录链接已失效或过期，请重新发送");
    }
  }, [searchParams]);

  // 邮件发出后监听另一个标签页登录完成的广播
  useEffect(() => {
    if (view !== "magic-sent") return;
    let ch: BroadcastChannel | null = null;
    try {
      ch = new BroadcastChannel("supabase_auth");
      ch.addEventListener("message", (e) => {
        if (e.data?.type === "LOGIN_SUCCESS") window.location.href = e.data.redirectTo || "/";
      });
    } catch { /* 不支持时忽略 */ }
    return () => { ch?.close(); };
  }, [view]);

  function getRedirectTarget() {
    const next = searchParams.get("next");
    return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  }

  function resetFields() {
    setPassword(""); setConfirmPassword(""); setError("");
  }

  function switchTab(t: Tab) {
    setTab(t); setView("login"); resetFields();
  }

  // ── 邮箱密码登录 ──────────────────────────────────────────────────────
  async function handlePasswordLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setLoading(true); setError("");
    const supabase = getSupabaseBrowserClient();
    const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setLoading(false);
    if (err) {
      setError(err.message.includes("Invalid login credentials") ? "邮箱或密码错误" : err.message);
    } else {
      window.location.href = getRedirectTarget();
    }
  }

  // ── 注册 ──────────────────────────────────────────────────────────────
  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password || !confirmPassword) return;
    if (password.length < 8)       { setError("密码至少需要 8 位"); return; }
    if (password !== confirmPassword) { setError("两次输入的密码不一致"); return; }
    setLoading(true); setError("");
    const supabase = getSupabaseBrowserClient();
    const { data, error: err } = await supabase.auth.signUp({ email: email.trim(), password });
    setLoading(false);
    if (err) {
      setError(err.message);
    } else if (data.session) {
      // 邮箱确认已关闭，直接登录
      window.location.href = getRedirectTarget();
    } else {
      // 需要邮件确认
      setView("registered");
    }
  }

  // ── 忘记密码 ──────────────────────────────────────────────────────────
  async function handleForgotPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true); setError("");
    const supabase = getSupabaseBrowserClient();
    const { error: err } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/auth/callback?redirectTo=/reset-password`,
    });
    setLoading(false);
    if (err) setError(err.message);
    else setView("reset-sent");
  }

  // ── 邮件链接登录 ──────────────────────────────────────────────────────
  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true); setError("");
    const supabase = getSupabaseBrowserClient();
    const { error: err } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback?redirectTo=${encodeURIComponent(getRedirectTarget())}`,
      },
    });
    setLoading(false);
    if (err) setError(err.message);
    else setView("magic-sent");
  }

  // ── 全屏特殊状态（不显示 Tab）────────────────────────────────────────
  if (view === "magic-sent") return (
    <div className="bg-white rounded-2xl p-8 shadow-sm text-center">
      <div className="text-5xl mb-4">📬</div>
      <h2 className="text-lg font-semibold text-gray-800 mb-2">邮件已发送！</h2>
      <p className="text-sm text-gray-500 mb-1">已向 <strong className="text-gray-700">{email}</strong> 发送了登录链接</p>
      <p className="text-sm text-gray-400">点击邮件里的按钮即可登录，链接 10 分钟内有效</p>
      <p className="text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2 mt-3">
        ⚠️ 请在<strong>同一台设备同一个浏览器</strong>里点击链接
      </p>
      <button className="mt-4 text-sm text-blue-500 hover:underline" onClick={() => setView("login")}>重新发送</button>
    </div>
  );

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
      <div className="text-5xl mb-4">✅</div>
      <h2 className="text-lg font-semibold text-gray-800 mb-2">注册成功！</h2>
      <p className="text-sm text-gray-500">请查看邮箱 <strong className="text-gray-700">{email}</strong></p>
      <p className="text-sm text-gray-400 mt-1">点击邮件里的确认链接后即可登录</p>
      <button className="mt-4 text-sm text-blue-500 hover:underline"
        onClick={() => { setView("login"); resetFields(); }}>返回登录</button>
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
        {(["password", "magic"] as Tab[]).map((t) => (
          <button key={t} onClick={() => switchTab(t)}
            className={`flex-1 py-3.5 text-sm font-medium transition-colors ${
              tab === t ? "text-blue-600 border-b-2 border-blue-600 bg-white"
                        : "text-gray-500 hover:text-gray-700"}`}>
            {t === "password" ? "邮箱密码登录" : "邮件链接登录"}
          </button>
        ))}
      </div>

      <div className="p-6">
        {/* ── 密码登录 ── */}
        {tab === "password" && view === "login" && (
          <form onSubmit={handlePasswordLogin} className="space-y-3">
            <h2 className="text-base font-semibold text-gray-800 mb-4">登录账号</h2>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
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
            <Button type="submit" size="lg" className="w-full"
              disabled={loading || !email.trim()}>
              {loading ? "发送中…" : "发送重置链接"}
            </Button>
            <div className="text-center pt-1">
              <button type="button" onClick={() => { setView("login"); setError(""); }}
                className="text-sm text-gray-400 hover:text-blue-500 transition-colors">返回登录</button>
            </div>
          </form>
        )}

        {/* ── 邮件链接登录 ── */}
        {tab === "magic" && (
          <form onSubmit={handleMagicLink} className="space-y-3">
            <h2 className="text-base font-semibold text-gray-800 mb-1">邮件链接登录</h2>
            <p className="text-sm text-gray-500 mb-4">输入邮箱，收到邮件后点击链接即可登录，无需密码</p>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="your@email.com" required disabled={loading} className={inputCls} />
            {errEl}
            <Button type="submit" size="lg" className="w-full"
              disabled={loading || !email.trim()}>
              {loading ? "发送中…" : "发送登录链接"}
            </Button>
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
