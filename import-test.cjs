/**
 * 回归测试：从文件导入（微信聊天记录 / 链接清单）
 *
 * 用法：先启动服务（node server.js），再执行
 *     node import-test.cjs
 *
 * 只读测试：只读取临时构造的样本文件、检查链接抽取与待导入框内容，
 * 不会向数据库写入任何文章。需要系统已安装 Edge。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE = process.env.BASE || 'http://127.0.0.1:4321';
const DEBUG_PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 样本：仿微信「合并转发」另存为的 html ---------- */
const L = {
  short: 'https://mp.weixin.qq.com/s/AbCdEf12345_xyz',
  perm: 'https://mp.weixin.qq.com/s?__biz=MzIyODI1MzYyNA==&mid=2653546018&idx=1&sn=69ff3b17631b8a88b7e96b7a971c5850',
  permAmp:
    'https://mp.weixin.qq.com/s?__biz=MzA5NzQyNTM2MA==&mid=2247483652&idx=1&sn=abcdef1234567890abcdef1234567890',
  params: 'https://mp.weixin.qq.com/s/QwErTy98765',
  hash: 'https://mp.weixin.qq.com/s/ZxCvBnM24680',
};

const chatHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>聊天记录</title></head>
<body><div class="record">
  <div class="item"><div class="content">看这篇 ${L.short}</div></div>
  <div class="item"><div class="content">转 <a href="${L.perm}">多模态大模型综述</a></div></div>
  <div class="item"><div class="content"><a href="${L.permAmp.replace(/&/g, '&amp;')}">路面性能预测</a></div></div>
  <div class="item"><div class="content">${L.short} 重复发了一次</div></div>
  <div class="item"><div class="content">https://mp.weixin.qq.com/s/QwErTy98765?from=singlemessage&isappinstalled=0 带跟踪参数</div></div>
  <div class="item"><div class="content">${L.hash}#rd 带锚点</div></div>
  <div class="item"><div class="content">随口一个网址 https://www.example.com/some/page</div></div>
  <div class="item"><div class="content">公众号主页 https://mp.weixin.qq.com/mp/profile_ext?action=home&__biz=MzA5 不是文章</div></div>
  <div class="item"><div class="content">结尾带中文标点 ${L.short}，还有一句</div></div>
