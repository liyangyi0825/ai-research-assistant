// 测试脚本：生成答辩风格 + 组会风格 PPT
// LAYOUT_16x9: 10" × 5.625"

const pptxgen = require("pptxgenjs");
const path = require("path");

const SLIDES_DATA = {"title":"天能Power 5016 Pro液冷储能系统","scene":"组会","total_pages":10,"slides":[{"type":"cover","title":"天能Power 5016 Pro液冷储能系统","subtitle":"5016kWh液冷储能解决方案","author":"汇报人","date":"2026年6月"},{"type":"contents","items":["产品概述","核心技术特点","系统技术参数","电芯技术规格","总结展望"]},{"type":"content","title":"产品定位与应用场景","points":["基于314Ah磷酸铁锂方形电芯","标称容量5016kWh，2-4小时储能","适用工商业、电网级储能应用","已获UL、IEC等国际认证","符合NFPA 855等安全标准"],"notes":"这是天能推出的大型液冷储能系统，主要面向工商业和电网侧应用。产品已通过主流国际认证，具备全球市场准入资质。"},{"type":"content","title":"高安全性设计","points":["实时监控电芯全维度数据","新型液冷系统提升均衡性","完整消防系统：气溶胶+多探测器","智能通风与泄压装置","多层级安全保护机制"],"notes":"安全是储能系统核心，采用实时监控配合液冷技术，同时配备完整消防系统，包括烟感、热感、气体检测等多重保护。"},{"type":"content","title":"低能耗与智能控制","points":["智能液冷温控系统","优化辅助功耗","在线智能监控","确保高效运行","降低运营成本"],"notes":"通过智能温控系统和在线监控，有效降低系统辅助能耗，提升整体运行效率，减少长期运营成本。"},{"type":"content","title":"成本优化与部署优势","points":["支持背靠背/并排安装节省空间","整体预装交付即插即用","灵活部署快速安装","长寿命电芯保障收益","高性价比解决方案"],"notes":"产品设计充分考虑实际部署需求，预装交付大幅缩短现场安装时间，灵活的安装方式适应不同场地条件。"},{"type":"content","title":"系统核心参数","points":["配置：12组1P416S，标称电压1331V","工作电压范围：1040-1497.6V","充放电倍率：0.5C/0.5C","尺寸：6058×2896×2438mm","防护等级IP55，重量<42吨"],"notes":"系统采用12个电池簇串并联配置，工作电压覆盖范围宽，IP55防护等级适应户外环境。"},{"type":"content","title":"环境适应性能","points":["工作温度：-30℃至50℃（>45℃降额）","湿度范围：0-95%非冷凝","最高海拔4000米","防腐等级C3/C4/C5可选","智能液冷温控系统"],"notes":"系统具备优异的环境适应能力，宽温度范围和高海拔适应性使其可在多种严苛环境下稳定运行。"},{"type":"content","title":"电芯技术指标","points":["型号TNSA71173207B314，314Ah磷酸铁锂","质量能量密度≥185Wh/kg","体积能量密度≥420Wh/L","循环寿命≥10000次（70%SOH）","工作温度：-35℃至65℃"],"notes":"电芯采用高性能磷酸铁锂技术，能量密度和循环寿命均达到行业领先水平，支持100%DOD深度放电。"},{"type":"content","title":"下一步工作计划","points":["完成现场安装调试验证","收集实际运行数据","评估长期性能表现","优化控制策略","拓展应用场景"],"notes":"产品已完成开发和认证，下一步重点是实际项目部署，通过现场数据反馈持续优化系统性能。"},{"type":"ending"}]};

// ─── 答辩风格（深蓝学术）─────────────────────────────────────────────────────
// W=10", H=5.625"
const DEFENSE_BLUE = "1B3A8C";

