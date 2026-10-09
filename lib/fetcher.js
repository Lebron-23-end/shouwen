'use strict';

const { decodeEntities, innerOf, sanitizeBody, toText } = require('./html');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const ALLOW_IMG_HOSTS = new Set([
  'mmbiz.qpic.cn', 'mmbiz.qlogo.cn', 'mmbiz.qlogo.cn', 'wx.qlogo.cn',
  'thirdwx.qlogo.cn', 'mmbiz.qpic.cn', 'res.wx.qq.com', 'mmbiz.qlogo.cn',
  'mmbiz.qpic.cn', 'mp.weixin.qq.com', 'mmbiz.qpic.cn',
]);

function isAllowedImageHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return false;
  if (ALLOW_IMG_HOSTS.has(h)) return true;
  return h.endsWith('.qpic.cn') || h.endsWith('.qlogo.cn') || h.endsWith('.wx.qq.com') || h.endsWith('.weixin.qq.com');
}

/** 从任意一段文本里提取所有链接 */
function extractUrls(text) {
  const found = [];
  const re = /(?:https?:\/\/)?(?:[\w-]+\.)+[a-zA-Z]{2,}(?:\/[^\s"'<>()【】（）]*)?/g;
  for (const m of String(text || '').matchAll(re)) {
    let raw = m[0].replace(/[，。；、）】》,.;)\]]+$/, '');
    if (!raw) continue;
    if (!/^https?:\/\//i.test(raw)) {
      if (!/\.[a-zA-Z]{2,}\//.test(raw) && !/^mp\.weixin\.qq\.com/i.test(raw) && !/^www\./i.test(raw)) continue;
      raw = 'https://' + raw;
    }
    found.push(raw);
  }
  return [...new Set(found)];
}

function normalizeUrl(input) {
  let raw = String(input || '').trim();
  if (!raw) return null;
  raw = raw.replace(/^[<（(【]+/, '').replace(/[>）)】]+$/, '');
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!/^https?:$/i.test(u.protocol)) return null;
  // 微信链接统一去掉追踪参数（保留必要参数）
  if (/(^|\.)mp\.weixin\.qq\.com$/i.test(u.hostname)) {
    const keep = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (['__biz', 'mid', 'idx', 'sn', 'chksm'].includes(k)) keep.append(k, v);
    }
    const qs = keep.toString();
    if (u.pathname.startsWith('/s/')) u.search = '';
    else if (qs) u.search = '?' + qs;
    else if (!u.pathname.startsWith('/s')) return null;
    u.hash = '';
  } else {
    u.hash = '';
  }
  return u.toString();
}

/**
 * 抓取时用的地址：保留原始查询参数。
 *
 * 为什么不能直接用 normalizeUrl 的结果去抓：微信对「被精简过参数」的链接会
 * 返回反爬验证页（wappoc_appmsgcaptcha），拿不到正文；带上 mpshare / scene /
 * srcid 这些分享参数才当成正常分享打开。
 * 所以——入库用规范化地址（便于去重），抓取用原始地址。
 */
function prepareFetchUrl(input) {
  let raw = String(input || '').trim();
  if (!raw) return null;
  raw = raw.replace(/^[<（(【]+/, '').replace(/[>）)】]+$/, '');
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  try {
    const u = new URL(raw);
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

function firstMatch(html, patterns) {
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1] != null) {
      const val = decodeEntities(String(m[1]).replace(/\\x0a/g, '\n').replace(/\\"/g, '"').replace(/\\'/g, "'")).trim();
      if (val) return val;
    }
  }
  return '';
}