</div></body></html>`;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shouwen-test-'));
const htmlPath = path.join(tmpDir, 'chat.html');
const gbkPath = path.join(tmpDir, 'chat-gbk.txt');
fs.writeFileSync(htmlPath, chatHtml, 'utf8');
// GBK 样本：「中文内容」+ 一个链接
fs.writeFileSync(
  gbkPath,
  Buffer.concat([
    Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xc4, 0xda, 0xc8, 0xdd]),
    Buffer.from('\n' + L.params + '\n', 'ascii'),
  ]),
);

// 期望：短链的 ?from= 跟踪参数会被剥掉（不影响阅读，还能让重复分享去重）
const EXPECTED = [L.short, L.perm, L.permAmp, L.params, L.hash];

/* ---------- CDP ---------- */
async function getTarget() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch {}
    await sleep(300);
  }
  throw new Error('无法连接调试端口，请确认 Edge 已用 --remote-debugging-port 启动');
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      }
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () =>
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const mid = ++id;
            pending.set(mid, { res, rej });
            ws.send(JSON.stringify({ id: mid, method, params }));
          });
        },
        close: () => ws.close(),
      }),
    );
  });
}

(async () => {
  let pass = 0;
  let fail = 0;
  const check = (name, ok, extra = '') => {
    console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
    ok ? pass++ : fail++;
  };

  const t = await getTarget();
  const cdp = await connect(t.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Page.navigate', { url: BASE + '/' });
  await sleep(2500);

  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  console.log('\nA. 链接抽取');
  check(
    'HTML 实体 &amp; 被还原',
    (await ev(
      `extractWechatLinks('<a href="https://mp.weixin.qq.com/s?__biz=X&amp;mid=1&amp;idx=1&amp;sn=abcdef">t</a>')[0]`,
    )) === 'https://mp.weixin.qq.com/s?__biz=X&mid=1&idx=1&sn=abcdef',
  );
  check(
    '浏览器支持 GBK 解码',
    (await ev(`new TextDecoder('gbk').decode(new Uint8Array([0xd6,0xd0,0xce,0xc4])) === '中文'`)) === true,
  );
  check(
    '非 /s 路径不计入',
    (await ev(`extractWechatLinks('https://mp.weixin.qq.com/mp/profile_ext?action=home&__biz=X').length`)) === 0,
  );
  check(
    '无协议链接可识别',
    (await ev(`extractWechatLinks('看这个 mp.weixin.qq.com/s/AbCdEf12345_xyz')[0]`)) === L.short,
  );

  console.log('\nB. 拖入仿微信导出的聊天记录 .html');
  check('初始弹层是关闭的', (await ev(`$('#importModal').classList.contains('hidden')`)) === true);
  const doc = await cdp.send('DOM.getDocument', { depth: -1 });
  const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fileInput' });
  await cdp.send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [htmlPath] });
  await sleep(1200);
  check('弹层自动打开', (await ev(`!$('#importModal').classList.contains('hidden')`)) === true);
  const filled = await ev(`$('#importText').value.trim().split('\\n')`);
  console.log('     识别结果：', JSON.stringify(filled, null, 0));
  check('链接数量正确', filled.length === EXPECTED.length, `实际 ${filled.length} / 期望 ${EXPECTED.length}`);
  check(
    '链接内容完全一致',
    EXPECTED.every((u) => filled.includes(u)),
  );
  check('重复链接已去重', filled.filter((u) => u === L.short).length === 1);
  const toastText = await ev(`$('#toast').textContent`);
  console.log('     toast：', toastText);
  check('提示文案含识别数量', /识别到\s*5\s*条公众号链接/.test(toastText));

  console.log('\nC. 拖入 GBK 编码的 txt');
  await ev(`$('#importText').value = ''`);
  await cdp.send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [gbkPath] });
  await sleep(900);
  const gbkVal = await ev(`$('#importText').value.trim()`);
  check('GBK 文件里的链接被抽出', gbkVal === L.params, gbkVal);

  console.log('\nD. 拖到窗口任意位置也能导入');
  // 用 DataTransfer 构造一次全窗口 drop，验证 window 级监听
  const dropped = await ev(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['闲聊 https://mp.weixin.qq.com/s/WindowDrop12345 存一下'], 'w.txt', { type: 'text/plain' }));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(1200);
  const afterDrop = await ev(`$('#importText').value.trim().split('\\n').pop()`);
  check('窗口级拖放生效', dropped === true && afterDrop === 'https://mp.weixin.qq.com/s/WindowDrop12345', afterDrop);
  check('拖放遮罩已收起', (await ev(`$('#dropOverlay').classList.contains('hidden')`)) === true);

  console.log('\nE. 内置帮助包含导出步骤');
  await ev(`openHelp()`);
  await sleep(300);
  const help = await ev(`$('#helpBody').textContent`);
  check('帮助里写了「合并转发 → 另存为 → 拖入」', /合并转发/.test(help) && /另存为/.test(help) && /从文件导入/.test(help));
  await ev(`closeOverlay('helpModal')`);

  cdp.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n结果：${pass} 项通过${fail ? `，${fail} 项失败` : '，全部通过'}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n执行失败：', e.message);
  console.error('提示：需要先用 --remote-debugging-port=9333 启动无头 Edge，例如');
  console.error(
    '  msedge.exe --headless=new --remote-debugging-port=9333 --user-data-dir=%TEMP%\\cdp about:blank',
  );
  process.exit(1);
});
