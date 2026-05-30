import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex flex-col">
      {/* 顶部导航栏 */}
      <header className="w-full px-6 py-4 flex items-center justify-between bg-white/70 backdrop-blur border-b border-gray-200">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🔬</span>
          <span className="font-bold text-lg text-gray-800">AI 科研助手</span>
        </div>
        <nav className="text-sm text-gray-500">大学生科研效率工具</nav>
      </header>

      {/* 主内容区 */}
      <main className="flex-1 flex flex-col items-center justify-center px-6 py-20 text-center">
        <div className="max-w-2xl mx-auto">
          {/* 标题 */}
          <h1 className="text-4xl font-bold text-gray-900 mb-4 leading-tight">
            读论文，从此不再费力
          </h1>
          <p className="text-xl text-gray-600 mb-8 leading-relaxed">
            上传 PDF 论文，AI 自动生成结构化总结，还能跟论文"对话"——
            研究问题、方法、结论，一目了然。
          </p>

          {/* 功能卡片 */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-10">
            <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
              <div className="text-3xl mb-2">📄</div>
              <h3 className="font-semibold text-gray-800 mb-1">上传论文</h3>
              <p className="text-sm text-gray-500">支持 PDF 格式，自动提取文字内容</p>
            </div>
            <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
              <div className="text-3xl mb-2">✨</div>
              <h3 className="font-semibold text-gray-800 mb-1">AI 总结</h3>
              <p className="text-sm text-gray-500">研究问题、方法、结论、创新点，结构清晰</p>
            </div>
            <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
              <div className="text-3xl mb-2">💬</div>
              <h3 className="font-semibold text-gray-800 mb-1">论文问答</h3>
              <p className="text-sm text-gray-500">基于论文内容提问，AI 精准回答</p>
            </div>
          </div>

          {/* 行动按钮 */}
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button size="lg" className="text-base px-8" asChild>
              <Link href="/upload">开始上传论文</Link>
            </Button>
          </div>

          <p className="mt-6 text-xs text-gray-400">
            目前为开发测试阶段 · MVP 版本
          </p>
        </div>
      </main>

      {/* 底部 */}
      <footer className="text-center py-4 text-xs text-gray-400 border-t border-gray-200 bg-white/50">
        AI 科研助手 · 大学生文献阅读效率工具
      </footer>
    </div>
  );
}
