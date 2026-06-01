// Supabase 客户端工具
// ─ 服务端（API 路由）和浏览器端都可以用这个文件
// ─ NEXT_PUBLIC_ 前缀的变量在浏览器和服务器都可见（后续登录功能需要）
// ─ 普通变量（无前缀）只在服务器可见
// ─ 为兼容已有配置，两种命名都能工作

import { createClient } from "@supabase/supabase-js";

function getEnvVars() {
  // 优先读 NEXT_PUBLIC_ 前缀（新命名），兼容旧命名（无前缀）
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    process.env.SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.SUPABASE_ANON_KEY;
  return { url, key };
}

/** 通用 Supabase 客户端（服务端 API 路由用） */
export function getSupabaseClient() {
  const { url, key } = getEnvVars();
  if (!url || !key) return null;
  return createClient(url, key);
}

/** 导出 URL 和 Key，供浏览器端直接使用（步骤 2 登录功能需要） */
export function getSupabaseEnv() {
  const { url, key } = getEnvVars();
  return { url: url ?? "", key: key ?? "" };
}
