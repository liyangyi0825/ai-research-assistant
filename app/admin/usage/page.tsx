// 管理员用量监控页面（仅 ADMIN_EMAIL 可访问）
// 路径：/admin/usage
// 注意：/admin 路径已在 AppShell 中排除，不显示侧边栏

import { redirect } from "next/navigation";
import { getSupabaseAuthClient, getSupabaseAdminClient } from "@/lib/supabase";
import { AdminLogoutButton } from "./LogoutButton";

// ── 限额配置（与 lib/limits.ts 保持一致，管理页单独维护方便展示）
const LIMITS = {
  summarize:       { label: "论文总结",   limit: 5  },
  chat:            { label: "对话",       limit: 30 },
  translate:       { label: "全文翻译",   limit: 3  },
  ppt_generate:    { label: "PPT生成",    limit: 3  },
  concept_explore: { label: "概念探索",   limit: 10 },
  keyword_gen:     { label: "检索词",     limit: 20 },
  bibtex_export:   { label: "BibTeX",     limit: 30 },
  extract_refs:    { label: "PDF提取",    limit: 10 },
} as const;

type ActionKey = keyof typeof LIMITS;

const STAT_COLORS: Record<ActionKey, string> = {
  summarize:       "bg-blue-50 text-blue-700",
  chat:            "bg-green-50 text-green-700",
  translate:       "bg-amber-50 text-amber-700",
  ppt_generate:    "bg-indigo-50 text-indigo-700",
  concept_explore: "bg-teal-50 text-teal-700",
  keyword_gen:     "bg-violet-50 text-violet-700",
  bibtex_export:   "bg-orange-50 text-orange-700",
  extract_refs:    "bg-rose-50 text-rose-700",
};

