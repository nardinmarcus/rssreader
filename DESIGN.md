---
version: 1.0
name: Namoo Reader Design System
description: >-
  Namoo Reader 的现行产品设计系统：以中性画布、多栏阅读工作区、紧凑控制界面和舒展正文为核心，支持浅色、深色与跟随系统三种主题模式。

colors:
  canvas: "var(--bg-0)"
  surface: "var(--surface)"
  surface-muted: "var(--bg-2)"
  surface-pressed: "var(--bg-3)"
  text-primary: "var(--text-0)"
  text-secondary: "var(--text-1)"
  text-tertiary: "var(--text-2)"
  accent: "var(--accent)"
  accent-soft: "var(--accent-soft)"
  on-accent: "var(--brand-logo-fg)"
  border: "var(--border)"
  border-subtle: "var(--border-subtle)"
  border-strong: "var(--border-strong)"
  focus: "#2f5f9f"
  focus-halo: "rgba(47, 95, 159, 0.18)"
  semantic-green: "#2f6f4e"
  semantic-blue: "#3e6383"
  semantic-amber: "#7b642f"
  semantic-red: "#d14b4b"
  light-canvas: "#f7f7f6"
  light-surface: "#ffffff"
  light-muted: "#f2f2f1"
  light-pressed: "#e8e8e6"
  light-text: "#171717"
  light-text-secondary: "#4f4f4a"
  light-text-tertiary: "#8a8a84"
  dark-canvas: "#0a0a0a"
  dark-surface: "#141414"
  dark-muted: "#181818"
  dark-pressed: "#242424"
  dark-text: "#f4f4f5"
  dark-text-secondary: "#c7c7c7"
  dark-text-tertiary: "#858585"

typography:
  ui:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"
    fontSize: 13px
    fontWeight: 560
    lineHeight: normal
    letterSpacing: normal
  ui-strong:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"
    fontSize: 12.5px
    fontWeight: 780
    lineHeight: normal
    letterSpacing: normal
  meta:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"
    fontSize: 11.5px
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: normal
  reader-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"
    fontSize: "clamp(25px, 2.2vw, 31px)"
    fontWeight: 820
    lineHeight: 1.35
    letterSpacing: normal
  reader-body:
    fontFamily: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', Georgia, serif"
    fontSize: 16.5px
    fontWeight: 400
    lineHeight: 1.88
    letterSpacing: normal
  reader-h2:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"
    fontSize: 24px
    fontWeight: 820
    lineHeight: 1.32
    letterSpacing: normal

rounded:
  xs: 4px
  sm: 6px
  md: 8px
  lg: 10px
  pill: 999px

spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 20px
  xxl: 24px

components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.ui-strong}"
    rounded: "{rounded.md}"
    minHeight: 34px
    padding: 7px 12px
    borderColor: "{colors.accent}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.ui-strong}"
    rounded: "{rounded.md}"
    minHeight: 34px
    padding: 7px 12px
    borderColor: "{colors.border-subtle}"
  icon-button:
    backgroundColor: transparent
    textColor: "{colors.text-tertiary}"
    rounded: "{rounded.sm}"
    minHeight: 32px
    minWidth: 32px
  search-input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    typography: "{typography.ui}"
    rounded: "{rounded.md}"
    minHeight: 34px
    padding: 7px 11px
    borderColor: "{colors.border-subtle}"
  entry-card:
    backgroundColor: transparent
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: 11px 12px
    gap: 10px
  asset-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.md}"
    padding: 11px 12px
    borderColor: "{colors.border}"
  reader-content:
    typography: "{typography.reader-body}"
    maxWidth: 70ch
    paragraphGap: 1.08em
  onepage-sheet:
    backgroundColor: "#fbfaf6"
    textColor: "#20221f"
    borderColor: "#d9dbd3"
    rounded: 3px
---

# Namoo Reader Design System

本文档描述 Namoo Reader 当前采用的设计语言和实现约束，供产品、设计与开发协作者共同使用。视觉 token 的权威实现位于 [`public/styles.css`](public/styles.css)，页面结构位于 [`public/index.html`](public/index.html)，交互和主题行为位于 [`public/app.js`](public/app.js)。代码与本文档不一致时，以当前代码为准，并在同一次变更中更新本文档。

