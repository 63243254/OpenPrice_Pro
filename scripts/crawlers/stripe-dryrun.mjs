/**
 * Web Stripe 真实结账页 Dry-Run 算税与支付方式探测引擎
 *
 * 工作原理（严格零扣费 Dry-Run）：
 * 1. 读取 config/checkout-sessions.json 中用户真实登录并创建的 Stripe Checkout Session ID
 *    (oaics_live_... / cs_live_...) 及对应的 Stripe Publishable Key (pk_live_...)
 * 2. 逐国向 Stripe 官方接口 POST https://api.stripe.com/v1/payment_pages/{sessionId} 提交各国真实
 *    tax_region[country] / tax_region[state] / tax_region[postal_code]，
 *    直接读取支付按钮上的真实 currency、subtotal、tax、total 与 ordered_payment_method_types！
 * 3. 同时额外探测一次美国免税州 (US / OR / 97201) 的去税后实付总额（例如菲区 ₱1,100 -> ₱982.15）！
 * 4. 绝不提交卡号，绝不发起扣款；若未配置真实 session，诚实返回 0 条探测并跳过，绝不伪造数据。
 */

import fs from 'node:fs';
import path from 'node:path';

// 重点国家真实邮编池（用于触发 Stripe Tax 真实算税）
const BILLING_TAX_REGIONS = {
  US: { country: 'US', state: 'OR', postal: '97201' },
  'US-TX': { country: 'US', state: 'NY', postal: '10001' },
  PH: { country: 'PH', state: '00', postal: '1000' },
  JP: { country: 'JP', state: '13', postal: '100-0001' },
  GB: { country: 'GB', state: '', postal: 'SW1A 1AA' },
  DE: { country: 'DE', state: '', postal: '10115' },
  FR: { country: 'FR', state: '', postal: '75001' },
  CA: { country: 'CA', state: 'AB', postal: 'T2P 1J9' },
  AU: { country: 'AU', state: 'NSW', postal: '2000' },
  SG: { country: 'SG', state: '', postal: '018956' },
  IN: { country: 'IN', state: 'DL', postal: '110001' },
  TR: { country: 'TR', state: '34', postal: '34000' },
  BR: { country: 'BR', state: 'SP', postal: '01001-000' },
  KR: { country: 'KR', state: '', postal: '04524' },
  TW: { country: 'TW', state: '', postal: '100' },
  MY: { country: 'MY', state: '', postal: '50000' },
  TH: { country: 'TH', state: '', postal: '10100' },
  ID: { country: 'ID', state: '', postal: '10110' },
  VN: { country: 'VN', state: '', postal: '100000' },
  NG: { country: 'NG', state: 'LA', postal: '100001' },
  PK: { country: 'PK', state: '', postal: '44000' },
  EG: { country: 'EG', state: '', postal: '11511' },
  PL: { country: 'PL', state: '', postal: '00-001' },
  NL: { country: 'NL', state: '', postal: '1012 JS' },
  ES: { country: 'ES', state: '', postal: '28001' },
  IT: { country: 'IT', state: '', postal: '00118' },
  CH: { country: 'CH', state: '', postal: '8001' },
  SE: { country: 'SE', state: '', postal: '111 22' },
  NO: { country: 'NO', state: '', postal: '0150' },
  DK: { country: 'DK', state: '', postal: '1050' },
  MX: { country: 'MX', state: '', postal: '06000' },
  NZ: { country: 'NZ', state: '', postal: '1010' },
  AE: { country: 'AE', state: '', postal: '00000' },
  SA: { country: 'SA', state: '', postal: '11564' },
  ZA: { country: 'ZA', state: '', postal: '2000' },
};

const ZERO_DEC = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const THREE_DEC = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);

function fromMinorUnits(minor, currency) {
  if (typeof minor !== 'number') return 0;
  if (ZERO_DEC.has(currency)) return minor;
  if (THREE_DEC.has(currency)) return Number((minor / 1000).toFixed(3));
  return Number((minor / 100).toFixed(2));
}

