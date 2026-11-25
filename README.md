# OpenPrice Pro 网页版（每日 00:00 自动更新）

基于 `openprice_pro_195_ai.tsx` 构建的独立网页版，覆盖全球 198 个国家/独立结算区、8 大主流 AI 平台、28 个订阅档位及 166 种法定货币实时汇率，并内置**三重每日 00:00 自动更新机制**。

## 快速启动

### 方式一：双击一键启动（推荐）
直接双击 `start.bat`，会自动启动本地网页服务器（默认 `http://localhost:8080`）并在浏览器打开，同时激活**后台每日 00:00 自动更新守护进程**。

### 方式二：命令行启动
```bash
# 1. 手动执行一次最新汇率与价格更新
npm run update-data

# 2. 开发模式预览 (热更新)
npm run dev

# 3. 构建并启动生产版（含内置 00:00 自动更新调度器）
npm run build
npm start
```

## 三重每日 00:00 自动更新机制

1. **网页端自动刷新（前端）**：
   - 打开网页后顶部状态栏实时显示距离下次 `00:00` 的倒计时；
   - 到达本地 `00:00:01` 自动重新拉取 `prices_all_countries.json` 与 160+ 实时汇率并重算全量 198 国排行；
   - 若电脑休眠跨日后唤醒页面，会自动检测日期翻篇并立即补更新。
2. **本地后台 / Windows 计划任务（本机）**：
   - 运行 `npm start`（或 `start.bat`）时，`scripts/server.mjs` 内置每日 `00:00:00` 定时调度器；
   - 也可右键使用 PowerShell 运行 `scripts/install-midnight-task.ps1` 注册 Windows 系统计划任务 `OpenPricePro-DailyMidnightUpdate`（支持休眠唤醒自动补跑）；卸载可运行 `scripts/uninstall-midnight-task.ps1`。
3. **云端 GitHub Actions + GitHub Pages（线上托管）**：
   - 仓库已内置 `.github/workflows/daily-update.yml`，定时为 `0 16 * * *`（UTC 16:00 = 北京时间每日 00:00）；
   - 推送到 GitHub 并在仓库 Settings → Pages 中选择 Source 为 `GitHub Actions`，即可获得永久在线、每天北京时间 00:00 自动更新数据的公开网页版。
