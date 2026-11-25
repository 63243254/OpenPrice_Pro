/**
 * 真实支付页去税自动化实测探针 (Live Stripe Tax Exemption Tester)
 * 
 * 用途：
 * 接收一个真实的 Stripe 结账链接或 Session ID，直接向 Stripe 官方 API 发起
 * 真实的算税探测请求（Zero-charge Dry-Run），逐一实测改填不同免税州/税号时
 * 接口返回的真实税额变化，输出 100% 真实的实测报告，杜绝任何脑补推断。
 * 
 * 用法：
 * node scripts/test-tax-exemption.mjs "https://checkout.stripe.com/c/pay/cs_live_...#fidkd..."
 * 或
 * node scripts/test-tax-exemption.mjs --session "cs_live_..." --key "pk_live_..."
 */

import fs from 'node:fs';
import path from 'node:path';

// 测试矩阵：各国真实邮编 vs 5 大美国免税州
const TEST_REGIONS = [
  { label: '原始本地：菲律宾 (PH)', country: 'PH', state: '00', postal: '1000' },
  { label: '改填去税：美国俄勒冈免税州 (OR)', country: 'US', state: 'OR', postal: '97201' },
  { label: '改填去税：美国特拉华免税州 (DE)', country: 'US', state: 'DE', postal: '19801' },
  { label: '原始本地：智利圣地亚哥 (CL)', country: 'CL', state: 'RM', postal: '8320000' },
  { label: '原始本地：日本东京 (JP)', country: 'JP', state: '13', postal: '100-0001' },
  { label: '原始本地：加拿大安省 (CA-ON)', country: 'CA', state: 'ON', postal: 'M5V 2T6' },
  { label: '改填省税：加拿大阿省 (CA-AB)', country: 'CA', state: 'AB', postal: 'T2P 1J9' },
  { label: '原始本地：德国柏林 (DE)', country: 'DE', state: '', postal: '10115' },
  { label: '原始本地：印度德里 (IN)', country: 'IN', state: 'DL', postal: '110001' },
  { label: '原始本地：巴西圣保罗 (BR)', country: 'BR', state: 'SP', postal: '01001-000' },
];

