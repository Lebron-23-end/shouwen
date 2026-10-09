'use strict';

/**
 * 转发收文监听器 —— 你在微信里「转发」一下，这边自动收进收文。
 *
 * 为什么走转发这条路
 * ────────────────────────────────────────────────────────────────
 * 微信 4.x 的聊天记录存在 SQLCipher 加密的消息库里，本地读不到；
 * 想从磁盘上「自动抓聊天记录」只能靠破解，那条路既有合规风险也不稳定。
 * 而微信自己开放了「合并转发给第三方应用」这个动作：转发出来的内容
 * 是**明文文件**（ZIP 里是 .txt / .html），拿得到、也不必绕过任何保护。
 * 所以这个监听器只做一件事：盯着转发落地目录，把新批次里的
 * 公众号链接抽出来，抓正文，入库。
 *
 * 落地目录（由 WeChatBridge「微信流」写入）
 * ────────────────────────────────────────────────────────────────
 *   %LOCALAPPDATA%\WeChatBridge\Inbox\Ready\<批次ID>\
 *     ├─ manifest.json     批次清单（items[].relativePath 指向文件）
 *     ├─ state.json        投递结果（delivered / copied / failed）
 *     └─ files\…           聊天记录_*.zip（内含明文 .txt / .html）
 *
 * zip 里的链接形如 `·[链接] 标题 https://mp.weixin.qq.com/s?...`。
 * 同级还有 Staging（还没提交完）、Failed、Logs 三个目录 —— 只认 Ready，
 * 并且要等 manifest.json 能解析了再动手，避免读到半截批次。
 *
 * 用法
 * ────────────────────────────────────────────────────────────────
 *   node wx-watch.cjs                 常驻监听
 *   node wx-watch.cjs --once          只扫一轮就退出（调试用）
 *   node wx-watch.cjs --dry-run       只打印将要做什么，不写库
 *
 * 零依赖：只用 Node 内置模块（http / fs / path / zlib）。需要收文服务在跑。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const zlib = require('zlib');

const cfg = require('./lib/ingest-config').load();

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = process.env.READLATER_WATCH_STATE || path.join(DATA_DIR, 'wx-watch-state.json');
const LOG_FILE = process.env.READLATER_WATCH_LOG || path.join(DATA_DIR, 'wx-watch.log');
const LOCK_FILE = process.env.READLATER_WATCH_LOCK || path.join(DATA_DIR, 'wx-watch.lock');

const ARGS = process.argv.slice(2);
const ONCE = ARGS.includes('--once');
const DRY = ARGS.includes('--dry-run');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ 日志 */

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch {
    /* 日志写不进去不影响主流程 */
  }
}

/* ------------------------------------------------------------ 状态 */

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (s && typeof s === 'object') {
        return {
          version: 3,
          // 已处理过的批次：batchId → 处理时间戳
          bridgeBatches: s.bridgeBatches && typeof s.bridgeBatches === 'object' ? s.bridgeBatches : {},
          // 本次启动是不是「状态文件丢了、从零重建」——见 ensureStateSafety()
          freshState: false,
        };
      }
    }
  } catch (e) {
    log('状态文件损坏，重新建立：' + e.message);
  }
  return { version: 3, bridgeBatches: {}, freshState: true };
}

let state = loadState();
let stateDirty = false;

function saveState(force) {
  if (!stateDirty && !force) return;
  // 批次记录只留最近的 3000 条，避免无限膨胀
  const keys = Object.keys(state.bridgeBatches || {});
  if (keys.length > 5000) {
    const sorted = keys.sort((a, b) => (state.bridgeBatches[b] || 0) - (state.bridgeBatches[a] || 0));
    const keep = {};
    for (const k of sorted.slice(0, 3000)) keep[k] = state.bridgeBatches[k];
    state.bridgeBatches = keep;
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // 只落盘需要持久化的字段。
    // freshState / forceSeedOnly 是**本次启动的运行时标志**，绝不能写进文件
    // —— 否则下次读回来会把熔断永久带下去。
    const out = { version: state.version, bridgeBatches: state.bridgeBatches };
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_FILE); // 原子替换，避免写一半断电留下坏文件
    stateDirty = false;
  } catch (e) {
    log('状态写入失败：' + e.message);
  }
}

/**
 * ★ 状态文件丢失熔断。
 *
 * 踩过的坑：状态文件一旦被删/损坏，脚本会以为「首次运行」，于是把
 * 收件箱里积攒的**历史转发批次**当成新内容全部重新导入一遍。
 * 入库端虽然会按 URL 去重，但那一刻依然会打出一片重复请求。
 *
 * 保护策略：状态文件不存在、但收文库里已经有文章 → 说明这是个用过的库。
 * 本次启动只「登记」已有批次、不导入任何内容；真正的新转发（下一轮才出现
 * 的批次）会被正常收录。
 */
