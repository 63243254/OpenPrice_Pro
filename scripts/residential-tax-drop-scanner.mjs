/**
 * 动态住宅 IP 全自动去税与降价实测扫描器 (Residential Tax-Drop Scanner)
 * 
 * 原理：
 * 1. 使用用户提供的 DataImpulse 动态住宅代理网关，根据国家代码动态切换出口（_cr.{iso}）；
 * 2. 真实获取该国原生家庭宽带住宅 IP (通过 ipinfo.io 校验真实归属国家、城市、ISP)；
 * 3. 站在该国原生住宅 IP 的视角，请求支付网关的算税引擎：
 *    - Step 1: 模拟本地居民真实购买，获取含税原始支付总额 (Listed Total with Local VAT)
 *    - Step 2: 模拟在支付页将账单地址修改为美国免税州 (OR 97201 / DE 19702)
 *    - Step 3: 读取网关返回的最终支付总价 (Final Pay Total) 与税额 (Tax Amount)
 * 4. 严格比对：
 *    - 最终支付价格是否真正变低？
 *    - 结算币种是否保留本币（如 PHP/CLP/BRL）还是被强转 USD？
 *    - 税额是否真实归零？
 * 5. 生成 100% 真实实测报告并落盘。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PROXY_HOST = 'gw.dataimpulse.com:823';
const PROXY_USER_BASE = 'f347fde565edfb36383b_cr.';
const PROXY_PASS = 'd38f07caf70bf160';

// 重点待实测国家列表
const TARGET_COUNTRIES = [
  { iso: 'ph', name: '菲律宾', currency: 'PHP', postal: '1000' },
  { iso: 'cl', name: '智利', currency: 'CLP', postal: '8320000' },
  { iso: 'br', name: '巴西', currency: 'BRL', postal: '01001-000' },
  { iso: 'jp', name: '日本', currency: 'JPY', postal: '100-0001' },
  { iso: 'ca', name: '加拿大 (安省)', currency: 'CAD', state: 'ON', postal: 'M5V 2T6' },
  { iso: 'de', name: '德国', currency: 'EUR', postal: '10115' },
  { iso: 'gb', name: '英国', currency: 'GBP', postal: 'SW1A 1AA' },
  { iso: 'in', name: '印度', currency: 'INR', postal: '110001' },
  { iso: 'tr', name: '土耳其', currency: 'TRY', postal: '34000' },
  { iso: 'co', name: '哥伦比亚', currency: 'COP', postal: '110111' },
  { iso: 'mx', name: '墨西哥', currency: 'MXN', postal: '06000' },
  { iso: 'th', name: '泰国', currency: 'THB', postal: '10100' },
  { iso: 'id', name: '印尼', currency: 'IDR', postal: '10110' },
  { iso: 'za', name: '南非', currency: 'ZAR', postal: '2000' },
];

function runCurl(args) {
  try {
    const out = execFileSync('curl.exe', args, { encoding: 'utf8', timeout: 20000 });
    return { ok: true, out: out.trim() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function getResidentialIpInfo(iso) {
  const proxyUrl = `http://${PROXY_USER_BASE}${iso}:${PROXY_PASS}@${PROXY_HOST}`;
  const res = runCurl(['-s', '--max-time', '15', '-x', proxyUrl, 'https://ipinfo.io/json']);
  if (!res.ok) return null;
  try {
    const data = JSON.parse(res.out);
    return data;
  } catch {
    return null;
  }
}

/**
 * 核心：向支付网关 (Stripe) 算税引擎进行真实住宅 IP 代理算税请求
 */
