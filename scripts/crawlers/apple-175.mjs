/**
 * Apple App Store 全量 175 个国家/地区真实内购价格爬虫
 * 直接请求 https://apps.apple.com/{iso}/app/id{appId} 并解析 Apple 官方页面 JSON (serialized-server-data)
 * 零估算、零编造：仅输出从 Apple 官方服务器实时解析并通过币种/区间核验的真实标价。
 */

// Apple 全球全部 175 个开通 App Store 的国家/地区 ISO 代码
export const APPLE_175_STOREFRONTS = [
  'ae','af','ag','ai','al','am','ao','ar','at','au','az','ba','bb','be','bf','bg','bh','bj','bm','bn',
  'bo','br','bs','bt','bw','by','bz','ca','cd','cg','ch','ci','cl','cm','co','cr','cv','cy','cz','de',
  'dk','dm','do','dz','ec','ee','eg','es','fi','fj','fm','fr','ga','gb','gd','ge','gh','gm','gr','gt',
  'gw','gy','hk','hn','hr','hu','id','ie','il','in','iq','is','it','jm','jo','jp','ke','kg','kh','kn',
  'kr','kw','ky','kz','la','lb','lc','lk','lr','lt','lu','lv','ly','ma','md','me','mg','mk','ml','mm',
  'mn','mo','mr','ms','mt','mu','mv','mw','mx','my','mz','na','ne','ng','ni','nl','no','np','nr','nz',
  'om','pa','pe','pg','ph','pk','pl','pt','pw','py','qa','ro','rs','rw','sa','sb','sc','se','sg','si',
  'sk','sl','sn','sr','st','sv','sz','tc','td','th','tj','tm','tn','to','tr','tt','tw','tz','ua','ug',
  'us','uy','uz','vc','ve','vg','vn','vu','xk','ye','za','zm','zw'
];

// 6 大移动端 AI 官方 Apple App Store ID
export const APPLE_APPS = [
  { aiId: 'chatgpt', appId: '6448311069' },
  { aiId: 'claude', appId: '6473753684' },
  { aiId: 'gemini', appId: '6477489729' },
  { aiId: 'grok', appId: '6670324846' },
  { aiId: 'perplexity', appId: '1668000334' },
  { aiId: 'poe', appId: '1640745955' },
];

// 美/加 Apple App Store 票面不含税，弹窗结账按邮编加收州/省税；其余地区票面价均已含当地税
const TAX_EXCLUSIVE_STOREFRONTS = new Set(['US', 'CA']);

// 各档位美元锚点，用于过滤苹果同名 SKU 中混入的年付/周付错配项
const PLAN_EXPECTED_USD = {
  'gpt-go-m': 8,
  'gpt-plus-m': 20,
  'gpt-pro-100': 100,
  'gpt-pro-200': 200,
  'gpt-pro-500': 500,
  'claude-pro-m': 20,
  'claude-pro-y': 215,
  'claude-max-5x': 125,
  'claude-ultra-20x': 250,
  'gemini-plus-m': 4.99,
  'gemini-pro-m': 19.99,
  'gemini-ultra-20x': 199.99,
  'grok-lite-m': 10,
  'grok-super-m': 30,
  'grok-super-y': 300,
  'grok-plus-m': 100,
  'grok-heavy-m': 300,
  'pplx-pro-m': 20,
  'pplx-pro-y': 200,
  'pplx-max-m': 200,
  'poe-basic-m': 4.99,
  'poe-std-m': 19.99,
  'poe-std-y': 199.99,
};

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function parseLocalizedNumber(raw) {
  if (!raw) return null;
  let multiplier = 1;
  if (/\b(ribu|rb)\b|ribu/i.test(raw)) {
    multiplier = 1000;
  } else if (/\b(juta|jt)\b|juta/i.test(raw)) {
    multiplier = 1000000;
  }

  let cleaned = raw.replace(/[^\d.,]/g, '').trim();
  if (!cleaned) return null;

  if (multiplier > 1) {
    cleaned = cleaned.replace(',', '.');
    const num = Number(cleaned) * multiplier;
    return Number.isFinite(num) && num > 0 ? Math.round(num) : null;
  }

  const hasComma = cleaned.includes(',');
  const hasDot = cleaned.includes('.');
  if (hasComma && hasDot) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      cleaned = cleaned.replace(/,/g, '');
    }
  } else if (hasComma) {
    const parts = cleaned.split(',');
    if (parts.length === 2 && parts[1].length <= 2) {
      cleaned = cleaned.replace(',', '.');
    } else {
      cleaned = cleaned.replace(/,/g, '');
    }
  } else if (hasDot) {
    const parts = cleaned.split('.');
    if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3 && Number(parts[0]) >= 1)) {
      cleaned = cleaned.replace(/\./g, '');
    }
  }

  const num = Number(cleaned) * multiplier;
  return Number.isFinite(num) && num > 0 ? Number(num.toFixed(2)) : null;
}