/** 标题 / 公众号名这类短文本：去标签、压空白 */
function cleanText(value) {
  return decodeEntities(String(value || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function parseWechatTime(html) {
  const ct = html.match(/var\s+ct\s*=\s*"(\d{9,13})"/);
  if (ct) {
    const n = Number(ct[1]);
    return n > 1e12 ? n : n * 1000;
  }
  const em = html.match(/id="publish_time"[^>]*>([^<]{4,40})</);
  if (em) {
    const t = Date.parse(em[1].replace(/年|月/g, '-').replace(/日/g, ' ').trim());
    if (Number.isFinite(t)) return t;
  }
  const ctStr = html.match(/create_time:\s*'([\d-]{8,12}(?:\s[\d:]{4,8})?)'/);
  if (ctStr) {
    const t = Date.parse(ctStr[1].replace(/-/g, '/'));
    if (Number.isFinite(t)) return t;
  }
  return null;
}

async function request(url, { timeout = 20000, referer } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(referer ? { Referer: referer } : {}),
      },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 抓取一篇文章
 * @param {string} inputUrl
 * @param {{ imageProxyBase?: string, timeout?: number }} opts
 */
async function fetchArticle(inputUrl, opts = {}) {
  const url = normalizeUrl(inputUrl);
  // 入库用规范化地址（去重），抓取用原始地址（微信认这个才给正文）
  const fetchUrl = prepareFetchUrl(inputUrl) || url;
  const imageProxyBase = opts.imageProxyBase || '/api/img?u=';
  const result = {
    url: url || String(inputUrl || '').trim(),
    title: '',
    account: '',
    cover: '',
    digest: '',
    contentHtml: '',
    contentText: '',
    images: [],
    publishAt: null,
    kind: 'unknown',
    fetchStatus: 'failed',
    fetchError: '',
  };
  if (!fetchUrl) {
    result.fetchError = '链接格式无法识别';
    return result;
  }

  let res;
  try {
    res = await request(fetchUrl, { timeout: opts.timeout });
  } catch (e) {
    result.fetchError = e.name === 'AbortError' ? '抓取超时，请稍后重试' : `网络请求失败：${e.message}`;
    return result;
  }
  if (!res.ok) {
    result.fetchError = `页面返回 ${res.status}`;
    return result;
  }

  let html = '';
  try {
    const buf = Buffer.from(await res.arrayBuffer());
    html = buf.toString('utf8');
  } catch (e) {
    result.fetchError = `读取页面失败：${e.message}`;
    return result;
  }

  const isWechat = /(^|\.)mp\.weixin\.qq\.com$/i.test(new URL(fetchUrl).hostname);
  const pageMid = (html.match(/PAGE_MID="([^"]+)"/) || [])[1] || '';
  // 微信反爬验证页：正常抓不到正文，但条目本身有效，稍后重试多半就好
  const landedUrl = String(res.url || '');
  const isCaptcha =
    /wappoc_appmsgcaptcha|\/mp\/verify|\/mp\/readtemplate/i.test(landedUrl) || /poc_token/.test(html.slice(0, 4000));
  if (isCaptcha) {
    result.kind = 'verify';
    result.fetchStatus = 'partial';
    result.fetchError = '微信要求验证（反爬），稍后点「重新抓取」即可';
    return result;
  }
  result.kind = isWechat ? (pageMid.includes('common_share') ? 'share-card' : 'article') : 'web';

  // ---------- 元数据 ----------
  result.title = cleanText(
    firstMatch(html, [
      /property="og:title"\s+content="([^"]*)"/,
      /var\s+msg_title\s*=\s*(?:window\.title\s*=\s*)?['"]([^'"]{1,240})['"]/,
      /<h1[^>]*id="activity-name"[^>]*>([\s\S]{1,600}?)<\/h1>/,
      /property="twitter:title"\s+content="([^"]*)"/,
      /<title[^>]*>([\s\S]{1,300}?)<\/title>/,
    ]),
  );
  result.account = cleanText(
    firstMatch(html, [
      /property="og:article:author"\s+content="([^"]*)"/,
      /<meta\s+name="author"\s+content="([^"]*)"/,
      /id="js_name"[^>]*>([\s\S]{1,120}?)<\/(?:a|span|div)>/,
      /var\s+nickname\s*=\s*['"]([^'"]{1,80})['"]/,
      /class="rich_media_meta rich_media_meta_nickname"[^>]*>([\s\S]{1,120}?)<\/(?:a|span)>/,
    ]),
  );
  result.digest = firstMatch(html, [
    /property="og:description"\s+content="([^"]*)"/,
    /<meta\s+name="description"\s+content="([^"]*)"/,
  ]);
  const coverRaw = firstMatch(html, [
    /property="og:image"\s+content="([^"]*)"/,
    /var\s+msg_cdn_url\s*=\s*['"]([\s\S]*?)['"]/,
  ]);
  if (coverRaw) result.cover = imageProxyBase + encodeURIComponent(coverRaw);
  result.publishAt = parseWechatTime(html);

  // ---------- 正文 ----------
  let bodyHtml = isWechat ? innerOf(html, 'js_content') : null;
  if (!bodyHtml) bodyHtml = innerOf(html, 'js_article') || innerOf(html, 'js_content_container');
  if (!bodyHtml && !isWechat) {
    bodyHtml = innerOf(html, 'content') || innerOf(html, 'article') || innerOf(html, 'main');
  }

  if (bodyHtml && toText(bodyHtml).length > 60) {
    const cleaned = sanitizeBody(bodyHtml, {
      proxyImage: (u) => imageProxyBase + encodeURIComponent(u),
    });
    result.contentHtml = cleaned.html;
    result.contentText = cleaned.text;
    result.images = cleaned.images;
    result.fetchStatus = 'ok';
  } else {
    result.fetchStatus = 'partial';
    if (html.includes('该内容已被发布者删除') || html.includes('此内容因违规无法查看')) {
      result.fetchStatus = 'gone';
      result.fetchError = '原文已被删除或无法查看';
    } else if (isWechat) {
      result.fetchError = '这是微信「分享卡片」页面，正文需在原文中查看';
    } else {
      result.fetchError = '未能从页面中提取正文';
    }
  }

  if (!result.title) {
    result.title = result.contentText.slice(0, 40) || '未命名文章';
  }
  if (!result.digest) {
    result.digest = result.contentText.replace(/\s+/g, ' ').slice(0, 120);
  }
  result.digest = result.digest.replace(/\s+/g, ' ').trim().slice(0, 200);
  return result;
}

module.exports = { fetchArticle, extractUrls, normalizeUrl, isAllowedImageHost, request, UA };