async function buildDefense(slides, outPath) {
  const pres = new pptxgen();
  pres.layout = "LAYOUT_16x9"; // 10" × 5.625"

  let contentIdx = 0;

  for (const s of slides) {

    // ── 封面 ──
    if (s.type === "cover") {
      const sl = pres.addSlide();
      sl.background = { color: DEFENSE_BLUE };
      // 中央分割线
      sl.addShape(pres.shapes.RECTANGLE, { x: 1.5, y: 2.55, w: 7, h: 0.04, fill: { color: "FFFFFF" }, line: { color: "FFFFFF" } });
      // 标题
      sl.addText(s.title, { x: 0.5, y: 1.3, w: 9, h: 1.1, align: "center", color: "FFFFFF", fontSize: 32, bold: true, fontFace: "Arial", margin: 0 });
      // 副标题
      sl.addText(s.subtitle, { x: 0.5, y: 2.7, w: 9, h: 0.65, align: "center", color: "CCDDFF", fontSize: 18, fontFace: "Arial", margin: 0 });
      // 作者
      sl.addText("汇报人：" + s.author, { x: 1, y: 4.5, w: 4, h: 0.4, color: "AABBDD", fontSize: 13, fontFace: "Calibri", margin: 0 });
      // 日期
      sl.addText(s.date, { x: 5, y: 4.5, w: 4, h: 0.4, align: "right", color: "AABBDD", fontSize: 13, fontFace: "Calibri", margin: 0 });
      sl.addNotes("答辩封面：" + s.title);
    }

    // ── 目录 ──
    else if (s.type === "contents") {
      const sl = pres.addSlide();
      sl.background = { color: "FFFFFF" };
      // 左侧深蓝色块
      sl.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 3.3, h: 5.625, fill: { color: DEFENSE_BLUE }, line: { color: DEFENSE_BLUE } });
      // "目录"
      sl.addText("目录", { x: 0.3, y: 0.35, w: 2.7, h: 0.7, color: "FFFFFF", fontSize: 26, bold: true, fontFace: "Arial", margin: 0 });
      // "CONTENTS"
      sl.addText("CONTENTS", { x: 0.3, y: 0.95, w: 2.7, h: 0.35, color: "AABBDD", fontSize: 11, fontFace: "Arial", charSpacing: 4, margin: 0 });
      // 每个目录项
      s.items.forEach((item, i) => {
        const cy = 0.85 + i * 0.78;
        // 序号圆圈
        sl.addShape(pres.shapes.OVAL, { x: 3.7, y: cy, w: 0.4, h: 0.4, fill: { color: DEFENSE_BLUE }, line: { color: DEFENSE_BLUE } });
        sl.addText(String(i + 1), { x: 3.7, y: cy, w: 0.4, h: 0.4, align: "center", valign: "middle", color: "FFFFFF", fontSize: 12, bold: true, fontFace: "Arial", margin: 0 });
        // 项目文字
        sl.addText(item, { x: 4.25, y: cy, w: 5.5, h: 0.4, valign: "middle", color: DEFENSE_BLUE, fontSize: 15, bold: true, fontFace: "Arial", margin: 0 });
      });
      sl.addNotes("目录页");
    }

    // ── 章节过渡 ──
    else if (s.type === "section") {
      const sl = pres.addSlide();
      sl.background = { color: DEFENSE_BLUE };
      // PART 编号
      sl.addText("PART  " + s.number, { x: 1, y: 1.8, w: 8, h: 0.6, color: "AABBDD", fontSize: 18, fontFace: "Arial", margin: 0 });
      // 细分割线
      sl.addShape(pres.shapes.RECTANGLE, { x: 1, y: 2.55, w: 2, h: 0.04, fill: { color: "FFFFFF" }, line: { color: "FFFFFF" } });
      // 章节标题
      sl.addText(s.title, { x: 1, y: 2.65, w: 8, h: 1.0, color: "FFFFFF", fontSize: 32, bold: true, fontFace: "Arial", margin: 0 });
      sl.addNotes("章节：" + s.title);
    }

    // ── 内容页 ──
    else if (s.type === "content") {
      contentIdx++;
      const sl = pres.addSlide();
      sl.background = { color: "FFFFFF" };
      // 顶部深蓝标题栏
      sl.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 1.1, fill: { color: DEFENSE_BLUE }, line: { color: DEFENSE_BLUE } });
      // 标题文字
      sl.addText(s.title, { x: 0.4, y: 0.12, w: 8.5, h: 0.86, valign: "middle", color: "FFFFFF", fontSize: 22, bold: true, fontFace: "Arial", margin: 0 });
      // 页码（右上）
      sl.addText(String(contentIdx), { x: 9.0, y: 0.12, w: 0.7, h: 0.86, align: "right", valign: "middle", color: "AABBDD", fontSize: 11, fontFace: "Calibri", margin: 0 });
      // 要点列表
      const pts = s.points || [];
      pts.forEach((pt, i) => {
        const py = 1.3 + i * 0.75;
        // 蓝色实心圆
        sl.addShape(pres.shapes.OVAL, { x: 0.45, y: py + 0.08, w: 0.2, h: 0.2, fill: { color: DEFENSE_BLUE }, line: { color: DEFENSE_BLUE } });
        sl.addText(pt, { x: 0.8, y: py, w: 8.9, h: 0.5, valign: "middle", color: "222222", fontSize: 15, fontFace: "Calibri", margin: 0 });
      });
      // 底部细线
      sl.addShape(pres.shapes.RECTANGLE, { x: 0, y: 5.45, w: 10, h: 0.05, fill: { color: DEFENSE_BLUE }, line: { color: DEFENSE_BLUE } });
      sl.addNotes(s.notes || "");
    }

    // ── 结尾 ──
    else if (s.type === "ending") {
      const sl = pres.addSlide();
      sl.background = { color: DEFENSE_BLUE };
      // "感谢聆听"
      sl.addText("感谢聆听", { x: 1, y: 1.6, w: 8, h: 1.3, align: "center", color: "FFFFFF", fontSize: 46, bold: true, fontFace: "Arial", margin: 0 });
      // 装饰线
      sl.addShape(pres.shapes.RECTANGLE, { x: 3.5, y: 3.1, w: 3, h: 0.04, fill: { color: "FFFFFF" }, line: { color: "FFFFFF" } });
      // "Thank You"
      sl.addText("Thank You", { x: 1, y: 3.25, w: 8, h: 0.65, align: "center", color: "AABBDD", fontSize: 20, fontFace: "Arial", margin: 0 });
      sl.addNotes("感谢各位的聆听，欢迎提问交流。");
    }
  }

  await pres.writeFile({ fileName: outPath });
  console.log("✅ 答辩风格已生成：" + outPath);
}