async function queryStripeTax(sessionId, publishableKey, region) {
  const body = new URLSearchParams({
    key: publishableKey,
    'tax_region[country]': region.country,
    'tax_region[postal_code]': region.postal,
  });
  if (region.state) body.set('tax_region[state]', region.state);

  const res = await fetch(`https://api.stripe.com/v1/payment_pages/${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const summary = data?.total_summary;
  if (!summary || typeof summary.total !== 'number') return null;

  const currency = (data.currency || 'usd').toUpperCase();
  return {
    currency,
    subtotal: fromMinorUnits(summary.subtotal ?? summary.total, currency),
    tax: fromMinorUnits(summary.tax ?? 0, currency),
    total: fromMinorUnits(summary.total, currency),
    minorUnitsAmount: summary.total,
    paymentMethods: data.ordered_payment_method_types || ['card'],
  };
}

export async function crawlWebStripeDryRun(rootDir) {
  const started = Date.now();
  const liveWebPrices = {};
  let taxRegimes = {};
  let probedCount = 0;
  let configuredSessions = 0;
  let receiptsLoaded = 0;

  // 1. 先加载用户/实测已验证的真实支付账单记录 (config/verified-receipts.json)
  const receiptsPath = path.join(rootDir, 'config', 'verified-receipts.json');
  if (fs.existsSync(receiptsPath)) {
    try {
      const receipts = JSON.parse(fs.readFileSync(receiptsPath, 'utf8'));
      if (receipts.taxRegimes) taxRegimes = receipts.taxRegimes;
      for (const [aiId, plans] of Object.entries(receipts || {})) {
        if (aiId.startsWith('_') || aiId === 'taxRegimes') continue;
        if (!liveWebPrices[aiId]) liveWebPrices[aiId] = {};
        for (const [planId, countries] of Object.entries(plans || {})) {
          if (!liveWebPrices[aiId][planId]) liveWebPrices[aiId][planId] = {};
          for (const [iso, entry] of Object.entries(countries || {})) {
            liveWebPrices[aiId][planId][iso] = {
              ...entry,
              sourceType: entry.sourceType || 'VERIFIED_RECEIPT',
            };
            receiptsLoaded += 1;
          }
        }
      }
    } catch (err) {
      console.warn('[WebStripe] 读取 config/verified-receipts.json 失败:', err.message);
    }
  }

  // 2. 若用户配置了真实 Checkout Session (config/checkout-sessions.json)，执行真实 Stripe 支付页 Dry-Run 探测
  const sessionsPath = path.join(rootDir, 'config', 'checkout-sessions.json');
  if (fs.existsSync(sessionsPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
      const sessions = Array.isArray(cfg?.sessions) ? cfg.sessions : [];
      configuredSessions = sessions.length;

      for (const s of sessions) {
        if (!s.aiId || !s.planId || !s.sessionId || !s.publishableKey) continue;
        if (s.sessionId.includes('REPLACE_ME')) continue;

        const targetIsos = Array.isArray(s.countries) && s.countries.length > 0
          ? s.countries
          : s.sessionCountry
          ? [s.sessionCountry]
          : Object.keys(BILLING_TAX_REGIONS);

        // 先探测美国免税州去税价（用于对比本地含税价）
        let usTaxFreeProbe = null;
        try {
          usTaxFreeProbe = await queryStripeTax(s.sessionId, s.publishableKey, BILLING_TAX_REGIONS.US);
        } catch {
          // ignore
        }

        for (const iso of targetIsos) {
          const region = BILLING_TAX_REGIONS[iso];
          if (!region) continue;
          try {
            const probed = await queryStripeTax(s.sessionId, s.publishableKey, region);
            if (!probed) continue;

            if (!liveWebPrices[s.aiId]) liveWebPrices[s.aiId] = {};
            if (!liveWebPrices[s.aiId][s.planId]) liveWebPrices[s.aiId][s.planId] = {};

            const hasTaxFreeDrop =
              usTaxFreeProbe &&
              usTaxFreeProbe.currency === probed.currency &&
              usTaxFreeProbe.total > 0 &&
              usTaxFreeProbe.total < probed.total;

            liveWebPrices[s.aiId][s.planId][iso] = {
              cur: probed.currency,
              listed: probed.total,
              subtotal: probed.subtotal,
              taxAmt: probed.tax,
              taxAtCheckout: false,
              taxFreeTotal: hasTaxFreeDrop ? usTaxFreeProbe.total : null,
              paymentMethods: probed.paymentMethods,
              minorUnitsAmount: probed.minorUnitsAmount,
              sourceType: 'LIVE_STRIPE',
              probedAt: new Date().toISOString(),
              note: hasTaxFreeDrop
                ? `Stripe 支付页实时 Dry-Run：本地实付 ${probed.currency} ${probed.total}，改填美区免税州实付 ${probed.currency} ${usTaxFreeProbe.total}`
                : `Stripe 支付页实时 Dry-Run：原币实付 ${probed.currency} ${probed.total} (含税额 ${probed.tax})`,
            };
            probedCount += 1;
          } catch {
            // single region failed
          }
        }
      }
    } catch (err) {
      console.warn('[WebStripe] 执行 Dry-Run 探测失败:', err.message);
    }
  }

  return {
    liveWebPrices,
    taxRegimes,
    stats: {
      configuredSessions,
      probedCount,
      receiptsLoaded,
      durationMs: Date.now() - started,
    },
  };
}
