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

# 尝试加载中文字体（服务器上有 WenQuanYi 等）
chinese_fonts = ['WenQuanYi Micro Hei', 'WenQuanYi Zen Hei', 'Noto Sans CJK SC',
                 'SimHei', 'Microsoft YaHei', 'DejaVu Sans']
available = {f.name for f in fm.fontManager.ttflist}
chosen_font = next((f for f in chinese_fonts if f in available), 'DejaVu Sans')

plt.rcParams.update({
    'font.family': chosen_font,
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

fig, ax = plt.subplots(figsize=(8, 6))
colors = ['#1f77b4', '#d62728', '#2ca02c', '#ff7f0e', '#9467bd']
markers = ['o', 's', '^', 'D', 'v']

for i, y_col in enumerate(y_cols):
    x = data[x_col]
    y = pd.to_numeric(data[y_col], errors='coerce')
    color = colors[i % len(colors)]
    marker = markers[i % len(markers)]
    if chart_type == 'line':
        ax.plot(x, y, color=color, marker=marker, markevery=max(1, len(x)//20),
                label=y_col)
    elif chart_type == 'scatter':
        ax.scatter(x, y, color=color, marker=marker, label=y_col)
    elif chart_type == 'bar':
        width = 0.8 / len(y_cols)
        x_pos = np.arange(len(x))
        ax.bar(x_pos + i * width, y, width=width, color=color, label=y_col)
        ax.set_xticks(x_pos + width * (len(y_cols) - 1) / 2)
        ax.set_xticklabels(x, rotation=45, ha='right')

ax.set_xlabel(x_label)
ax.set_ylabel(y_label)
if title:
    ax.set_title(title, fontsize=15, fontweight='bold', pad=12)
if len(y_cols) > 1:
    ax.legend()
ax.spines['top'].set_visible(False)
ax.spines['right'].set_visible(False)
plt.tight_layout()

os.makedirs(os.path.dirname(output_path), exist_ok=True)
plt.savefig(output_path + '.png', format='png', dpi=300)
plt.savefig(output_path + '.svg', format='svg')
plt.close()

print(json.dumps({'success': True, 'png': output_path + '.png', 'svg': output_path + '.svg'}))
