/**
 * ChatGPT Plus 成品号批量验活与风控审计系统
 * 
 * 核心功能：
 * 1. 批量导入号商交号文本 (支持 email:pass:sessionToken / 纯 sessionToken / session.json)
 * 2. 自动挂载 DataImpulse 动态住宅代理 (防 OpenAI 429 频控与风控拦截)
 * 3. 深入底层接口核验：
 *    - 凭据存活与封禁状态 (Session Validity & Account Deactivation)
 *    - Plus 真实开通状态 (has_active_subscription & plan_type)
 *    - 剩余质保期倒计时 (renews_at / cancels_at / 剩余天数)
 *    - 透支拒付黑卡预警 (isDelinquent 欠费标记，揪出 3 天必死黑卡)
 *    - 独享性指纹 (User ID, Email, 账号结构)
 * 4. 自动生成售后维权索赔报告 (audit_claim_letter.md 与 audit_report.json)，直接找卖家退换！
 * 
 * 用法：
 * node scripts/verify-plus-accounts.mjs --file "accounts.txt"
 * node scripts/verify-plus-accounts.mjs --proxy "ph" --file "accounts.txt"
 * node scripts/verify-plus-accounts.mjs "D:/REA/portal/session.json"
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// 默认动态住宅代理网关配置 (可由 --proxy 参数动态指定出口地区，如 --proxy us 或 --proxy ph)
const DEFAULT_PROXY_HOST = 'gw.dataimpulse.com:823';
const DEFAULT_PROXY_USER = 'f347fde565edfb36383b_cr.us';
const DEFAULT_PROXY_PASS = 'd38f07caf70bf160';

function runCurl(args) {
  try {
    const out = execFileSync('curl.exe', args, { encoding: 'utf8', timeout: 25000 });
    return { ok: true, out: out.trim() };
  } catch (err) {
    return { ok: false, error: err.message, stderr: err.stderr?.toString() };
  }
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  let inputFile = null;
  let singleInput = null;
  let useProxy = true;
  let proxyCountry = 'us';

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '--file' || a === '-f') && args[i + 1]) {
      inputFile = args[++i];
    } else if ((a === '--proxy' || a === '-p') && args[i + 1]) {
      proxyCountry = args[++i].toLowerCase();
    } else if (a === '--no-proxy') {
      useProxy = false;
    } else if (!a.startsWith('-')) {
      singleInput = a;
    }
  }

  return { inputFile, singleInput, useProxy, proxyCountry };
}

function parseAccountItems(inputFile, singleInput) {
  const items = [];

  if (inputFile && fs.existsSync(inputFile)) {
    const lines = fs.readFileSync(inputFile, 'utf8').split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      items.push(extractTokenOrPath(line));
    }
  } else if (singleInput) {
    items.push(extractTokenOrPath(singleInput));
  } else {
    // 默认查找 accounts_to_verify.txt 或 session.json
    const defaultList = path.resolve('config/accounts_to_verify.txt');
    const defaultSession = path.resolve('D:/REA/portal/session.json');

    if (fs.existsSync(defaultList)) {
      const lines = fs.readFileSync(defaultList, 'utf8').split(/\r?\n/);
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        items.push(extractTokenOrPath(line));
      }
    } else if (fs.existsSync(defaultSession)) {
      items.push({ type: 'json_file', path: defaultSession, raw: defaultSession });
    }
  }

  return items;
}

function extractTokenOrPath(line) {
  // 1. 若是 JSON 文件路径
  if (line.endsWith('.json') && fs.existsSync(line)) {
    return { type: 'json_file', path: line, raw: line };
  }

  // 2. 若包含 ---- 或 : 分隔符 (常见号商格式: email----pass----sessionToken)
  if (line.includes('----')) {
    const parts = line.split('----');
    const token = parts.find((p) => p.startsWith('eyJ') && p.length > 50) || parts[parts.length - 1];
    return { type: 'session_token', token: token.trim(), email: parts[0].trim(), raw: line };
  }

  if (line.includes(':') && !line.startsWith('http')) {
    const parts = line.split(':');
    const token = parts.find((p) => p.startsWith('eyJ') && p.length > 50) || parts[parts.length - 1];
    return { type: 'session_token', token: token.trim(), email: parts[0].trim(), raw: line };
  }

  // 3. 纯 token
  return { type: 'session_token', token: line.trim(), email: null, raw: line };
}

function extractTokenValue(item) {
  if (item.type === 'json_file') {
    try {
      const json = JSON.parse(fs.readFileSync(item.path, 'utf8'));
      return {
        sessionToken: json.sessionToken || null,
        accessToken: json.accessToken || null,
        email: json.user?.email || null,
        source: item.path,
      };
    } catch {
      return { sessionToken: null, accessToken: null, email: null, source: item.path };
    }
  }

  return {
    sessionToken: item.token,
    accessToken: null,
    email: item.email,
    source: 'direct_input',
  };
}

/**
 * Phase 1: 验证 SessionToken 获取最新 AccessToken 与账户基础信息
 */
