'use strict';

/** 轻量 HTML 工具集：实体解码、标签清理、正文抽取 */

const ENTITY_MAP = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—', ndash: '–',
  middot: '·', times: '×', divide: '÷', copy: '©', reg: '®', trade: '™', deg: '°',
  plusmn: '±', bull: '•', dagger: '†', sect: '§', para: '¶', permil: '‰',
  euro: '€', pound: '£', yen: '¥', cent: '¢', curren: '¤',
  laquo: '«', raquo: '»', prime: '′', Prime: '″', ne: '≠', le: '≤', ge: '≥', equiv: '≡',
  infin: '∞', prop: '∝', sum: '∑', prod: '∏', radic: '√', int: '∫', part: '∂', nabla: '∇',
  forall: '∀', exist: '∃', empty: '∅', isin: '∈', notin: '∉', sub: '⊂', sup: '⊃',
  sube: '⊆', supe: '⊇', cup: '∪', cap: '∩', and: '∧', or: '∨', not: '¬',
  rarr: '→', larr: '←', uarr: '↑', darr: '↓', harr: '↔', rArr: '⇒', hArr: '⇔',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο',
  pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ',
  Psi: 'Ψ', Omega: 'Ω', oline: '‾', frasl: '⁄',
};

function decodeEntities(input) {
  if (!input) return '';
  return String(input).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,10});/g, (whole, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      return String.fromCodePoint(code);
    }
    const hit = ENTITY_MAP[body] ?? ENTITY_MAP[body.toLowerCase()];
    return hit === undefined ? whole : hit;
  });
}

