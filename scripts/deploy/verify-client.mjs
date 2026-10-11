import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
/**
 * 验证 3080 的客户端是否真的能启动。
 *
 * 关键点：HTTP 200 只说明服务在跑；页面能否启动取决于每个 client 模块
 * 能否被 import。上一个版本的重启脚本只探测 200，所以在 "Failed to load
 * plugins" 期间一直报「成功」。
 *
 * 做法：取首页的 __DSH_BOOT__ 清单，逐个抓取被标记 immediately 的入口模块，
 * 检查响应与内容，并比对故障特征（模块被解析成旧 release 的副本时，
 * 会带出 codec 的旧写法）。
 */
const base = process.argv[2] ?? 'http://127.0.0.1:3080/';

function extractBoot(html) {
  const s = html.indexOf('__DSH_BOOT__');
  if (s < 0) return undefined;
  const i = html.indexOf('{', s);
  let d = 0, e = -1, inStr = false, esc = false;
  for (let j = i; j < html.length; j++) {
    const ch = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') d++;
    else if (ch === '}') { d--; if (!d) { e = j + 1; break; } }
  }
  return JSON.parse(html.slice(i, e));
}

const problems = [];
const res = await fetch(base);
const html = await res.text();
const boot = extractBoot(html);
if (boot === undefined) problems.push('首页没有 __DSH_BOOT__ 清单');

const entries = boot?.entries ?? [];
for (const entry of entries) {
  let body;
  try {
    const r = await fetch(new URL(entry.url, base));
    body = await r.text();
    if (!r.ok) problems.push(entry.id + ': HTTP ' + r.status);
  } catch (error) {
    problems.push(entry.id + ': ' + String(error));
    continue;
  }
  if (body.length === 0) problems.push(entry.id + ': 空响应');
}

// 已知的降级特征：agent-team 的 codec 在新旧版本间写法不同。
// 新版用 schema.value 缓存，旧版直接 intersection(string(), unknown())。
const marker = entries.find(e => e.id === '@deepseek-ai/dsh-experimental-client-ui-agent-team');
if (marker !== undefined) {
  const body = await (await fetch(new URL(marker.url, base))).text();
  const oldCodec = body.split('intersection(string').length - 1;
  const newCodec = body.split('schema.value').length - 1;
  // Expected count comes from the profile the server runs, not from a constant: upstream
  // changed this list between releases (rc30 declared 6, rc31 declares 5), so the count is
  // only meaningful compared with the declaration it should match.
  let declaredInject = undefined
  try {
    const link = realpathSync('/root/.dsh/profiles/plus')
    const pkg = JSON.parse(readFileSync(join(link, 'node_modules', marker.id, 'package.json'), 'utf8'))
    declaredInject = pkg.dsh?.client?.inject
  } catch { /* fall back to the numeric floor below */ }
  if (Array.isArray(declaredInject)) {
    if (marker.inject.length !== declaredInject.length) {
      problems.push('agent-team 的 inject 有 ' + marker.inject.length + ' 项，但该 profile 声明 ' + declaredInject.length + ' 项，说明解析到了别的副本')
    }
  } else if (marker.inject.length < 5) {
    problems.push('agent-team 的 inject 只有 ' + marker.inject.length + ' 项，低于任何已知版本')
  }
  if (newCodec > 0 && oldCodec > 0) {
    problems.push('agent-team 模块内容同时含新旧两种 codec 写法，说明模块来自混合副本')
  }
}

if (problems.length > 0) {
  console.log('CLIENT-VERIFY: FAILED (' + problems.length + ' 项)');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('CLIENT-VERIFY: OK (' + entries.length + ' 个客户端模块全部可加载)');
