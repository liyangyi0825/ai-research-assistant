// Supabase 客户端工具
// ─ getSupabaseClient()        简单客户端，无 session，用于反馈等不需要鉴权的接口
// ─ getSupabaseAuthClient()    Session 感知客户端，从 Cookie 读取登录状态，用于 AI 接口
// ─ recordUsage()              记录一次 AI 用量到 usage 表

import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

function getEnvVars() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";
  return { url, key };
}

/** 简单客户端（不含用户 session）—— 反馈接口等使用 */
export function getSupabaseClient() {
  const { url, key } = getEnvVars();
  if (!url || !key) return null;
  return createClient(url, key);
}

/**
 * 记录一次 AI 用量到 usage 表
 * 失败时只打印日志，不影响主请求
 */
export async function recordUsage(actionType: "summarize" | "chat") {
  try {
    const supabase = await getSupabaseAuthClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return; // 未登录用户不记录

    const { error } = await supabase.from("usage").insert({
      user_id: user.id,
      action_type: actionType,
    });
    if (error) console.error("用量写入失败:", error.message);
  } catch (err) {
    console.error("用量记录异常:", err);
  }
}

/**
 * Session 感知客户端（从 Cookie 读取登录用户）
 * 用于需要知道"当前是谁"的 API 路由：用量记录、限额检查、管理页面
 */
export async function getSupabaseAuthClient() {
  const { url, key } = getEnvVars();
  const cookieStore = await cookies();

  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            cookieStore.set(name, value, options as any)
          );
        } catch {
          // 在 Server Component 中调用会只读报错，在 Route Handler 中正常
        }
      },
    },
  });
}
