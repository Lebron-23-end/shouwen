'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const { Store } = require('./lib/store');
const { fetchArticle, extractUrls, isAllowedImageHost, request } = require('./lib/fetcher');
const ingestConfig = require('./lib/ingest-config');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const IMG_CACHE_DIR = path.join(DATA_DIR, 'img');
const FILES_DIR = path.join(DATA_DIR, 'files');
const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || '0.0.0.0';

const store = new Store(DATA_DIR);

// 本地文件条目：对外提供下载/预览用的 MIME
const FILE_MIME = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.epub': 'application/epub+zip',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(buf);
}

function json(res, status, payload) {
  send(res, status, JSON.stringify(payload), { 'Content-Type': 'application/json; charset=utf-8' });
}

async function readBody(req, limit = 6 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function toSummary(a) {
  return {
    id: a.id,
    url: a.url,
    title: a.title,
    account: a.account,
    cover: a.cover,
    digest: a.digest,
    publishAt: a.publishAt,
    kind: a.kind,
    fetchStatus: a.fetchStatus,
    fetchError: a.fetchError,
    category: a.category,
    tags: a.tags || [],
    note: a.note || '',
    starred: !!a.starred,
    readAt: a.readAt || null,
    createdAt: a.createdAt,
    wordCount: a.contentText ? a.contentText.length : 0,
    hasContent: !!a.contentHtml,
    fileName: a.fileName || '',
    fileSize: a.fileSize || 0,
    hasFile: !!a.fileRel,
    fileMime: a.fileMime || '',
    fileSource: a.fileSource || '',
  };
}

// ---------------- 图片代理 ----------------
const memImgCache = new Map();
const MEM_LIMIT = 200;

async function handleImage(req, res, urlObj) {
  const raw = urlObj.searchParams.get('u');
  if (!raw) return send(res, 400, 'missing u');
  let target;
  try {
    target = new URL(raw);
  } catch {
    return send(res, 400, 'bad url');
  }
  if (!isAllowedImageHost(target.hostname)) return send(res, 403, 'host not allowed');

  const key = crypto.createHash('sha1').update(target.toString()).digest('hex');
  const ext = (target.searchParams.get('wx_fmt') || 'jpg').replace(/[^a-z0-9]/gi, '') || 'jpg';
  const cacheFile = path.join(IMG_CACHE_DIR, `${key}.${ext}`);

  if (memImgCache.has(key)) {
    const hit = memImgCache.get(key);
    return send(res, 200, hit.buf, { 'Content-Type': hit.type, 'Cache-Control': 'public, max-age=604800' });
  }
  if (fs.existsSync(cacheFile)) {
    const buf = fs.readFileSync(cacheFile);
    const type = MIME['.' + ext] || 'image/jpeg';
    memImgCache.set(key, { buf, type });
    return send(res, 200, buf, { 'Content-Type': type, 'Cache-Control': 'public, max-age=604800' });
  }

  try {
    const r = await request(target.toString(), { timeout: 15000, referer: 'https://mp.weixin.qq.com/' });
    if (!r.ok) return send(res, 502, 'upstream ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    const type = r.headers.get('content-type') || MIME['.' + ext] || 'image/jpeg';
    try {
      fs.mkdirSync(IMG_CACHE_DIR, { recursive: true });
      fs.writeFileSync(cacheFile, buf);
    } catch {}
    if (memImgCache.size >= MEM_LIMIT) memImgCache.delete(memImgCache.keys().next().value);
    memImgCache.set(key, { buf, type });
    send(res, 200, buf, { 'Content-Type': type, 'Cache-Control': 'public, max-age=604800' });
  } catch (e) {
    send(res, 502, 'fetch failed: ' + e.message);
  }
}

// ---------------- 静态文件 ----------------
function serveStatic(req, res, urlObj) {
  let rel = decodeURIComponent(urlObj.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden');
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return send(res, 404, 'not found');
  }
  const ext = path.extname(filePath).toLowerCase();
  const buf = fs.readFileSync(filePath);
  send(res, 200, buf, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300',
  });
}

// ---------------- 本地文件条目 ----------------
function extOf(name) {
  return path.extname(String(name || '')).toLowerCase();
}

/** 文件名里不能出现路径分隔符与 Windows 保留字符 */
function safeBaseName(name) {
  const cleaned = String(name || 'file')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned.slice(0, 120) || 'file';
}

function humanSize(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = Number(n) || 0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : Math.round(v * 10) / 10} ${units[i]}`;
}

function hashFileSync(file) {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
}

/** 删掉条目时一并清掉落盘的副本 */
function removeStoredFile(item) {
  if (!item || !item.fileRel) return;
  const abs = path.join(FILES_DIR, item.fileRel);
  if (!abs.startsWith(FILES_DIR)) return;
  try {
    fs.unlinkSync(abs);
  } catch {}
}

/**
 * POST /api/files —— 把一个本机文件收进收文。
 * 文件会被复制到 data/files（原文件保持不动），条目默认未读。
 */
async function handleFileIngest(req, res) {
  const cfg = ingestConfig.load();
  const body = JSON.parse((await readBody(req)) || '{}');
  const src = String(body.path || '').trim();
  if (!src) return json(res, 400, { error: '缺少 path' });
  if (!fs.existsSync(src)) return json(res, 400, { error: '文件不存在' });

  let st;
  try {
    st = fs.statSync(src);
  } catch (e) {
    return json(res, 400, { error: '无法读取文件：' + e.message });
  }
  if (!st.isFile()) return json(res, 400, { error: '不是一个文件' });

  const ext = extOf(src);
  if (!cfg.exts.includes(ext)) {
    return json(res, 400, { error: `扩展名不在白名单（${ext || '无'}）`, skipped: true });
  }
  if (st.size > cfg.maxFileMB * 1024 * 1024) {
    return json(res, 400, { error: `超过 ${cfg.maxFileMB} MB 上限`, skipped: true });
  }
  if (!st.size) return json(res, 400, { error: '空文件', skipped: true });

  const hash = hashFileSync(src);
  const exist = store.findByFileHash(hash);
  if (exist) return json(res, 200, { duplicate: true, item: toSummary(exist) });

  const baseName = String(body.title || path.basename(src)).slice(0, 300);
  const item = store.add({
    kind: 'local-file',
    title: baseName,
    account: String(body.source || cfg.sourceLabel),
    digest: `${(ext.slice(1) || '文件').toUpperCase()} · ${humanSize(st.size)}`,
    category: String(body.category || cfg.category),
    fetchStatus: 'ok',
    publishAt: Math.round(st.mtimeMs) || null,
    fileName: path.basename(src),
    fileSize: st.size,
    fileSource: src,
    fileHash: hash,
    fileMime: FILE_MIME[ext] || 'application/octet-stream',
  });

  try {
    fs.mkdirSync(FILES_DIR, { recursive: true });
    const rel = `${item.id}__${safeBaseName(path.basename(src))}`;
    fs.copyFileSync(src, path.join(FILES_DIR, rel));
    store.update(item.id, { fileRel: rel, url: `/api/files/${item.id}` });
  } catch (e) {
    // 复制失败就不要留下半残条目
    store.purge(item.id);
    return json(res, 500, { error: '文件复制失败：' + e.message });
  }

  return json(res, 201, { duplicate: false, item: toSummary(store.find(item.id)) });
}

/** GET /api/files/:id —— 预览/下载落盘副本（PDF、图片、文本走 inline） */
function handleFileGet(req, res, id) {
  const item = store.find(id);
  if (!item || !item.fileRel) return send(res, 404, 'not found');
  const abs = path.join(FILES_DIR, item.fileRel);
  if (!abs.startsWith(FILES_DIR) || !fs.existsSync(abs)) return send(res, 404, '文件已丢失');
  const buf = fs.readFileSync(abs);
  const type = item.fileMime || FILE_MIME[extOf(item.fileName)] || 'application/octet-stream';
  const inline = /^(application\/pdf|image\/|text\/|audio\/|video\/)/.test(type);
  send(res, 200, buf, {
    'Content-Type': type,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(item.fileName || 'file')}`,
    'Cache-Control': 'public, max-age=300',
  });
}

