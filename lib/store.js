'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CATEGORIES = [
  { id: 'inbox', name: '未分类', color: '#6b7280' },
  { id: 'ai', name: 'AI', color: '#7c3aed' },
  { id: 'product', name: '产品', color: '#0ea5e9' },
  { id: 'business', name: '商业', color: '#f59e0b' },
  { id: 'invest', name: '投资', color: '#10b981' },
];

function makeId(prefix = '') {
  return (
    prefix +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 7) +
    Math.random().toString(36).slice(2, 5)
  );
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    this.data = { version: 1, articles: [], categories: DEFAULT_CATEGORIES.slice(), settings: {} };
    this._timer = null;
    this._writing = false;
    this._dirty = false;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.articles)) {
          this.data = {
            version: 1,
            articles: parsed.articles,
            categories: Array.isArray(parsed.categories) && parsed.categories.length ? parsed.categories : DEFAULT_CATEGORIES.slice(),
            settings: parsed.settings || {},
          };
        }
      } else {
        this.saveNow();
      }
    } catch (e) {
      const backup = this.file + '.corrupt-' + Date.now();
      try {
        fs.copyFileSync(this.file, backup);
      } catch {}
      console.error('[store] 数据文件损坏，已备份到', backup, e.message);
    }
  }

  save() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.saveNow();
    }, 250);
  }

  saveNow() {
    if (!this._dirty && fs.existsSync(this.file)) return;
    const tmp = this.file + '.tmp';
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
      this._dirty = false;
    } catch (e) {
      console.error('[store] 写入失败', e.message);
    }
  }

  // ---------- 文章 ----------
  list({ category, status, q, tag, sort } = {}) {
    let items = this.data.articles.filter((a) => !a.deletedAt);
    if (category && category !== 'all') items = items.filter((a) => a.category === category);
    if (status === 'unread') items = items.filter((a) => !a.readAt);
    else if (status === 'read') items = items.filter((a) => a.readAt);
    else if (status === 'starred') items = items.filter((a) => a.starred);
    else if (status === 'noted') items = items.filter((a) => a.note && a.note.trim());
    if (tag) items = items.filter((a) => (a.tags || []).includes(tag));
    if (q) {
      const needle = String(q).toLowerCase();
      items = items.filter((a) =>
        [a.title, a.account, a.digest, a.note, a.contentText ? a.contentText.slice(0, 4000) : '', (a.tags || []).join(' ')]
          .join('\n')
          .toLowerCase()
          .includes(needle),
      );
    }
    const by = sort || 'added';
    items.sort((a, b) => {
      if (by === 'read') return (b.readAt || 0) - (a.readAt || 0);
      if (by === 'publish') return (b.publishAt || b.createdAt) - (a.publishAt || a.createdAt);
      if (by === 'title') return String(a.title).localeCompare(String(b.title), 'zh-Hans-CN');
      return b.createdAt - a.createdAt;
    });
    return items;
  }

  find(id) {
    return this.data.articles.find((a) => a.id === id) || null;
  }

  findByUrl(url) {
    return this.data.articles.find((a) => a.url === url && !a.deletedAt) || null;
  }

  /** 按内容指纹查重（本地文件条目不重复入库）——回收站里的也算已存在，避免删掉又被自动加回来 */
  findByFileHash(hash) {
    if (!hash) return null;
    return this.data.articles.find((a) => a.fileHash === hash) || null;
  }

  add(article) {
    const now = Date.now();
    const item = {
      id: makeId('a'),
      url: article.url,
      title: article.title || '未命名文章',
      account: article.account || '',
      cover: article.cover || '',
      digest: article.digest || '',
      contentHtml: article.contentHtml || '',
      contentText: article.contentText || '',
      images: article.images || [],
      publishAt: article.publishAt || null,
      kind: article.kind || 'unknown',
      fetchStatus: article.fetchStatus || 'partial',
      fetchError: article.fetchError || '',
      category: article.category || 'inbox',
      tags: article.tags || [],
      note: article.note || '',
      // 本地文件条目（kind === 'local-file'）：文件已复制进 data/files
      fileName: article.fileName || '',
      fileSize: article.fileSize || 0,
      fileRel: article.fileRel || '',
      fileSource: article.fileSource || '',
      fileHash: article.fileHash || '',
      fileMime: article.fileMime || '',
      starred: false,
      readAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.data.articles.unshift(item);
    this.save();
    return item;
  }

  update(id, patch) {
    const item = this.find(id);
    if (!item) return null;
    const allowed = [
      'title', 'account', 'category', 'tags', 'note', 'starred', 'readAt',
      'cover', 'digest', 'contentHtml', 'contentText', 'images', 'fetchStatus',
      'fetchError', 'publishAt', 'kind', 'url',
      'fileName', 'fileSize', 'fileRel', 'fileSource', 'fileHash', 'fileMime',
    ];
    for (const key of Object.keys(patch)) {
      if (allowed.includes(key)) item[key] = patch[key];
    }
    item.updatedAt = Date.now();
    this.save();
    return item;
  }

  markRead(id, read) {
    return this.update(id, { readAt: read ? Date.now() : null });
  }

  trash(id) {
    const item = this.find(id);
    if (!item) return null;
    item.deletedAt = Date.now();
    item.updatedAt = item.deletedAt;
    this.save();
    return item;
  }

  restore(id) {
    const item = this.find(id);
    if (!item) return null;
    item.deletedAt = null;
    item.updatedAt = Date.now();
    this.save();
    return item;
  }

  purge(id) {
    const idx = this.data.articles.findIndex((a) => a.id === id);
    if (idx < 0) return false;
    this.data.articles.splice(idx, 1);
    this.save();
    return true;
  }

  emptyTrash() {
    const before = this.data.articles.length;
    this.data.articles = this.data.articles.filter((a) => !a.deletedAt);
    this.save();
    return before - this.data.articles.length;
  }

  listTrash() {
    return this.data.articles.filter((a) => a.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);
  }

  // ---------- 分类 ----------
  listCategories() {
    const used = new Map();
    for (const a of this.data.articles) {
      if (a.deletedAt) continue;
      used.set(a.category, (used.get(a.category) || 0) + 1);
    }
    return this.data.categories.map((c) => ({ ...c, count: used.get(c.id) || 0 }));
  }

  addCategory(name, color) {
    const trimmed = String(name || '').trim().slice(0, 20);
    if (!trimmed) return null;
    const exist = this.data.categories.find((c) => c.name === trimmed);
    if (exist) return exist;
    const item = { id: makeId('c'), name: trimmed, color: color || '#6b7280' };
    this.data.categories.push(item);
    this.save();
    return item;
  }

  updateCategory(id, patch) {
    const item = this.data.categories.find((c) => c.id === id);
    if (!item) return null;
    if (patch.name) item.name = String(patch.name).trim().slice(0, 20);
    if (patch.color) item.color = patch.color;
    this.save();
    return item;
  }

  removeCategory(id, fallbackId = 'inbox') {
    if (id === 'inbox') return false;
    const idx = this.data.categories.findIndex((c) => c.id === id);
    if (idx < 0) return false;
    this.data.categories.splice(idx, 1);
    for (const a of this.data.articles) {
      if (a.category === id) a.category = fallbackId;
    }
    this.save();
    return true;
  }

  allTags() {
    const counter = new Map();
    for (const a of this.data.articles) {
      if (a.deletedAt) continue;
      for (const t of a.tags || []) counter.set(t, (counter.get(t) || 0) + 1);
    }
    return [...counter.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
  }

  stats() {
    const live = this.data.articles.filter((a) => !a.deletedAt);
    return {
      total: live.length,
      unread: live.filter((a) => !a.readAt).length,
      read: live.filter((a) => a.readAt).length,
      starred: live.filter((a) => a.starred).length,
      trash: this.data.articles.filter((a) => a.deletedAt).length,
    };
  }
}

module.exports = { Store, makeId, DEFAULT_CATEGORIES };
