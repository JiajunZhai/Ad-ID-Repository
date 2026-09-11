# Ad ID Warehouse

## 命令

- `npm run dev` — 在 `0.0.0.0:3333` 启动 Vite 开发服务器，自动打开浏览器
- `npm run build` — 构建静态资源到 `dist/`
- `npm run preview` — 预览构建结果（不包含 API 中间件）

项目没有 lint、typecheck、测试或格式化脚本，也没有 CI 配置。

## 关键：双模式持久化

本地存储 API（`/api/apps`、`/api/apps/save`、`/api/apps/delete`）与 Google Play 抓取 API（`/api/play/lookup`、`/icons/*`）以 Vite 插件中间件形式实现于 `vite.config.js`，只在 `npm run dev` 时注册。`build` 和 `preview` 都不会注册该中间件。

`load()`（app.js）启动探测：GitHub Pages（`*.github.io`）与 `file:` 直开 → 直接 `modeLocal()`，**不发 `/api/apps` 请求**（控制台零 404）；其余环境请求 `/api/apps`，成功 → `MODE='server'`（数据写 `data/*.json`，权威），404/非 JSON/异常 → `modeLocal(reason)` 降级，读写 `localStorage['adiw.warehouse']`（整库 JSON）。`save()/deleteApp/restoreJSON` 均按 `MODE` 分流。静态模式下 Google Play 抓取/图标/Excel 导入不可用（`lookupBind`/`refreshPlay` 有守卫 toast），`appIcon`/`appIc` 在 `MODE==='local'` 直接渲字母徽章（不发 `/icons/*` 请求）。备份迁移用应用列表头部的「⧓ 导出备份 / ⇪ 导入备份」：导出 `{version,exportedAt,apps}` 下载 JSON；导入走 `#importFile`（accept 已含 `.json`）按扩展名分支，覆盖前 confirm。切勿依赖 `index.html` 直开保存。GitHub Pages 由 `.github/workflows/deploy.yml` 用 Vite 构建 `dist/` 自动部署（`base:'./'` 相对路径）。

## 架构

- `app.js` — 整个应用：数据模型、渲染、事件处理、API 调用、双模式持久化（`MODE`/`localStorage['adiw.warehouse']`）与 JSON 备份迁移（50 行，高度压缩）
- `index.html` — 外壳：侧边栏、顶栏（面包屑切换器/进度胶囊）、工作区容器、toast、导入预览浮层、批量粘贴气泡窗（`#pastePopover`）
- `styles.css` — 全部样式，含手风琴内嵌矩阵 + iOS 风格响应式设计
- `importer.js` — XLSX 导入核心（纯函数：`parseXlsx`/`buildImportModel`/`applyImport`）
- `vite.config.js` — Vite 配置（构建相对 base `'./'`） + 通过 `configureServer` 插件实现的本地 JSON 文件 API 与 Google Play 抓取/图标缓存
- `.github/workflows/deploy.yml` — GitHub Pages 自动部署：`npm ci && npm run build` 后上传 `dist/`
- `data/*.json` — 持久化应用数据，每个应用一个 JSON 文件（文件名 = 应用名）
- `data/play-meta.json` — Google Play 包名 → 商店元数据缓存（防重复抓取）
- `icons/` — 抓取到的应用图标本地文件缓存（`<包名>.<png|webp|jpg>`），经 `/icons/*` 长缓存（86400s）静态服务

## 数据模型

`Application → Format → Placement → Segment → ID Config`（四级层级）。ID 通过 `app.js:3` 的基于时间戳的 `uid()` 生成。`app.js:10` 的 `calc()` 为锁定项重算 `floorPrice` 与 `adName`；底价按组标识倍率计算（L×1.15 / H×1.35 / M×1.8）。ID Config 另有运营状态字段 `opState`（`OPST` 四态）：`running`=🟢运行中 / `mediation`=🟠中介组未建 / `meta`=🟣Meta未建 / **缺省或 `idle`=⚪未创建**（零迁移）。

