#!/usr/bin/env node
/**
 * OpenPrice Pro - 生产级静态网页服务 + 内置每日 00:00 自动更新调度器
 *
 * 启动后：
 * - 在 http://localhost:8080 提供已构建的网页版 OpenPrice Pro
 * - 自动在每天本地时间 00:00:00 执行 updatePrices() 刷新最新汇率与价格数据
 * - 启动时若当天尚未更新，自动补跑一次更新
 * - 提供 GET /api/status 和 POST /api/trigger-update 接口
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { updatePrices } from './update-prices.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const PUBLIC_JSON = path.join(ROOT_DIR, 'public', 'prices_all_countries.json');
const DIST_JSON = path.join(DIST_DIR, 'prices_all_countries.json');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

let isUpdating = false;
let lastResult = null;
let nextScheduledAt = null;

function getLocalDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getMsUntilNextMidnight(now = new Date()) {
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return Math.max(1000, next.getTime() - now.getTime());
}

async function runSafeUpdate(reason = 'scheduled') {
  if (isUpdating) return lastResult;
  isUpdating = true;
  console.log(`[Scheduler] 触发数据更新 (reason=${reason}) @ ${new Date().toLocaleString('zh-CN')}`);
  try {
    lastResult = await updatePrices();
    return lastResult;
  } catch (err) {
    console.error('[Scheduler] 更新失败:', err);
    return null;
  } finally {
    isUpdating = false;
  }
}

function scheduleNextMidnight() {
  const ms = getMsUntilNextMidnight();
  nextScheduledAt = new Date(Date.now() + ms);
  console.log(
    `[Scheduler] 已设定下次 00:00 自动更新：${nextScheduledAt.toLocaleString('zh-CN')} (约 ${Math.round(ms / 60000)} 分钟后)`
  );
  const timer = setTimeout(async () => {
    await runSafeUpdate('daily-00:00');
    scheduleNextMidnight();
  }, ms);
  timer.unref?.();
}

function shouldRunInitialUpdate() {
  const target = fs.existsSync(DIST_JSON) ? DIST_JSON : PUBLIC_JSON;
  if (!fs.existsSync(target)) return true;
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    const updatedAt = parsed?.meta?.updatedAt;
    if (!updatedAt) return true;
    return getLocalDateKey(new Date(updatedAt)) !== getLocalDateKey(new Date());
  } catch {
    return true;
  }
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(reqUrl.pathname);

  // API: 查询调度与更新状态
  if (pathname === '/api/status') {
    let snapshotMeta = null;
    const jsonPath = fs.existsSync(DIST_JSON) ? DIST_JSON : PUBLIC_JSON;
    if (fs.existsSync(jsonPath)) {
      try {
        snapshotMeta = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).meta || null;
      } catch {
        snapshotMeta = null;
      }
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(
      JSON.stringify({
        ok: true,
        isUpdating,
        nextScheduledAt: nextScheduledAt?.toISOString() || null,
        snapshotMeta,
      })
    );
    return;
  }

  // API: 手动触发后台立即更新
  if (pathname === '/api/trigger-update' && req.method === 'POST') {
    const result = await runSafeUpdate('manual-api');
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ ok: Boolean(result), meta: result?.meta || null }));
    return;
  }

  // 静态文件服务 (dist/)
  if (!fs.existsSync(DIST_DIR)) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('前端尚未构建，请先执行: npm run build');
    return;
  }

  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(DIST_DIR, safePath === '/' || safePath === '\\' ? 'index.html' : safePath);

  // 优先返回最新价格 JSON 且禁用缓存
  if (pathname === '/prices_all_countries.json') {
    filePath = fs.existsSync(DIST_JSON) ? DIST_JSON : PUBLIC_JSON;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST_DIR, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const cacheControl =
    ext === '.json' || ext === '.html'
      ? 'no-store, no-cache, must-revalidate'
      : 'public, max-age=31536000, immutable';

  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': cacheControl,
  });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, HOST, async () => {
  console.log(`\n🚀 OpenPrice Pro 网页版已启动：http://localhost:${PORT}`);
  console.log(`🕛 每日 00:00 自动更新守护进程已激活`);
  scheduleNextMidnight();
  if (shouldRunInitialUpdate()) {
    await runSafeUpdate('startup-catchup');
  } else {
    console.log('[Scheduler] 今日数据快照已存在，等待下次 00:00 自动更新。');
  }
});
