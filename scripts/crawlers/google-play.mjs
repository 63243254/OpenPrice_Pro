/**
 * Google Play Store 官方公开页实时探测器
 *
 * 诚实技术说明：
 * Google Play 网页端 (play.google.com/store/apps/details?id=...&gl={iso}&hl=en)
 * 公开返回的是该国 Play 商店的真实 IAP 价格区间（例如 "₱300.00 - ₱32,490.00 per item"）及真实结算币种；
 * 中间每个具体订阅 SKU 的精确价格仅在 Android 客户端登录后通过 Play Billing API (queryProductDetailsAsync) 返回。
 *
 * 本模块职责：
 * 1. 并发直采 46 个核心国家/地区 × 6 大 AI 应用的 Google Play 官方公开 IAP 区间与真实结算币种；
 * 2. 若用户已通过锁区 Android 设备导出了真实 Play Billing SKU 实采数据 (config/gplay-billing-skus.json)，
 *    自动合并为逐档位精确真价；否则绝不编造中间档位假价格！
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseLocalizedNumber, detectCurrency } from './apple-175.mjs';

export const GOOGLE_PLAY_APPS = [
  { aiId: 'chatgpt', pkg: 'com.openai.chatgpt', lowestPlanId: 'gpt-go-m', highestPlanId: 'gpt-pro-500' },
  { aiId: 'claude', pkg: 'com.anthropic.claude' },
  { aiId: 'gemini', pkg: 'com.google.android.apps.subscriptions.red' },
  { aiId: 'grok', pkg: 'ai.x.grok' },
  { aiId: 'perplexity', pkg: 'ai.perplexity.app.android' },
  { aiId: 'poe', pkg: 'com.poe.android' },
];

export const GOOGLE_PLAY_COUNTRIES = [
  'US', 'CA', 'PH', 'NG', 'PK', 'TR', 'IN', 'BD', 'JP', 'KR', 'HK', 'TW', 'SG', 'MY', 'TH', 'ID', 'VN',
  'KZ', 'EG', 'ZA', 'KE', 'GH', 'UA', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'PL', 'CZ', 'HU', 'RO', 'SE',
  'NO', 'DK', 'CH', 'AU', 'NZ', 'BR', 'MX', 'CO', 'CL', 'PE', 'AR', 'AE', 'SA'
];

async function fetchWithTimeout(url, options = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function extractGPlayIapRange(html) {
  // 匹配 Google Play 内嵌 JSON 中主 App 的 ["<min> - <max> per item", ...]
  const m = html.match(/\["([^"\[\]]+?)\s*-\s*([^"\[\]]+?)\s+per item",\s*\[0\]\]/i);
  if (!m) return null;
  const minText = m[1].trim();
  const maxText = m[2].trim();
  const minVal = parseLocalizedNumber(minText);
  const maxVal = parseLocalizedNumber(maxText);
  if (!minVal || !maxVal) return null;
  const currency = detectCurrency(minText, null);
  return {
    currency,
    minAmount: minVal,
    maxAmount: maxVal,
    rawRange: `${minText} - ${maxText}`,
  };
}

async function runWithConcurrency(tasks, limit = 16) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const current = idx++;
      results[current] = await tasks[current]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

export async function crawlGooglePlay(rootDir, { concurrency = 18 } = {}) {
  const started = Date.now();
  const liveGPlayRanges = {};
  const liveGPlayExact = {};
  let rangeHits = 0;
  let exactSkuHits = 0;

  // 1. 公开页直采真实 IAP 价格区间 + 结算币种
  const jobs = [];
  for (const app of GOOGLE_PLAY_APPS) {
    for (const iso of GOOGLE_PLAY_COUNTRIES) {
      jobs.push(async () => {
        const url = `https://play.google.com/store/apps/details?id=${app.pkg}&gl=${iso.toLowerCase()}&hl=en`;
        try {
          const res = await fetchWithTimeout(
            url,
            {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
              },
            },
            9000
          );
          if (!res.ok) return null;
          const html = await res.text();
          const range = extractGPlayIapRange(html);
          if (!range) return null;
          return { aiId: app.aiId, iso, range };
        } catch {
          return null;
        }
      });
    }
  }

  const results = await runWithConcurrency(jobs, concurrency);
  for (const r of results) {
    if (!r) continue;
    if (!liveGPlayRanges[r.aiId]) liveGPlayRanges[r.aiId] = {};
    liveGPlayRanges[r.aiId][r.iso] = r.range;
    if (r.iso === 'US') {
      liveGPlayRanges[r.aiId]['US-TX'] = r.range;
    }
    rangeHits += 1;
  }

  // 2. 若用户已提供真实 Android Play Billing 导出的精确 SKU 文件，自动合入
  const exactFile = path.join(rootDir, 'config', 'gplay-billing-skus.json');
  if (fs.existsSync(exactFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(exactFile, 'utf8'));
      for (const [aiId, plans] of Object.entries(parsed || {})) {
        if (aiId.startsWith('_')) continue;
        liveGPlayExact[aiId] = plans;
        for (const countries of Object.values(plans || {})) {
          exactSkuHits += Object.keys(countries || {}).length;
        }
      }
    } catch (err) {
      console.warn('[GooglePlay] 读取 config/gplay-billing-skus.json 失败:', err.message);
    }
  }

  return {
    liveGPlayRanges,
    liveGPlayExact,
    stats: {
      rangeHits,
      exactSkuHits,
      durationMs: Date.now() - started,
    },
  };
}
