// Supabase 客户端工具
// 在 API 路由（后端）里使用这里导出的 supabase 实例
// 注意：这里的变量没有 NEXT_PUBLIC_ 前缀，只在服务器端可用，更安全

import { createClient } from "@supabase/supabase-js";

// 创建客户端（仅在配置了 Supabase 时才有效）
export function getSupabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return null;
  }
  return createClient(supabaseUrl, supabaseAnonKey);
}