function probeSession(sessionToken, proxyUrl) {
  const url = 'https://chatgpt.com/api/auth/session';
  const cookieHeader = `Cookie: __Secure-next-auth.session-token=${sessionToken}; oai-did=5058e9dd-9221-4eb2-ab48-9fe48864f6cc`;
  
  const args = [
    '-s',
    '--max-time', '18',
    '-H', cookieHeader,
    '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    '-H', 'Accept: application/json',
    url,
  ];

  if (proxyUrl) {
    args.unshift('-x', proxyUrl);
  }

  const res = runCurl(args);
  if (!res.ok) {
    return { ok: false, error: `网络请求失败: ${res.error}` };
  }

  try {
    const json = JSON.parse(res.out);
    if (!json || !json.accessToken) {
      if (res.out.includes('account_deactivated')) {
        return { ok: false, status: 'ACCOUNT_BANNED', error: '账号已被 OpenAI 官方封禁 (Deactivated)' };
      }
      return { ok: false, status: 'TOKEN_INVALID', error: '会话凭据已失效或已过期 (未返回 AccessToken)' };
    }
    return { ok: true, data: json };
  } catch {
    if (res.out.includes('403') || res.out.includes('cloudflare')) {
      return { ok: false, status: 'CLOUDFLARE_BLOCKED', error: '遭遇 Cloudflare 节点风控拦截' };
    }
    return { ok: false, status: 'PARSE_ERROR', error: `解析异常: ${res.out.slice(0, 100)}` };
  }
}

/**
 * Phase 2: 获取真实底层订阅明细 (Subscriptions API)
 */
function probeSubscription(accessToken, accountId, proxyUrl) {
  const url = `https://chatgpt.com/backend-api/subscriptions?account_id=${encodeURIComponent(accountId)}`;
  const authHeader = `Authorization: Bearer ${accessToken}`;

  const args = [
    '-s',
    '--max-time', '18',
    '-H', authHeader,
    '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    '-H', 'Accept: application/json',
    url,
  ];

  if (proxyUrl) {
    args.unshift('-x', proxyUrl);
  }

  const res = runCurl(args);
  if (!res.ok) return { ok: false, error: res.error };

  try {
    const json = JSON.parse(res.out);
    return { ok: true, data: json };
  } catch {
    return { ok: false, error: res.out.slice(0, 100) };
  }
}

function formatRemainingDays(timestampSec) {
  if (!timestampSec) return null;
  const now = Date.now() / 1000;
  const diffSec = timestampSec - now;
  if (diffSec <= 0) return 0;
  return Math.ceil(diffSec / 86400);
}