应用另有 Google Play 关联字段（可选）：`pkg`（包名，同时作为图标缓存文件名）、`title`（商店真实名称）、`dev`/`genre`（开发者/分类，写回缓存）、`icon`（本地图标文件名 `icons/<pkg>.<ext>`）、`iconState`（`ok`=图标就绪 / `err`=商店未找到或下载失败 / 缺字段=未绑定）。历史应用无这些字段，按“未绑定”渲染，零迁移。

## 交互与状态

- **层级导航（面包屑切换器，`renderNav`）**：取代旧 3 张维度卡片。`apps` 显示静态“⌂ 应用列表”；`app`/`placement` 显示三段式 `⌂ 应用列表 / [应用名 ▾] / [广告位代码▾]`（根节点 `crumb-root` 用 `data-switch-select="apps"` 直返应用列表），点击 `▾` 弹出 `#switchPopover`（`state.openDropdown` 控制）就地搜索切换：选应用落到其广告位列表层（`app` 视图），选广告位直达 `placement` 视图；“查看全部 App”回应用列表。**键盘导航**：开层自动聚焦搜索框，`↑↓` 在可见 `.switch-item` 间循环高亮（`.ki`＋滚入视野），`Enter` 确认（聚焦搜索框时），输入过滤后高亮自动重置到首项；点击外部或 `Esc` 关闭。
- **进度胶囊（`statusCapsule`，`renderCap`）**：按层级上下文显示 `[进度条] filled/total 就绪 + 状态标签`，需可点时追加 `▾`。状态标签（`N 组待回填`橙 / `已全部就绪`绿 / `待配置`灰）。**待回填 = 分组内存在空 placementId 行的分组数**。`placement` 层且有待回填时标签可点击 → 切换 `state.pendingOnly` 过滤瀑布流只显待回填分组（头部出现“仅看待回填 ×”chip）。
- **单页手风琴**：流量分组层（`placementView`）平铺全部分组，不再有独立 segment 页跳转。`render()` 分发只有 `{apps, app, placement, copy}`。“N/M 已展开”计数移至工具栏 `toggle-all` 旁。
- **复制中心（`copyView`，侧边栏 `data-navside="copy"` → `state.level==='copy'`）**：全库 ID 扁平化平铺工作台（表格列：勾选/序号/应用·广告位/层级/标识/底价/广告名称/广告 ID/Meta ID/状态，Meta ID 空值显「未回填」灰色斜体）。**组合筛选**（`state.cc`）：应用选择器为自定义下拉弹层（`state.ccAppSel`，触发器 `.cc-app-trigger` + 弹层 `.cc-appsel-pop`，每项前显缓存图标 / `.pv-letter.sm` 字母徽章；点击选择、`↑↓ki` 高亮、`Enter` 确认、Esc/外点关闭；联动广告位下拉，未选应用时禁用）、组标识 `L/M/H` 分段、排序（`tag`=标识 L-M-H 升序 / `price`=底价高→低 / `pri`=P1→P8）、顶栏搜索框复用为 名称/ID/应用/广告位 模糊搜索（renderNav 切换 placeholder）。**状态速筛 Tab**：全部/运行中/未创建/中介组未建/Meta未建，带实时计数（计数基于状态之外的筛选，Tab 本身不过滤计数）；surface-head 右侧有全库「ID 概况」胶囊与 ⚙️ 格式模板。**勾选**（`state.ccSel` Set + `ccAnchor` 锚点）：复选框支持 `Shift+点击` 范围连选（`input[data-cc-check]` preventDefault 后程序化勾选），表头/浮条 `data-cc-all` 全选当前筛选；筛选/搜索变化时自动修剪不可见选中项。**批量浮条 `.cc-bulk`**（勾选 ≥1 行 sticky 浮现）：4 个打状态按钮（按 app 分组去重后 `Promise` 并行 `save`，Toast「已将 N 个 ID 状态更新为 [××] ✓」）+ 复制 ID/名称/底价/Meta ID/ID+底价(TSV)/导出 Excel(全列 TSV)，按钮成功后文字变绿「✓ 已复制 N 项」1.5s 复原。**行交互**：状态 Pill（`data-cc-menu`）点击弹 fixed 定位四态菜单（`state.ccMenu` 存坐标）；广告名称/广告 ID 单元格悬停出 `📋`（复用 `data-quick-copy`）。**键盘**：勾选后 `Ctrl+C`/`Cmd+C` 直取选中行广告 ID（焦点不在输入框时）。**格式模板**（`localStorage['ccTpl']`，默认 `{广告名称} | {广告ID} | {底价}`）：占位符 `{应用}{广告位}{层级}{标识}{底价}{广告名称}{广告ID}{Meta ID}`，输入实时预览首行，按模板复制（有勾选用勾选，否则全部筛选结果）。
- **`state.open{}`**：记录已展开分组 ID 集合，支持多开。`toggleOpen/toggleAll`（`app.js:6-7`）负责单个 / 全部展开收起；`segOf()`（`app.js:5`）从 DOM 向上取 `data-seg` 定位所属分组，避免多开串组。
- **`segmentPanel(s)`**：手风琴行内嵌的 ID 配置矩阵（批量生成、表头列操作、批量导出、类 Excel 网格）。面板头仅保留 `⚡ 批量生成` 与 `⧉ 批量导出 ▾`（`state.exportMenu` 控制下坠菜单，`data-export-tsv` 一键复制当前分组全表＝表头+数据行、制表符分隔可直接贴入 Excel）。
- **表头集成列操作（`thCol`）**：底价/广告名称表头悬停出 `📋 复制全列`（触屏 `hover:none` 常显）；广告 ID / Meta 来源 ID 表头另加 `📥 批量粘贴`。复制＝按行提取该列全部值以 `\n` 连接写入剪贴板（底价去 `$` 纯数字），图标瞬变绿 `✓` 1.5s 复原（`flashCopied`），Toast `已复制 N 行<列名>到剪贴板 ✓`。
- **批量粘贴双模（ID 列）**：**A 极速模式**——多行粘贴进矩阵内任意 ID 输入框，无确认直接覆盖当前分组前 `min(行数, rows)` 行该列（其余保留），受影响输入框绿闪（`cell-flash`/`flashCells`）＋Toast `已自动批量填充 N 个广告 ID/Meta ID`；**B 可视化模式**——表头 `📥` 开 `#pastePopover`（`state.pastePop`，fixed 定位锚在按钮下方/上方），textarea 输入实时校验行数 vs 槽位数：相等→绿色`完美匹配 ✓`（确认按钮变绿）、超出→黄色`将只填充前 N 个`、不足→橙色`第 N+1 槽位保持为空`，`确认回填`从第 1 行填充并绿闪反馈，`Ctrl+Enter` 确认、`Esc`/点外部/取消关闭。
- **分组定位**：批量生成、整列复制/回填、编辑、删除等操作都以 `draft.seg` 或 `data-seg` 定位目标分组，而非全局 `segment()`。
- **批量生成**：`⚡ 批量生成 L/H/M`——输入每组数量 n，生成 3n 条（L/H/M 各 n），广告源固定为 `Admob`，`draft.type==='batch'` 且 `draft.seg` 绑定分组。
- **整列回填**：已并入「批量粘贴双模」的极速模式（见上）——多行粘贴到任意 ID 输入框 → 覆盖当前分组前 `min(行数, rows)` 行的该列，其余保留，无确认弹窗。
- **草稿框拆行**：在“快速添加”草稿框粘贴多行 → 拆分为多条新记录（`draft.type==='id'`）。
- **Tab 纵向盲打**：焦点在 `[data-field="placementId"]` 时，Tab 在同一分组内跨行跳转到下一行同列（Shift 反向）。
- 快捷键：`Ctrl+K`/`Cmd+K` 聚焦搜索、`Alt+1` 直达应用列表、`Enter` 提交草稿、`Esc` 关闭批量粘贴气泡窗 / 取消草稿 / 关闭绑定浮层 / 关闭导入浮层 / 关闭切换浮层 / **逐级上跳**（`placement→app→apps`）、气泡窗内 `Ctrl+Enter` 确认回填。
- **Google Play 绑定（`appIcon` + `#appModal`）**：应用列表第一列＝图标四态（`ok`=真实图标 / `err`=双字母前缀＋hover“未在 Play 商店找到该应用” / `none`=虚线 `＋` 开绑定弹窗 / 加载中 shimmer）。行内信息流＝代号粗体＋商店真实名（省略）＋包名（mono，hover 出 `📋` 复制）。操作列 `✏️` 绑定/更改包名、`🔄` 刷新商店数据（`?refresh=1` 强制抓取）、`⧉/×/→` 保留。绑定弹窗中包名输入 blur/Enter 触发抓取预览（图标＋标题＋开发者＋分类），提交写回应用数据并保存。图标框 hover 微放大＋右下 `↗` 开 Play 详情页。新建应用仍走行内草稿，弹窗仅服务绑定/改包名。

