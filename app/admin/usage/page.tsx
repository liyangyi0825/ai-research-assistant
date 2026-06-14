// 管理员用量监控页面（仅 ADMIN_EMAIL 可访问）
// 路径：/admin/usage

import { redirect } from "next/navigation";
import { getSupabaseAuthClient, getSupabaseAdminClient } from "@/lib/supabase";

export default async function AdminUsagePage() {
  // ── 1. 验证当前用户是管理员 ────────────────────────────────────────
  const supabase = await getSupabaseAuthClient();
  const { data: { user } } = await supabase.auth.getUser();

  const adminEmail = process.env.ADMIN_EMAIL;
  if (!user || !adminEmail || user.email !== adminEmail) {
    redirect("/");
  }

  // ── 2. 用管理员客户端拉数据 ───────────────────────────────────────
  const admin = getSupabaseAdminClient();
  if (!admin) {
    return <ErrorBox msg="服务器未配置 SUPABASE_SERVICE_ROLE_KEY" />;
  }

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const [usersRes, usageRes, feedbackRes] = await Promise.all([
    admin.auth.admin.listUsers({ perPage: 1000 }),
    admin.from("usage").select("user_id, action_type, created_at").order("created_at", { ascending: false }),
    admin.from("feedback").select("id, message, email, page_url, created_at").order("created_at", { ascending: false }).limit(50),
  ]);

  if (usersRes.error || usageRes.error) {
    return <ErrorBox msg={usersRes.error?.message ?? usageRes.error?.message ?? "数据获取失败"} />;
  }

  const users = usersRes.data?.users ?? [];
  const usage = usageRes.data ?? [];
  const feedbacks = feedbackRes.data ?? [];

  // ── 3. 聚合每个用户的用量 ─────────────────────────────────────────
  const stats = users
    .map((u) => {
      const all = usage.filter((r) => r.user_id === u.id);
      const thisMonth = all.filter((r) => r.created_at >= startOfMonth);
      return {
        email: u.email ?? u.id,
        createdAt: u.created_at,
        summarizeMonth: thisMonth.filter((r) => r.action_type === "summarize").length,
        chatMonth:      thisMonth.filter((r) => r.action_type === "chat").length,
        summarizeTotal: all.filter((r) => r.action_type === "summarize").length,
        chatTotal:      all.filter((r) => r.action_type === "chat").length,
      };
    })
    .filter((s) => s.summarizeTotal > 0 || s.chatTotal > 0)
    .sort((a, b) => (b.summarizeTotal + b.chatTotal) - (a.summarizeTotal + a.chatTotal));

  // ── 4. 全站统计汇总 ───────────────────────────────────────────────
  const totalSummarizeMonth = stats.reduce((s, r) => s + r.summarizeMonth, 0);
  const totalChatMonth      = stats.reduce((s, r) => s + r.chatMonth, 0);
  const totalSummarizeAll   = stats.reduce((s, r) => s + r.summarizeTotal, 0);
  const totalChatAll        = stats.reduce((s, r) => s + r.chatTotal, 0);

  const monthLabel = `${now.getFullYear()}年${now.getMonth() + 1}月`;

  // ── 5. 渲染 ──────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-50 px-4 py-8">
      <div className="max-w-5xl mx-auto space-y-10">

        {/* 标题 */}
        <div>
          <h1 className="text-2xl font-bold text-gray-800">📊 用量监控</h1>
          <p className="text-sm text-gray-500 mt-1">
            当前管理员：{user.email}　·　共 {users.length} 位注册用户，{stats.length} 位有用量
          </p>
        </div>

        {/* 汇总卡片 */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCard label={`${monthLabel} 总结`} value={totalSummarizeMonth} color="blue" />
          <StatCard label={`${monthLabel} 对话`} value={totalChatMonth}      color="green" />
          <StatCard label="累计总结"             value={totalSummarizeAll}   color="indigo" />
          <StatCard label="累计对话"             value={totalChatAll}        color="teal" />
        </div>

        {/* 用户明细表 */}
        <section>
          <h2 className="text-base font-semibold text-gray-700 mb-3">用户用量明细</h2>
          {stats.length === 0 ? (
            <div className="bg-white rounded-xl p-8 text-center text-gray-400">暂无用量数据</div>
          ) : (
            <div className="bg-white rounded-xl shadow-sm overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="text-left px-4 py-3">用户邮箱</th>
                    <th className="text-center px-3 py-3">{monthLabel}<br/>总结</th>
                    <th className="text-center px-3 py-3">{monthLabel}<br/>对话</th>
                    <th className="text-center px-3 py-3">累计<br/>总结</th>
                    <th className="text-center px-3 py-3">累计<br/>对话</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {stats.map((s) => (
                    <tr key={s.email} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 text-gray-700 font-medium truncate max-w-[200px]">{s.email}</td>
                      <td className="px-3 py-3 text-center"><UsageCell value={s.summarizeMonth} limit={5} /></td>
                      <td className="px-3 py-3 text-center"><UsageCell value={s.chatMonth}      limit={30} /></td>
                      <td className="px-3 py-3 text-center text-gray-600">{s.summarizeTotal}</td>
                      <td className="px-3 py-3 text-center text-gray-600">{s.chatTotal}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-xs text-gray-400">月份限额：总结 5 次，对话 30 次　·　数据实时刷新</p>
        </section>

        {/* 用户反馈列表 */}
        <section>
          <h2 className="text-base font-semibold text-gray-700 mb-3">
            💬 用户反馈
            <span className="ml-2 text-xs font-normal text-gray-400">最近 50 条，按时间倒序</span>
          </h2>
          {feedbacks.length === 0 ? (
            <div className="bg-white rounded-xl p-8 text-center text-gray-400">暂无反馈</div>
          ) : (
            <div className="space-y-3">
              {feedbacks.map((f) => {
                const date = new Date(f.created_at).toLocaleString("zh-CN", {
                  timeZone: "Asia/Shanghai",
                  year: "numeric", month: "2-digit", day: "2-digit",
                  hour: "2-digit", minute: "2-digit",
                });
                return (
                  <div key={f.id} className="bg-white rounded-xl shadow-sm p-4">
                    <div className="flex items-center justify-between mb-2 text-xs text-gray-400">
                      <span>{f.email || "匿名用户"}</span>
                      <span>{date}</span>
                    </div>
                    <p className="text-sm text-gray-700 whitespace-pre-wrap">{f.message}</p>
                    {f.page_url && (
                      <p className="mt-1 text-xs text-gray-400 truncate">来自：{f.page_url}</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

      </div>
    </div>
  );
}

// ── 小组件 ────────────────────────────────────────────────────────────

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  const colors: Record<string, string> = {
    blue:   "bg-blue-50 text-blue-700",
    green:  "bg-green-50 text-green-700",
    indigo: "bg-indigo-50 text-indigo-700",
    teal:   "bg-teal-50 text-teal-700",
  };
  return (
    <div className={`rounded-xl p-4 ${colors[color] ?? colors.blue}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs mt-1 opacity-80">{label}</div>
    </div>
  );
}

function UsageCell({ value, limit }: { value: number; limit: number }) {
  const pct = Math.min(value / limit, 1);
  const color = pct >= 1 ? "text-red-600 font-semibold" : pct >= 0.8 ? "text-orange-500" : "text-gray-700";
  return (
    <span className={color}>
      {value}<span className="text-gray-400 font-normal">/{limit}</span>
    </span>
  );
}

function ErrorBox({ msg }: { msg: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-red-600 max-w-md text-center">
        <p className="font-semibold mb-1">配置错误</p>
        <p className="text-sm">{msg}</p>
      </div>
    </div>
  );
}