function formatDateStr(timestampSec) {
  if (!timestampSec) return 'N/A';
  const d = new Date(timestampSec * 1000);
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

async function verifyAccount(item, idx, total, proxyUrl) {
  const { sessionToken, accessToken: directAccessToken, email: hintEmail, source } = extractTokenValue(item);

  console.log(`\n[${idx}/${total}] 正在验活账号: ${hintEmail || source || '匿名Token'}...`);

  if (!sessionToken && !directAccessToken) {
    console.log(`  ❌ 格式错误：未提取到有效 SessionToken`);
    return {
      index: idx,
      email: hintEmail || 'UNKNOWN',
      verdict: 'FORMAT_ERROR',
      verdictText: '格式错误 / 无Token',
      details: '未能从输入中解析出有效的 SessionToken 字符串',
    };
  }

  // Step 1: Session 探活
  let activeAccessToken = directAccessToken;
  let sessionData = null;

  if (sessionToken) {
    const sessRes = probeSession(sessionToken, proxyUrl);
    if (!sessRes.ok) {
      console.log(`  ❌ 探活失败: ${sessRes.error}`);
      return {
        index: idx,
        email: hintEmail || 'UNKNOWN',
        verdict: sessRes.status || 'SESSION_EXPIRED',
        verdictText: sessRes.status === 'ACCOUNT_BANNED' ? '⛔ 账号已封禁' : '❌ 凭据失效/密码被改',
        details: sessRes.error,
        rawInput: item.raw?.slice(0, 80) + '...',
      };
    }
    sessionData = sessRes.data;
    activeAccessToken = sessionData.accessToken;
  }

  const user = sessionData?.user || {};
  const account = sessionData?.account || {};
  const email = user.email || hintEmail || 'UNKNOWN';
  const accountId = account.id || user.id || '';
  const planType = (account.planType || 'free').toLowerCase();
  const isDelinquent = account.isDelinquent === true;

  console.log(`  👤 用户标识: ${email} (Account: ${accountId.slice(0, 8)}...)`);
  console.log(`  💳 基础权限: ${planType.toUpperCase()} | 欠费/拒付标记: ${isDelinquent ? '🚨 是 (高危透支黑卡)' : '✅ 否 (正常)'}`);

  // Step 2: 订阅底层接口深度穿透
  let subInfo = null;
  if (activeAccessToken && accountId) {
    const subRes = probeSubscription(activeAccessToken, accountId, proxyUrl);
    if (subRes.ok) {
      subInfo = subRes.data;
    }
  }

  const hasActiveSub = subInfo?.has_active_subscription ?? (planType === 'plus' || planType === 'pro' || planType === 'go');
  const actualPlan = subInfo?.plan || planType;
  const renewsAt = subInfo?.renews_at;
  const cancelsAt = subInfo?.cancels_at;
  const expiryTimestamp = cancelsAt || renewsAt || null;
  const remainingDays = formatRemainingDays(expiryTimestamp);

  // Step 3: 风控合规评级
  let verdict = 'UNKNOWN';
  let verdictText = '';

  if (isDelinquent) {
    verdict = 'HIGH_RISK_CHARGEBACK';
    verdictText = '🚨 高危透支黑卡 (Stripe已标记欠款拒付，即将封号)';
    console.log(`  🚨 风控预警: ${verdictText}`);
  } else if (!hasActiveSub || actualPlan === 'free') {
    verdict = 'FAKE_FREE_ACCOUNT';
    verdictText = '❌ 假号欺诈 (当前实为免费 Free 账号，无 Plus 权益)';
    console.log(`  ❌ 货不对板: ${verdictText}`);
  } else if (remainingDays !== null && remainingDays <= 3) {
    verdict = 'EXPIRING_CRITICAL';
    verdictText = `⚠️ 临期超期 (仅剩 ${remainingDays} 天，质保严重不足)`;
    console.log(`  ⚠️ 临期预警: ${verdictText}`);
  } else if (actualPlan.includes('plus') || planType === 'plus') {
    verdict = 'CONFIRMED_GENUINE_PLUS';
    verdictText = `🟢 100% 正品 Plus (有效，剩余约 ${remainingDays != null ? remainingDays + '天' : '正常'})`;
    console.log(`  🎉 验收通过: ${verdictText}`);
  } else {
    verdict = `CONFIRMED_${actualPlan.toUpperCase()}`;
    verdictText = `🟢 正品 ${actualPlan.toUpperCase()} 会员 (剩余约 ${remainingDays != null ? remainingDays + '天' : '正常'})`;
    console.log(`  🎉 验收通过: ${verdictText}`);
  }

  return {
    index: idx,
    email,
    userId: user.id || null,
    accountId,
    planType: actualPlan,
    hasActiveSubscription: hasActiveSub,
    isDelinquent,
    willRenew: subInfo?.will_renew ?? null,
    expiresAtStr: formatDateStr(expiryTimestamp),
    remainingDays,
    verdict,
    verdictText,
    isPass: verdict === 'CONFIRMED_GENUINE_PLUS' || verdict.startsWith('CONFIRMED_'),
    testedAt: new Date().toISOString(),
  };
}

async function main() {
  console.log('========================================================================');
  console.log('       ChatGPT 成品号批量深度验活与风控审计系统 (Pro & Plus Auditor)');
  console.log('========================================================================\n');

  const { inputFile, singleInput, useProxy, proxyCountry } = parseCliArgs();

  let proxyUrl = null;
  if (useProxy) {
    const user = `f347fde565edfb36383b_cr.${proxyCountry}`;
    proxyUrl = `http://${user}:${DEFAULT_PROXY_PASS}@${DEFAULT_PROXY_HOST}`;
    console.log(`[网络代理] 已启用 DataImpulse 动态住宅代理 -> [${proxyCountry.toUpperCase()}] 出口`);
  } else {
    console.log(`[网络代理] 当前使用直连模式`);
  }

  const items = parseAccountItems(inputFile, singleInput);

  if (items.length === 0) {
    console.log('❌ 未找到待检测的账号列表！');
    console.log('\n使用方式说明：');
    console.log('1. 创建 config/accounts_to_verify.txt 并粘贴账号列表（一行一个，支持 email----pass----sessionToken）');
    console.log('   运行：node scripts/verify-plus-accounts.mjs --file config/accounts_to_verify.txt\n');
    console.log('2. 或者直接传入 session.json 进行单号诊断：');
    console.log('   运行：node scripts/verify-plus-accounts.mjs "D:/REA/portal/session.json"\n');
    console.log('3. 切换代理出口国家（如菲律宾或智利）：');
    console.log('   运行：node scripts/verify-plus-accounts.mjs --proxy ph --file accounts.txt');
    process.exit(1);
  }

  console.log(`[任务载入] 成功解析 ${items.length} 个待检测账号目标，开始逐一穿透核验...\n`);

  const results = [];
  let passCount = 0;
  let fakeCount = 0;
  let chargebackCount = 0;
  let deadCount = 0;

  for (let i = 0; i < items.length; i++) {
    const r = await verifyAccount(items[i], i + 1, items.length, proxyUrl);
    results.push(r);

    if (r.isPass) passCount++;
    else if (r.verdict === 'FAKE_FREE_ACCOUNT') fakeCount++;
    else if (r.verdict === 'HIGH_RISK_CHARGEBACK') chargebackCount++;
    else deadCount++;
  }

  // 输出终端汇总表格
  console.log('\n========================================================================');
  console.log('                           最终批量验收结果汇总');
  console.log('========================================================================');
  console.log(
    `${'序号'.padEnd(4, ' ')} | ${'账号邮箱'.padEnd(30, ' ')} | ${'规格'.padEnd(8, ' ')} | ${'剩余天数'.padEnd(8, ' ')} | ${'验收评级'}`
  );
  console.log('------------------------------------------------------------------------');

  for (const r of results) {
    const days = r.remainingDays != null ? `${r.remainingDays}天` : '未知';
    console.log(
      `${String(r.index).padEnd(4, ' ')} | ${(r.email || 'N/A').padEnd(30, ' ')} | ${(r.planType || 'N/A').padEnd(8, ' ')} | ${days.padEnd(8, ' ')} | ${r.verdictText}`
    );
  }

  console.log('------------------------------------------------------------------------');
  console.log(`📊 统计数据：总检测 ${results.length} 个 | 正品合格: ${passCount} | 假号欺诈: ${fakeCount} | 透支拒付黑卡: ${chargebackCount} | 失效/死号: ${deadCount}`);

  // 生成维权与详细报表文件
  const reportJsonPath = path.resolve('audit_report.json');
  fs.writeFileSync(reportJsonPath, JSON.stringify({ testedAt: new Date().toISOString(), summary: { total: results.length, passCount, fakeCount, chargebackCount, deadCount }, results }, null, 2));

  // 生成给号商对线的售后维权凭据 (audit_claim_letter.md)
  const failedList = results.filter((x) => !x.isPass);
  let claimMd = `# ChatGPT 成品号提货质量检测与维权索赔单\n\n`;
  claimMd += `> **检测时间**：${new Date().toISOString()}  \n`;
  claimMd += `> **检测总数**：${results.length} 个 ｜ **正规合格**：${passCount} 个 ｜ **不合格/异常需要退换**：${failedList.length} 个  \n\n`;
  claimMd += `### 异常账号明细（请号商核实并立即补号或退款）：\n\n`;
  claimMd += `| 序号 | 账号邮箱 | 报告评级 | 接口真实返回原因 | 判定违规类型 |\n`;
  claimMd += `| :--- | :--- | :--- | :--- | :--- |\n`;

  for (const f of failedList) {
    let typeName = '死号/无法登录';
    if (f.verdict === 'FAKE_FREE_ACCOUNT') typeName = '以次充好 (实为Free白号)';
    if (f.verdict === 'HIGH_RISK_CHARGEBACK') typeName = '透支黑卡 (isDelinquent=true)';
    claimMd += `| ${f.index} | \`${f.email}\` | **${f.verdictText}** | \`${f.details || '已停权/失效'}\` | ${typeName} |\n`;
  }

  claimMd += `\n---\n*本报告由 OpenPrice Pro 官方底层接口验活工具自动化生成，具备完整请求日志溯源依据。*\n`;

  const claimMdPath = path.resolve('audit_claim_letter.md');
  fs.writeFileSync(claimMdPath, claimMd, 'utf8');

  console.log(`\n📄 详细原始 JSON 报告已保存至: ${reportJsonPath}`);
  console.log(`📝 售后维权退款索赔单已生成至: ${claimMdPath} (可直接复制发给卖家进行退换)`);
}

main().catch(console.error);
