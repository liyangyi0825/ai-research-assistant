import sys, json, os
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.font_manager as fm
import pandas as pd
import numpy as np

config = json.loads(sys.argv[1])
data = pd.DataFrame(config['data'])
chart_type = config['chart_type']
x_col = config['x_col']
y_cols = config['y_cols']
title = config.get('title', '')
x_label = config.get('x_label', x_col)
y_label = config.get('y_label', '')
output_path = config['output_path']

# 修复1：直接加载已知路径的中文字体
fm.fontManager.addfont('/usr/share/fonts/truetype/wqy/wqy-microhei.ttc')
plt.rcParams['font.family'] = ['WenQuanYi Micro Hei', 'DejaVu Sans']

plt.rcParams.update({
    'font.size': 12,
    'axes.linewidth': 1.5,
    'axes.labelsize': 14,
    'xtick.labelsize': 12,
    'ytick.labelsize': 12,
    'legend.fontsize': 11,
    'lines.linewidth': 2,
    'lines.markersize': 6,
    'figure.dpi': 300,
    'savefig.dpi': 300,
    'savefig.bbox': 'tight',
})

# 修复2：X轴列名匹配 + 调试信息
print(f"[debug] columns: {list(data.columns)}", file=sys.stderr)
print(f"[debug] x_col: {x_col}", file=sys.stderr)

if x_col not in data.columns:
    print(f"[debug] x_col not found, fallback to first column", file=sys.stderr)
    x_col = data.columns[0]

print(f"[debug] x data: {data[x_col].tolist()[:5]}", file=sys.stderr)

# Y轴列名兜底过滤
valid_y_cols = [col for col in y_cols if col in data.columns]
if not valid_y_cols:
    print(json.dumps({'success': False,
                      'error': f'Y轴列名不存在，可用列：{list(data.columns)}'}))
    sys.exit(1)
y_cols = valid_y_cols
print(f"[debug] y_cols (valid): {y_cols}", file=sys.stderr)

# X轴统一用位置索引绘图，字符串标签单独设置
x_raw = data[x_col].fillna('').astype(str).tolist()
x_pos = list(range(len(x_raw)))

fig, ax = plt.subplots(figsize=(8, 6))
colors = ['#1f77b4', '#d62728', '#2ca02c', '#ff7f0e', '#9467bd']
markers = ['o', 's', '^', 'D', 'v']

for i, y_col in enumerate(y_cols):
    y = pd.to_numeric(data[y_col], errors='coerce')
    color = colors[i % len(colors)]
    marker = markers[i % len(markers)]
    if chart_type == 'line':
        ax.plot(x_pos, y, color=color, marker=marker,
                markevery=max(1, len(x_pos) // 20), label=y_col)
    elif chart_type == 'scatter':
        ax.scatter(x_pos, y, color=color, marker=marker, label=y_col)
    elif chart_type == 'bar':
        width = 0.8 / len(y_cols)
        ax.bar([p + i * width for p in x_pos], y, width=width, color=color, label=y_col)
        if i == len(y_cols) - 1:
            ax.set_xticks([p + width * (len(y_cols) - 1) / 2 for p in x_pos])
            ax.set_xticklabels(x_raw, rotation=45, ha='right')

# 折线图和散点图统一设置 X 轴刻度标签
if chart_type in ('line', 'scatter'):
    step = max(1, len(x_pos) // 24)  # 最多显示 24 个刻度，避免拥挤
    shown_pos = x_pos[::step]
    shown_labels = x_raw[::step]
    ax.set_xticks(shown_pos)
    ax.set_xticklabels(shown_labels, rotation=45, ha='right')

ax.set_xlabel(x_label)
ax.set_ylabel(y_label)
if title:
    ax.set_title(title, fontsize=15, fontweight='bold', pad=12)
if len(y_cols) > 1:
    ax.legend(fontsize=9, loc='best', framealpha=0.8)
ax.spines['top'].set_visible(False)
ax.spines['right'].set_visible(False)
plt.tight_layout()

os.makedirs(os.path.dirname(output_path), exist_ok=True)
plt.savefig(output_path + '.png', format='png', dpi=300)
plt.savefig(output_path + '.svg', format='svg')
plt.close()

print(json.dumps({'success': True, 'png': output_path + '.png', 'svg': output_path + '.svg'}))
