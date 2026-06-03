// 路由保护中间件
// ─ 未登录用户访问任何页面 → 自动跳转到 /login
// ─ /login 和 /auth/* 本身不需要登录，不会被拦截
// ─ /api/* 不经过这里，由各 API 路由自己处理

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  // Supabase 未配置时直接放行（开发阶段安全降级）
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.next({ request });
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
        // 把新 cookie 先写进 request（供后续中间件读取）
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value)
        );
        // 再写进 response（返回给浏览器）
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          supabaseResponse.cookies.set(name, value, options as any)
        );
      },
    },
  });

  // 获取当前用户（同时刷新过期的 session）
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // 这些路径不需要登录
  const isPublicPath =
    pathname.startsWith("/login") ||
    pathname.startsWith("/auth");

  // ⚠️ 登录功能暂时关闭，所有人可直接访问，无需登录
  // 恢复时取消下面的注释，并删除这行说明
  /*
  // 未登录 + 访问需要登录的页面 → 跳转到登录页
  if (!user && !isPublicPath) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    return NextResponse.redirect(loginUrl);
  }

  // 已登录 + 访问登录页 → 跳转到首页（避免重复登录）
  if (user && pathname === "/login") {
    const homeUrl = request.nextUrl.clone();
    homeUrl.pathname = "/";
    return NextResponse.redirect(homeUrl);
  }
  */

  return supabaseResponse;
}

export const config = {
  matcher: [
    // 拦截所有路径，排除静态资源、图片优化和 API 路由
    "/((?!_next/static|_next/image|favicon.ico|api/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