async function ensureStateSafety() {
  let existing = 0;
  try {
    const res = await fetch(cfg.serverBase + '/api/stats', { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const j = await res.json();
      existing = Number(j.total || 0);
    }
  } catch {
    /* 服务没起、拿不到总数就算了 —— 后面的默认行为依然是安全的 */
  }
  if (state.freshState && existing > 0) {
    state.forceSeedOnly = true;
    log(
      `⚠ 状态文件不见了，但收文库里已有 ${existing} 篇文章。` +
        `为避免把历史转发批次误当新内容灌回来，本次只登记、不导入。` +
        `新转发的内容从下一轮开始正常收录。`,
    );
  }
}

/* ------------------------------------------------------------ 单实例锁 */

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // 进程存在但没权限发信号 → 算活着
  }
}

/** 已有监听器在跑就不要重复启动，否则两个进程会同时入库 */
function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const old = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      if (old && old.pid && old.pid !== process.pid && pidAlive(old.pid)) {
        return { ok: false, holder: old };
      }
      log(`发现残留锁（PID ${old && old.pid} 已不在），接管。`);
    }
  } catch {
    /* 锁文件坏掉就当没有 */
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 'utf8');
  } catch (e) {
    log('锁写入失败（忽略）：' + e.message);
  }
  return { ok: true };
}