## 注意事项

- **导入规则**（`importer.js`）：广告类型由 `inferType` 关键词推断（口诀：`inter`/`int` 词边界→插屏、`reward`→激励视频、`banner`→横幅、`splash`/`open`→开屏、`native`→原生），仍无法识别的在导入预览下拉手动指定（`typeMap`，键 `应用|代码`）。**聚合平台复合值**（如 `Admob,Pangle`）在预览由用户单选（`platformMap`，取单值写入 `mediation`/`network`）。底价差异**绝对值 < 1 放行**（`floorOk`，`importer.js:117`），导入后统一按 eCPM×倍率用 `calc()` 重算。**同价值分组可重复**：同名不同 eCPM 视为不同分组保留（合并/定位键 = 名称+eCPM），同名同 eCPM 才合并更新。导入只保证 应用/广告位/广告类型/价值分组/参考eCPM/广告ID/Meta广告ID 正确，广告名称与底价由项目自行组合/计算（不采信表内名称与底价）。未知广告位必须全部选完才能导入。**adName 生成**（`calc()` 与导入预览 `makeAdName` 同一清洗公式）：各段空白→`_`，仅删除非 CJK 的噪声字符，**中文流量分组名（`\u4e00-\u9fff`）原样保留在名称中**。
- API 无鉴权，仅限可信的本机开发环境
- **应用名 = 文件名**（`data/` 下）——避免操作系统不允许的字符；同名会覆盖
- **自动保存**：eCPM 与 ID 输入约 1 秒（`schedule`，`app.js:13`）防抖后 POST 到 `/api/apps/save`
- **Google Play 抓取**：`google-play-scraper`（默认 `gplay.app` 自带无内存在线缓存）仅由 `vite.config.js` 的服务端中间件调用；`data/play-meta.json` + `icons/` 是唯一持久缓存层，列表加载绝不并发请求 Play（防限流/CORS）。`?refresh=1` 跳过 meta 缓存强制重抓。图标 URL 尺寸段（`=w…h…`）裁剪后以 `=w512-h512-rw` 下载，魔数识别 `png/webp/jpg` 落盘。404 确认不算命中时写 `{found:false}` 防重复打接口（瞬态 5xx/限流只返回不落盘，`msg` 字段留存原因可重试）。**包名接受完整 Play 商店链接**：`pkgOf`（app.js）与 `safePkg`（vite.config.js）先匹配 `[?&]id=` 提取真实包名，再校验点号结构且拒绝含 `https`/`storeapps`/`playgoogle` 的伪 URL 串，非法即拒绝（客户端 toast 提示，服务端回 400，均不写缓存）——防止把链接当包名抓取出垃圾缓存。包名前缀双字母（`pvOf`）作为 `err` 态占位，字号 13px 且不可去除内描边（防白图标融色）。
- **Vite 版本**：`package.json` 声明 `^5.0.0`。2026-09 已装 `google-play-scraper@10.1.3` 时 lockfile 重算，vite 稳定到 `5.4.21`（与声明一致）——重新 `npm install` 需保持该版本一致，勿混入 8.x
- `app.js` 通过 `<script type="module">` 作为单模块脚本加载——无打包器转换、无 JSX、无 TypeScript
- 界面语言为中文（zh-CN）
