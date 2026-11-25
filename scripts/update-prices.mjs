#!/usr/bin/env node
/**
 * OpenPrice Pro - 每日 00:00 全渠道真实支付价格爬虫总控引擎
 *
 * 严格真实原则（零假数据、零估算伪装）：
 * 1. 全球 166 种实时外汇牌价 (open.er-api.com + exchangerate-api.com)
 * 2. Apple App Store 全量 175 国 × 6 大移动端 AI 应用逐规格真实直采 (scripts/crawlers/apple-175.mjs)
 * 3. Google Play 47 国官方公开页 IAP 真实价格区间 & 币种直采 + 可选 Play Billing 实测 SKU 导入 (scripts/crawlers/google-play.mjs)
 * 4. Web Stripe 真实结账页 Dry-Run 算税与免税州去税探测 + 实测账单核验库 (scripts/crawlers/stripe-dryrun.mjs)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crawlAppleAll175 } from './crawlers/apple-175.mjs';
import { crawlGooglePlay } from './crawlers/google-play.mjs';
import { crawlWebStripeDryRun } from './crawlers/stripe-dryrun.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_OUT = path.join(ROOT_DIR, 'public', 'prices_all_countries.json');
const DIST_OUT = path.join(ROOT_DIR, 'dist', 'prices_all_countries.json');

const FX_ENDPOINTS = [
  { name: 'open.er-api.com', url: 'https://open.er-api.com/v6/latest/USD' },
  { name: 'exchangerate-api.com', url: 'https://api.exchangerate-api.com/v4/latest/USD' },
];

function formatBeijingTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
}

function getNextBeijingMidnightStr(now = new Date()) {
  const bjOffsetMs = 8 * 3600 * 1000;
  const bjNow = new Date(now.getTime() + bjOffsetMs);
  bjNow.setUTCHours(24, 0, 0, 0);
  const nextUtc = new Date(bjNow.getTime() - bjOffsetMs);
  return formatBeijingTime(nextUtc);
}

async function fetchLiveFXRates() {
  for (const ep of FX_ENDPOINTS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(ep.url, { headers: { Accept: 'application/json' }, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const data = await res.json();
      if (data?.rates && typeof data.rates.CNY === 'number') {
        return {
          ok: true,
          source: ep.name,
          rates: data.rates,
          fxLastUpdateUtc: data.time_last_update_utc || data.date || new Date().toISOString(),
        };
      }
    } catch (err) {
      console.warn(`[FX] ${ep.name} 拉取失败:`, err?.message || err);
    }
  }
  return { ok: false, source: 'fallback', rates: null, fxLastUpdateUtc: null };
}

export async function updatePrices({ skipIapProbe = false } = {}) {
  const startedAt = new Date();
  console.log(`[OpenPrice Pro] 开始执行全量真实支付价格爬虫 (${formatBeijingTime(startedAt)} 北京时间)...`);

  let previousSnapshot = null;
  if (fs.existsSync(PUBLIC_OUT)) {
    try {
      previousSnapshot = JSON.parse(fs.readFileSync(PUBLIC_OUT, 'utf8'));
    } catch {
      previousSnapshot = null;
    }
  }

  // 1. 拉取全球 160+ 实时外汇
  const fx = await fetchLiveFXRates();
  const finalRates = fx.rates || previousSnapshot?.rates || null;
  console.log(`[1/4 FX] ${fx.ok ? '成功' : '降级缓存'} · ${finalRates ? Object.keys(finalRates).length : 0} 种货币 · 1 USD = ¥${finalRates?.CNY ?? 'N/A'}`);

  // 2. 并行运行三路真实采集器：Apple 全量 175 国 + Google Play + Web Stripe Dry-Run
  const [appleRes, gplayRes, webRes] = skipIapProbe
    ? [
        { liveIapPrices: previousSnapshot?.liveIapPrices || {}, stats: { targetStorefronts: 175, storefrontsHit: 0, totalSkuHits: 0, durationMs: 0 } },
        { liveGPlayRanges: previousSnapshot?.liveGPlayRanges || {}, liveGPlayExact: previousSnapshot?.liveGPlayExact || {}, stats: { rangeHits: 0, exactSkuHits: 0, durationMs: 0 } },
        await crawlWebStripeDryRun(ROOT_DIR),
      ]
    : await Promise.all([
        crawlAppleAll175(finalRates, { concurrency: 16 }),
        crawlGooglePlay(ROOT_DIR, { concurrency: 18 }),
        crawlWebStripeDryRun(ROOT_DIR),
      ]);

  console.log(
    `[2/4 Apple App Store] 实采命中 ${appleRes.stats.storefrontsHit}/${appleRes.stats.targetStorefronts} 国 · 共 ${appleRes.stats.totalSkuHits} 条逐规格真实内购价 (${appleRes.stats.durationMs}ms)`
  );
  console.log(
    `[3/4 Google Play] 官方公开页实采 ${gplayRes.stats.rangeHits} 条真实价格区间 · 精确 Play Billing SKU=${gplayRes.stats.exactSkuHits} 条 (${gplayRes.stats.durationMs}ms)`
  );
  console.log(
    `[4/4 Web Stripe] 已配置会话=${webRes.stats.configuredSessions} · 实时 Dry-Run=${webRes.stats.probedCount} 条 · 实测账单库=${webRes.stats.receiptsLoaded} 条 (${webRes.stats.durationMs}ms)`
  );

  const finishedAt = new Date();
  const payload = {
    meta: {
      schemaVersion: 4,
      strictRealOnly: true,
      updatedAt: finishedAt.toISOString(),
      updatedAtBeijing: formatBeijingTime(finishedAt),
      nextScheduledUpdateBeijing: getNextBeijingMidnightStr(finishedAt),
      scheduleRule: '每天 00:00 自动更新 (Asia/Shanghai)',
      fxStatus: fx.ok ? 'live' : previousSnapshot?.rates ? 'cached' : 'fallback',
      fxSource: fx.ok ? fx.source : previousSnapshot?.meta?.fxSource || 'builtin-fallback',
      fxLastUpdateUtc: fx.fxLastUpdateUtc || previousSnapshot?.meta?.fxLastUpdateUtc || null,
      fxCurrencyCount: finalRates ? Object.keys(finalRates).length : 0,
      usdToCny: finalRates?.CNY || null,
      liveIapProbedCount: appleRes.stats.totalSkuHits,
      liveStorefrontsHit: appleRes.stats.storefrontsHit,
      appleTargetStorefronts: appleRes.stats.targetStorefronts,
      gplayRangeHits: gplayRes.stats.rangeHits,
      gplayExactSkuHits: gplayRes.stats.exactSkuHits,
      webStripeLiveProbedCount: webRes.stats.probedCount,
      webVerifiedReceiptsCount: webRes.stats.receiptsLoaded,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    },
    rates: finalRates,
    taxRegimes: webRes.taxRegimes || {},
    liveIapPrices: appleRes.stats.totalSkuHits > 0 ? appleRes.liveIapPrices : previousSnapshot?.liveIapPrices || {},
    liveGPlayRanges: gplayRes.stats.rangeHits > 0 ? gplayRes.liveGPlayRanges : previousSnapshot?.liveGPlayRanges || {},
    liveGPlayExact: gplayRes.liveGPlayExact || {},
    liveWebPrices: webRes.liveWebPrices || {},
    overrides: previousSnapshot?.overrides || {},
  };

  fs.mkdirSync(path.dirname(PUBLIC_OUT), { recursive: true });
  const serialized = JSON.stringify(payload, null, 2);
  fs.writeFileSync(PUBLIC_OUT, serialized, 'utf8');

  if (fs.existsSync(path.dirname(DIST_OUT))) {
    fs.writeFileSync(DIST_OUT, serialized, 'utf8');
  }

  console.log(
    `[OpenPrice Pro] 全渠道真实采集完成！总耗时=${payload.meta.durationMs}ms，已落盘至 public/prices_all_countries.json`
  );
  return payload;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const skipIap = process.argv.includes('--fx-only');
  updatePrices({ skipIapProbe: skipIap }).catch((err) => {
    console.error('[OpenPrice Pro] 爬虫运行异常:', err);
    process.exitCode = 1;
  });
}
