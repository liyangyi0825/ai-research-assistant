"use client";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { Sidebar } from "./Sidebar";

// 导入各功能页面（CSS display 切换，组件始终挂载，状态不丢失）
import UploadPage         from "@/app/upload/page";
import TranslatePage      from "@/app/translate/page";
import LiteratureSearchPage from "@/app/literature-search/page";
import ConceptExplorerPage  from "@/app/concept-explorer/page";
import PptPage            from "@/app/ppt/page";
import LiteratureReviewPage from "@/app/literature-review/page";
import MyPapersPage       from "@/app/my-papers/page";
import MyProfilePage      from "@/app/my-profile/page";
import MyNotesPage        from "@/app/my-notes/page";
import HelpPage           from "@/app/help/page";

// SPA 里所有功能 tab
const SPA_TABS = [
  { key: "upload",             Component: UploadPage },
  { key: "translate",          Component: TranslatePage },
  { key: "literature-search",  Component: LiteratureSearchPage },
  { key: "concept-explorer",   Component: ConceptExplorerPage },
  { key: "ppt",                Component: PptPage },
  { key: "literature-review",  Component: LiteratureReviewPage },
  { key: "my-papers",          Component: MyPapersPage },
  { key: "my-profile",         Component: MyProfilePage },
  { key: "my-notes",           Component: MyNotesPage },
  { key: "help",               Component: HelpPage },
] as const;

type TabKey = (typeof SPA_TABS)[number]["key"];
const TAB_KEYS = SPA_TABS.map(t => t.key) as string[];

// pathname → 初始 tab（直接 URL 访问时用）
const PATH_TO_TAB: Record<string, TabKey> = {
  "/":                  "upload",
  "/upload":            "upload",
  "/translate":         "translate",
  "/literature-search": "literature-search",
  "/concept-explorer":  "concept-explorer",
  "/ppt":               "ppt",
  "/literature-review": "literature-review",
  "/my-papers":         "my-papers",
  "/my-profile":        "my-profile",
  "/my-notes":          "my-notes",
  "/help":              "help",
};

// 这些路径完全不走 Shell（无侧边栏）
const AUTH_PATHS   = ["/login", "/auth", "/reset-password"];
// admin 独立：直接渲染 children，无任何 Shell
const ADMIN_PATHS  = ["/admin"];
const BYPASS_PATHS = ["/paper/", "/search-history"];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // 初始 tab：优先 pathname 映射，兜底 upload
  const [activeTab, setActiveTab] = useState<string>(
    () => PATH_TO_TAB[pathname] ?? "upload"
  );
  // 记录哪些 tab 已被挂载（懒挂载：首次切到该 tab 才渲染，之后保持挂载）
  const [mountedTabs, setMountedTabs] = useState<Set<string>>(
    () => new Set([PATH_TO_TAB[pathname] ?? "upload"])
  );

  const isAuthPage   = AUTH_PATHS.some(p => pathname.startsWith(p));
  const isAdminPage  = ADMIN_PATHS.some(p => pathname.startsWith(p));
  const isBypassPage = BYPASS_PATHS.some(p => pathname.startsWith(p));

  // 首次加载：从 URL hash 恢复 tab（支持 #upload?paper=xxx 格式）
  useEffect(() => {
    const raw = window.location.hash.slice(1);       // "upload?paper=xxx"
    const tabKey = raw.split("?")[0];                // "upload"
    if (tabKey && TAB_KEYS.includes(tabKey)) {
      setActiveTab(tabKey);
      setMountedTabs(prev => new Set([...prev, tabKey]));
    }
    // 监听浏览器前进/后退
    function onHashChange() {
      const h = window.location.hash.slice(1).split("?")[0];
      if (TAB_KEYS.includes(h)) {
        setActiveTab(h);
        setMountedTabs(prev => new Set([...prev, h]));
      }
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // 监听「我的论文」点击事件 → 切到 upload tab（upload 页自行加载论文）
  useEffect(() => {
    function onLoadPaper() {
      setActiveTab("upload");
      setMountedTabs(prev => new Set([...prev, "upload"]));
      window.location.hash = "upload";
    }
    window.addEventListener("spa-load-paper", onLoadPaper);
    return () => window.removeEventListener("spa-load-paper", onLoadPaper);
  }, []);

  function handleTabChange(tab: string) {
    setActiveTab(tab);
    setSidebarOpen(false);
    setMountedTabs(prev => new Set([...prev, tab]));
    // 只在切换到不同 tab 时更新 hash；各功能页面自行在 hash 里追加 ?paper= 等参数
    const currentTab = window.location.hash.slice(1).split("?")[0];
    if (currentTab !== tab) {
      window.location.hash = tab;
    }
  }

  // Admin 页面：无任何 Shell，直接渲染
  if (isAdminPage || isAuthPage) return <>{children}</>;

  // 论文详情等 bypass 页面：有侧边栏但不走 SPA tab 系统
  if (isBypassPage) {
    return (
      <div className="flex h-screen overflow-hidden" style={{ background: "#F8FAFC" }}>
        <div className="hidden md:flex h-full">
          <Sidebar />
        </div>
        {sidebarOpen && (
          <div className="fixed inset-0 z-50 flex md:hidden">
            <Sidebar onClose={() => setSidebarOpen(false)} />
            <div className="flex-1" style={{ background: "rgba(0,0,0,0.45)" }} onClick={() => setSidebarOpen(false)} />
          </div>
        )}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          <div className="md:hidden flex items-center gap-3 px-4 py-3 border-b" style={{ background: "#1E293B", borderColor: "#334155" }}>
            <button onClick={() => setSidebarOpen(true)} className="text-slate-300 hover:text-white text-xl leading-none" aria-label="打开菜单">☰</button>
            <span className="font-bold text-white text-lg">易研</span>
          </div>
          <main className="flex-1 overflow-auto">{children}</main>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: "#F8FAFC" }}>
      {/* 桌面端侧边栏 */}
      <div className="hidden md:flex h-full">
        <Sidebar activeTab={activeTab} onTabChange={handleTabChange} />
      </div>

      {/* 移动端侧边栏覆盖层 */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <Sidebar activeTab={activeTab} onTabChange={handleTabChange} onClose={() => setSidebarOpen(false)} />
          <div className="flex-1" style={{ background: "rgba(0,0,0,0.45)" }} onClick={() => setSidebarOpen(false)} />
        </div>
      )}

      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* 移动端顶部栏 */}
        <div className="md:hidden flex items-center gap-3 px-4 py-3 border-b" style={{ background: "#1E293B", borderColor: "#334155" }}>
          <button onClick={() => setSidebarOpen(true)} className="text-slate-300 hover:text-white text-xl leading-none" aria-label="打开菜单">☰</button>
          <span className="font-bold text-white text-lg">易研</span>
        </div>

        {/* SPA 主区域：所有 tab 同时挂载，CSS 控制显示 */}
        <main className="flex-1 overflow-auto bg-gradient-to-br from-blue-50 to-indigo-100">
          {SPA_TABS.map(({ key, Component }) => {
            if (!mountedTabs.has(key)) return null;
            return (
              <div key={key} style={{ display: activeTab === key ? "block" : "none", minHeight: "100%" }}>
                <Component />
              </div>
            );
          })}
        </main>
      </div>
    </div>
  );
}