## Design Principles

Namoo Reader 是桌面应用式的阅读和创作工作区，不是营销型网页。界面需要同时容纳订阅范围、文章列表、阅读内容与 AI 上下文，因此设计重点是建立安静、清晰、可持续阅读的信息层级。

- **结构优先**：用分栏、表面色和 1px 边界建立层级，不依赖大阴影和装饰。
- **紧凑控制，舒展阅读**：导航和控制区保持高密度，正文保持足够字号、行高与行宽。
- **动作克制**：主题前景色承担主要动作；绿、蓝、琥珀、红只表达语义状态。
- **内容优先**：favicon、缩略图和正文图片是内容证据，不是背景装饰。
- **任务聚焦**：桌面并列展示工作区，窄屏只保留当前任务所需的主区域。

## Colors

### Theme System

产品支持浅色、深色和跟随系统三种模式。组件必须使用 `--bg-*`、`--surface`、`--text-*`、`--accent`、`--border*` 等语义变量，不要在组件内直接写死浅色或深色值。

| Role | Light | Dark |
|---|---|---|
| Canvas `--bg-0` | `#f7f7f6` | `#0a0a0a` |
| Primary surface `--surface` | `#ffffff` | `#141414` |
| Muted surface `--bg-2` | `#f2f2f1` | `#181818` |
| Pressed surface `--bg-3` | `#e8e8e6` | `#242424` |
| Primary text `--text-0` | `#171717` | `#f4f4f5` |
| Secondary text `--text-1` | `#4f4f4a` | `#c7c7c7` |
| Tertiary text `--text-2` | `#8a8a84` | `#858585` |
| Accent `--accent` | `#111111` | `#f5f5f5` |
| Border `--border` | `#e2e2df` | `#2b2b2b` |

浅色模式使用暖灰画布和白色活动表面；深色模式使用近黑画布和分级黑灰表面。三级文字灰阶必须保留，不能把所有文字压成同一对比度。

### Semantic and Focus Colors

| Token | Value | Purpose |
|---|---|---|
| `--semantic-green` | `#2f6f4e` | 成功、正向状态 |
| `--semantic-blue` | `#3e6383` | 信息、对话状态 |
| `--semantic-amber` | `#7b642f` | 草稿、提醒状态 |
| `--semantic-red` | `#d14b4b` | 错误、风险、删除动作 |
| `--focus-ring` | `#2f5f9f` | 键盘焦点轮廓 |
| `--focus-halo` | `rgba(47, 95, 159, 0.18)` | 键盘焦点外圈 |

语义色通过 `color-mix()` 与当前主题表面混合形成背景和边界。它们不能替代主要动作色，也不能大面积铺满界面。

## Typography

### UI Typography

界面统一使用系统 sans 栈 `--font-ui`。普通导航和列表文字主要处于 12.5–14px，辅助信息为 10.5–11.5px；通过 400–820 的字重变化建立层级。

- 面板、标签和重要控件使用 750–820 的高字重。
- 普通导航和列表项使用约 560–700 的中等字重。
- 时间、计数和辅助说明使用三级文字色，不靠进一步缩小字号隐藏信息。
- 输入、按钮和原生控件继承 `--font-ui`，不建立局部字体系统。

### Reading Typography

正文默认使用 `--font-reading`，并允许读者切换苹方、宋体、楷体、衬线、等宽和黑体等阅读字体。

| Element | Default |
|---|---|
| Article title | 默认 `clamp(25px, 2.2vw, 31px)`；861px 以上阅读模式为 `clamp(28px, 2.3vw, 38px)`；窄屏为 22px |
| Body | 16.5px / 1.88；最大宽度 70ch |
| H2 | 24px / 1.32 / 820 |
| H3 | 19px / 1.32 / 820 |
| Paragraph gap | 默认 1.08em，并按语言配置调整 |

阅读设置可以修改字体、字号、行高和行宽。CJK 与混合语言内容会获得额外行高和相应段距，正文容器不得绕过这些变量硬编码尺寸。