// ---------------- 路由 ----------------
async function handleApi(req, res, urlObj) {
  const { pathname } = urlObj;
  const method = req.method.toUpperCase();

  if (pathname === '/api/img' && method === 'GET') return handleImage(req, res, urlObj);

  // 本地文件条目：收进来 / 读出来
  if (pathname === '/api/files' && method === 'POST') return handleFileIngest(req, res);
  const fileMatch = pathname.match(/^\/api\/files\/([A-Za-z0-9]+)$/);
  if (fileMatch && method === 'GET') return handleFileGet(req, res, fileMatch[1]);

  if (pathname === '/api/stats' && method === 'GET') {
    return json(res, 200, { ...store.stats(), categories: store.listCategories(), tags: store.allTags() });
  }

  if (pathname === '/api/articles' && method === 'GET') {
    const items = store.list({
      category: urlObj.searchParams.get('category') || undefined,
      status: urlObj.searchParams.get('status') || undefined,
      q: urlObj.searchParams.get('q') || undefined,
      tag: urlObj.searchParams.get('tag') || undefined,
      sort: urlObj.searchParams.get('sort') || undefined,
    });
    return json(res, 200, { items: items.map(toSummary), total: items.length });
  }

  // 解析粘贴文本中的链接
  if (pathname === '/api/parse' && method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const urls = extractUrls(body.text || '');
    return json(res, 200, { urls });
  }

  // ── 批量入库：把一段自由文本（微信转发内容、剪贴板、聊天记录片段）里
  //    的所有公众号链接抽出来，逐条抓取入库。给「手动转发 → 一键收文」用。
  if (pathname === '/api/ingest-text' && method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const text = String(body.text || '');
    const urls = extractUrls(text);

    if (!urls.length) {
      return json(res, 200, { total: 0, added: 0, duplicate: 0, failed: 0, results: [] });
    }

    const results = [];
    for (const url of urls) {
      try {
        const parsed = await fetchArticle(url, { imageProxyBase: '/api/img?u=' });
        if (!parsed.url) {
          results.push({ url, status: 'failed', error: parsed.fetchError || '链接无效' });
          continue;
        }
        const exist = store.findByUrl(parsed.url);
        if (exist) {
          // 已有：用新抓到的内容补全（正文可能这次才抓到）
          store.update(exist.id, {
            title: parsed.title && parsed.title !== '未命名文章' ? parsed.title : exist.title,
            account: parsed.account || exist.account,
            cover: parsed.cover || exist.cover,
            digest: parsed.digest || exist.digest,
            contentHtml: parsed.contentHtml || exist.contentHtml,
            contentText: parsed.contentText || exist.contentText,
            images: parsed.images.length ? parsed.images : exist.images,
            fetchStatus: parsed.fetchStatus,
            fetchError: parsed.fetchError,
            publishAt: parsed.publishAt || exist.publishAt,
            kind: parsed.kind,
          });
          results.push({ url: parsed.url, status: 'duplicate', id: exist.id, title: store.find(exist.id).title });
          continue;
        }
        const item = store.add({ ...parsed, category: body.category || 'inbox' });
        results.push({
          url: parsed.url, status: 'added', id: item.id,
          title: item.title, fetchStatus: parsed.fetchStatus,
        });
      } catch (e) {
        results.push({ url, status: 'failed', error: e.message });
      }
    }

    const added = results.filter((r) => r.status === 'added').length;
    const duplicate = results.filter((r) => r.status === 'duplicate').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    return json(res, 200, { total: urls.length, added, duplicate, failed, results });
  }

  // 导入单条链接
  if (pathname === '/api/articles' && method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const input = (body.url || '').trim();
    if (!input) return json(res, 400, { error: '缺少链接' });

    // 本地已有的元数据（微信内置浏览器里的标题 / 公众号 / 封面 / 摘要）。
    // 抓取失败或被反爬挡住时用来兜底，条目至少不是一片空白。
    const hint = {
      title: String(body.title || '').slice(0, 300),
      account: String(body.account || '').slice(0, 120),
      cover: String(body.cover || '').slice(0, 600),
      digest: String(body.digest || '').slice(0, 600),
    };

    const parsed = await fetchArticle(input, { imageProxyBase: '/api/img?u=' });
    if (!parsed.url) return json(res, 400, { error: parsed.fetchError || '链接无效' });

    // 抓取失败时 fetcher 会给个占位标题，别让它盖住本地已有的真标题
    const fetchedTitle = parsed.title && parsed.title !== '未命名文章' ? parsed.title : '';
    parsed.title = fetchedTitle || hint.title;
    parsed.account = parsed.account || hint.account;
    parsed.cover = parsed.cover || hint.cover;
    parsed.digest = parsed.digest || hint.digest;

    const exist = store.findByUrl(parsed.url);
    if (exist) {
      store.update(exist.id, {
        title: parsed.title || exist.title,
        account: parsed.account || exist.account,
        cover: parsed.cover || exist.cover,
        digest: parsed.digest || exist.digest,
        contentHtml: parsed.contentHtml || exist.contentHtml,
        contentText: parsed.contentText || exist.contentText,
        images: parsed.images.length ? parsed.images : exist.images,
        fetchStatus: parsed.fetchStatus,
        fetchError: parsed.fetchError,
        publishAt: parsed.publishAt || exist.publishAt,
        kind: parsed.kind,
      });
      return json(res, 200, { item: toSummary(store.find(exist.id)), duplicate: true });
    }

    const item = store.add({ ...parsed, category: body.category || 'inbox' });
    return json(res, 201, { item: toSummary(item), duplicate: false });
  }

  const detailMatch = pathname.match(/^\/api\/articles\/([A-Za-z0-9]+)$/);
  if (detailMatch) {
    const id = detailMatch[1];
    const item = store.find(id);

    // DELETE 放在前面：回收站里的条目（deletedAt 已置位）也必须能彻底删除
    if (method === 'DELETE') {
      if (!item) return json(res, 404, { error: '文章不存在' });
      if (urlObj.searchParams.get('mode') === 'purge') {
        removeStoredFile(item);
        store.purge(id);
        return json(res, 200, { ok: true, purged: true });
      }
      if (item.deletedAt) return json(res, 200, { ok: true, already: true });
      store.trash(id);
      return json(res, 200, { ok: true });
    }

    if (!item || item.deletedAt) return json(res, 404, { error: '文章不存在' });
    if (method === 'GET') return json(res, 200, { item });
    if (method === 'PATCH') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const patch = {};
      if ('read' in body) patch.readAt = body.read ? Date.now() : null;
      if ('readAt' in body) patch.readAt = body.readAt;
      if ('category' in body) patch.category = body.category;
      if ('note' in body) patch.note = String(body.note || '').slice(0, 20000);
      if ('title' in body) patch.title = String(body.title || '').slice(0, 300);
      if ('starred' in body) patch.starred = !!body.starred;
      if ('tags' in body) {
        patch.tags = Array.isArray(body.tags)
          ? body.tags.map((t) => String(t).trim().slice(0, 24)).filter(Boolean).slice(0, 20)
          : [];
      }
      const updated = store.update(id, patch);
      return json(res, 200, { item: updated ? toSummary(updated) : null });
    }
  }

  // 重新抓取正文
  const refetchMatch = pathname.match(/^\/api\/articles\/([A-Za-z0-9]+)\/refetch$/);
  if (refetchMatch && method === 'POST') {
    const item = store.find(refetchMatch[1]);
    if (!item) return json(res, 404, { error: '文章不存在' });
    if (item.kind === 'local-file') return json(res, 400, { error: '本地文件条目没有可抓取的正文' });
    const parsed = await fetchArticle(item.url, { imageProxyBase: '/api/img?u=' });
    const updated = store.update(item.id, {
      contentHtml: parsed.contentHtml || item.contentHtml,
      contentText: parsed.contentText || item.contentText,
      images: parsed.images.length ? parsed.images : item.images,
      fetchStatus: parsed.fetchStatus,
      fetchError: parsed.fetchError,
      title: parsed.title || item.title,
      cover: parsed.cover || item.cover,
    });
    return json(res, 200, { item: updated });
  }

  const restoreMatch = pathname.match(/^\/api\/trash\/([A-Za-z0-9]+)\/restore$/);
  if (restoreMatch && method === 'POST') {
    store.restore(restoreMatch[1]);
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/trash' && method === 'GET') {
    return json(res, 200, { items: store.listTrash().map(toSummary) });
  }
  if (pathname === '/api/trash' && method === 'DELETE') {
    for (const it of store.listTrash()) removeStoredFile(it);
    return json(res, 200, { removed: store.emptyTrash() });
  }

  // 批量操作
  if (pathname === '/api/bulk' && method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const ids = Array.isArray(body.ids) ? body.ids : [];
    let n = 0;
    for (const id of ids) {
      if (body.action === 'purge') {
        const it = store.find(id);
        if (it) {
          removeStoredFile(it);
          n += store.purge(id) ? 1 : 0;
        }
      } else if (body.action === 'trash') n += store.trash(id) ? 1 : 0;
      else if (body.action === 'read') n += store.markRead(id, true) ? 1 : 0;
      else if (body.action === 'unread') n += store.markRead(id, false) ? 1 : 0;
      else if (body.action === 'star') n += store.update(id, { starred: !!body.value }) ? 1 : 0;
      else if (body.action === 'category') n += store.update(id, { category: body.value || 'inbox' }) ? 1 : 0;
    }
    return json(res, 200, { ok: true, affected: n });
  }

  // 分类
  if (pathname === '/api/categories') {
    if (method === 'GET') return json(res, 200, { items: store.listCategories() });
    if (method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const item = store.addCategory(body.name, body.color);
      if (!item) return json(res, 400, { error: '分类名不能为空' });
      return json(res, 201, { item });
    }
  }
  const catMatch = pathname.match(/^\/api\/categories\/([A-Za-z0-9]+)$/);
  if (catMatch) {
    if (method === 'PATCH') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const item = store.updateCategory(catMatch[1], body);
      return json(res, 200, { item });
    }
    if (method === 'DELETE') {
      const ok = store.removeCategory(catMatch[1]);
      return json(res, ok ? 200 : 400, { ok });
    }
  }

  if (pathname === '/api/tags' && method === 'GET') return json(res, 200, { items: store.allTags() });

  return json(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    // 分享目标入口：/share?url=...&title=...&text=...
    if (urlObj.pathname === '/share') {
      const candidate = [urlObj.searchParams.get('url'), urlObj.searchParams.get('text'), urlObj.searchParams.get('title')]
        .filter(Boolean)
        .join(' ');
      const u = extractUrls(candidate)[0] || '';
      res.writeHead(302, { Location: `/?import=${encodeURIComponent(u)}` });
      return res.end();
    }

    if (urlObj.pathname.startsWith('/api/')) return await handleApi(req, res, urlObj);
    return serveStatic(req, res, urlObj);
  } catch (e) {
    console.error('[error]', req.method, urlObj.pathname, e.message);
    if (!res.headersSent) json(res, 500, { error: e.message });
  }
});

