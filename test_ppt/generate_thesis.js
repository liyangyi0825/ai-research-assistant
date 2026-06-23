const pptxgen = require('pptxgenjs');

const NAVY  = '1B3A8C';
const WHITE = 'FFFFFF';
const DARK  = '222222';
const W = 10;
const H = 5.625;

const slides = [
  { type: "cover", title: "纳米硅/石墨烯粉体的自组装及锂电负极性能研究", subtitle: "材料物理专业本科毕业论文", author: "汇报人：李洋溢\n指导教师：王恭凯 研究员", date: "2025年6月" },
  { type: "contents", items: ["第一章 研究背景与意义", "第二章 实验方法与表征", "第三章 结果分析与讨论", "第四章 结论与展望"] },
  { type: "section", number: "01", title: "研究背景与意义" },
  { type: "content", title: "锂离子电池负极材料的挑战", points: ["石墨负极容量低，仅372 mAh/g", "难以满足高能量密度需求", "充放电速率慢，接近析锂电位", "急需开发新型负极材料"], notes: "传统石墨负极材料存在诸多限制，特别是在新能源汽车和便携式电子设备等领域，对高能量密度电池的需求日益迫切，因此探索新型负极材料成为研究重点。" },
  { type: "content", title: "纳米硅材料的优势与问题", points: ["理论比容量高达4200 mAh/g", "锂离子扩散距离短，反应速度快", "充放电过程体积膨胀达300%", "导致材料破碎和循环性能衰减"], notes: "纳米硅具有超高理论容量，是石墨的十倍以上，但严重的体积膨胀问题限制了其实际应用。如何在保持高容量的同时解决体积膨胀是当前研究的核心难题。" },
  { type: "content", title: "石墨烯复合的解决方案", points: ["石墨烯具有极高导电性和机械强度", "比表面积达2630 m²/g", "可缓冲硅的体积膨胀", "构建稳定导电网络提升性能"], notes: "石墨烯作为二维碳材料，不仅能提供优异的导电性，其高机械强度还能有效抑制硅颗粒的破碎，通过复合可实现优势互补，构建高性能负极材料。" },
  { type: "content", title: "研究目标与创新点", points: ["采用喷雾干燥法实现自组装", "构建纳米硅/石墨烯核壳结构", "调控固含量优化材料形貌", "提升负极材料综合电化学性能"], notes: "本研究创新性地运用喷雾干燥自组装技术，通过调控工艺参数特别是固含量，制备出形貌可控的核壳复合材料，旨在平衡高容量与循环稳定性。" },
  { type: "section", number: "02", title: "实验方法与表征" },
  { type: "content", title: "材料制备流程", points: ["超声分散：硅/石墨烯质量比1:1~5:1", "喷雾干燥：固含量30~100 mg/mL", "进料速率6 mL/min，温度150~200℃", "惰性气氛热处理800~1000℃"], notes: "制备过程分三步：首先通过超声获得均匀分散的混合浆料，然后喷雾干燥形成微球结构，最后高温热处理强化界面结合。关键参数的精确控制是获得理想结构的保障。" },
  { type: "content", title: "结构与性能表征方法", points: ["SEM分析材料形貌和粒径分布", "循环性能测试评估容量保持率", "GCD曲线表征充放电平台", "倍率性能测试不同电流密度表现"], notes: "采用多种表征手段全面评价材料性能：扫描电镜揭示微观结构，电化学测试考察实际应用性能，通过系统分析建立结构与性能的关联。" },
  { type: "section", number: "03", title: "结果分析与讨论" },
  { type: "content", title: "固含量对形貌的影响", points: ["低浓度30 mg/mL：颗粒分散，粒径约2 μm", "高浓度100 mg/mL：出现团聚，粒径>5 μm", "浓度升高比表面积减小", "D90粒径随浓度增加呈上升趋势"], notes: "SEM分析显示固含量是调控形貌的关键参数。低浓度下颗粒分散均匀但负载量低，高浓度虽提升负载量但易团聚。粒径统计数据证实了浓度与颗粒大小的正相关关系。" },
  { type: "content", title: "面负载量与浓度关系", points: ["面负载量随固含量提升而增加", "20 mg/mL负载量约0.8 mg/cm²", "100 mg/mL负载量达2.0 mg/cm²", "高浓度分散性下降影响均匀性"], notes: "面负载量测试表明提高固含量能有效增加活性物质负载，有利于提升能量密度。但需注意过高浓度导致的分散性问题，需在负载量与结构均匀性间寻求最佳平衡点。" },
  { type: "content", title: "循环稳定性分析", points: ["前20次循环容量快速衰减", "低浓度初期稳定，后期衰减快", "100 mg/mL初期衰减快但后期稳定", "高致密结构缓解纳米硅破碎"], notes: "循环测试揭示了浓度对性能的双重影响：低浓度样品导电网络好但机械强度不足，高浓度样品虽初期内阻大但致密结构在长循环中显示优势，证明了结构稳定性的重要性。" },
  { type: "content", title: "GCD曲线特征分析", points: ["放电过程电压快速下降", "复合材料内阻较大", "首次循环不可逆容量损失明显", "第3次循环后电压衰减加剧"], notes: "恒流充放电曲线反映了材料的电化学行为。电压平台差异大说明SEI膜形成消耗锂源，后期衰减提示界面副反应需优化，这为进一步改进提供了方向。" },
  { type: "content", title: "倍率性能表现", points: ["0.1~2 A/g电流密度下测试", "保持较高库伦效率", "高倍率下容量保持率良好", "证明导电网络有效性"], notes: "倍率性能测试验证了石墨烯复合的有效性。材料在不同电流密度下均保持高库伦效率，说明离子和电子传导通道畅通，快充性能优异，适合实际应用需求。" },
  { type: "section", number: "04", title: "结论与展望" },
  { type: "content", title: "主要研究结论", points: ["成功制备核壳结构复合微球", "固含量是关键调控参数", "需平衡负载量与结构均匀性", "石墨烯有效提升综合性能"], notes: "研究成功证明了喷雾干燥自组装技术的可行性，明确了固含量对材料形貌和性能的调控规律，为设计高性能硅基负极提供了新思路和实验依据。" },
  { type: "content", title: "研究展望", points: ["优化固含量寻找最佳配比", "改善界面副反应抑制容量衰减", "探索表面包覆增强稳定性", "推进材料产业化应用研究"], notes: "未来工作将聚焦于进一步优化工艺参数，通过表面改性、电解液优化等手段提升循环寿命，并开展规模化制备研究，推动纳米硅/石墨烯复合材料的实际应用。" },
  { type: "ending" }
];