## Spacing, Shape, and Depth

### Spacing

全局间距采用 4、8、12、16、20、24px 六级 scale。组件内部允许使用与具体几何相关的 6、7、10、11px，但不要把这些局部值扩展成第二套全局间距系统。

### Shape

- 8px 是输入、按钮、标签和普通卡片的主圆角。
- 4px 用于 favicon、微型控件和紧凑内容。
- 6px 用于图标按钮；10px 用于条目卡和较大入口。
- 999px 只用于胶囊标签、分段选择和圆形控制。
- 普通工作区不使用大面积 16–24px 的软卡片语言。

### Depth

工作区整体保持平面化。默认层级来自表面色、分区位置和发丝边界；常规选中态使用 `0 1px 1–3px` 的弱阴影，浮层和偏好面板才使用更明显的阴影。模糊只用于固定浮动控制或对话框背景，渐变只用于分隔线、阅读标记等结构提示；二者都不是基础表面语言。

## Layout

### Desktop Workspace

默认工作区由四个功能区域组成：订阅侧栏、条目列表、阅读器和 AI 上下文。区域彼此独立滚动，通过 4px 分隔/拖拽区域连接。

- 订阅侧栏基准宽度为 264px，可折叠为 64px 图标轨。
- 条目列表通常在 292–340px 之间；阅读模式会收窄或隐藏列表，把宽度让给正文。
- 阅读区占据剩余空间，正文内部仍以阅读行宽约束，不横向铺满。
- AI 上下文栏桌面基准宽度约 300px，可折叠；它是辅助区，不压缩正文到不可读宽度。

### Reader

阅读器由标题与来源、阅读工具栏、正文/创作/翻译内容和讨论区域构成。正文默认最大宽度 70ch，图片自适应容器；代码块和表格在空间不足时独立横向滚动。沉浸模式隐藏其他工作区，只保留阅读器。

阅读模式固定显示“原文 / 创作草稿 / Onepage / 中文翻译”四个等宽标签，内容尚未生成时由对应面板展示空态，不能通过隐藏标签改变导航结构。游客和新账号默认打开原文；已有用户保存的原文或创作草稿偏好保持不变；具体资产深链始终优先于个人默认值。

### Onepage

Onepage 是文章衍生的编辑纸张，不复用普通卡片外观。它使用米白纸张 `#fbfaf6`、深色墨色 `#20221f`、3px 圆角和更强的编辑排版；深色主题切换为 `#191b18` 纸张和 `#edeee8` 文字。该样式只用于 Onepage 内容，不扩散到主工作区。

## Components

### Buttons and Inputs

- **Primary button**：使用 `--accent` 背景和 `--brand-logo-fg` 前景，默认高度至少 34px、8px 圆角。一个局部区域只保留一个主要动作。
- **Secondary button**：使用活动表面、弱边界和次级文字；hover 提高边界与文字对比度。
- **Icon button**：至少 32×32px、6px 圆角；窄屏主导航入口保持约 44×36/38px。
- **Search and form controls**：使用活动表面、弱边界、8px 圆角和系统 UI 字体；搜索框高度 34px。
- disabled 状态降低不透明度并保留清晰的禁用指针，不通过颜色变化伪装成可用控件。

### Navigation and Selection

- 普通导航行保持透明，hover 使用弱表面，active 使用 `--accent` 与 `--accent-soft`。
- 双段或多段选择器使用 8px 容器/按钮圆角；选中项使用活动表面、较强边界和极浅阴影。
- 计数与类型 badge 使用胶囊形状、弱边界和小字号，只承担状态说明。
- 左侧来源行默认不是卡片，避免侧栏变成重复白色块。

### Cards

- **Entry card**：透明背景、11×12px 内边距、10px 间距和 10px 圆角；hover 显示表面，active 增加边界与弱阴影。
- **Asset card**：活动表面、1px 边界、11×12px 内边距和 8px 圆角，用于区分原始文章与沉淀资产。
- **Empty state**：直接位于画布上，使用低对比图标和简短说明，不额外套大卡片。
- **Popover / preferences**：活动表面、8px 圆角、明确边界和较强阴影；仅浮层使用该深度。