function stripTags(html) {
  return String(html || '')
    .replace(/<(script|style|svg|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|li|h[1-6]|tr|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
}

/** 把一段 HTML 变成可读纯文本 */
function toText(html) {
  return decodeEntities(stripTags(html))
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 从头标签开始，做深度匹配，切出完整元素 */
const VOID_TAGS = new Set([
  'br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'area', 'base', 'col',
  'embed', 'track', 'wbr', 'path', 'circle', 'rect', 'line', 'polygon', 'polyline',
  'ellipse', 'stop', 'use', 'image',
]);

function sliceElement(html, startIdx) {
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;
  tagRe.lastIndex = startIdx;
  let depth = 0;
  let m;
  while ((m = tagRe.exec(html))) {
    const isClose = m[1] === '/';
    const name = m[2].toLowerCase();
    const selfClose = m[3] === '/';
    if (VOID_TAGS.has(name) || selfClose) continue;
    if (isClose) {
      depth -= 1;
      if (depth <= 0) return html.slice(startIdx, m.index + m[0].length);
    } else {
      depth += 1;
    }
  }
  return html.slice(startIdx, startIdx + 400000);
}

/** 取某个 id 容器的内部 HTML（自动处理 div 嵌套） */
function innerOf(html, idPattern) {
  const openRe = new RegExp(`<([a-zA-Z][a-zA-Z0-9-]*)\\b[^>]*\\bid="${idPattern}"[^>]*>`, 'i');
  const m = openRe.exec(html);
  if (!m) return null;
  const outer = sliceElement(html, m.index);
  const openLen = m[0].length;
  return outer.slice(openLen, outer.length - (outer.match(/<\/[a-zA-Z][a-zA-Z0-9-]*>\s*$/) || [''])[0].length);
}

const SAFE_STYLE_PROPS = new Set([
  'color', 'background-color', 'background', 'font-size', 'font-weight', 'font-style',
  'font-family', 'text-align', 'text-indent', 'text-decoration', 'line-height',
  'letter-spacing', 'word-spacing', 'margin', 'margin-top', 'margin-bottom',
  'margin-left', 'margin-right', 'padding', 'padding-top', 'padding-bottom',
  'padding-left', 'padding-right', 'border', 'border-radius', 'border-color',
  'border-width', 'border-style', 'border-left', 'border-right', 'border-top',
  'border-bottom', 'width', 'max-width', 'height', 'max-height', 'display',
  'vertical-align', 'white-space', 'word-break', 'writing-mode', 'text-shadow',
  'box-shadow', 'opacity', 'transform', 'filter', 'overflow-x', 'list-style',
  'list-style-type', 'text-overflow', 'column-count', 'object-fit', 'aspect-ratio',
]);

function cleanStyle(styleValue) {
  if (!styleValue) return '';
  const kept = [];
  for (const raw of String(styleValue).split(';')) {
    const idx = raw.indexOf(':');
    if (idx < 0) continue;
    const prop = raw.slice(0, idx).trim().toLowerCase();
    const val = raw.slice(idx + 1).trim();
    if (!val || !SAFE_STYLE_PROPS.has(prop)) continue;
    if (/url\s*\(|expression\s*\(|javascript:/i.test(val)) continue;
    if (/(^|\s)(position|z-index|top|left|right|bottom)\s*:/.test(prop + ':')) continue;

    // 公众号正文字号普遍偏小（15px），等比放大后阅读更舒服
    if (prop === 'font-size') {
      const px = val.match(/^([\d.]+)px$/i);
      if (px) {
        const scaled = Math.max(15, Math.min(44, parseFloat(px[1]) * 1.12));
        kept.push(`font-size: ${Math.round(scaled * 10) / 10}px`);
        continue;
      }
    }
    if (prop === 'line-height') {
      const num = val.match(/^([\d.]+)$/);
      if (num && parseFloat(num[1]) < 1.5) {
        kept.push('line-height: 1.72');
        continue;
      }
    }
    kept.push(`${prop}: ${val}`);
  }
  return kept.join('; ');
}

const BLOCKED_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button',
  'textarea', 'select', 'option', 'link', 'meta', 'base', 'audio', 'video', 'source',
  'svg', 'canvas', 'applet', 'frame', 'frameset', 'template', 'noscript',
]);

/**
 * 清洗公众号正文 HTML
 * @param {string} raw
 * @param {{ proxyImage?: (url: string) => string }} opts
 * @returns {{ html: string, text: string, images: string[] }}
 */
function sanitizeBody(raw, opts = {}) {
  const proxyImage = opts.proxyImage || ((u) => u);
  const images = [];
  let html = String(raw || '');

  html = html.replace(/<!--[\s\S]*?-->/g, '');
  html = html.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g, (whole, slash, tag, attrs) => {
    const name = tag.toLowerCase();
    if (BLOCKED_TAGS.has(name)) return '';
    return `<${slash}${name}${attrs}>`;
  });

  // 属性清理
  html = html.replace(/<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^<>]*?)?)\s*\/?>/g, (whole, tag, attrs) => {
    const name = tag.toLowerCase();
    if (!attrs) return `<${name}>`;
    const out = [];
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))|([a-zA-Z_:][-a-zA-Z0-9_:.]*)/g;
    let m;
    while ((m = attrRe.exec(attrs))) {
      const key = (m[1] || m[6] || '').toLowerCase();
      const value = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5] !== undefined ? m[5] : '';
      if (!key) continue;
      if (key.startsWith('on') || key === 'id' || key === 'class' || key === 'epub:type') continue;
      if (key === 'style') {
        const s = cleanStyle(decodeEntities(value));
        if (s) out.push(`style="${s.replace(/"/g, '&quot;')}"`);
        continue;
      }
      if (key === 'data-src' || key === 'data-raw-src' || key === 'data-original') {
        if (name === 'img' && value) out.push(`src="${proxyImage(value)}"`);
        continue;
      }
      if (key === 'src') {
        if (name === 'img') {
          if (/^data:image\//i.test(value) === false) out.push(`src="${proxyImage(value)}"`);
        }
        continue;
      }
      if (key === 'href') {
        let href = decodeEntities(value).trim();
        if (/^javascript:/i.test(href)) continue;
        if (href && !/^(https?:|mailto:)/i.test(href)) href = 'https://mp.weixin.qq.com' + (href.startsWith('/') ? '' : '/') + href;
        if (href) out.push(`href="${href.replace(/"/g, '&quot;')}"`);
        continue;
      }
      if (key === 'data-type' || key === 'data-role' || key === 'data-w' || key === 'data-ratio') {
        if (value) out.push(`${key}="${value.replace(/"/g, '&quot;')}"`);
        continue;
      }
    }
    const isImg = name === 'img';
    if (name === 'a') out.push('target="_blank"', 'rel="noopener noreferrer"');
    return `<${name}${out.length ? ' ' + out.join(' ') : ''}${isImg ? ' /' : ''}>`;
  });

  // 收集图片
  for (const m of html.matchAll(/<img[^>]+src="([^"]+)"/gi)) {
    if (m[1]) images.push(decodeEntities(m[1]));
  }

  html = html.replace(/(\s*<p[^>]*>\s*(<br\s*\/?>|&nbsp;|\s)*<\/p>\s*)+/gi, '');
  html = html.replace(/<(p|section|div|span)([^>]*)>\s*<\/(p|section|div|span)>/gi, '');

  const text = toText(html);
  return { html: html.trim(), text, images };
}

module.exports = { decodeEntities, toText, stripTags, sliceElement, innerOf, sanitizeBody, cleanStyle };