function releaseLock() {
  try {
    if (!fs.existsSync(LOCK_FILE)) return;
    const cur = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (cur && cur.pid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch {
    /* 退出路径上尽力而为 */
  }
}

/* ------------------------------------------------------------ HTTP 客户端 */

function apiCall(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const base = new URL(cfg.serverBase);
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = http.request(
      {
        hostname: base.hostname,
        port: base.port || 80,
        path: urlPath,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length }
          : {},
        timeout: 120000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            /* 非 JSON 响应，保留原文给调用方看 */
          }
          resolve({ status: res.statusCode, body: parsed, text });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function serverAlive() {
  try {
    const r = await apiCall('GET', '/api/stats');
    return r.status === 200;
  } catch {
    return false;
  }
}

/**
 * 上一次入库后条目的 kind（article / verify / partial / share-card …）。
 * 用来识别「只拿到腾讯验证码页」的条目 —— 那多半是抓太快被限流，
 * 值得冷却后重试；而 URL 天生缺 chksm 的那种，重试也没用。
 */
let lastIngestKind = '';

async function ingestArticle(url) {
  const r = await apiCall('POST', '/api/articles', { url, category: cfg.category });
  lastIngestKind = (r.body && r.body.item && r.body.item.kind) || '';
  if (r.status === 201) return 'new';
  if (r.status === 200 && r.body && r.body.duplicate) return 'dup';
  return 'fail:' + ((r.body && r.body.error) || 'HTTP ' + r.status);
}

/* ------------------------------------------------------------ 收件箱定位 */

/** 找 WeChatBridge 的 Inbox/Ready 目录；找不到返回 null */
function wechatBridgeInbox() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidates = [
    process.env.READLATER_BRIDGE_INBOX, // 手动指定优先
    path.join(local, 'WeChatBridge', 'Inbox', 'Ready'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'WeChatBridge', 'Inbox', 'Ready') : '',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory()) return c;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

/* ------------------------------------------------------------ 链接抽取 */

/**
 * 从一段文本里抽公众号链接。
 *
 * 微信转发出来的 ZIP 里是明文 txt，链接形如：
 *   ·[链接] 某篇文章标题 https://mp.weixin.qq.com/s?__biz=…&mid=…&idx=…&sn=…&chksm=…
 */
function extractArticleUrls(text) {
  if (!text) return [];
  const out = [];
  const seen = new Set();
  const push = (u) => {
    const clean = normalizeShareUrl(u);
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    out.push(clean);
  };
  let m;
  // 短链：/s/<hash>
  const RE_SHORT = /https?:\/\/mp\.weixin\.qq\.com\/s\/[A-Za-z0-9_-]+/g;
  while ((m = RE_SHORT.exec(text))) push(m[0]);
  // 长链：/s?__biz=…（含查询参数）
  const RE_LONG = /https?:\/\/mp\.weixin\.qq\.com\/s\?[^\s"'<>）)【】]+/g;
  while ((m = RE_LONG.exec(text))) push(m[0]);
  return out;
}

/**
 * 规范化公众号链接：只保留文章身份参数，剥掉一切分享/会话/凭证参数。
 *
 * 两个作用：
 *   1. 同一篇文章无论从哪个入口转发过来（带不带 mpshare / scene / srcid），
 *      都会归一化成同一个 URL —— 去重才准。
 *   2. URL 里夹带的 key / pass_ticket / exportkey / uin 是**登录会话凭证**，
 *      对抓取毫无用处，必须剥掉，免得泄漏进本地库。
 */
const KEEP_PARAMS = ['__biz', 'mid', 'idx', 'sn', 'chksm'];
function normalizeShareUrl(raw) {
  const s = String(raw).replace(/[.,;:!?。，；：！？）)】\]>]+$/, '').split('#')[0];
  try {
    const u = new URL(s);
    if (!/mp\.weixin\.qq\.com$/i.test(u.hostname)) return s;
    // 短链没有可剥的参数，原样返回
    if (/^\/s\/[A-Za-z0-9_-]+$/.test(u.pathname)) return u.origin + u.pathname;
    const q = new URLSearchParams();
    for (const k of KEEP_PARAMS) {
      const v = u.searchParams.get(k);
      if (v) q.set(k, v);
    }
    const qs = q.toString();
    return qs ? u.origin + '/s?' + qs : s;
  } catch {
    return s;
  }
}

/* ------------------------------------------------------------ ZIP 读取 */

/**
 * 从 .zip 里读出所有条目 —— Node 没有内置 zip，这里手写最小实现。
 * 只做「读」：定位 EOCD → 遍历中央目录 → 按 method 解压（0=存储，8=deflate）。
 */
function readZipEntries(buf) {
  // End of Central Directory 签名 0x06054b50，从尾部往回扫
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break; // 中央目录头签名
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    // 本地文件头：30 字节 + 文件名 + 扩展区，之后才是数据
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    let data = null;
    if (method === 0) data = raw;
    else if (method === 8) {
      try {
        data = zlib.inflateRawSync(raw);
      } catch {
        data = null;
      }
    }
    if (data) entries.push({ name, data });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** UTF-8 优先，出现替换符就按 GBK 再试（TextDecoder 内置支持 gbk，无需依赖） */
function decodeText(buf) {
  if (!buf || !buf.length) return '';
  const utf8 = new TextDecoder('utf-8').decode(buf);
  const bad = (utf8.match(/\uFFFD/g) || []).length;
  if (bad <= 3) return utf8;
  try {
    const gbk = new TextDecoder('gbk').decode(buf);
    if ((gbk.match(/\uFFFD/g) || []).length < bad) return gbk;
  } catch {
    /* 运行时不支持 gbk 就用 utf8 的结果 */
  }
  return utf8;
}

/* ------------------------------------------------------------ 扫描 */

let bridgeWarned = false;

/** 扫描转发收件箱：解包每个新批次，抽出链接入库 */
async function scanWechatBridge() {
  const root = wechatBridgeInbox();
  if (!root) {
    if (!bridgeWarned) {
      bridgeWarned = true;
      log('没找到 WeChatBridge 的 Inbox/Ready 目录（装好 WeChatBridge、转发一次就会出现）');
    }
    return 0;
  }

  let dirs = [];
  try {
    dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (e) {
    log('读取转发收件箱失败：' + e.message);
    return 0;
  }

  let added = 0;
  for (const batchId of dirs) {
    if (state.bridgeBatches[batchId]) continue; // 已处理过

    const bdir = path.join(root, batchId);
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(bdir, 'manifest.json'), 'utf8'));
    } catch {
      continue; // manifest 还没写完，下轮再来
    }

    // 熔断期间：这些都是「存量批次」，只登记不导入
    if (state.forceSeedOnly) {
      state.bridgeBatches[batchId] = Date.now();
      stateDirty = true;
      continue;
    }

    // 只处理会带文件的那几种转发动作
    const action = manifest.action || '';
    if (action !== 'workBuddy' && action !== 'folder' && action !== 'hub' && action !== 'custom') {
      state.bridgeBatches[batchId] = Date.now();
      stateDirty = true;
      continue;
    }

    const items = Array.isArray(manifest.items) ? manifest.items : [];
    if (!items.length) {
      state.bridgeBatches[batchId] = Date.now();
      stateDirty = true;
      continue;
    }

    // 把批次里所有文件里的链接都抽出来
    const urls = [];
    for (const it of items) {
      const rel = it.relativePath;
      if (!rel) continue;
      let buf;
      try {
        buf = fs.readFileSync(path.join(bdir, rel));
      } catch {
        continue;
      }
      const lower = String(rel).toLowerCase();
      if (lower.endsWith('.zip')) {
        for (const e of readZipEntries(buf)) urls.push(...extractArticleUrls(decodeText(e.data)));
      } else if (/\.(txt|html?|md)$/.test(lower)) {
        urls.push(...extractArticleUrls(decodeText(buf)));
      }
    }

    const uniq = [...new Set(urls)];
    if (!uniq.length) {
      log(`转发批次 ${batchId.slice(0, 8)}：没找到公众号链接（已记录，不再重扫）`);
      state.bridgeBatches[batchId] = Date.now();
      stateDirty = true;
      continue;
    }

    if (DRY) {
      log(`[dry] 转发批次 ${batchId.slice(0, 8)}：${uniq.length} 条链接`);
      for (const u of uniq) log('  → ' + u);
      continue;
    }

    if (!(await serverAlive())) {
      log(`收文服务没在运行（${cfg.serverBase}），批次不标记，下轮重试。`);
      return added;
    }

    let ok = 0;
    let dup = 0;
    let fail = 0;
    const throttled = []; // 有正文该拿到、却只拿到验证码页的 → 疑似被限流
    for (const u of uniq) {
      try {
        const res = await ingestArticle(u);
        if (res === 'new') {
          ok++;
          log(`已收文章（未读）：${u}`);
          if (lastIngestKind === 'verify' || lastIngestKind === 'partial') throttled.push(u);
        } else if (res === 'dup') {
          dup++;
          if (lastIngestKind === 'verify' || lastIngestKind === 'partial') throttled.push(u);
        } else {
          fail++;
          log(`入库失败：${res} ← ${u}`);
        }
      } catch (e) {
        fail++;
        log('入库异常：' + e.message);
      }
      // 降速：一批几十篇时 1 秒 1 篇会被风控，隔一下稳很多
      await sleep(cfg.fetchThrottleMs);
    }

    state.bridgeBatches[batchId] = Date.now();
    stateDirty = true;
    added += ok;
    log(`转发批次 ${batchId.slice(0, 8)}：${ok} 篇新收录 / ${dup} 篇已在库 / ${fail} 篇失败`);

    // 被限流的等风控冷却后重抓一遍（服务端按 URL 就地补全正文，不会产生重复条目）
    if (throttled.length) {
      log(`其中 ${throttled.length} 篇只拿到验证码页（疑似限流），等 ${cfg.retryCooldownMs / 1000} 秒后重试…`);
      await sleep(cfg.retryCooldownMs);
      let fixed = 0;
      for (const u of throttled) {
        try {
          await ingestArticle(u);
          if (lastIngestKind === 'article') fixed++;
        } catch {
          /* 重试失败就算了：条目已在库里，只是暂时没正文 */
        }
        await sleep(cfg.retryThrottleMs);
      }
      log(`限流重试完成：${fixed}/${throttled.length} 篇补回了正文`);
    }
  }

  if (stateDirty) saveState();
  return added;
}

/* ------------------------------------------------------------ 主循环 */

async function tick() {
  try {
    await scanWechatBridge();
  } catch (e) {
    log('转发收件箱异常：' + e.message);
  }
}

async function main() {
  const inbox = wechatBridgeInbox();
  log('─'.repeat(50));
  log('转发收文监听已启动');
  log(`  转发收件箱 : ${inbox || '（没找到，转发一次就会出现）'}`);
  log(`  收文服务   : ${cfg.serverBase}`);
  log(`  轮询间隔   : ${cfg.intervalMs} ms`);
  log(`  抓取节流   : 每篇 ${cfg.fetchThrottleMs} ms，限流冷却 ${cfg.retryCooldownMs} ms`);
  if (DRY) log('  [dry-run] 只打印，不写库');

  // ★ 必须在第一轮扫描前跑完
  await ensureStateSafety();

  if (ONCE) {
    // 调试用途：不受锁限制，但要提醒可能有常驻监听在跑
    if (fs.existsSync(LOCK_FILE)) {
      log('  [提示] 检测到常驻监听器正在运行，--once 与它同时扫描可能重复，仅供调试');
    }
    await tick();
    saveState(true);
    log('单轮扫描结束。');
    return;
  }

  const lock = acquireLock();
  if (!lock.ok) {
    log(
      `已有监听器在运行（PID ${lock.holder.pid}，启动于 ${new Date(lock.holder.startedAt).toLocaleString('zh-CN')}），本次退出。`,
    );
    log('  要重启：先关掉那个进程，或删除 data/wx-watch.lock');
    return;
  }
  process.on('exit', releaseLock);

  let running = true;
  const stop = () => {
    running = false;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (running) {
    await tick();
    if (!running) break;
    await sleep(cfg.intervalMs);
  }

  saveState(true);
  releaseLock();
  log('监听已停止。');
}

main();