// ─── 组会汇报风格（简洁深绿）────────────────────────────────────────────────
const MEETING_GREEN = "1A5C38";
const MEETING_LIGHT = "D4EBD9";

async function buildMeeting(slides, outPath) {
  const pres = new pptxgen();
  pres.layout = "LAYOUT_16x9"; // 10" × 5.625"

  for (const s of slides) {

    // ── 封面 ──
    if (s.type === "cover") {
      const sl = pres.addSlide();
      sl.background = { color: "FFFFFF" };
      // 顶部深绿色块
      sl.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 1.85, fill: { color: MEETING_GREEN }, line: { color: MEETING_GREEN } });
      // 标题
      sl.addText(s.title, { x: 0.5, y: 0.22, w: 9, h: 0.9, valign: "middle", color: "FFFFFF", fontSize: 26, bold: true, fontFace: "Arial", margin: 0 });
      // 副标题
      sl.addText(s.subtitle, { x: 0.5, y: 1.15, w: 9, h: 0.55, valign: "middle", color: "C8E6D4", fontSize: 15, fontFace: "Arial", margin: 0 });
      // 左侧竖线装饰
      sl.addShape(pres.shapes.RECTANGLE, { x: 0.5, y: 2.1, w: 0.07, h: 1.3, fill: { color: MEETING_GREEN }, line: { color: MEETING_GREEN } });
      // 作者
      sl.addText("汇报人：" + s.author, { x: 0.75, y: 2.2, w: 5, h: 0.38, color: "333333", fontSize: 13, fontFace: "Calibri", margin: 0 });
      // 日期
      sl.addText("日期：" + s.date, { x: 0.75, y: 2.7, w: 5, h: 0.38, color: "333333", fontSize: 13, fontFace: "Calibri", margin: 0 });
      // 装饰圆点
      sl.addShape(pres.shapes.OVAL, { x: 9.1, y: 3.5, w: 0.55, h: 0.55, fill: { color: MEETING_GREEN }, line: { color: MEETING_GREEN } });
      sl.addShape(pres.shapes.OVAL, { x: 8.85, y: 4.25, w: 0.32, h: 0.32, fill: { color: MEETING_LIGHT }, line: { color: MEETING_LIGHT } });
      sl.addNotes("组会汇报封面：" + s.title);
    }

    // ── 目录 ──
    else if (s.type === "contents") {
      const sl = pres.addSlide();
      sl.background = { color: "FFFFFF" };
      // 左侧竖线
      sl.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 0.18, h: 5.625, fill: { color: MEETING_GREEN }, line: { color: MEETING_GREEN } });
      // 标题
      sl.addText("目  录", { x: 0.55, y: 0.32, w: 8, h: 0.75, color: MEETING_GREEN, fontSize: 28, bold: true, fontFace: "Arial", margin: 0 });
      // 各项
      s.items.forEach((item, i) => {
        const iy = 1.45 + i * 0.7;
        sl.addText(String(i + 1).padStart(2, "0"), { x: 0.55, y: iy, w: 0.7, h: 0.5, valign: "middle", color: MEETING_GREEN, fontSize: 14, bold: true, fontFace: "Arial", margin: 0 });
        // 分隔竖线
        sl.addShape(pres.shapes.RECTANGLE, { x: 1.3, y: iy + 0.08, w: 0.04, h: 0.34, fill: { color: "CCCCCC" }, line: { color: "CCCCCC" } });
        sl.addText(item, { x: 1.5, y: iy, w: 8.2, h: 0.5, valign: "middle", color: "333333", fontSize: 15, fontFace: "Calibri", margin: 0 });
      });
      sl.addNotes("目录页");
    }

    // ── 内容页 ──
    else if (s.type === "content") {
      const sl = pres.addSlide();
      sl.background = { color: "FFFFFF" };
      // 左侧深绿竖线
      sl.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 0.18, h: 5.625, fill: { color: MEETING_GREEN }, line: { color: MEETING_GREEN } });
      // 标题
      sl.addText(s.title, { x: 0.45, y: 0.28, w: 9.2, h: 0.65, valign: "middle", color: MEETING_GREEN, fontSize: 21, bold: true, fontFace: "Arial", margin: 0 });
      // 标题下横线
      sl.addShape(pres.shapes.RECTANGLE, { x: 0.45, y: 0.95, w: 9.3, h: 0.04, fill: { color: "E0E0E0" }, line: { color: "E0E0E0" } });
      // 要点列表
      const pts = s.points || [];
      pts.forEach((pt, i) => {
        const py = 1.2 + i * 0.78;
        // 绿色小方块
        sl.addShape(pres.shapes.RECTANGLE, { x: 0.45, y: py + 0.14, w: 0.14, h: 0.14, fill: { color: MEETING_GREEN }, line: { color: MEETING_GREEN } });
        sl.addText(pt, { x: 0.75, y: py, w: 9.0, h: 0.52, valign: "middle", color: "333333", fontSize: 14, fontFace: "Calibri", margin: 0 });
      });
      // 右下角浅绿装饰圆
      sl.addShape(pres.shapes.OVAL, { x: 8.7, y: 4.55, w: 1.3, h: 1.3, fill: { color: MEETING_LIGHT }, line: { color: MEETING_LIGHT } });
      sl.addNotes(s.notes || "");
    }

    // ── 结尾 ──
    else if (s.type === "ending") {
      const sl = pres.addSlide();
      sl.background = { color: "FFFFFF" };
      // 左侧竖线
      sl.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 0.18, h: 5.625, fill: { color: MEETING_GREEN }, line: { color: MEETING_GREEN } });
      // 右侧大浅绿圆装饰
      sl.addShape(pres.shapes.OVAL, { x: 6.2, y: 0.5, w: 4.5, h: 4.5, fill: { color: MEETING_LIGHT }, line: { color: MEETING_LIGHT } });
      // "汇报结束"
      sl.addText("汇报结束", { x: 0.7, y: 1.65, w: 6, h: 1.2, color: MEETING_GREEN, fontSize: 42, bold: true, fontFace: "Arial", margin: 0 });
      // 绿色细线
      sl.addShape(pres.shapes.RECTANGLE, { x: 0.7, y: 3.0, w: 2.5, h: 0.06, fill: { color: MEETING_GREEN }, line: { color: MEETING_GREEN } });
      // "欢迎讨论"
      sl.addText("欢迎讨论", { x: 0.7, y: 3.2, w: 5, h: 0.82, color: MEETING_GREEN, fontSize: 24, fontFace: "Arial", margin: 0 });
      sl.addNotes("汇报结束，感谢大家的聆听，欢迎提问交流。");
    }
  }

  await pres.writeFile({ fileName: outPath });
  console.log("✅ 组会风格已生成：" + outPath);
}

// ─── 主程序 ──────────────────────────────────────────────────────────────────
(async () => {
  const outDir = __dirname;
  const defensePath = path.join(outDir, "答辩风格_测试.pptx");
  const meetingPath = path.join(outDir, "组会汇报_测试.pptx");

  await buildDefense(SLIDES_DATA.slides, defensePath);
  await buildMeeting(SLIDES_DATA.slides, meetingPath);

  console.log("\n两个文件已生成：");
  console.log("  " + defensePath);
  console.log("  " + meetingPath);
})();