function probeStripeTaxUnderResidentialProxy(iso, sessionId, publishableKey, countryCode, stateCode, postalCode) {
  const proxyUrl = `http://${PROXY_USER_BASE}${iso}:${PROXY_PASS}@${PROXY_HOST}`;
  const apiUrl = `https://api.stripe.com/v1/payment_pages/${encodeURIComponent(sessionId)}`;
  
  const postData = [
    `key=${encodeURIComponent(publishableKey)}`,
    `tax_region[country]=${encodeURIComponent(countryCode)}`,
    `tax_region[postal_code]=${encodeURIComponent(postalCode)}`,
  ];
  if (stateCode) postData.push(`tax_region[state]=${encodeURIComponent(stateCode)}`);

  const res = runCurl([
    '-s',
    '--max-time', '18',
    '-x', proxyUrl,
    '-X', 'POST',
    '-H', 'Content-Type: application/x-www-form-urlencoded',
    '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    '--data', postData.join('&'),
    apiUrl,
  ]);

  if (!res.ok) return { ok: false, error: res.error };
  try {
    const json = JSON.parse(res.out);
    if (json.error) return { ok: false, error: json.error.message || json.error };
    return { ok: true, data: json };
  } catch {
    return { ok: false, error: 'JSON parse error: ' + res.out.slice(0, 100) };
  }
}

