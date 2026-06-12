"use client";

import { useEffect } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { toast } from "sonner";
import { Suspense } from "react";

function NoticeInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (searchParams.get("loginSuccess") !== "1") return;

    // 登录成功 toast
    toast.success("登录成功，欢迎回来 👋", { duration: 4000 });

    // 跨设备提示（稍晚弹出，避免叠在一起）
    const timer = setTimeout(() => {
      toast.info("如果你在另一台设备打开了链接，请回到原来的设备刷新页面", {
        duration: 8000,
      });
    }, 600);

    // 把 loginSuccess 参数从 URL 里清掉，防止刷新重复弹
    const newParams = new URLSearchParams(searchParams.toString());
    newParams.delete("loginSuccess");
    const newSearch = newParams.toString();
    router.replace(pathname + (newSearch ? `?${newSearch}` : ""), { scroll: false });

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

export function LoginSuccessNotice() {
  return (
    <Suspense fallback={null}>
      <NoticeInner />
    </Suspense>
  );
}