const prs = new pptxgen();
prs.layout = 'LAYOUT_16x9';

let contentPageNum = 0;

for (const slide of slides) {
  const s = prs.addSlide();

  // ── 封面 ──────────────────────────────────────────────────
  if (slide.type === 'cover') {
    s.background = { fill: NAVY };

    // 白色装饰横线
    s.addShape(prs.ShapeType.rect, {
      x: 1.5, y: 3.15, w: 7, h: 0.04,
      fill: { color: WHITE }, line: { color: WHITE, width: 0 }
    });

    // 标题
    s.addText(slide.title, {
      x: 0.5, y: 1.6, w: 9, h: 1.3,
      fontSize: 34, bold: true, color: WHITE,
      fontFace: 'Arial', align: 'center', valign: 'middle'
    });

    // 副标题
    s.addText(slide.subtitle, {
      x: 0.5, y: 3.25, w: 9, h: 0.6,
      fontSize: 18, color: WHITE,
      fontFace: 'Arial', align: 'center', valign: 'middle'
    });

    // 汇报人（两行）
    const authorLines = slide.author.split('\n');
    s.addText(authorLines[0], {
      x: 1, y: 4.3, w: 5, h: 0.38,
      fontSize: 13, color: WHITE, fontFace: 'Calibri'
    });
    s.addText(authorLines[1] || '', {
      x: 1, y: 4.68, w: 5, h: 0.38,
      fontSize: 13, color: WHITE, fontFace: 'Calibri'
    });

    // 日期（右对齐）
    s.addText(slide.date, {
      x: 5, y: 4.3, w: 4.5, h: 0.38,
      fontSize: 13, color: WHITE, fontFace: 'Calibri', align: 'right'
    });

    s.addNotes('感谢各位评委老师莅临指导！本次汇报题目是纳米硅/石墨烯粉体的自组装及锂电负极性能研究，指导教师是王恭凯研究员。');
  }

  // ── 目录 ──────────────────────────────────────────────────
  else if (slide.type === 'contents') {
    s.background = { fill: WHITE };

    // 左侧深蓝色块
    s.addShape(prs.ShapeType.rect, {
      x: 0, y: 0, w: 3.3, h: H,
      fill: { color: NAVY }, line: { color: NAVY, width: 0 }
    });

    // 目录标题
    s.addText('目录', {
      x: 0.3, y: 0.4, w: 2.7, h: 0.8,
      fontSize: 28, bold: true, color: WHITE, fontFace: 'Arial'
    });
    s.addText('CONTENTS', {
      x: 0.3, y: 1.1, w: 2.7, h: 0.4,
      fontSize: 11, color: WHITE, fontFace: 'Arial', charSpacing: 3
    });

    // 条目
    slide.items.forEach((item, i) => {
      const cy = 1.0 + i * 1.0;
      // 序号圆圈
      s.addShape(prs.ShapeType.ellipse, {
        x: 3.7, y: cy, w: 0.45, h: 0.45,
        fill: { color: NAVY }, line: { color: NAVY, width: 0 }
      });
      s.addText(String(i + 1), {
        x: 3.7, y: cy, w: 0.45, h: 0.45,
        fontSize: 13, bold: true, color: WHITE,
        fontFace: 'Arial', align: 'center', valign: 'middle'
      });
      // 条目文字
      s.addText(item, {
        x: 4.3, y: cy - 0.05, w: 5.4, h: 0.55,
        fontSize: 16, bold: true, color: NAVY,
        fontFace: 'Arial', valign: 'middle'
      });
    });
  }

  // ── 章节过渡页 ────────────────────────────────────────────
  else if (slide.type === 'section') {
    s.background = { fill: NAVY };

    s.addText('PART ' + slide.number.padStart(2, '0'), {
      x: 1, y: 1.9, w: 8, h: 0.6,
      fontSize: 18, color: WHITE, fontFace: 'Arial', align: 'center'
    });

    // 装饰线（在 PART 下方）
    s.addShape(prs.ShapeType.rect, {
      x: 3.5, y: 2.58, w: 3, h: 0.04,
      fill: { color: WHITE }, line: { color: WHITE, width: 0 }
    });

    s.addText(slide.title, {
      x: 0.5, y: 2.7, w: 9, h: 1.4,
      fontSize: 36, bold: true, color: WHITE,
      fontFace: 'Arial', align: 'center', valign: 'middle'
    });
  }

  // ── 内容页 ────────────────────────────────────────────────
  else if (slide.type === 'content') {
    contentPageNum++;
    s.background = { fill: WHITE };

    // 顶部深蓝标题栏
    s.addShape(prs.ShapeType.rect, {
      x: 0, y: 0, w: W, h: 1.1,
      fill: { color: NAVY }, line: { color: NAVY, width: 0 }
    });

    // 标题
    s.addText(slide.title, {
      x: 0.4, y: 0.1, w: 8.8, h: 0.9,
      fontSize: 22, bold: true, color: WHITE,
      fontFace: 'Arial', valign: 'middle'
    });

    // 页码
    s.addText(String(contentPageNum), {
      x: 8.5, y: 0.1, w: 1.3, h: 0.4,
      fontSize: 11, color: WHITE, fontFace: 'Calibri', align: 'right'
    });

    // 要点列表（最多5条，间距自适应）
    const n = slide.points.length;
    const startY = 1.25;
    const endY = 4.65;
    const spacing = n > 1 ? (endY - startY) / (n - 1) : 0;

    slide.points.forEach((point, i) => {
      const py = n === 1 ? (startY + endY) / 2 - 0.3 : startY + i * spacing - 0.15;
      // 蓝色圆点
      s.addShape(prs.ShapeType.ellipse, {
        x: 0.45, y: py + 0.17, w: 0.22, h: 0.22,
        fill: { color: NAVY }, line: { color: NAVY, width: 0 }
      });
      // 文字
      s.addText(point, {
        x: 0.85, y: py, w: 8.9, h: 0.6,
        fontSize: 16, color: DARK, fontFace: 'Calibri', valign: 'middle'
      });
    });

    // 底部细线
    s.addShape(prs.ShapeType.rect, {
      x: 0, y: 5.35, w: W, h: 0.05,
      fill: { color: NAVY }, line: { color: NAVY, width: 0 }
    });

    if (slide.notes) s.addNotes(slide.notes);
  }

  // ── 结尾页 ────────────────────────────────────────────────
  else if (slide.type === 'ending') {
    s.background = { fill: NAVY };

    s.addText('感谢聆听', {
      x: 1, y: 1.6, w: 8, h: 1.5,
      fontSize: 52, bold: true, color: WHITE,
      fontFace: 'Arial', align: 'center', valign: 'middle'
    });

    s.addShape(prs.ShapeType.rect, {
      x: 3.5, y: 3.3, w: 3, h: 0.04,
      fill: { color: WHITE }, line: { color: WHITE, width: 0 }
    });

    s.addText('Thank You  |  欢迎提问', {
      x: 1, y: 3.4, w: 8, h: 0.7,
      fontSize: 20, color: WHITE, fontFace: 'Arial', align: 'center'
    });

    s.addNotes('感谢各位评委老师的聆听，欢迎提问交流！');
  }
}

const outPath = 'D:\\网站项目\\test_ppt\\毕业答辩_纳米硅石墨烯.pptx';
prs.writeFile({ fileName: outPath })
  .then(() => console.log('✅ 已生成：' + outPath))
  .catch(err => console.error('❌ 生成失败:', err));