async function main() {
  console.log('================================================================');
  console.log('   DataImpulse 动态住宅 IP 全自动多国免税州降价实测扫描器');
  console.log('================================================================\n');

  console.log(`[配置] 住宅代理网关: ${PROXY_HOST}`);
  console.log(`[目标] 即将自动轮换 ${TARGET_COUNTRIES.length} 个国家的原生家庭住宅 IP 进行实测...\n`);

  // 1. 尝试从 checkout-sessions.json 读取活跃 session，若无则使用公网公开 Stripe Session 探针
  let activeSessionId = null;
  let activePublishableKey = null;

  const cfgPath = path.resolve('config/checkout-sessions.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const s = cfg?.sessions?.[0];
      if (s && s.sessionId && !s.sessionId.includes('REPLACE_ME')) {
        activeSessionId = s.sessionId;
        activePublishableKey = s.publishableKey;
      }
    } catch {
      // ignore
    }
  }

  const reports = [];

  for (const c of TARGET_COUNTRIES) {
    console.log(`----------------------------------------------------------------`);
    console.log(`▶ 正在接入 [${c.name} (${c.iso.toUpperCase()})] 动态住宅 IP...`);
    
    // Step 1: 验证住宅 IP 出口真实性
    const ipInfo = getResidentialIpInfo(c.iso);
    if (!ipInfo || !ipInfo.ip) {
      console.log(`  ❌ 住宅 IP 连接超时或不可用，跳过该地区`);
      reports.push({ ...c, status: 'PROXY_UNAVAILABLE' });
      continue;
    }

    console.log(`  🏠 住宅 IP 确认: ${ipInfo.ip} (${ipInfo.city || 'N/A'}, ${ipInfo.region || 'N/A'}) · ISP: ${ipInfo.org || 'N/A'}`);

    if (!activeSessionId) {
      // 代理通畅，记录网络有效性
      reports.push({
        ...c,
        residentialIp: ipInfo.ip,
        city: ipInfo.city,
        isp: ipInfo.org,
        status: 'PROXY_READY_AWAITING_SESSION',
        note: `成功建立 ${c.name} 原生家庭宽带出口连接，随时可执行挂载算税探测`,
      });
      console.log(`  ✅ 原生住宅出口就绪`);
      continue;
    }

    // Step 2: 挂载该住宅 IP，向支付网关探测本地含税总价
    console.log(`  🔍 站在 ${c.name} 住宅 IP 视角请求初始支付页...`);
    const localProbe = probeStripeTaxUnderResidentialProxy(c.iso, activeSessionId, activePublishableKey, c.iso.toUpperCase(), c.state || '', c.postal);
    
    if (!localProbe.ok) {
      console.log(`  ⚠️ 本地标价探测受阻: ${localProbe.error}`);
      reports.push({ ...c, residentialIp: ipInfo.ip, status: 'LOCAL_PROBE_ERROR', error: localProbe.error });
      continue;
    }

    const localSummary = localProbe.data.total_summary || {};
    const localCur = (localProbe.data.currency || c.currency).toUpperCase();
    const localTotal = (localSummary.total / 100).toFixed(2);
    const localTax = ((localSummary.tax || 0) / 100).toFixed(2);
    console.log(`  💰 本地初始实付: ${localCur} ${localTotal} (含税额: ${localTax})`);

    // Step 3: 在同一个住宅 IP 链接中，模拟修改账单地址为美国俄勒冈免税州 (OR 97201)
    console.log(`  🎯 保持 ${c.name} 住宅 IP，自动修改账单为美国俄勒冈免税州 (OR 97201)...`);
    const usFreeProbe = probeStripeTaxUnderResidentialProxy(c.iso, activeSessionId, activePublishableKey, 'US', 'OR', '97201');

    if (!usFreeProbe.ok) {
      console.log(`  ❌ 改填免税州被网关拦截拒绝: ${usFreeProbe.error}`);
      reports.push({
        ...c,
        residentialIp: ipInfo.ip,
        localTotal,
        status: 'TAX_FREE_REJECTED',
        error: usFreeProbe.error,
      });
      continue;
    }

    const freeSummary = usFreeProbe.data.total_summary || {};
    const freeCur = (usFreeProbe.data.currency || 'USD').toUpperCase();
    const freeTotal = (freeSummary.total / 100).toFixed(2);
    const freeTax = ((freeSummary.tax || 0) / 100).toFixed(2);

    console.log(`  🏷️ 改免税州后实付: ${freeCur} ${freeTotal} (税额: ${freeTax})`);

    // Step 4: 比对价格是否真正变便宜
    let verdict = 'UNKNOWN';
    let dropAmount = 0;

    if (localCur === freeCur) {
      if (Number(freeTotal) < Number(localTotal)) {
        dropAmount = Number((localTotal - freeTotal).toFixed(2));
        verdict = 'CONFIRMED_DROPPED';
        console.log(`  🎉 实测确认降价！最终实付降低 ${localCur} ${dropAmount} (立省 ${(dropAmount / localTotal * 100).toFixed(1)}%)！`);
      } else if (Number(freeTotal) === Number(localTotal)) {
        verdict = 'NO_CHANGE_ALREADY_TAX_FREE';
        console.log(`  ℹ️ 实测总价无变化（本身即为 0 税或固定价）`);
      } else {
        verdict = 'PRICE_INCREASED';
        console.log(`  ⚠️ 实测总价反升`);
      }
    } else {
      verdict = 'CURRENCY_RESET_TO_' + freeCur;
      console.log(`  ⚠️ 结算币种被重置为 ${freeCur}，无法以原币 ${localCur} 扣款`);
    }

    reports.push({
      ...c,
      residentialIp: ipInfo.ip,
      city: ipInfo.city,
      isp: ipInfo.org,
      localCurrency: localCur,
      localTotal: Number(localTotal),
      localTax: Number(localTax),
      taxFreeCurrency: freeCur,
      taxFreeTotal: Number(freeTotal),
      taxFreeTax: Number(freeTax),
      verdict,
      dropAmount,
      testedAt: new Date().toISOString(),
    });
  }

  // 输出报告
  console.log('\n================================================================');
  console.log('                 全自动住宅 IP 实测矩阵汇总报告');
  console.log('================================================================');

  for (const r of reports) {
    console.log(`[${r.iso.toUpperCase()}] ${r.name.padEnd(16, ' ')} | IP: ${(r.residentialIp || 'N/A').padEnd(15, ' ')} | 状态: ${r.status || r.verdict}`);
  }

  const outPath = path.resolve('residential_tax_drop_report.json');
  fs.writeFileSync(outPath, JSON.stringify({ testedAt: new Date().toISOString(), proxyHost: PROXY_HOST, reports }, null, 2));
  console.log(`\n完整实测原始报告已保存至: ${outPath}`);
}

main();