### Media

favicon 使用居中 cover 和 4px 圆角；条目缩略图使用 cover 裁切；正文图片保持 `max-width: 100%`、自动高度和 8px 圆角。第三方图片颜色不进入产品调色板。

## Interaction and Accessibility

- 常规交互使用约 140–160ms 的颜色、边界、阴影或透明度过渡；列表与卡片 hover 不使用上浮位移。
- hover 只能作为补充反馈；所有可操作元素必须保留 `:focus-visible`。
- 键盘焦点使用 2px `--focus-ring`、2px offset 和 `--focus-halo` 外圈。
- `prefers-reduced-motion: reduce` 下，动画和过渡缩短到 1ms，并删除 hover/active 位移。
- 图标按钮必须提供可访问名称；状态切换使用适当的 `aria-*` 属性表达当前值。
- 阅读模式使用标准 tab/tabpanel 关系，并支持方向键、Home 和 End；文章切换快捷键不能抢占表单、链接、按钮或标签页按键。
- 危险确认使用原生对话框，默认焦点落在取消操作，Enter 不得作为 document 级隐式确认；Toast 使用常驻 polite live region。
- 正文颜色、语义色和失活状态都必须在明暗主题下保持可辨识度。

## Responsive Behavior

响应式策略是切换工作模式，而不是等比缩小桌面四栏。

- **1500px 以下的阅读模式**：侧栏折叠为 64px 图标轨，并逐步收窄条目与上下文栏。
- **1181px 以上**：允许完整桌面工作台；AI 上下文尊重桌面保存偏好，空间不足时可以临时收起。
- **1180–981px 的阅读模式**：隐藏条目列表，保留 64px 图标轨、阅读器和按需右侧 AI 上下文。
- **980–861px 的阅读模式**：阅读器独占主区域；AI 默认收起，显式打开时作为右侧覆盖层，不压缩正文。
- **980px 以下的列表模式**：保留 64px 图标轨与单一内容列，隐藏上下文栏和拖拽线。
- **860px 以下的文章模式**：阅读器占满视口；四个阅读标签保持单行且触控高度至少 44px；AI 默认收起，显式展开时位于下方，最大约 38vh。
- **窄屏正文**：使用约 20px 横向、26px 顶部和 64px 底部内边距；图片自适应，代码块和表格独立滚动。
- **560px 以下**：进一步压缩阅读偏好、上下文 tabs 和局部复杂组件，不改变主导航模型。

响应式自动收起属于当前视口的派生状态，不得写入用户保存的桌面偏好。没有活动文章时上下文保持关闭且不显示开启入口；`focus=chat` 等明确路由意图可以覆盖当前视口默认值。

## Usage Rules

### Do

- 用语义变量实现组件，确保浅色、深色和跟随系统模式同时成立。
- 优先使用分区、表面色和边界建立层级，保持 8px 主圆角与轻阴影。
- 保持紧凑 UI 与舒展正文的双重节奏。
- 保持主要动作稀缺，语义色只用于状态和反馈。
- 在移动端隐藏次要区域，让当前阅读或浏览任务占据主区域。
- 修改组件时同步验证键盘焦点、减少动态效果和两套主题。

### Don't

- 不要把普通列表全部改成带厚阴影的白色大卡片。
- 不要用饱和语义色替代主题主动作色。
- 不要把装饰渐变、玻璃模糊、霓虹发光或持续动画扩展为大面积视觉语言。
- 不要把移动端做成桌面四栏的缩小版本。
- 不要把 12–14px 的 UI 密度复制到长文正文。
- 不要在组件中绕过主题、阅读和间距变量写死局部体系。

## Maintenance

设计变更应先落在现有架构中：样式修改 [`public/styles.css`](public/styles.css)，结构修改 [`public/index.html`](public/index.html)，交互修改 [`public/app.js`](public/app.js)。新增 token 前先确认现有语义变量无法表达需求；修改前端资产时，同时更新页面中的资源版本和对应回归断言。