export default async function AdminUsagePage() {
  const supabase = await getSupabaseAuthClient();
  const { data: { user } } = await supabase.auth.getUser();

  const adminEmail = process.env.ADMIN_EMAIL;
  if (!user || !adminEmail || user.email !== adminEmail) redirect("/");

  const admin = getSupabaseAdminClient();
  if (!admin) return <ErrorBox msg="服务器未配置 SUPABASE_SERVICE_ROLE_KEY" />;

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const monthLabel = `${now.getFullYear()}年${now.getMonth() + 1}月`;

  const [usersRes, usageRes, feedbackRes] = await Promise.all([
    admin.auth.admin.listUsers({ perPage: 1000 }),
    admin.from("usage").select("user_id, action_type, created_at").order("created_at", { ascending: false }),
    admin.from("feedback").select("id, message, email, page_url, created_at").order("created_at", { ascending: false }).limit(100),
  ]);

  if (usersRes.error || usageRes.error) {
    return <ErrorBox msg={usersRes.error?.message ?? usageRes.error?.message ?? "数据获取失败"} />;
  }

  const users    = usersRes.data?.users ?? [];
  const usage    = usageRes.data ?? [];
  const feedbacks = feedbackRes.data ?? [];

  // ── 聚合每个用户的本月用量 ────────────────────────────────────────────
  const count = (rows: typeof usage, type: string) =>
    rows.filter(r => r.action_type === type).length;

  const stats = users
    .map((u) => {
      const all = usage.filter(r => r.user_id === u.id);
      const mon = all.filter(r => r.created_at >= startOfMonth);
      return {
        email:          u.email ?? u.id,
        summarize:      count(mon, "summarize"),
        chat:           count(mon, "chat"),
        translate:      count(mon, "translate"),
        pptGenerate:    count(mon, "ppt_generate"),
        conceptExplore: count(mon, "concept_explore"),
        keywordGen:     count(mon, "keyword_gen"),
        bibtex:         count(mon, "bibtex_export"),
        extractRefs:    count(mon, "extract_refs"),
        totalActions:   all.length,
      };
    })
    .filter(s => s.totalActions > 0)
    .sort((a, b) => b.totalActions - a.totalActions);

  // 各功能月度总和
  const monthly: Record<ActionKey, number> = {
    summarize:       stats.reduce((a, s) => a + s.summarize,      0),
    chat:            stats.reduce((a, s) => a + s.chat,           0),
    translate:       stats.reduce((a, s) => a + s.translate,      0),
    ppt_generate:    stats.reduce((a, s) => a + s.pptGenerate,    0),
    concept_explore: stats.reduce((a, s) => a + s.conceptExplore, 0),
    keyword_gen:     stats.reduce((a, s) => a + s.keywordGen,     0),
    bibtex_export:   stats.reduce((a, s) => a + s.bibtex,         0),
    extract_refs:    stats.reduce((a, s) => a + s.extractRefs,    0),
  };

  return (
    <div className="min-h-screen" style={{ background: "#F8FAFC" }}>

      {/* ── 顶部 Header ───────────────────────────────── */}
      <header className="bg-white border-b border-gray-100 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-xl">🔬</span>
            <span className="font-bold text-gray-800 text-lg">易研管理后台</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-600 font-medium">Admin</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-500">{user.email}</span>
            <AdminLogoutButton />
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-6 py-8 space-y-10">

        {/* ── 概览 ──────────────────────────────────────── */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-gray-800">📊 用量监控</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              共 {users.length} 位注册用户 · {stats.length} 位有用量 · 数据实时刷新
            </p>
          </div>
          <div className="text-right text-sm text-gray-400">
            <div>{monthLabel}统计</div>
            <div className="text-xs mt-0.5">刷新页面获取最新数据</div>
          </div>
        </div>

        {/* ── 汇总卡片（8宫格）────────────────────────── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
          {(Object.entries(LIMITS) as [ActionKey, { label: string; limit: number }][]).map(
            ([key, { label, limit }]) => (
              <div key={key} className={`rounded-xl p-3 ${STAT_COLORS[key]}`}>
                <div className="text-xl font-bold">{monthly[key]}</div>
                <div className="text-xs mt-0.5 opacity-75">{label}</div>
                <div className="text-xs opacity-50 mt-0.5">限{limit}次</div>
              </div>
            )
          )}
        </div>

        {/* ── 用户明细表 ───────────────────────────────── */}
        <section>
          <h2 className="text-base font-semibold text-gray-700 mb-3">
            用户用量明细
            <span className="ml-2 text-xs font-normal text-gray-400">（{monthLabel}）</span>
          </h2>

          {stats.length === 0 ? (
            <div className="bg-white rounded-xl p-8 text-center text-gray-400">暂无用量数据</div>
          ) : (
            <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                  <tr>
                    <th className="text-left px-4 py-3 sticky left-0 bg-gray-50">用户邮箱</th>
                    {(Object.entries(LIMITS) as [ActionKey, { label: string; limit: number }][]).map(
                      ([key, { label, limit }]) => (
                        <th key={key} className="text-center px-3 py-3">
                          {label}<br/>
                          <span className="text-gray-400 font-normal normal-case">限{limit}次</span>
                        </th>
                      )
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {stats.map((s) => (
                    <tr key={s.email} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 text-gray-700 font-medium truncate max-w-[200px] sticky left-0 bg-white">
                        {s.email}
                      </td>
                      <td className="px-3 py-3 text-center"><UsageCell value={s.summarize}      limit={LIMITS.summarize.limit} /></td>
                      <td className="px-3 py-3 text-center"><UsageCell value={s.chat}           limit={LIMITS.chat.limit} /></td>
                      <td className="px-3 py-3 text-center"><UsageCell value={s.translate}      limit={LIMITS.translate.limit} /></td>
                      <td className="px-3 py-3 text-center"><UsageCell value={s.pptGenerate}    limit={LIMITS.ppt_generate.limit} /></td>
                      <td className="px-3 py-3 text-center"><UsageCell value={s.conceptExplore} limit={LIMITS.concept_explore.limit} /></td>
                      <td className="px-3 py-3 text-center"><UsageCell value={s.keywordGen}     limit={LIMITS.keyword_gen.limit} /></td>
                      <td className="px-3 py-3 text-center"><UsageCell value={s.bibtex}         limit={LIMITS.bibtex_export.limit} /></td>
                      <td className="px-3 py-3 text-center"><UsageCell value={s.extractRefs}    limit={LIMITS.extract_refs.limit} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="mt-2 text-xs text-gray-400 leading-relaxed">
            月度限额：论文总结 5 次 · 对话 30 次 · 全文翻译 3 次 · PPT生成 3 次 · 概念探索 10 次 · 检索词生成 20 次 · BibTeX导出 30 次 · PDF提取 10 次
          </p>
        </section>

        {/* ── 用户反馈 ─────────────────────────────────── */}
        <section>
          <h2 className="text-base font-semibold text-gray-700 mb-3">
            💬 用户反馈
            <span className="ml-2 text-xs font-normal text-gray-400">最近 100 条，按时间倒序</span>
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
                      <span className="font-medium text-gray-600">{f.email || "匿名用户"}</span>
                      <span>{date}</span>
                    </div>
                    <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">{f.message}</p>
                    {f.page_url && (
                      <p className="mt-1.5 text-xs text-gray-400 truncate">来自：{f.page_url}</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* ── 底部 ─────────────────────────────────────── */}
        <div className="pb-8 flex items-center justify-between text-xs text-gray-400 border-t border-gray-100 pt-4">
          <span>易研管理后台 · 数据来源 Supabase</span>
          <AdminLogoutButton />
        </div>

      </div>
    </div>
  );
}

// ── 小组件 ────────────────────────────────────────────────────────────────────

function UsageCell({ value, limit }: { value: number; limit: number }) {
  const pct = limit > 0 ? value / limit : 0;
  const color =
    pct >= 1     ? "text-red-600 font-semibold" :
    pct >= 0.8   ? "text-orange-500" :
                   "text-gray-700";
  return (
    <span className={color}>
      {value}
      <span className="text-gray-400 font-normal">/{limit}</span>
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