export function detectCurrency(priceText, ldCurrency) {
  const s = (priceText || '').trim();
  // 优先识别明确 ISO 3 位货币代码（如 USD 22.99 / QAR 74.99 / TZS 59,900 / BGN 44.99）
  const isoCodeMatch = s.match(/\b(USD|EUR|GBP|JPY|KRW|CNY|HKD|TWD|MOP|SGD|AUD|NZD|CAD|CHF|SEK|NOK|DKK|ISK|PLN|CZK|HUF|RON|BGN|TRY|ILS|AED|SAR|QAR|KWD|BHD|OMR|JOD|EGP|NGN|ZAR|KES|GHS|TZS|UGX|MAD|DZD|TND|INR|PKR|BDT|LKR|NPR|PHP|IDR|VND|THB|MYR|KZT|UZS|UAH|RUB|BYN|BRL|MXN|ARS|CLP|COP|PEN|UYU|CRC|DOP|GTQ|HNL|NIO|PYG|BOB|JMD|TTD|BBD|XCD|XAF|XOF|FJD|PGK)\b/);
  if (isoCodeMatch) return isoCodeMatch[1];

  if (/US\$/i.test(s)) return 'USD';
  if (/CA\$/i.test(s)) return 'CAD';
  if (/HK\$/i.test(s)) return 'HKD';
  if (/NT\$/i.test(s)) return 'TWD';
  if (/S\$/i.test(s)) return 'SGD';
  if (/A\$/i.test(s)) return 'AUD';
  if (/NZ\$/i.test(s)) return 'NZD';
  if (/MX\$/i.test(s)) return 'MXN';
  if (/R\$/i.test(s)) return 'BRL';
  if (/₱/.test(s)) return 'PHP';
  if (/₦/.test(s)) return 'NGN';
  if (/₺/.test(s)) return 'TRY';
  if (/₹/.test(s)) return 'INR';
  if (/₩/.test(s)) return 'KRW';
  if (/€/.test(s)) return 'EUR';
  if (/£/.test(s)) return 'GBP';
  if (/¥|￥/.test(s)) return ldCurrency === 'CNY' ? 'CNY' : 'JPY';
  if (/[₫đ]/.test(s)) return 'VND';
  if (/Rp\b|ribu|juta/i.test(s)) return 'IDR';
  if (/RM\b/.test(s)) return 'MYR';
  if (/฿/.test(s)) return 'THB';
  if (/₸/.test(s)) return 'KZT';
  if (/E£/.test(s)) return 'EGP';
  if (/KSh/.test(s)) return 'KES';
  if (/GH₵/.test(s)) return 'GHS';
  if (/zł/.test(s)) return 'PLN';
  if (/Kč/.test(s)) return 'CZK';
  if (/Ft\b/.test(s)) return 'HUF';
  if (/lei\b/i.test(s)) return 'RON';
  if (/Rs\b/.test(s)) return 'PKR';
  if (/S\//.test(s)) return 'PEN';
  if (/₪/.test(s)) return 'ILS';
  if (/₴/.test(s)) return 'UAH';
  if (/^R\s*\d/.test(s)) return 'ZAR';
  return ldCurrency || 'USD';
}

function extractAppleIapList(html) {
  let ldCurrency = null;
  const ldMatch = html.match(/<script[^>]*id=["']?software-application["']?[^>]*>([\s\S]*?)<\/script>/i);
  if (ldMatch) {
    try {
      const ld = JSON.parse(ldMatch[1]);
      ldCurrency = ld?.offers?.priceCurrency || null;
    } catch {
      // ignore
    }
  }

  const m = html.match(/<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return { ldCurrency, items: [] };

  try {
    const json = JSON.parse(m[1]);
    const items = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (node.$kind === 'Annotation' && Array.isArray(node.items)) {
        const hasInAppBtn = node.items.some(
          (it) => it?.$kind === 'button' && it?.action?.origin === 'inapp'
        );
        if (hasInAppBtn || node.title === 'In-App Purchases') {
          for (const it of node.items) {
            if (it?.$kind === 'textPair' && it.leadingText && it.trailingText) {
              items.push({ title: it.leadingText.trim(), priceText: it.trailingText.trim() });
            }
          }
        }
      }
      for (const v of Object.values(node)) walk(v);
    };
    walk(json);
    return { ldCurrency, items };
  } catch {
    return { ldCurrency, items: [] };
  }
}

function mostFrequent(nums) {
  const counts = new Map();
  for (const n of nums) counts.set(n, (counts.get(n) || 0) + 1);
  let best = nums[0];
  let bestC = 0;
  for (const [k, c] of counts.entries()) {
    if (c > bestC || (c === bestC && k > best)) {
      best = k;
      bestC = c;
    }
  }
  return best;
}

function mapIapsToPlans(aiId, items, ldCurrency, isoUpper, rates) {
  const taxAtCheckout = TAX_EXCLUSIVE_STOREFRONTS.has(isoUpper);
  const parsed = items
    .map((it) => ({
      title: it.title,
      lower: it.title.toLowerCase(),
      priceText: it.priceText,
      amount: parseLocalizedNumber(it.priceText),
      currency: detectCurrency(it.priceText, ldCurrency),
    }))
    .filter((x) => x.amount !== null);

  if (parsed.length === 0) return {};

  const out = {};
  const setPlan = (planId, entry) => {
    if (!entry) return;
    const expected = PLAN_EXPECTED_USD[planId];
    if (expected && rates && rates[entry.currency]) {
      const approxUsd = entry.amount / rates[entry.currency];
      if (approxUsd < expected * 0.22 || approxUsd > expected * 2.4) {
        return;
      }
    }
    // 格式: [currency, amount, taxAtCheckout, rawDisplayString]
    out[planId] = [entry.currency, entry.amount, taxAtCheckout, entry.priceText];
  };

  if (aiId === 'chatgpt') {
    const go = parsed.find((x) => x.lower === 'chatgpt go');
    const plusList = parsed.filter((x) => x.lower === 'chatgpt plus').sort((a, b) => a.amount - b.amount);
    const pro100 = parsed.find((x) => x.lower === 'chatgpt pro 100');
    const pro200 = parsed.find((x) => x.lower === 'chatgpt pro 200');
    const pro500 = parsed.find((x) => x.lower === 'chatgpt pro 500');
    setPlan('gpt-go-m', go);
    setPlan('gpt-plus-m', plusList[0]);
    setPlan('gpt-pro-100', pro100);
    setPlan('gpt-pro-200', pro200);
    setPlan('gpt-pro-500', pro500);
  } else if (aiId === 'claude') {
    const proM =
      parsed.find((x) => x.lower.includes('claude pro') && (x.lower.includes('month') || x.lower.includes('月'))) ||
      parsed.filter((x) => x.lower.includes('claude pro')).sort((a, b) => a.amount - b.amount)[0];
    const proY =
      parsed.find((x) => x.lower.includes('claude pro') && (x.lower.includes('annual') || x.lower.includes('year') || x.lower.includes('年'))) ||
      parsed.filter((x) => x.lower.includes('claude pro')).sort((a, b) => b.amount - a.amount)[0];
    const max5 = parsed.find((x) => x.lower.includes('claude max'));
    const ultra = parsed.find((x) => x.lower.includes('claude ultra'));
    setPlan('claude-pro-m', proM);
    if (proY && (!proM || proY.amount > proM.amount * 5)) setPlan('claude-pro-y', proY);
    setPlan('claude-max-5x', max5);
    setPlan('claude-ultra-20x', ultra);
  } else if (aiId === 'gemini') {
    const plus400 = parsed
      .filter((x) => x.lower.includes('google ai plus') && x.lower.includes('400'))
      .sort((a, b) => a.amount - b.amount);
    const proList = parsed.filter((x) => x.lower.includes('google ai pro'));
    const ultra30 = parsed
      .filter((x) => x.lower.includes('google ai ultra'))
      .sort((a, b) => a.amount - b.amount);

    setPlan('gemini-plus-m', plus400[0]);
    if (proList.length > 0) {
      const minPro = Math.min(...proList.map((x) => x.amount));
      const monthlyPros = proList.filter((x) => x.amount < minPro * 5);
      const stdAmt = mostFrequent(monthlyPros.map((x) => x.amount));
      const chosen = monthlyPros.find((x) => x.amount === stdAmt) || monthlyPros[0];
      setPlan('gemini-pro-m', chosen);
    }
    setPlan('gemini-ultra-20x', ultra30[0]);
  } else if (aiId === 'grok') {
    const lite = parsed.find((x) => x.lower === 'supergrok lite');
    const supers = parsed.filter((x) => x.lower === 'supergrok').sort((a, b) => a.amount - b.amount);
    const plusList = parsed.filter((x) => x.lower === 'supergrok plus').sort((a, b) => a.amount - b.amount);
    const heavy = parsed.find((x) => x.lower === 'supergrok heavy');
    setPlan('grok-lite-m', lite);
    setPlan('grok-super-m', supers[0]);
    if (supers.length > 1 && supers[supers.length - 1].amount > supers[0].amount * 5) {
      setPlan('grok-super-y', supers[supers.length - 1]);
    }
    setPlan('grok-plus-m', plusList[0]);
    setPlan('grok-heavy-m', heavy);
  } else if (aiId === 'perplexity') {
    const pros = parsed.filter((x) => x.lower === 'perplexity pro').sort((a, b) => a.amount - b.amount);
    const maxItem = parsed.find((x) => x.lower === 'perplexity max');
    setPlan('pplx-pro-m', pros[0]);
    if (pros.length > 1 && pros[pros.length - 1].amount > pros[0].amount * 5) {
      setPlan('pplx-pro-y', pros[pros.length - 1]);
    }
    setPlan('pplx-max-m', maxItem);
  } else if (aiId === 'poe') {
    const basicM = parsed.find((x) => x.lower.includes('monthly') && x.lower.includes('basic'));
    const plusM =
      parsed.find((x) => x.lower.includes('monthly') && x.lower.includes('plus')) ||
      parsed.find((x) => x.lower === 'poe monthly subscription');
    const plusY =
      parsed.find((x) => (x.lower.includes('annual') || x.lower.includes('yearly')) && x.lower.includes('plus')) ||
      parsed.find((x) => x.lower === 'poe yearly subscription');
    setPlan('poe-basic-m', basicM);
    setPlan('poe-std-m', plusM);
    setPlan('poe-std-y', plusY);
  }

  return out;
}

async function runWithConcurrency(tasks, limit = 24) {
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

export async function crawlAppleAll175(rates, { concurrency = 8 } = {}) {
  const started = Date.now();
  const liveIapPrices = {};
  const storefrontsHit = new Set();
  let totalSkuHits = 0;
  let totalRequests = 0;
  let failedRequests = 0;

  // 核心热门与低价 46 国优先队列，避免突发限流影响核心区，其余 127 国紧随其后全量补齐
  const PRIORITY_SLUGS = [
    'us','ca','ph','ng','pk','tr','in','jp','kr','hk','tw','sg','my','th','id','vn',
    'kz','eg','za','ke','gh','ua','gb','de','fr','it','es','nl','pl','cz','hu','ro',
    'se','no','dk','ch','au','nz','br','mx','co','cl','pe','ar','ae','sa','il','me'
  ];
  const prioritySet = new Set(PRIORITY_SLUGS);
  const orderedSlugs = [
    ...PRIORITY_SLUGS.filter((s) => APPLE_175_STOREFRONTS.includes(s)),
    ...APPLE_175_STOREFRONTS.filter((s) => !prioritySet.has(s)),
  ];

  const fetchOneWithRetry = async (url, retries = 1) => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetchWithTimeout(
          url,
          {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
              'Accept-Language': 'en-US,en;q=0.9',
            },
          },
          8000
        );
        if (res.ok) return await res.text();
        if (res.status === 404) return null;
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 800));
        }
      } catch {
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }
    return null;
  };

  // 按「国家优先、交叉轮询 6 个 App」构造任务队列，确保所有 6 个 AI 均衡拿到全量数据
  const jobs = [];
  for (const slug of orderedSlugs) {
    const isoUpper = slug.toUpperCase();
    for (const app of APPLE_APPS) {
      jobs.push(async () => {
        totalRequests += 1;
        const url = `https://apps.apple.com/${slug}/app/id${app.appId}`;
        const html = await fetchOneWithRetry(url, 1);
        if (!html) {
          failedRequests += 1;
          return null;
        }
        const { ldCurrency, items } = extractAppleIapList(html);
        if (items.length === 0) return null;
        const mapped = mapIapsToPlans(app.aiId, items, ldCurrency, isoUpper, rates);
        if (Object.keys(mapped).length === 0) return null;
        return { aiId: app.aiId, iso: isoUpper, plans: mapped };
      });
    }
  }

  const results = await runWithConcurrency(jobs, concurrency);
  for (const r of results) {
    if (!r) continue;
    storefrontsHit.add(r.iso);
    if (!liveIapPrices[r.aiId]) liveIapPrices[r.aiId] = {};
    for (const [planId, spec] of Object.entries(r.plans)) {
      if (!liveIapPrices[r.aiId][planId]) liveIapPrices[r.aiId][planId] = {};
      liveIapPrices[r.aiId][planId][r.iso] = spec;
      if (r.iso === 'US') {
        liveIapPrices[r.aiId][planId]['US-TX'] = spec;
      }
      totalSkuHits += 1;
    }
  }

  return {
    liveIapPrices,
    stats: {
      targetStorefronts: APPLE_175_STOREFRONTS.length,
      storefrontsHit: storefrontsHit.size,
      totalSkuHits,
      totalRequests,
      failedRequests,
      durationMs: Date.now() - started,
    },
  };
}
