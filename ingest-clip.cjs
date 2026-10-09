'use strict';
/**
 * 剪贴板收文 / 命令行收文。
 *
 * 用法（三种都行）：
 *   1) 双击 收链接.cmd        → 读剪贴板里的文本，抽出公众号链接并入库
 *   2) node ingest-clip.cjs   → 同上（命令行等价）
 *   3) node ingest-clip.cjs "https://mp.weixin.qq.com/s/xxxx"
 *                             → 直接收参数里的链接（可给多个）
 *   4) type 文本文件 | node ingest-clip.cjs   → 从管道读
 *
 * 说明：微信「转发 → 转发到其他应用 → 微⁠信流 → 发给 WorkBuddy」之后，
 * 你也可以直接把那段文本粘贴到剪贴板跑第 1 种，效果一样，且不依赖任何注入。
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const cfgMod = require('./lib/ingest-config');
const cfg = cfgMod.load ? cfgMod.load() : cfgMod;
const BASE = cfg.serverBase || 'http://127.0.0.1:4321';

/* ------------------------------------------------------------ 读剪贴板 */

function readClipboard() {
  // Windows：PowerShell 的 Get-Clipboard 最稳，读的是 Unicode 文本
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'],
    { encoding: 'utf8', timeout: 15000 },
  );
  if (r.error || r.status !== 0) {
    // 兜底：从临时文件读（有些环境不允许 spawn powershell）
    const tmp = path.join(require('os').tmpdir(), 'readlater-clip.txt');
    try {
      const clip = spawnSync('cmd', ['/c', 'powershell -NoProfile Get-Clipboard -Raw > "' + tmp + '"'], {
        timeout: 15000,
      });
      if (!clip.error && fs.existsSync(tmp)) {
        const s = fs.readFileSync(tmp, 'utf8');
        try { fs.unlinkSync(tmp); } catch {}
        return s;
      }
    } catch {}
    return null;
  }
  return r.stdout || '';
}

function readStdin() {
  try {
    if (process.stdin.isTTY) return null;
    return fs.readFileSync(0, 'utf8');
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ 提取链接 */

const RE_URL = /https?:\/\/mp\.weixin\.qq\.com\/[^\s"'<>（）()【】,，、]+/g;
const RE_SHORT = /https?:\/\/mp\.weixin\.qq\.com\/s\/[A-Za-z0-9_-]+/g;

function extractUrls(text) {
  if (!text) return [];
  const out = [];
  const seen = new Set();
  const push = (u) => {
    const clean = u.replace(/[.,;:!?。，；：！？]+$/, '');
    if (seen.has(clean)) return;
    seen.add(clean);
    out.push(clean);
  };
  let m;
  RE_SHORT.lastIndex = 0;
  while ((m = RE_SHORT.exec(text))) push(m[0]);
  RE_URL.lastIndex = 0;
  while ((m = RE_URL.exec(text))) {
    if (!/\/s\/[A-Za-z0-9_-]+$/.test(m[0])) push(m[0]);
  }
  return out;
}

/* ------------------------------------------------------------ 主流程 */

async function main() {
  const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  let text = '';
  let from = '';

  if (argv.length) {
    text = argv.join('\n');
    from = '命令行参数';
  } else {
    const stdin = readStdin();
    if (stdin && stdin.trim()) {
      text = stdin;
      from = '标准输入';
    } else {
      const clip = readClipboard();
      if (clip && clip.trim()) {
        text = clip;
        from = '剪贴板';
      }
    }
  }

  if (!text.trim()) {
    console.log('没拿到任何文本。');
    console.log('用法：');
    console.log('  1) 先把内容复制到剪贴板，再跑本脚本');
    console.log('  2) node ingest-clip.cjs "https://mp.weixin.qq.com/s/xxxx"');
    process.exit(1);
  }

  const urls = extractUrls(text);
  console.log(`来源：${from} | 文本 ${text.length} 字 | 识别到 ${urls.length} 条公众号链接`);
  if (!urls.length) {
    console.log('没找到公众号链接。文本前 200 字：');
    console.log(text.slice(0, 200));
    process.exit(1);
  }
  urls.forEach((u, i) => console.log(`  ${i + 1}. ${u}`));

  // 探活
  try {
    const r = await fetch(BASE + '/api/stats', { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
  } catch (e) {
    console.log(`\n收文服务没在运行（${BASE}）。请先双击 启动收文.cmd。`);
    process.exit(1);
  }

  console.log('\n开始入库…');
  const res = await fetch(BASE + '/api/ingest-text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const out = await res.json();

  console.log('\n─────────────────────────────────────────');
  for (const r of out.results || []) {
    const mark = r.status === 'added' ? '✅ 新收' : r.status === 'duplicate' ? '↩︎ 已在库' : '❌ 失败';
    console.log(`${mark}  ${r.title || r.error || r.url}`);
  }
  console.log('─────────────────────────────────────────');
  console.log(`合计 ${out.total} 条：新收 ${out.added} / 已在库 ${out.duplicate} / 失败 ${out.failed}`);
  console.log(`打开看：${BASE}`);
}

main().catch((e) => {
  console.error('出错：', e.message);
  process.exit(1);
});
