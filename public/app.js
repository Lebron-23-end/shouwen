'use strict';

/* ------------------------------------------------------------------ *
 *  收文 · 我的稍后读
 * ------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  status: 'all',
  category: 'all',
  q: '',
  sort: 'added',
  items: [],
  cats: [],
  tags: [],
  stats: { total: 0, unread: 0, read: 0, starred: 0, trash: 0 },
  selected: new Set(),
  current: null,                     // 当前阅读的文章
  limits: { unread: 60, read: 60 },  // 未读 / 已读 两组各自渲染条数
  lastQuery: '',                     // 上次列表请求条件，用于判断是否重置分页
  collapsed: loadCollapsed(),        // 分组折叠状态
};

function loadCollapsed() {
  try {
    const saved = JSON.parse(localStorage.getItem('shouwen.collapsed') || '{}');
    return { unread: !!saved.unread, read: !!saved.read };
  } catch {
    return { unread: false, read: false };
  }
}

function saveCollapsed() {
  try {
    localStorage.setItem('shouwen.collapsed', JSON.stringify(state.collapsed));
  } catch {}
}

/* ---------------- 工具 ---------------- */
const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function relTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const min = 60000, hour = 3600000, day = 86400000;
  if (diff < min) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < day * 2) return '昨天';
  if (diff < day * 7) return `${Math.floor(diff / day)} 天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

let toastTimer = null;
function toast(msg, ms = 2000) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

async function api(path, opts = {}) {
  const init = { ...opts };
  if (init.body && typeof init.body !== 'string') {
    init.body = JSON.stringify(init.body);
    init.headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
  }
  const res = await fetch(path, init);
  let data = {};
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

/* ---------------- 数据加载 ---------------- */
async function loadMeta() {
  const data = await api('/api/stats');
  state.stats = data;
  state.cats = data.categories || [];
  state.tags = data.tags || [];
}

async function loadList() {
  const params = new URLSearchParams();
  if (state.category !== 'all') params.set('category', state.category);
  if (state.status !== 'all') params.set('status', state.status);
  if (state.q) params.set('q', state.q);
  params.set('sort', state.sort);
  const queryKey = params.toString();

  const data = await api('/api/articles?' + queryKey);
  state.items = data.items || [];

  // 筛选条件变化时重置分页；单纯刷新（如标记已读后）保留已加载条数
  if (queryKey !== state.lastQuery) {
    state.lastQuery = queryKey;
    state.limits = { unread: 60, read: 60 };
  }
  renderList();
}

async function refresh() {
  await Promise.all([loadMeta(), loadList()]);
  renderChips();
}

/* ---------------- 渲染：筛选条 ---------------- */
function renderChips() {
  const s = state.stats;
  const statusDefs = [
    { key: 'all', label: '全部', n: s.total },
    { key: 'unread', label: '未读', n: s.unread },
    { key: 'read', label: '已读', n: s.read },
    { key: 'starred', label: '收藏', n: s.starred },
    { key: 'noted', label: '有备注' },
  ];
  $('#statusChips').innerHTML = statusDefs
    .map(
      (d) =>
        `<button class="chip ${state.status === d.key ? 'on' : ''}" data-status="${d.key}">${d.label}${
          d.n != null ? `<span class="n">${d.n}</span>` : ''
        }</button>`,
    )
    .join('');

  $('#catChips').innerHTML =
    `<button class="chip ${state.category === 'all' ? 'on' : ''}" data-cat="all">全部</button>` +
    state.cats
      .map(
        (c) =>
          `<button class="chip ${state.category === c.id ? 'on' : ''}" data-cat="${c.id}"><span class="swatch" style="background:${
            c.color || '#6b7280'
          }"></span>${esc(c.name)}<span class="n">${c.count || 0}</span></button>`,
      )
      .join('') +
    `<button class="chip add" data-act="newCat">＋ 分类</button>`;
}

/* ---------------- 渲染：列表 ---------------- */
function catOf(id) {
  return state.cats.find((c) => c.id === id) || { id, name: '未分类', color: '#6b7280' };
}