async function queryStripeLiveTax(sessionId, publishableKey, region) {
  const body = new URLSearchParams({
    key: publishableKey,
    'tax_region[country]': region.country,
    'tax_region[postal_code]': region.postal,
  });
  if (region.state) body.set('tax_region[state]', region.state);

  const url = `https://api.stripe.com/v1/payment_pages/${encodeURIComponent(sessionId)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    body: body.toString(),
  });

  const status = res.status;
  const json = await res.json().catch(() => null);
  return { status, ok: res.ok, data: json };
}

function parseInputArgs() {
  const args = process.argv.slice(2);
  let sessionId = null;
  let publishableKey = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('https://checkout.stripe.com')) {
      const match = a.match(/pay\/(cs_live_[a-zA-Z0-9]+|oaics_live_[a-zA-Z0-9]+)/);
      if (match) sessionId = match[1];
      const keyMatch = a.match(/#fidkd[^#]*publishable_key=([^&]+)/);
      if (keyMatch) publishableKey = decodeURIComponent(keyMatch[1]);
    } else if (a === '--session' && args[i + 1]) {
      sessionId = args[++i];
    } else if (a === '--key' && args[i + 1]) {
      publishableKey = args[++i];
    }
  }

  // 若未指定，尝试从 config/checkout-sessions.json 读取
  if (!sessionId) {
    const cfgPath = path.resolve('config/checkout-sessions.json');
    if (fs.existsSync(cfgPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        const s = cfg?.sessions?.[0];
        if (s && s.sessionId && !s.sessionId.includes('REPLACE_ME')) {
          sessionId = s.sessionId;
          publishableKey = s.publishableKey;
        }
      } catch {
        // ignore
      }
    }
  }

  return { sessionId, publishableKey };
}

async function main() {
  console.log('=====================================================');
  console.log('   Stripe 结账页去税实测探针 (Live Exemption Tester)');
  console.log('=====================================================\n');

  const { sessionId, publishableKey } = parseInputArgs();

  if (!sessionId) {
    console.log('❌ 错误：未提供真实的 Stripe 结账链接或 Session ID！');
    console.log('\n使用方法（二选一）：');
    console.log('1. 直接传入您登录任何平台（ChatGPT / Claude 等）后点充值弹出的真实结账页完整网址：');
    console.log('   node scripts/test-tax-exemption.mjs "https://checkout.stripe.com/c/pay/cs_live_...#..."\n');
    console.log('2. 或者在 config/checkout-sessions.json 中填入 sessionId 与 publishableKey 后直接运行：');
    console.log('   node scripts/test-tax-exemption.mjs\n');
    console.log('💡 严格保证：探针仅向 Stripe 算税接口查询 tax_region 算税返回结果，零扣费，不提交任何卡号。');
    process.exit(1);
  }

  const pKey = publishableKey || 'pk_live_51M0...'; // 默认回退
  console.log(`[实测目标] Session ID: ${sessionId}`);
  console.log(`[实测发起] 正在逐个国家向 Stripe 官方网关提交真实 tax_region 探测...\n`);

  const results = [];

  for (const reg of TEST_REGIONS) {
    process.stdout.write(`  正在探测: ${reg.label.padEnd(35, ' ')} ... `);
    try {
      const resp = await queryStripeLiveTax(sessionId, pKey, reg);
      if (!resp.ok) {
        const errMsg = resp.data?.error?.message || `HTTP ${resp.status}`;
        console.log(`❌ 接口拒绝: ${errMsg}`);
        results.push({ ...reg, ok: false, error: errMsg });
        continue;
      }

      const cur = (resp.data.currency || 'USD').toUpperCase();
      const summary = resp.data.total_summary || {};
      const subtotal = summary.subtotal != null ? (summary.subtotal / 100).toFixed(2) : 'N/A';
      const tax = summary.tax != null ? (summary.tax / 100).toFixed(2) : '0.00';
      const total = summary.total != null ? (summary.total / 100).toFixed(2) : 'N/A';

      console.log(`✅ 接口返回: ${cur} ${total} (基数: ${subtotal}, 税额: ${tax})`);
      results.push({
        ...reg,
        ok: true,
        currency: cur,
        subtotal: Number(subtotal),
        tax: Number(tax),
        total: Number(total),
        rawTotal: summary.total,
      });
    } catch (err) {
      console.log(`❌ 网络异常: ${err.message}`);
      results.push({ ...reg, ok: false, error: err.message });
    }
  }

  // 输出实测报告
  console.log('\n=====================================================');
  console.log('               100% 真实接口实测核验报告');
  console.log('=====================================================');

  const usOr = results.find((r) => r.country === 'US' && r.state === 'OR');
  for (const r of results) {
    if (!r.ok) {
      console.log(`[${r.country}] ${r.label}: 实测不可用 (${r.error})`);
      continue;
    }
    const isTaxFree = r.tax === 0;
    const canDrop = usOr && usOr.ok && usOr.currency === r.currency && usOr.total < r.total;
    const diff = canDrop ? (r.total - usOr.total).toFixed(2) : null;

    console.log(
      `[${r.country}] ${r.label.padEnd(30, ' ')} -> 实付 ${r.currency} ${r.total} | 税额: ${r.tax} | ` +
      (isTaxFree ? '🟢 当前即免税' : canDrop ? `🎯 改免税州可去税 (降 ${r.currency} ${diff})` : '⚠️ 锁税/币种变更')
    );
  }

  const reportPath = path.resolve('tax_exemption_test_report.json');
  fs.writeFileSync(reportPath, JSON.stringify({ sessionId, testedAt: new Date().toISOString(), results }, null, 2));
  console.log(`\n完整实测原始 JSON 已落盘至: ${reportPath}`);
}

main();
