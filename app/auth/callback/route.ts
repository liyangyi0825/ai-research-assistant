// 魔法链接登录回调
// 用户点击邮件里的链接后，Supabase 会带着 code 参数跳到这个地址
// 这里把 code 换成真正的 session（写入 cookie），然后跳到首页

import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (code) {
    // 先创建好跳转到首页的 response
    const response = NextResponse.redirect(`${origin}/`);

    // 把 cookie 直接写进这个 response，确保浏览器能收到
    const supabase = createServerClient(
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

    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return response; // 带着 session cookie 一起跳到首页
    }
  }

  // code 不存在或兑换失败，回到登录页并显示错误
  return NextResponse.redirect(`${origin}/login?error=auth_failed`);
}