/** 本地文件条目（微信自动收进来的 PDF / docx 等） */
function isFileItem(a) {
  return a && a.kind === 'local-file';
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

function extOfName(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

function cardHTML(a) {
  const cat = catOf(a.category);
  const file = isFileItem(a);
  const ext = file ? extOfName(a.fileName || a.title) : '';
  const initial = file
    ? esc((ext || 'file').slice(0, 4).toUpperCase())
    : esc((a.account || a.title || '文').slice(0, 1));
  const coverHTML = a.cover
    ? `<img src="${esc(a.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />`
    : '';
  const kindTag = file
    ? '<span class="kind file">文件</span>'
    : a.fetchStatus === 'ok'
      ? ''
      : `<span class="kind">${a.kind === 'share-card' ? '微信卡片' : a.fetchStatus === 'gone' ? '已失效' : '仅链接'}</span>`;

  const sel = state.selected.has(a.id);

  return `
  <div class="card ${a.readAt ? 'read' : 'unread'} ${sel ? 'selected' : ''}${a.starred ? ' starred' : ''}" data-id="${a.id}">
    <div class="card-actions">
      <button class="btn sm icon-only reveal" data-act="select" data-id="${a.id}" title="${sel ? '取消选择' : '选择'}">${sel ? '✓' : '☐'}</button>
      <button class="btn sm icon-only reveal" data-act="menu" data-id="${a.id}" title="更多">⋯</button>
      <button class="btn sm icon-only star${a.starred ? ' on' : ''}" data-act="star" data-id="${a.id}" title="${a.starred ? '取消星标' : '加星标'}">${a.starred ? '★' : '☆'}</button>
      <button class="btn sm icon-only del" data-act="del" data-id="${a.id}" title="删除（不可恢复）">✕</button>
    </div>
    <div class="card-cover${file ? ' file' : ''}">
      <span class="ph-letter">${initial}</span>
      ${coverHTML}
      ${kindTag}
    </div>
    <div class="card-body">
      <div class="card-title">${esc(a.title)}</div>
      ${a.digest ? `<div class="card-digest">${esc(a.digest)}</div>` : ''}
      <div class="card-foot">
        <span class="card-account">${esc(a.account || '未知来源')}</span>
        <span class="card-dot"></span>
        <span>${relTime(a.createdAt)}</span>
        <span class="card-cat"><span class="swatch" style="width:6px;height:6px;border-radius:50%;background:${cat.color || '#6b7280'}"></span>${esc(cat.name)}</span>
        ${a.note ? '<span class="card-note">✎ 有备注</span>' : ''}
      </div>
    </div>
    ${a.readAt ? '<span class="badge-read">已读</span>' : ''}
  </div>`;
}

/** 一个分组：标题（可点击收起）+ 卡片网格 */
function groupHTML(key, label, items, limit) {
  const slice = items.slice(0, limit);
  const collapsed = !!state.collapsed[key];
  const rest = items.length - slice.length;
  return `
  <section class="group ${key}${collapsed ? ' collapsed' : ''}">
    <div class="group-head" data-toggle="${key}" title="点击${collapsed ? '展开' : '收起'}">
      <h2>${label}<span class="n">${items.length}</span></h2>
      <button class="group-toggle" tabindex="-1">${collapsed ? '展开' : '收起'}</button>
    </div>
    <div class="grid">${slice.map(cardHTML).join('')}</div>
    ${rest > 0 ? `<div class="more-hint">还有 ${rest} 篇，滚动继续加载…</div>` : ''}
  </section>`;
}

function renderList() {
  const list = $('#list');
  const empty = $('#empty');

  if (!state.items.length) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    const isFiltered = state.q || state.status !== 'all' || state.category !== 'all';
    $('#emptyTitle').textContent = isFiltered ? '这里还没有内容' : '还没有收进来的文章';
    $('#emptyText').textContent = isFiltered
      ? '换个筛选条件试试，或者添加新文章。'
      : '把公众号文章链接粘贴进来，之后就能在这里统一慢慢看。';
    $('[data-act="openImport"]', empty).style.display = isFiltered ? 'none' : '';
    return;
  }

  empty.classList.add('hidden');

  const unread = state.items.filter((a) => !a.readAt);
  const read = state.items.filter((a) => a.readAt);

  // 已读未读混在一起时才分区；只有一类时直接平铺，不显示标题
  if (unread.length && read.length) {
    list.innerHTML =
      groupHTML('unread', '未读', unread, state.limits.unread) +
      groupHTML('read', '已读', read, state.limits.read);
  } else {
    const only = unread.length ? unread : read;
    const limit = unread.length ? state.limits.unread : state.limits.read;
    list.innerHTML = `<div class="grid">${only.slice(0, limit).map(cardHTML).join('')}</div>`;
  }
  renderBulkBar();
}

function renderBulkBar() {
  const bar = $('#bulkbar');
  if (!state.selected.size) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  $('#bulkCount').textContent = `已选 ${state.selected.size} 篇`;
}

/* ---------------- 导入 ---------------- */
function openImport(prefill = '') {
  const modal = $('#importModal');
  modal.classList.remove('hidden');
  const ta = $('#importText');
  if (prefill) ta.value = prefill;
  const sel = $('#importCategory');
  sel.innerHTML = state.cats.map((c) => `<option value="${c.id}">存入：${esc(c.name)}</option>`).join('');
  $('#importProgress').classList.add('hidden');
  $('#importProgress').innerHTML = '';
  setTimeout(() => ta.focus(), 60);
}

function closeOverlay(id) {
  $('#' + id).classList.add('hidden');
}

async function doImport() {
  const text = $('#importText').value;
  const { urls } = await api('/api/parse', { method: 'POST', body: { text } });
  if (!urls.length) return toast('没有识别到链接');

  const category = $('#importCategory').value || 'inbox';
  const box = $('#importProgress');
  box.classList.remove('hidden');
  box.innerHTML = urls
    .map((u, i) => `<div class="prog-item pending" id="prog${i}"><span class="st">等待中</span><span class="u">${esc(u)}</span></div>`)
    .join('');

  const btn = $('#btnImport');
  btn.disabled = true;
  let ok = 0, dup = 0, fail = 0;

  for (let i = 0; i < urls.length; i++) {
    const row = $('#prog' + i);
    $('.st', row).textContent = '抓取中';
    try {
      const res = await api('/api/articles', { method: 'POST', body: { url: urls[i], category } });
      if (res.duplicate) {
        row.className = 'prog-item warn';
        $('.st', row).textContent = '已存在';
        dup++;
      } else if (res.item.fetchStatus === 'ok') {
        row.className = 'prog-item ok';
        $('.st', row).textContent = '已入库';
        $('.u', row).textContent = res.item.title;
        ok++;
      } else {
        row.className = 'prog-item warn';
        $('.st', row).textContent = '仅链接';
        $('.u', row).textContent = `${res.item.title} — ${res.item.fetchError || ''}`;
        ok++;
      }
    } catch (e) {
      row.className = 'prog-item err';
      $('.st', row).textContent = '失败';
      $('.u', row).textContent = `${urls[i]} — ${e.message}`;
      fail++;
    }
    if (i === 0) await refresh();
  }

  btn.disabled = false;
  await refresh();
  const parts = [`成功 ${ok}`];
  if (dup) parts.push(`重复 ${dup}`);
  if (fail) parts.push(`失败 ${fail}`);
  toast(parts.join(' · '), 3000);
  if (fail === 0) {
    $('#importText').value = '';
    setTimeout(() => closeOverlay('importModal'), 700);
  }
}

/* ---------------- 从文件导入（微信聊天记录 / 导出清单） ---------------- */

// 公众号文章：/s/<短码> 或 /s?__biz=... 永久链接
const WX_LINK_RE = /(?:https?:\/\/)?mp\.weixin\.qq\.com\/s(?:\/[A-Za-z0-9_\-]{6,}|\?[^\s"'<>]*)/gi;
// 任意链接（用于统计被忽略了多少）
const ANY_LINK_RE = /https?:\/\/(?:[\w-]+\.)+[a-zA-Z]{2,}(?:\/[^\s"'<>()【】（）]*)?/gi;

/** HTML 实体与 JS 转义的 & 还原（链接里的 &amp; 会让永久链接参数解析错） */
function decodeLinkEntities(text) {
  return String(text || '')
    .replace(/&amp;/gi, '&')
    .replace(/&#0?38;/g, '&')
    .replace(/\\u0026/gi, '&')
    .replace(/&quot;/gi, '"');
}

function extractWechatLinks(text) {
  const src = decodeLinkEntities(text);
  const out = [];
  const seen = new Set();
  for (const m of src.matchAll(WX_LINK_RE)) {
    let u = m[0].replace(/[，。；、）】》,.;)\]"'<]+$/, '');
    u = u.split('#')[0].replace(/[?&]+$/, '');
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    if (u.length < 30) continue; // mp.weixin.qq.com/s/ + 短码
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

function countOtherLinks(text) {
  const seen = new Set();
  for (const m of decodeLinkEntities(text).matchAll(ANY_LINK_RE)) {
    if (/^https?:\/\/mp\.weixin\.qq\.com\/s/i.test(m[0])) continue;
    seen.add(m[0]);
  }
  return seen.size;
}

/** 读文件为文本：优先 UTF-8，乱码时用 GBK 重试（微信导出的老文件可能是 GBK） */
async function readAsText(file) {
  const buf = await file.arrayBuffer();
  let text = new TextDecoder('utf-8').decode(buf);
  if ((text.match(/\uFFFD/g) || []).length > 3) {
    try {
      text = new TextDecoder('gbk').decode(buf);
    } catch {}
  }
  return text;
}

async function importFromFiles(fileList) {
  const files = [...(fileList || [])].filter(Boolean);
  if (!files.length) return;

  const links = [];
  let others = 0;
  let huge = 0;

  for (const f of files) {
    if (f.size > 60 * 1024 * 1024) {
      huge++;
      continue;
    }
    try {
      const text = await readAsText(f);
      links.push(...extractWechatLinks(text));
      others += countOtherLinks(text);
    } catch {
      huge++;
    }
  }

  const uniq = [...new Set(links)];
  if (!uniq.length) {
    toast(
      files.length > 1 ? '这些文件里没有找到公众号文章链接' : '这个文件里没有找到公众号文章链接',
      3000,
    );
    return;
  }

  openImport();
  const ta = $('#importText');
  const exist = ta.value.trim();
  ta.value = (exist ? exist.replace(/\s*$/, '\n') : '') + uniq.join('\n');
  ta.scrollTop = 0;

  const bits = [`已从 ${files.length > 1 ? files.length + ' 个文件' : '文件'}里识别到 ${uniq.length} 条公众号链接`];
  if (others) bits.push(`忽略 ${others} 条其他链接`);
  if (huge) bits.push(`${huge} 个文件读取失败`);
  toast(bits.join(' · '), 3600);
}

/* ---------------- 本地文件条目渲染 ---------------- */
function fileBodyHTML(a) {
  const ext = extOfName(a.fileName || a.title);
  const src = `/api/files/${a.id}`;
  const name = esc(a.fileName || a.title);
  let preview = '';
  if (ext === 'pdf') {
    preview = `<iframe class="file-preview" src="${src}" title="${name}"></iframe>`;
  } else if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) {
    preview = `<img class="file-preview-img" src="${src}" alt="${name}" />`;
  } else if (['txt', 'md', 'csv', 'json', 'log'].includes(ext)) {
    preview = `<pre class="file-text" data-src="${src}">读取中…</pre>`;
  }
  return `
  <div class="file-card">
    <div class="file-badge">${esc((ext || 'file').slice(0, 4).toUpperCase())}</div>
    <div class="file-meta">
      <div class="file-name">${name}</div>
      <div class="file-sub">${esc(a.fileMime || '')}${a.fileSize ? ' · ' + humanSize(a.fileSize) : ''}</div>
      ${a.fileSource ? `<div class="file-src" title="${esc(a.fileSource)}">来源：${esc(a.fileSource)}</div>` : ''}
    </div>
    <a class="btn primary sm" href="${src}" target="_blank" rel="noopener">打开文件</a>
  </div>
  ${preview}`;
}

function hydrateFilePreview(root) {
  const pre = root.querySelector('.file-text[data-src]');
  if (!pre) return;
  fetch(pre.dataset.src)
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error('读取失败'))))
    .then((t) => {
      pre.textContent = t.slice(0, 200000);
    })
    .catch((e) => {
      pre.textContent = '预览失败：' + e.message;
    });
}

/* ---------------- 阅读 ---------------- */
async function openReader(id) {
  const data = await api('/api/articles/' + id);
  const a = data.item;
  state.current = a;

  const reader = $('#reader');
  reader.classList.remove('hidden');
  $('#readerScroll').scrollTop = 0;

  const file = isFileItem(a);
  $('#readerTitle').textContent = a.title;
  $('#articleTitle').textContent = a.title;
  $('#articleAccount').textContent = a.account || '未知来源';
  $('#articleDate').textContent = a.publishAt ? '文件时间 ' + fmtDate(a.publishAt) : '收录于 ' + fmtDate(a.createdAt);
  $('#articleWords').textContent = file
    ? humanSize(a.fileSize)
    : a.contentText
      ? `约 ${Math.round(a.contentText.length / 100) / 10} 千字`
      : '无正文';
  $('#readerStar').style.color = a.starred ? '#e8a800' : '';
  $('#readerToggleRead').textContent = a.readAt ? '标为未读' : '标为已读';
  $('#readerOpen').textContent = file ? '打开文件' : '打开原文';

  const body = $('#articleBody');
  const fb = $('#articleFallback');
  const endMark = $('#reader .article-end');
  if (endMark) endMark.style.display = file ? 'none' : '';

  if (file) {
    fb.classList.add('hidden');
    body.innerHTML = fileBodyHTML(a);
    hydrateFilePreview(body);
  } else if (a.contentHtml) {
    body.innerHTML = a.contentHtml;
    fb.classList.add('hidden');
  } else {
    body.innerHTML = '';
    fb.classList.remove('hidden');
    fb.innerHTML = `${esc(a.fetchError || '没能抓到正文内容。')}<br/><br/>可以点右上角「打开原文」在微信里阅读，或点下面按钮再试一次抓取。<br/><br/><a href="#" id="fbRefetch" style="font-weight:600">↻ 重新抓取正文</a>`;
    $('#fbRefetch')?.addEventListener('click', (e) => {
      e.preventDefault();
      refetchCurrent();
    });
  }

  $('#noteInput').value = a.note || '';
  $('#noteState').textContent = '';
  $('#noteState').className = 'save-state';
  renderTags(a.tags || []);
  const sel = $('#readerCategory');
  sel.innerHTML = state.cats.map((c) => `<option value="${c.id}" ${c.id === a.category ? 'selected' : ''}>${esc(c.name)}</option>`).join('');

  if (!a.readAt) {
    await api('/api/articles/' + id, { method: 'PATCH', body: { read: true } });
    a.readAt = Date.now();
    const local = state.items.find((x) => x.id === id);
    if (local) local.readAt = a.readAt;
    await loadMeta();
    renderChips();
    renderList();
  }
  $('#readerToggleRead').textContent = a.readAt ? '标为未读' : '标为已读';
}

function closeReader() {
  $('#reader').classList.add('hidden');
  state.current = null;
  refresh();
}

function renderTags(tags) {
  $('#tagList').innerHTML = tags
    .map((t) => `<span class="tag">${esc(t)}<button data-act="rmTag" data-tag="${esc(t)}">✕</button></span>`)
    .join('');
}

async function refetchCurrent() {
  if (!state.current) return;
  toast('正在重新抓取…', 1200);
  try {
    const { item } = await api(`/api/articles/${state.current.id}/refetch`, { method: 'POST' });
    state.current = item;
    if (item.contentHtml) {
      $('#articleBody').innerHTML = item.contentHtml;
      $('#articleFallback').classList.add('hidden');
      toast('正文抓取成功');
    } else {
      toast(item.fetchError || '仍然没能抓到正文', 2600);
    }
  } catch (e) {
    toast('抓取失败：' + e.message);
  }
}

let noteTimer = null;
function queueNoteSave(value) {
  const st = $('#noteState');
  st.textContent = '编辑中…';
  st.className = 'save-state';
  clearTimeout(noteTimer);
  noteTimer = setTimeout(async () => {
    if (!state.current) return;
    try {
      await api('/api/articles/' + state.current.id, { method: 'PATCH', body: { note: value } });
      state.current.note = value;
      st.textContent = '已保存';
      st.className = 'save-state saved';
      const local = state.items.find((x) => x.id === state.current.id);
      if (local) local.note = value;
    } catch {
      st.textContent = '保存失败';
    }
  }, 700);
}

/* ---------------- 菜单 ---------------- */
function showMenu(x, y, items) {
  const menu = $('#ctxMenu');
  menu.innerHTML = items
    .map((it) =>
      it.type === 'sep'
        ? '<div class="sep"></div>'
        : it.type === 'label'
          ? `<div class="label">${esc(it.label)}</div>`
          : `<button data-i="${items.indexOf(it)}" class="${it.danger ? 'danger' : ''}">${esc(it.label)}</button>`,
    )
    .join('');
  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - rect.width - 12);
  const py = Math.min(y, window.innerHeight - rect.height - 12);
  menu.style.left = px + 'px';
  menu.style.top = py + 'px';
  menu.onclick = (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const item = items[Number(btn.dataset.i)];
    menu.classList.add('hidden');
    item?.onClick?.();
  };
}

function cardMenu(id, x, y) {
  const a = state.items.find((i) => i.id === id);
  if (!a) return;
  showMenu(x, y, [
    { label: a.readAt ? '标为未读' : '标为已读', onClick: () => toggleRead(id, !a.readAt) },
    { label: a.starred ? '取消收藏' : '收藏', onClick: () => toggleStar(id, !a.starred) },
    { label: '打开原文', onClick: () => window.open(a.url, '_blank', 'noopener') },
    { type: 'sep' },
    { type: 'label', label: '移动到分类' },
    ...state.cats.map((c) => ({
      label: (c.id === a.category ? '✓ ' : '　') + c.name,
      onClick: () => moveCategory(id, c.id),
    })),
    { type: 'sep' },
    { label: '删除', danger: true, onClick: () => trashOne(id) },
  ]);
}

async function toggleRead(id, read) {
  await api('/api/articles/' + id, { method: 'PATCH', body: { read } });
  if (state.current && state.current.id === id) {
    state.current.readAt = read ? Date.now() : null;
    $('#readerToggleRead').textContent = read ? '标为未读' : '标为已读';
  }
  await refresh();
}

async function toggleStar(id, starred) {
  // 先本地翻转，点下去立刻有反馈
  const hit = state.items.find((i) => i.id === id);
  if (hit) hit.starred = starred;
  if (state.current && state.current.id === id) state.current.starred = starred;
  renderList();
  if (state.current && state.current.id === id) {
    $('#readerStar').style.color = starred ? '#e8a800' : '';
  }
  try {
    await api('/api/articles/' + id, { method: 'PATCH', body: { starred } });
  } catch (e) {
    toast('星标保存失败：' + e.message);
  }
  await refresh();
}

async function moveCategory(id, category) {
  await api('/api/articles/' + id, { method: 'PATCH', body: { category } });
  if (state.current && state.current.id === id) {
    state.current.category = category;
    $('#readerCategory').value = category;
  }
  await refresh();
  toast('已移动到「' + catOf(category).name + '」');
}

async function trashOne(id) {
  // ✕ 直接永久删除，不进回收站（连带删掉本地文件副本）
  await api('/api/articles/' + id + '?mode=purge', { method: 'DELETE' });
  state.selected.delete(id);
  if (state.current && state.current.id === id) $('#reader').classList.add('hidden');
  await refresh();
  toast('已删除');
}

async function newCategory() {
  const name = prompt('新建分类名称');
  if (!name || !name.trim()) return null;
  const colors = ['#002fa7', '#7c3aed', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#6b7280'];
  const color = colors[state.cats.length % colors.length];
  const { item } = await api('/api/categories', { method: 'POST', body: { name: name.trim(), color } });
  await loadMeta();
  renderChips();
  return item;
}

/* ---------------- 回收站 ---------------- */
async function openTrash() {
  const { items } = await api('/api/trash');
  $('#trashList').innerHTML = items.length
    ? items
        .map(
          (a) => `<div class="trash-item">
            <div class="info"><div class="t">${esc(a.title)}</div><div class="s">${esc(a.account || '')} · 删除于 ${relTime(
              a.deletedAt || a.updatedAt,
            )}</div></div>
            <button class="btn ghost sm" data-restore="${a.id}">恢复</button>
            <button class="btn danger-ghost sm" data-purge="${a.id}">彻底删除</button>
          </div>`,
        )
        .join('')
    : '<p class="hint" style="text-align:center;padding:20px 0">回收站是空的</p>';
  $('#trashModal').classList.remove('hidden');
}

/* ---------------- 帮助 ---------------- */
function openHelp() {
  const lan = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  $('#helpBody').innerHTML = `
    <p class="hint">这个服务跑在你自己电脑上，数据存在本地 <code>data/db.json</code>，不会上传到任何服务器。</p>
    <p><b>1 · 电脑上用</b><br/>浏览器打开 <code>http://localhost:${location.port || 4321}</code>，点「添加文章」，把链接粘进去，一行一条。</p>
    <p><b>2 · 手机上看</b><br/>手机连同一个 Wi-Fi，浏览器打开：<br/><code id="lanUrl">http://电脑IP:${location.port || 4321}</code><br/>把上面的 <code>电脑IP</code> 换成你电脑的局域网地址（启动服务时终端里会打印）。</p>
    <p><b>3 · 从微信直接分享进来</b><br/>服务运行在 <code>localhost</code> 时，可以在浏览器里「安装」本页为应用（地址栏右侧的安装图标）。装好后，安卓手机在微信里点「分享 → 更多 → 收文」即可直接入库。iPhone 的系统限制不支持该分享方式，用第 2 步粘贴链接同样方便。</p>
    <p><b>4 · 剪贴板一键导入</b><br/>在微信里点「… → 复制链接」，回到本页点「添加文章 → 读剪贴板」，一键填入。</p>
    <p><b>5 · 把文件传输助手攒的链接一次导进来</b><br/>微信不开放聊天记录读取，所以走官方导出这条路最稳：<br/>
      a. 手机微信打开「文件传输助手」，长按任意一条消息 → <b>多选</b>，勾选你要导的文章链接（一次最多 100 条）；<br/>
      b. 点底部「分享」（方框带箭头）→ <b>合并转发</b> → 发送给「文件传输助手」；<br/>
      c. 电脑微信打开该会话，右键那条聊天记录 → <b>另存为</b>，得到一个 .html 文件；<br/>
      d. 把这个 .html 拖到本页任意位置（或「添加文章 → 从文件导入」），链接会自动全部抽出来，确认后导入。<br/>
      电脑端也可以直接在会话里多选消息后右键复制，再用「读剪贴板」批量填入。</p>
    <p class="hint">${lan ? '' : '提示：手机通过局域网访问时无法使用「读剪贴板」，手动粘贴即可。'}</p>
  `;
  $('#helpModal').classList.remove('hidden');
}

/* ---------------- 事件绑定 ---------------- */
function bind() {
  $('#search').addEventListener('input', debounce((e) => {
    state.q = e.target.value.trim();
    loadList();
  }, 250));

  $('#btnAdd').addEventListener('click', () => openImport());
  $('#btnImport').addEventListener('click', doImport);

  // 从文件导入（聊天记录 / 链接清单）
  $('#btnPickFile').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', (e) => {
    importFromFiles(e.target.files);
    e.target.value = '';
  });

  const zone = $('#dropZone');
  zone.addEventListener('click', () => $('#fileInput').click());
  for (const ev of ['dragenter', 'dragover']) {
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.add('over');
    });
  }
  for (const ev of ['dragleave', 'drop']) {
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove('over');
    });
  }
  zone.addEventListener('drop', (e) => importFromFiles(e.dataTransfer.files));

  // 拖到窗口任意位置也能导入
  let dragDepth = 0;
  const overlay = $('#dropOverlay');
  window.addEventListener('dragenter', (e) => {
    if (![...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files')) return;
    dragDepth++;
    overlay.classList.remove('hidden');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) overlay.classList.add('hidden');
  });
  window.addEventListener('drop', (e) => {
    dragDepth = 0;
    overlay.classList.add('hidden');
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    e.preventDefault();
    importFromFiles(files);
  });

  $('#btnPaste').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return toast('剪贴板是空的');
      const ta = $('#importText');
      ta.value = (ta.value ? ta.value.replace(/\s*$/, '\n') : '') + text.trim();
      toast('已读取剪贴板');
    } catch {
      toast('浏览器未授权读取剪贴板，请手动粘贴', 2600);
    }
  });

  // 顶栏更多
  $('#btnMore').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(r.right - 168, r.bottom + 6, [
      { label: '回收站', onClick: openTrash },
      { label: '手机上怎么用', onClick: openHelp },
      { label: '管理分类', onClick: manageCategories },
      { label: '全部重新抓取', onClick: refetchAll },
    ]);
  });

  // 筛选
  document.addEventListener('click', async (e) => {
    const statusBtn = e.target.closest('[data-status]');
    if (statusBtn) {
      state.status = statusBtn.dataset.status;
      renderChips();
      return loadList();
    }
    const catBtn = e.target.closest('[data-cat]');
    if (catBtn) {
      state.category = catBtn.dataset.cat;
      renderChips();
      return loadList();
    }
    if (e.target.closest('[data-act="newCat"]')) return newCategory();
    if (e.target.closest('[data-act="openImport"]')) return openImport();

    // 未读 / 已读 分组收起
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const key = toggle.dataset.toggle;
      state.collapsed[key] = !state.collapsed[key];
      saveCollapsed();
      return renderList();
    }

    const closer = e.target.closest('[data-close]');
    if (closer) return closeOverlay(closer.dataset.close);
    if (e.target.classList.contains('overlay')) return e.target.classList.add('hidden');

    // 卡片操作
    const actBtn = e.target.closest('[data-act]');
    if (actBtn && actBtn.closest('.card')) {
      e.stopPropagation();
      const id = actBtn.dataset.id;
      if (actBtn.dataset.act === 'select') {
        if (state.selected.has(id)) state.selected.delete(id);
        else state.selected.add(id);
        return renderList();
      }
      if (actBtn.dataset.act === 'menu') {
        const r = actBtn.getBoundingClientRect();
        return cardMenu(id, r.right - 180, r.bottom + 6);
      }
      if (actBtn.dataset.act === 'star') {
        const a = state.items.find((i) => i.id === id);
        return toggleStar(id, !(a && a.starred));
      }
      if (actBtn.dataset.act === 'del') return trashOne(id);
    }

    const card = e.target.closest('.card');
    if (card) return openReader(card.dataset.id);

    const bulkBtn = e.target.closest('[data-bulk]');
    if (bulkBtn) return handleBulk(bulkBtn.dataset.bulk);

    const restoreBtn = e.target.closest('[data-restore]');
    if (restoreBtn) {
      await api(`/api/trash/${restoreBtn.dataset.restore}/restore`, { method: 'POST' });
      await openTrash();
      await refresh();
      return;
    }
    const purgeBtn = e.target.closest('[data-purge]');
    if (purgeBtn) {
      await api(`/api/articles/${purgeBtn.dataset.purge}?mode=purge`, { method: 'DELETE' });
      await openTrash();
      await loadMeta();
      return;
    }

    const rmTag = e.target.closest('[data-act="rmTag"]');
    if (rmTag && state.current) {
      const tags = (state.current.tags || []).filter((t) => t !== rmTag.dataset.tag);
      state.current.tags = tags;
      await api('/api/articles/' + state.current.id, { method: 'PATCH', body: { tags } });
      renderTags(tags);
      return;
    }

    const moreBtn = e.target.closest('[data-more]');
    if (moreBtn) {
      $('#moreMenu').classList.add('hidden');
      const k = moreBtn.dataset.more;
      if (k === 'trash') openTrash();
      if (k === 'help') openHelp();
      if (k === 'cats') manageCategories();
      if (k === 'refresh') refetchAll();
    }
  });

  // 阅读视图
  $('#readerBack').addEventListener('click', closeReader);
  $('#readerOpen').addEventListener('click', () => {
    if (state.current) window.open(state.current.url, '_blank', 'noopener');
  });
  $('#readerStar').addEventListener('click', () => state.current && toggleStar(state.current.id, !state.current.starred));
  $('#readerToggleRead').addEventListener('click', () => state.current && toggleRead(state.current.id, !state.current.readAt));
  $('#readerDelete').addEventListener('click', () => state.current && trashOne(state.current.id));
  $('#noteInput').addEventListener('input', (e) => queueNoteSave(e.target.value));
  $('#readerCategory').addEventListener('change', (e) => state.current && moveCategory(state.current.id, e.target.value));
  $('#btnNewCat').addEventListener('click', async () => {
    const c = await newCategory();
    if (c && state.current) moveCategory(state.current.id, c.id);
  });
  $('#tagInput').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || !state.current) return;
    const val = e.target.value.trim();
    if (!val) return;
    const tags = [...new Set([...(state.current.tags || []), val])].slice(0, 20);
    state.current.tags = tags;
    e.target.value = '';
    await api('/api/articles/' + state.current.id, { method: 'PATCH', body: { tags } });
    renderTags(tags);
  });

  $('#btnEmptyTrash').addEventListener('click', async () => {
    if (!confirm('彻底清空回收站？此操作不可恢复。')) return;
    await api('/api/trash', { method: 'DELETE' });
    await openTrash();
    await loadMeta();
    toast('回收站已清空');
  });

  // 键盘
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#reader').classList.contains('hidden')) return closeReader();
      $$('.overlay').forEach((o) => o.classList.add('hidden'));
      $('#ctxMenu').classList.add('hidden');
      return;
    }
    if (e.key === '/' && !e.target.closest('input,textarea')) {
      e.preventDefault();
      $('#search').focus();
    }
  });

  // 滚动加载更多（未读 / 已读 两组各自累积）
  window.addEventListener('scroll', () => {
    if (window.innerHeight + window.scrollY < document.body.scrollHeight - 400) return;
    const unreadN = state.items.filter((a) => !a.readAt).length;
    const readN = state.items.length - unreadN;
    let grew = false;
    if (!state.collapsed.unread && state.limits.unread < unreadN) {
      state.limits.unread += 60;
      grew = true;
    }
    if (!state.collapsed.read && state.limits.read < readN) {
      state.limits.read += 60;
      grew = true;
    }
    if (grew) renderList();
  });

  // 接口用不到的旧菜单
  $('#moreMenu').classList.add('hidden');
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#ctxMenu')) $('#ctxMenu').classList.add('hidden');
  });
}

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

