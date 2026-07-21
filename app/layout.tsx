import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { FeedbackWidget } from "@/components/FeedbackWidget";
import { LoginSuccessNotice } from "@/components/LoginSuccessNotice";
import { AppShell } from "@/components/AppShell";
import { SiteFilingFooter } from "@/components/SiteFilingFooter";
import { Toaster } from "sonner";
import "./globals.css";
import "katex/dist/katex.min.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AI 科研助手",
  description: "帮助大学生更高效地读文献、处理实验数据、做学术输出",
};

// 让 iOS 安全区域（底部 Home 条、刘海）被正确处理
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <div className="min-h-0 flex-1">
          <AppShell>{children}</AppShell>
        </div>
        <SiteFilingFooter />
        <FeedbackWidget />
        <LoginSuccessNotice />
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
