// Supabase 客户端工具
// ─ getSupabaseClient()        简单客户端，无 session，用于反馈等不需要鉴权的接口
// ─ getSupabaseAuthClient()    Session 感知客户端，从 Cookie 读取登录状态，用于 AI 接口
// ─ checkUsageLimit()          检查本月用量是否超限（同时返回 userId）
// ─ insertUsageRecord()        写入用量记录（含真实 token 数和费用）

import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { FREE_MONTHLY_LIMITS, UsageActionType } from "@/lib/limits";

function getEnvVars() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";
  return { url, key };
}

/**
 * 管理员客户端（使用 Service Role Key，拥有完整数据库权限）
 * 只能在服务器端使用，绝不能暴露给浏览器
 */
export function getSupabaseAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** 简单客户端（不含用户 session）—— 反馈接口等使用 */
export function getSupabaseClient() {
  const { url, key } = getEnvVars();
  if (!url || !key) return null;
  return createClient(url, key);
}

/**
 * 检查当前用户本月用量是否超限
 * 同时返回 userId，供后续写入用量记录使用
 */
export async function checkUsageLimit(
  actionType: UsageActionType
): Promise<{ allowed: boolean; used: number; limit: number; userId: string | null }> {
  const limit = FREE_MONTHLY_LIMITS[actionType];

  try {
    const supabase = await getSupabaseAuthClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) return { allowed: false, used: 0, limit, userId: null };

    // 本月第一天 00:00:00
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const { count, error } = await supabase
      .from("usage")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("action_type", actionType)
      .gte("created_at", startOfMonth);

    if (error) {
      console.error("查询用量失败:", error.message);
      return { allowed: true, used: 0, limit, userId: user.id };
    }

    const used = count ?? 0;
    return { allowed: used < limit, used, limit, userId: user.id };
  } catch (err) {
    console.error("用量检查异常:", err);
    return { allowed: true, used: 0, limit, userId: null };
  }
}

/**
 * 写入用量记录（含真实 token 数和费用）
 * 使用 Admin Client，在流式响应结束后调用，不依赖 Cookie
 *
 * Claude Sonnet 4.5/4.6 定价：
 *   输入        $3.00 / 百万 token
 *   输出        $15.00 / 百万 token
 *   缓存写入    $3.75 / 百万 token（1.25×）
 *   缓存读取    $0.30 / 百万 token（0.1×）
 */
export async function insertUsageRecord({
  userId,
  actionType,
  tokensInput,
  tokensOutput,
  cacheCreationTokens = 0,
  cacheReadTokens = 0,
}: {
  userId: string;
  actionType: UsageActionType;
  tokensInput: number;
  tokensOutput: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}) {
  try {
    console.log('=== usage写入开始 ===');
    console.log('user_id:', userId);
    console.log('action_type:', actionType);
    console.log('tokens_input:', tokensInput);
    console.log('tokens_output:', tokensOutput);

    const admin = getSupabaseAdminClient();
    if (!admin) {
      console.error('=== usage写入错误: getSupabaseAdminClient 返回 null ===');
      return;
    }

    const costUsd =
      (tokensInput         / 1_000_000) * 3.00 +
      (tokensOutput        / 1_000_000) * 15.00 +
      (cacheCreationTokens / 1_000_000) * 3.75 +
      (cacheReadTokens     / 1_000_000) * 0.30;

    console.log('准备插入的数据:', {
      user_id: userId,
      action_type: actionType,
      tokens_input: tokensInput,
      tokens_output: tokensOutput,
      cost_usd: costUsd
    });

    const result = await admin.from("usage").insert({
      user_id: userId,
      action_type: actionType,
      tokens_input: tokensInput,
      tokens_output: tokensOutput,
      cost_usd: costUsd,
    });

    console.log('写入结果:', result);
    console.log('写入错误:', result.error);

    if (result.error) {
      console.error('=== usage写入失败 ===', result.error.message, result.error);
    } else {
      console.log('=== usage写入成功 ===');
    }
  } catch (err) {
    console.error('=== usage写入异常 ===', err);
  }
}

/**
 * 写入搜索历史记录
 * 使用 Admin Client，规避 RLS，服务端调用
 */
export async function insertSearchHistory({
  userId,
  type,
  query,
}: {
  userId: string;
  type: "keyword_gen" | "concept_explore";
  query: string;
}) {
  try {
    const admin = getSupabaseAdminClient();
    if (!admin) return;
    await admin.from("search_history").insert({
      user_id: userId,
      type,
      query: query.slice(0, 500),
    });
  } catch { /* 历史记录失败不影响主流程 */ }
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