function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const info of list || []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address);
    }
  }
  return out;
}

const PID_FILE = path.join(DATA_DIR, 'server.pid');

function writePidFile() {
  try {
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
  } catch {
    /* 写不了也无所谓，停止脚本还有端口兜底 */
  }
}

server.listen(PORT, HOST, () => {
  // 写 PID 文件，方便 停止收文.cmd 精确结束进程（不依赖窗口标题）
  writePidFile();
  const line = '─'.repeat(58);
  console.log(line);
  console.log('  📥  收文 · 我的稍后读');
  console.log(line);
  console.log(`  本机访问 : http://localhost:${PORT}`);
  for (const ip of localAddresses()) console.log(`  局域网   : http://${ip}:${PORT}`);
  console.log(`  数据文件 : ${path.join(DATA_DIR, 'db.json')}`);
  console.log(line);
});

// 自愈：PID 文件被误删（例如手工清理 data 目录后）时自动补回。
// 每 30 秒校验一次，空跑开销可忽略。
setInterval(() => {
  try {
    if (!fs.existsSync(PID_FILE) || fs.readFileSync(PID_FILE, 'utf8').trim() !== String(process.pid)) {
      writePidFile();
    }
  } catch {
    /* ignore */
  }
}, 30000).unref();

function cleanupPidFile() {
  try {
    if (fs.existsSync(PID_FILE) && fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) {
      fs.unlinkSync(PID_FILE);
    }
  } catch {
    /* ignore */
  }
}

process.on('SIGINT', () => {
  store.saveNow();
  cleanupPidFile();
  console.log('\n已保存数据，服务已停止。');
  process.exit(0);
});
process.on('SIGTERM', () => {
  store.saveNow();
  cleanupPidFile();
  process.exit(0);
});
