// 后端接口：接收用户反馈，存入 Supabase feedback 表
// 路径：POST /api/feedback

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient, getSupabaseAdminClient } from "@/lib/supabase";
import { Resend } from "resend";

const MIN_LEN = 10;
const MAX_LEN = 500;
const MAX_DAILY = 3;

function getClientIP(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

export async function POST(req: NextRequest) {
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      return NextResponse.json({ error: "Supabase 未配置，请联系管理员" }, { status: 500 });
    }

    const formData = await req.formData();
    const message = (formData.get("message") as string)?.trim() ?? "";
    const email = (formData.get("email") as string | null)?.trim() || null;
    const screenshot = formData.get("screenshot") as File | null;
    const pageUrl = (formData.get("pageUrl") as string | null) || null;

    // ── 内容长度校验 ───────────────────────────────────────────────────
    if (!message) {
      return NextResponse.json({ error: "反馈内容不能为空" }, { status: 400 });
    }
    if (message.length < MIN_LEN) {
      return NextResponse.json({ error: `反馈内容至少需要 ${MIN_LEN} 个字` }, { status: 400 });
    }
    if (message.length > MAX_LEN) {
      return NextResponse.json({ error: `反馈内容不能超过 ${MAX_LEN} 个字` }, { status: 400 });
    }

    // ── 频率限制：同一 IP 每天最多 3 次 ────────────────────────────────
    const ip = getClientIP(req);
    const admin = getSupabaseAdminClient();
    if (admin && ip !== "unknown") {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { count } = await admin
        .from("feedback")
        .select("id", { count: "exact", head: true })
        .eq("ip_address", ip)
        .gte("created_at", since);

      if ((count ?? 0) >= MAX_DAILY) {
        return NextResponse.json(
          { error: "今天的反馈次数已达上限，明天再来" },
          { status: 429 }
        );
      }
    }

    // ── 截图上传 ────────────────────────────────────────────────────────
    let screenshotUrl: string | null = null;
    if (screenshot && screenshot.size > 0) {
      if (screenshot.size > 5 * 1024 * 1024) {
        return NextResponse.json({ error: "截图不能超过 5MB" }, { status: 400 });
      }
      const ext = screenshot.name.split(".").pop()?.toLowerCase() || "png";
      const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
      const bytes = await screenshot.arrayBuffer();

      const { data: uploadData, error: uploadError } = await supabase.storage
        .from("feedback-screenshots")
        .upload(fileName, bytes, { contentType: screenshot.type || "image/png", upsert: false });

      if (!uploadError) {
        const { data: urlData } = supabase.storage
          .from("feedback-screenshots")
          .getPublicUrl(uploadData.path);
        screenshotUrl = urlData.publicUrl;
      } else {
        console.error("截图上传失败:", uploadError.message);
      }
    }

    // ── 写入 feedback 表 ────────────────────────────────────────────────
    const { error: insertError } = await supabase.from("feedback").insert({
      message,
      email,
      screenshot_url: screenshotUrl,
      page_url: pageUrl,
      user_agent: req.headers.get("user-agent") || null,
      ip_address: ip,
    });

    if (insertError) {
      console.error("写入反馈失败:", insertError.message);
      return NextResponse.json({ error: "保存失败，请重试" }, { status: 500 });
    }

    // ── 邮件通知 ────────────────────────────────────────────────────────
    const resendKey = process.env.RESEND_API_KEY;
    const adminEmail = process.env.ADMIN_EMAIL;
    const fromEmail = process.env.RESEND_FROM_EMAIL || "noreply@iyanhub.com";

    if (resendKey && adminEmail) {
      try {
        const resend = new Resend(resendKey);
        const timeStr = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
        await resend.emails.send({
          from: `iyanhub 反馈 <${fromEmail}>`,
          to: adminEmail,
          subject: "📬 有新的用户反馈",
          html: `
            <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px;">
              <h2 style="color:#1d4ed8;margin-bottom:16px;">📬 新用户反馈</h2>
              <table style="width:100%;border-collapse:collapse;font-size:14px;">
                <tr><td style="padding:8px 0;color:#6b7280;width:80px;">时间</td><td style="padding:8px 0;">${timeStr}</td></tr>
                <tr><td style="padding:8px 0;color:#6b7280;">用户邮箱</td><td style="padding:8px 0;">${email || "（未填写）"}</td></tr>
                <tr><td style="padding:8px 0;color:#6b7280;">来源页面</td><td style="padding:8px 0;">${pageUrl || "未知"}</td></tr>
              </table>
              <div style="margin-top:16px;padding:16px;background:#f8fafc;border-radius:8px;border-left:4px solid #3b82f6;">
                <p style="margin:0;white-space:pre-wrap;">${message.replace(/</g, "&lt;")}</p>
              </div>
              ${screenshotUrl ? `<p style="margin-top:12px;"><a href="${screenshotUrl}" style="color:#3b82f6;">查看截图 →</a></p>` : ""}
            </div>
          `,
        });
      } catch (e) {
        console.error("邮件发送失败:", e);
        // 邮件失败不影响反馈保存
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("反馈接口出错:", error);
    const msg = error instanceof Error ? error.message : "提交失败，请重试";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
