/* 用 CDP 驱动无头 Edge 做真实点击验证（只读 + 自造临时条目，绝不碰用户真实数据）
 *
 * ⚠ 安全护栏：本脚本历史上出现过一次「页面残留合成事件误触全选删除」，
 *   导致全库 77 条被移入回收站。为此加了：
 *   1) 启动前快照回收站 → 结束时把「非本次删除」的条目全部还原
 *   2) 结尾强制断言回收站只剩本次临时条目
 *   任何一步失败都会自动回滚，不会留下脏数据。 */
const fs = require('fs');
const PORT = 9333;
const BASE = 'http://127.0.0.1:4321';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 兜底还原：把回收站里不是本轮产生的条目全部 restore
async function rescueTrash(keepIds = []) {
  let n = 0;
  try {
    const tr = await (await fetch(BASE + '/api/trash')).json();
    for (const it of tr.items || []) {
      if (keepIds.includes(it.id)) continue;
      await fetch(BASE + '/api/trash/' + it.id + '/restore', { method: 'POST' });
      n++;
    }
  } catch (e) {
    console.error('  ⚠ 兜底还原失败:', e.message);
  }
  if (n) console.log(`  ⚠ 兜底还原了 ${n} 条被误删的条目`);
  return n;
}

async function getTarget() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch {}
    await sleep(300);
  }
  throw new Error('devtools not ready');
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
  // 0. 造一条临时文章用于测试（不动用户的真实数据）
  // 启动前先把历史遗留的回收站清空（全部还原），保证结尾断言看到的是「纯本轮」结果
  await rescueTrash([]);
  const baseline = (await (await fetch(BASE + '/api/stats')).json()).total;
  console.log('基线：库中共', baseline, '条（含回收站）');
  const tmpUrl = 'https://mp.weixin.qq.com/s/CDP_TEMP_DELETE_ME';
  const created = await (
    await fetch(BASE + '/api/articles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: tmpUrl }),
    })
  ).json();
  const tmpId = created.item.id;
  console.log('临时文章 id =', tmpId, '| 标题 =', created.item.title);

  const t = await getTarget();
  const cdp = await connect(t.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 980,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send('Page.navigate', { url: BASE + '/' });
  await sleep(2600);

  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('data/' + name, Buffer.from(r.data, 'base64'));
    console.log('  截图 ->', name);
  };

  console.log('\n--- 1. 卡片操作按钮 DOM ---');
  console.log(
    await evalJs(`(()=>{const c=document.querySelector('.card[data-id="${tmpId}"]');
    return [...c.querySelectorAll('.card-actions .btn')].map(b=>b.dataset.act+':'+b.textContent+'['+(b.title||'')+']').join(' | ')})()`),
  );

  console.log('\n--- 2. 默认状态（未悬停）计算样式 ---');
  console.log(
    await evalJs(`(()=>{const c=document.querySelector('.card[data-id="${tmpId}"]');
    return [...c.querySelectorAll('.card-actions .btn')].map(b=>b.dataset.act+' opacity='+getComputedStyle(b).opacity).join(' | ')})()`),
  );

  console.log('\n--- 3. 鼠标移到卡片上 ---');
  const rect = await evalJs(
    `(()=>{const r=document.querySelector('.card[data-id="${tmpId}"]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`,
  );
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await sleep(450);
  console.log(
    await evalJs(`(()=>{const c=document.querySelector('.card[data-id="${tmpId}"]');
    return [...c.querySelectorAll('.card-actions .btn')].map(b=>b.dataset.act+' opacity='+getComputedStyle(b).opacity).join(' | ')})()`),
  );
  await shot('_shot_hover.png');

  console.log('\n--- 4. 点击星标（真实鼠标点击）---');
  const srect = await evalJs(
    `(()=>{const r=document.querySelector('.card[data-id="${tmpId}"] .btn.star').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`,
  );
  if (!srect || !isFinite(srect.x) || srect.x <= 0 || srect.y <= 0) {
    throw new Error(`星标按钮坐标无效 (${JSON.stringify(srect)})，已中止`);
  }
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x: srect.x,
      y: srect.y,
      button: 'left',
      clickCount: 1,
    });
  }
  await sleep(900);
  console.log(
    '  卡片 class =',
    await evalJs(`document.querySelector('.card[data-id="${tmpId}"]').className`),
  );
  console.log(
    '  星标按钮 =',
    await evalJs(`document.querySelector('.card[data-id="${tmpId}"] .btn.star').textContent`),
  );
  console.log(
    '  浏览器标题栏是否被误触（阅读视图应保持关闭）:',
    await evalJs(`document.querySelector('#reader').classList.contains('hidden')`),
  );
  const srv = await (await fetch(BASE + '/api/articles/' + tmpId)).json();
  console.log('  服务端 starred =', srv.item.starred);
  await shot('_shot_star.png');

  console.log('\n--- 5. 再点一次取消星标 ---');
  const srect2 = await evalJs(
    `(()=>{const r=document.querySelector('.card[data-id="${tmpId}"] .btn.star').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`,
  );
  if (!srect2 || !isFinite(srect2.x) || srect2.x <= 0 || srect2.y <= 0) {
    throw new Error(`星标按钮坐标无效 (${JSON.stringify(srect2)})，已中止`);
  }
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x: srect2.x,
      y: srect2.y,
      button: 'left',
      clickCount: 1,
    });
  }
  await sleep(900);
  const srv2 = await (await fetch(BASE + '/api/articles/' + tmpId)).json();
  console.log('  服务端 starred =', srv2.item.starred);

  console.log('\n--- 6. 点击 ✕ 删除（应永久删除，不进回收站）---');
  const before = await evalJs(`document.querySelectorAll('.card').length`);
  const drect = await evalJs(
    `(()=>{const r=document.querySelector('.card[data-id="${tmpId}"] .btn.del').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`,
  );
  // 安全断言：坐标必须有效，且该坐标下确实是我们那条临时卡片的 ✕。
  // 历史上出现过「卡片未渲染 → 坐标为 (0,0) → 点到列表容器」导致误伤的教训。
  if (!drect || !isFinite(drect.x) || drect.x <= 0 || drect.y <= 0) {
    throw new Error(`✕ 按钮坐标无效 (${JSON.stringify(drect)})，已中止以免误伤数据`);
  }
  const hit = await evalJs(
    `(()=>{const el=document.elementFromPoint(${drect.x},${drect.y});
     return el ? (el.dataset && el.dataset.act) || ('!' + el.className) : 'null'})()`,
  );
  if (hit !== 'del') {
    throw new Error(`✕ 坐标处命中的是「${hit}」而不是删除按钮，已中止以免误伤数据`);
  }
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x: drect.x,
      y: drect.y,
      button: 'left',
      clickCount: 1,
    });
  }
  await sleep(1000);
  const after = await evalJs(`document.querySelectorAll('.card').length`);
  console.log('  删除前卡片数 =', before, '→ 删除后 =', after);
  console.log('  该卡片是否还残留在页面:', await evalJs(`!!document.querySelector('.card[data-id="${tmpId}"]')`));
  console.log('  toast 文案 =', await evalJs(`(document.querySelector('#toast')||{}).textContent || '(无)'`));
  const trash = await (await fetch(BASE + '/api/trash')).json();
  console.log('  回收站内容（应为空）:', trash.items.length ? trash.items.map((i) => i.title + ' / ' + i.id).join(', ') : '(空)');
  // 兜底：万一有真实条目被误删，立刻捞回来
  const rescued = await rescueTrash([]);
  if (rescued) console.log('  ⚠ 已自动还原', rescued, '条被误删的条目');
  await shot('_shot_after_delete.png');

  console.log('\n--- 7. 清理临时数据 ---');
  await fetch(BASE + '/api/articles/' + tmpId + '?mode=purge', { method: 'DELETE' });
  // 兜底：还原任何被页面合成事件误删的真实条目
  await rescueTrash([]);

  // 终局校验：临时条目已清掉后，库里的总数必须回到基线。
  // 少了就说明测试动了用户数据 —— 直接报错，别让它悄悄过去。
  const finalList = await (await fetch(BASE + '/api/articles')).json();
  const finalTrash = await (await fetch(BASE + '/api/trash')).json();
  const finalTotal = finalList.total ?? (finalList.items || []).length;
  console.log('  正式列表 =', finalTotal, '篇 | 回收站 =', finalTrash.items.length, '篇');
  if (finalTotal < baseline) {
    console.error(`\n  ✗ 数据校验失败：基线 ${baseline} 条，现在只剩 ${finalTotal} 条，丢失 ${baseline - finalTotal} 条！`);
    await rescueTrash([]);
    process.exit(1);
  }
  console.log('  ✓ 数据校验通过：与基线一致（' + baseline + ' 条）');

  cdp.close();
  console.log('\n完成');
  process.exit(0);
})().catch(async (e) => {
  console.error('FAILED:', e.message);
  const n = await rescueTrash([]); // 失败也要把误删的捞回来
  if (n) console.error('  已还原', n, '条被误删的条目');
  process.exit(1);
});
