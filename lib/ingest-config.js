'use strict';

/**
 * 收文 —— 共享配置。
 *
 * Web 服务（server.js）和转发监听器（wx-watch.cjs）读同一份，
 * 保证「文件白名单 / 大小上限 / 分类 / 服务地址」两边判断一致。
 *
 * 优先级：环境变量 > ingest.config.json > 下面这些默认值。
 * ingest.config.json 是可选的，没有也能跑（各人配置不同，已加进 .gitignore）。
 */

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'ingest.config.json');

const DEFAULTS = {
  // ── 服务与轮询 ────────────────────────────────────────────────
  // 收文服务地址（监听器把抓到的链接提交到这里）
  serverBase: 'http://127.0.0.1:4321',
  // 监听轮询间隔（毫秒）
  intervalMs: 5000,

  // ── 入库默认值 ────────────────────────────────────────────────
  // 新条目默认进哪个分类
  category: 'inbox',
  // 「手动导入本机文件」时，条目上显示的来源名（见 POST /api/files）
  sourceLabel: '本地导入',

  // ── 手动导入本机文件（POST /api/files）的约束 ─────────────────
  // 只接受这些扩展名，其余一律拒收
  exts: ['.pdf', '.doc', '.docx', '.md', '.html', '.htm', '.txt', '.epub', '.pptx', '.xlsx', '.csv'],
  // 单个文件大小上限（MB）
  maxFileMB: 200,

  // ── 微信转发收件箱 ────────────────────────────────────────────
  // 抓正文时每篇之间停一下。一批几十篇时 1 秒 1 篇的突发抓取会被
  // 腾讯风控拦成验证码页，降速之后稳定很多。
  fetchThrottleMs: 350,
  // 万一还是被拦，等这么久让风控冷却，然后逐条重抓一次
  retryCooldownMs: 8000,
  // 重抓时每篇之间的间隔
  retryThrottleMs: 900,
};

function load() {
  let raw = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
    }
  } catch (e) {
    console.error('[ingest-config] 配置读取失败，使用默认值：', e.message);
  }
  const cfg = { ...DEFAULTS, ...raw };
  // 环境变量优先，方便临时换服务地址做测试
  if (process.env.READLATER_SERVER_BASE) cfg.serverBase = process.env.READLATER_SERVER_BASE;
  cfg.exts = normalizeExts(cfg.exts, DEFAULTS.exts);
  return cfg;
}

function normalizeExts(value, fallback) {
  if (!Array.isArray(value)) return fallback.slice();
  const out = value
    .map((e) => String(e || '').trim().toLowerCase())
    .filter(Boolean)
    .map((e) => (e.startsWith('.') ? e : '.' + e));
  return out.length ? [...new Set(out)] : fallback.slice();
}

module.exports = { load, CONFIG_FILE, DEFAULTS };
