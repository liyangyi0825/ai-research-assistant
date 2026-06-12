// 魔法链接登录回调
// Supabase 支持两种回调参数格式：
//   1. code（PKCE 流程，OAuth 等）→ 用 exchangeCodeForSession
//   2. token_hash + type（Magic Link / 邮件 OTP）→ 用 verifyOtp
// 两种都要处理，否则魔法链接登录会失败

import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";

export async function GET(request: NextRequest) {
  const { searchParams, origin: requestOrigin } = new URL(request.url);
  // 生产环境经过 Nginx 反向代理后 request.url 是 localhost:3000，
  // 用 NEXT_PUBLIC_SITE_URL 覆盖，确保跳转到正确的域名
  const origin = process.env.NEXT_PUBLIC_SITE_URL || requestOrigin;
  const code = searchParams.get("code");
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  // ── 诊断日志（排查问题后可删除）──────────────────────────────────
  console.log("[auth/callback] 收到回调，完整 URL:", request.url);
  console.log("[auth/callback] redirectTo 参数:", searchParams.get("redirectTo"));
  console.log("[auth/callback] code:", code ? "有" : "无");
  console.log("[auth/callback] token_hash:", token_hash ? "有" : "无");
  console.log("[auth/callback] type:", type);
  // ─────────────────────────────────────────────────────────────────

  // 读取登录前的来源页面，登录成功后跳回去；没有则跳首页
  const rawRedirect = searchParams.get("redirectTo") ?? "/";
  // 只允许站内路径（以 / 开头且不是 //），防止开放重定向
  const redirectPath = rawRedirect.startsWith("/") && !rawRedirect.startsWith("//")
    ? rawRedirect
    : "/";
  const successUrl = `${origin}${redirectPath}?loginSuccess=1`;
  console.log("[auth/callback] 将跳转到:", successUrl);

  // 工厂函数：创建一个把 cookie 写进指定 response 的 Supabase 客户端
  function makeSupabase(response: NextResponse) {
    return createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
            cookiesToSet.forEach(({ name, value, options }) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              response.cookies.set(name, value, options as any);
            });
          },
        },
      }
    );
  }

  // ── 情况 1：PKCE 授权码流程 ──────────────────────────────────────
  if (code) {
    const response = NextResponse.redirect(successUrl);
    const supabase = makeSupabase(response);
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return response;
  }

  // ── 情况 2：Magic Link / 邮件 OTP（token_hash 流程）──────────────
  if (token_hash && type) {
    const response = NextResponse.redirect(successUrl);
    const supabase = makeSupabase(response);
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });
    if (!error) return response;
  }

  // 两种都失败 → 回登录页并显示错误
  return NextResponse.redirect(`${origin}/login?error=auth_failed`);
}