async function handleBulk(action) {
  const ids = [...state.selected];
  if (!ids.length) return;
  if (action === 'clear') {
    state.selected.clear();
    return renderList();
  }
  if (action === 'category') {
    const r = $('[data-bulk="category"]').getBoundingClientRect();
    return showMenu(r.left - 120, r.bottom + 6, state.cats.map((c) => ({
      label: c.name,
      onClick: async () => {
        await api('/api/bulk', { method: 'POST', body: { ids, action: 'category', value: c.id } });
        state.selected.clear();
        await refresh();
        toast(`已移动 ${ids.length} 篇到「${c.name}」`);
      },
    })));
  }
  if (action === 'trash' && !confirm(`永久删除选中的 ${ids.length} 篇文章？此操作不可恢复。`)) return;
  await api('/api/bulk', { method: 'POST', body: { ids, action: action === 'trash' ? 'purge' : action } });
  state.selected.clear();
  await refresh();
  toast(action === 'trash' ? `已删除 ${ids.length} 篇` : '已更新');
}

async function manageCategories() {
  const list = state.cats
    .map((c) => `${c.id === 'inbox' ? '（固定）' : ''}${c.name} — ${c.count || 0} 篇`)
    .join('\n');
  const name = prompt(`现有分类：\n${list}\n\n输入要新建的分类名（留空则取消）：`);
  if (!name || !name.trim()) return;
  await newCategory();
  toast('分类已创建');
}

async function refetchAll() {
  const targets = state.items.filter((a) => a.fetchStatus !== 'ok');
  if (!targets.length) return toast('所有文章都有正文了');
  if (!confirm(`对 ${targets.length} 篇没抓到正文的文章重新抓取？`)) return;
  toast(`开始重新抓取 ${targets.length} 篇…`, 3000);
  let ok = 0;
  for (const a of targets) {
    try {
      const { item } = await api(`/api/articles/${a.id}/refetch`, { method: 'POST' });
      if (item.contentHtml) ok++;
    } catch {}
  }
  await refresh();
  toast(`重新抓取完成：成功 ${ok} / ${targets.length}`, 3000);
}

/* ---------------- 启动 ---------------- */
(async function init() {
  bind();
  await refresh();

  const params = new URLSearchParams(location.search);
  const shareUrl = params.get('import');
  if (shareUrl) {
    history.replaceState(null, '', '/');
    openImport(shareUrl);
    setTimeout(doImport, 300);
  }
  const readId = params.get('read');
  if (readId) {
    history.replaceState(null, '', '/');
    openReader(readId).catch(() => toast('文章不存在'));
  }

  const secureContext = location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && secureContext) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
})();
