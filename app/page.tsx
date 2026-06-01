import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Header } from "@/components/Header";

export default function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex flex-col">
      <Header />

      {/* 主内容区 */}
      <main className="flex-1 flex flex-col items-center justify-center px-4 sm:px-6 py-10 sm:py-20 pb-24 sm:pb-20 text-center">
        <div className="max-w-2xl mx-auto w-full">
          {/* 标题 */}
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-3 sm:mb-4 leading-tight">
            读论文，从此不再费力
          </h1>
          <p className="text-base sm:text-xl text-gray-600 mb-6 sm:mb-8 leading-relaxed">
            上传 PDF 论文，AI 自动生成结构化总结，还能跟论文"对话"——
            研究问题、方法、结论，一目了然。
          </p>

          {/* 功能卡片 */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 mb-7 sm:mb-10">
            <div className="bg-white rounded-xl p-4 sm:p-5 shadow-sm border border-gray-100 flex sm:flex-col items-center sm:items-start gap-3 sm:gap-0 text-left sm:text-center">
              <div className="text-3xl sm:mb-2 shrink-0">📄</div>
              <div>
                <h3 className="font-semibold text-gray-800 mb-0.5 sm:mb-1">上传论文</h3>
                <p className="text-sm text-gray-500">支持 PDF 格式，自动提取文字内容</p>
              </div>
            </div>
            <div className="bg-white rounded-xl p-4 sm:p-5 shadow-sm border border-gray-100 flex sm:flex-col items-center sm:items-start gap-3 sm:gap-0 text-left sm:text-center">
              <div className="text-3xl sm:mb-2 shrink-0">✨</div>
              <div>
                <h3 className="font-semibold text-gray-800 mb-0.5 sm:mb-1">AI 总结</h3>
                <p className="text-sm text-gray-500">研究问题、方法、结论、创新点，结构清晰</p>
              </div>
            </div>
            <div className="bg-white rounded-xl p-4 sm:p-5 shadow-sm border border-gray-100 flex sm:flex-col items-center sm:items-start gap-3 sm:gap-0 text-left sm:text-center">
              <div className="text-3xl sm:mb-2 shrink-0">💬</div>
              <div>
                <h3 className="font-semibold text-gray-800 mb-0.5 sm:mb-1">论文问答</h3>
                <p className="text-sm text-gray-500">基于论文内容提问，AI 精准回答</p>
              </div>
            </div>
          </div>

          {/* 行动按钮 */}
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              href="/upload"
              className={buttonVariants({ size: "lg" }) + " w-full sm:w-auto"}
            >
              开始上传论文
            </Link>
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
