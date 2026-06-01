// 魔法链接登录回调
// 用户点击邮件里的链接后，Supabase 会带着 code 参数跳到这个地址
// 这里把 code 换成真正的 session（写入 cookie），然后跳到首页

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (code) {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          },
        },
      }
    );

    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // 登录成功，跳到首页
      return NextResponse.redirect(`${origin}/`);
    }
  }

  // code 不存在或兑换失败，回到登录页并显示错误
  return NextResponse.redirect(`${origin}/login?error=auth_failed`);
}
