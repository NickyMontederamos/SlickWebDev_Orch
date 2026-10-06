// Drives the three pages in a real Chrome and fails on any broken behaviour.
// Run: npm run test:browser      (CHROME_PATH overrides the browser location)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.env.SHOTS_DIR || '';
if (shots) fs.mkdirSync(shots, { recursive: true });
const SLICK = 'slicklab_tcc_orchestration_corrected.html';
const HYPER = 'TCC_HyperInteractive_Integrated_Infrastructure.html';
const SQL_FILE = fs.readFileSync(path.join(root, 'sql/TCC_Integrated_Nexus_Schema.sql'), 'utf8');

const types = { '.html': 'text/html; charset=utf-8', '.sql': 'text/plain; charset=utf-8' };
const server = http.createServer((q, r) => {
  let rel = decodeURIComponent(q.url.split('?')[0]);
  if (rel.endsWith('/')) rel += 'index.html';
  const f = path.join(root, path.normalize(rel));
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('not found'); }
  r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(r);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; return; }
  failures.push(name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
}
async function open(file, w, h, { mobile = false, context = browser.defaultBrowserContext() } = {}) {
  const page = await context.newPage();
  await page.setViewport({ width: w, height: h, isMobile: mobile, hasTouch: mobile });
  const log = { errors: [], external: [] };
  page.on('pageerror', e => log.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') log.errors.push(m.text()); });
  page.on('request', q => { const u = q.url(); if (!u.startsWith(base) && !u.startsWith('data:') && !u.startsWith('blob:')) log.external.push(u); });
  await page.goto(base + file, { waitUntil: 'load' });
  await sleep(450);
  return { page, log };
}
const shot = (page, name) => shots ? page.screenshot({ path: path.join(shots, name + '.png') }) : null;

// Shared geometry checks, evaluated in the page. `boxes` and `links` are in the same coordinate space.
// Every link must end on the border of its target and must not run through any other box.
function geometry(boxes, links) {
  const out = { offBorder: [], through: [] };
  for (const l of links) {
    const b = boxes[l.to], e = l.pts[l.pts.length - 1];
    const onBorder = e.x >= b.l - 2 && e.x <= b.r + 2 && e.y >= b.t - 2 && e.y <= b.b + 2 &&
      (Math.abs(e.x - b.l) < 2 || Math.abs(e.x - b.r) < 2 || Math.abs(e.y - b.t) < 2 || Math.abs(e.y - b.b) < 2);
    if (!onBorder) out.offBorder.push(l.from + '>' + l.to);
    for (const [id, x] of Object.entries(boxes)) {
      if (id === String(l.from) || id === String(l.to)) continue;
      if (l.pts.some(p => p.x > x.l + 3 && p.x < x.r - 3 && p.y > x.t + 3 && p.y < x.b - 3)) out.through.push(l.from + '>' + l.to + ' crosses ' + id);
    }
  }
  return out;
}
const sample = p => { const L = p.getTotalLength(); return Array.from({ length: 81 }, (_, i) => { const q = p.getPointAtLength(L * i / 80); return { x: q.x, y: q.y }; }); };

// ======================= SlickLab TCC, desktop =======================
console.log('SlickLab TCC · 1360x850');
{
  const { page, log } = await open(SLICK, 1360, 850);
  const tf = () => page.evaluate(() => document.getElementById('world').style.transform);
  const visible = () => page.evaluate(() => [...document.querySelectorAll('.node:not(.hidden)')].map(n => n.querySelector('h2').textContent));
  const drawerOpen = () => page.evaluate(() => document.getElementById('drawer').classList.contains('open'));
  const inView = () => page.evaluate(() => { const v = document.getElementById('viewport').getBoundingClientRect(); return [...document.querySelectorAll('.node')].filter(n => { const b = n.getBoundingClientRect(); return b.left >= v.left && b.right <= v.right && b.top >= v.top && b.bottom <= v.bottom; }).length; });

  const c = await page.evaluate(() => ({ nodes: document.querySelectorAll('.node').length, edges: document.querySelectorAll('path.edge').length, gateCount: document.getElementById('gateCount').textContent }));
  check('18 steps and 18 links are drawn', c.nodes === 18 && c.edges === 18, c);
  check('gate count shows the real number of approval gates', c.gateCount === '4', c.gateCount);
  check('whole map is on screen at load', await inView() === 18, await inView());
  const hudClash = await page.evaluate(() => { const t = document.querySelector('.titlebox').getBoundingClientRect(); return [...document.querySelectorAll('.node')].filter(n => { const b = n.getBoundingClientRect(); return b.top < t.bottom && b.left < t.right; }).length; });
  check('no step sits under the page title', hudClash === 0, hudClash);
  const geo = await page.evaluate((geometryFn, sampleFn) => {
    const geometry = new Function('return ' + geometryFn)(), sample = new Function('return ' + sampleFn)();
    const boxes = {}; document.querySelectorAll('.node').forEach((e, i) => { boxes[i] = { l: e.offsetLeft, t: e.offsetTop, r: e.offsetLeft + e.offsetWidth, b: e.offsetTop + e.offsetHeight }; });
    return geometry(boxes, [...document.querySelectorAll('path.edge')].map(p => ({ from: p.dataset.from, to: p.dataset.to, pts: sample(p) })));
  }, geometry.toString(), sample.toString());
  check('every arrow ends on the border of its target step', geo.offBorder.length === 0, geo.offBorder);
  check('no link runs through another step', geo.through.length === 0, geo.through);
  await shot(page, 'slicklab-1360');

  // pan, zoom
  let a = await tf();
  await page.mouse.move(800, 700); await page.mouse.down(); await page.mouse.move(660, 640, { steps: 6 }); await page.mouse.up();
  let b = await tf();
  check('dragging the canvas pans the map', a !== b, { a, b });
  await page.mouse.move(700, 500); await page.mouse.wheel({ deltaY: -300 }); await sleep(80);
  a = await tf();
  check('mouse wheel zooms the map', a !== b, { a, b });
  await page.click('#zoomIn'); b = await tf(); check('+ button zooms', a !== b);
  await page.click('#zoomOut'); a = await tf(); check('− button zooms', a !== b);
  await page.click('#home'); await sleep(450);
  check('fit button brings the whole map back', await inView() === 18, await inView());
  // a drag that starts and ends on a step must not open it
  const nb = await page.evaluate(() => { const r = document.querySelectorAll('.node')[2].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(nb.x, nb.y); await page.mouse.down(); await page.mouse.move(nb.x + 60, nb.y + 30, { steps: 6 }); await page.mouse.up(); await sleep(120);
  check('dragging across a step pans without opening it', !(await drawerOpen()));
  await page.click('#home'); await sleep(450);

  // drawer
  await page.click('.node:nth-of-type(7)'); await sleep(500);
  const d = await page.evaluate(() => ({ title: document.getElementById('dtitle').textContent, state: document.getElementById('dstate').textContent, auth: document.getElementById('dauth').textContent, tasks: document.getElementById('dtasks').children.length, step: document.getElementById('dstep').textContent, bar: document.getElementById('dbar').style.width }));
  check('clicking a step opens its details', await drawerOpen() && d.title === 'Human Review Gate' && d.state === 'OUTREACH_APPROVAL' && d.auth === 'Human Authority' && d.tasks === 3, d);
  check('details show the true position in the lifecycle', d.step === 'Step 7 of 18 · Acquisition' && d.bar.startsWith('38.8'), d);
  const covered = await page.evaluate(() => { const n = document.querySelector('.node.sel').getBoundingClientRect(), dr = document.getElementById('drawer').getBoundingClientRect(); return n.right > dr.left; });
  check('the opened step is not hidden behind the details panel', !covered);
  await sleep(200); // the zoom buttons slide clear of the panel
  const zoomHit = await page.evaluate(() => ['zoomOut', 'home', 'zoomIn'].every(id => { const e = document.getElementById(id), r = e.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === e; }));
  check('the zoom buttons stay clickable while the details panel is open', zoomHit);
  await shot(page, 'slicklab-drawer-1360');
  await page.click('#drawerClose'); await sleep(450);
  check('the × button closes the details panel', !(await drawerOpen()));
  await page.click('.node:nth-of-type(1)'); await sleep(200); await page.keyboard.press('Escape'); await sleep(450);
  check('Escape closes the details panel', !(await drawerOpen()));
  await page.click('#home'); await sleep(450);

  // filters
  await page.click('[data-filter="gate"]');
  check('Approval gates filter leaves the four gates', (await visible()).length === 4, await visible());
  await page.type('#search', 'audit');
  let st = await page.evaluate(() => ({ shown: document.querySelectorAll('.node:not(.hidden)').length, empty: !document.getElementById('empty').hidden, chip: document.querySelector('.chip.active').textContent }));
  check('search narrows inside the active filter and says when nothing matches', st.shown === 0 && st.empty && st.chip === 'Approval gates', st);
  await page.click('#clearFilters');
  st = await page.evaluate(() => ({ shown: document.querySelectorAll('.node:not(.hidden)').length, chip: document.querySelector('.chip.active').textContent, q: document.getElementById('search').value }));
  check('Clear filters restores every step and the All chip', st.shown === 18 && st.chip === 'All' && st.q === '', st);
  await page.type('#search', 'audit');
  check('search finds steps by their text', JSON.stringify(await visible()) === JSON.stringify(['Website Audit']), await visible());
  await page.evaluate(() => { const s = document.getElementById('search'); s.value = '430'; s.dispatchEvent(new Event('input')); });
  check('layout coordinates are not searchable', (await visible()).length === 0, await visible());
  await page.click('#clearFilters');
  await page.click('[data-phase="sales"]'); await sleep(450);
  check('Sales phase shows its two steps', JSON.stringify(await visible()) === JSON.stringify(['Sales Intelligence', 'Proposal & Agreement']), await visible());
  await page.click('[data-phase="sales"]'); await sleep(450);
  check('clicking the phase again shows every step', (await visible()).length === 18);
  await page.click('[data-nav="gates"]'); await sleep(450);
  check('sidebar Approval gates applies the gate filter', (await visible()).length === 4);
  await page.click('[data-nav="map"]'); await sleep(450);
  check('sidebar Orchestration map resets the view', (await visible()).length === 18 && await inView() === 18);
  const dead = await page.evaluate(() => [...document.querySelectorAll('.sidebar .nav')].filter(b => !b.disabled && !b.dataset.nav && !b.dataset.phase).length);
  check('no sidebar item is a dead control', dead === 0, dead);

  // palette
  await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control'); await sleep(120);
  check('Ctrl+K opens the command palette', await page.evaluate(() => document.getElementById('palette').classList.contains('open')));
  await page.keyboard.type('gates'); await page.keyboard.press('Enter'); await sleep(120);
  st = await page.evaluate(() => ({ open: document.getElementById('palette').classList.contains('open'), chip: document.querySelector('.chip.active').textContent }));
  check('typing a command and pressing Enter runs it', !st.open && st.chip === 'Approval gates', st);
  await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control'); await sleep(120);
  await page.keyboard.type('deploy'); await page.keyboard.press('Enter'); await sleep(500);
  st = await page.evaluate(() => ({ title: document.getElementById('dtitle').textContent, open: document.getElementById('drawer').classList.contains('open'), shown: document.querySelectorAll('.node:not(.hidden)').length }));
  check('the palette can jump to a step by name', st.open && st.title === 'Deployment' && st.shown === 18, st);
  await page.keyboard.press('Escape'); await sleep(300);

  // focus mode
  await page.click('#focusBtn'); await sleep(350);
  st = await page.evaluate(() => ({ on: document.body.classList.contains('focusmode'), sidebar: !!document.querySelector('.sidebar').offsetParent, label: document.getElementById('focusBtn').textContent }));
  check('Focus mode hides the sidebar', st.on && !st.sidebar && st.label === 'Exit focus', st);
  await page.click('#focusBtn'); await sleep(350);
  check('Focus mode switches off again', await page.evaluate(() => !document.body.classList.contains('focusmode') && !!document.querySelector('.sidebar').offsetParent));
  await page.click('#home'); await sleep(450);

  // keyboard
  await page.focus('.node:nth-of-type(3)'); await page.keyboard.press('Enter'); await sleep(450);
  check('a step can be opened from the keyboard', await page.evaluate(() => document.getElementById('dtitle').textContent === 'Enrichment' && document.getElementById('drawer').classList.contains('open')));
  await page.keyboard.press('Escape'); await sleep(300);
  check('all 18 steps are reachable with Tab', await page.evaluate(() => [...document.querySelectorAll('.node')].filter(n => n.tabIndex === 0).length) === 18);
  check('closed details panel is out of the tab order', await page.evaluate(() => document.getElementById('drawer').inert === true));

  // simulation
  const simStart = Date.now();
  await page.click('#simBtn'); await sleep(1700);
  // The map glides to each step, so wait for the glide to settle rather than sampling mid-move.
  const settled = () => { const n = document.querySelector('.node.active'); if (!n) return false; const r = n.getBoundingClientRect(), d = document.getElementById('drawer'), v = document.getElementById('viewport').getBoundingClientRect(); const right = d.classList.contains('open') ? d.getBoundingClientRect().left : v.right; return r.left >= v.left && r.right <= right && r.top >= v.top && r.bottom <= v.bottom; };
  const inViewDesktop = await page.waitForFunction(settled, { timeout: 2500 }).then(() => true, () => false);
  st = await page.evaluate(() => { const n = document.querySelector('.node.active'); if (!n) return { none: true }; return { label: document.getElementById('simBtn').textContent, title: document.getElementById('dtitle').textContent, name: n.querySelector('h2').textContent, active: document.querySelectorAll('.node.active').length }; });
  st.visible = inViewDesktop;
  check('simulation highlights one step, shows its details and keeps it in view', st.visible && st.active === 1 && st.title === st.name && st.label === '■ Stop', st);
  await shot(page, 'slicklab-simulate-1360');
  await sleep(Math.max(0, 18 * 800 + 1500 - (Date.now() - simStart)));
  st = await page.evaluate(() => ({ label: document.getElementById('simBtn').textContent, active: document.querySelectorAll('.node.active').length, title: document.getElementById('dtitle').textContent }));
  check('simulation reaches the last step and ends cleanly', st.label === '▶ Simulate flow' && st.active === 0 && st.title === 'Learning Loop', st);
  await page.click('#simBtn'); await sleep(1000); await page.click('#simBtn'); await sleep(200);
  st = await page.evaluate(() => ({ label: document.getElementById('simBtn').textContent, active: document.querySelectorAll('.node.active').length }));
  check('simulation can be stopped part-way', st.label === '▶ Simulate flow' && st.active === 0, st);

  check('reduced-motion rule is present', await page.evaluate(() => [...document.styleSheets].some(s => [...s.cssRules].some(r => r.media && /reduced-motion/.test(r.media.mediaText)))));
  check('every button has an accessible name', await page.evaluate(() => [...document.querySelectorAll('button')].filter(x => !x.textContent.trim() && !x.getAttribute('aria-label')).length) === 0);
  check('no script or console errors', log.errors.length === 0, log.errors);
  check('no requests leave the page', log.external.length === 0, log.external);
  await page.close();
}

// ======================= SlickLab TCC, phone =======================
console.log('SlickLab TCC · 390x800 touch');
{
  const { page, log } = await open(SLICK, 390, 800, { mobile: true });
  const tf = () => page.evaluate(() => document.getElementById('world').style.transform);
  await shot(page, 'slicklab-390');
  let st = await page.evaluate(() => {
    const v = document.getElementById('viewport').getBoundingClientRect(), n = document.querySelector('.node').getBoundingClientRect();
    const lg = document.querySelector('.legend').getBoundingClientRect(), ct = document.querySelector('.controls').getBoundingClientRect(), t = document.querySelector('.titlebox').getBoundingClientRect();
    return { overflow: document.documentElement.scrollWidth - innerWidth, firstInView: n.left >= v.left && n.right <= v.right && n.top >= t.bottom && n.bottom <= v.bottom, nodeWidth: Math.round(n.width), chips: !!document.querySelector('.chips').offsetParent, legendClash: lg.right > ct.left && lg.bottom > ct.top && lg.top < ct.bottom, sim: !!document.getElementById('simBtn').offsetParent };
  });
  check('phone: page does not scroll sideways', st.overflow <= 0, st.overflow);
  check('phone: the first step is in view at a readable size', st.firstInView && st.nodeWidth >= 120, st);
  check('phone: filter chips are available', st.chips);
  check('phone: legend does not sit on the zoom buttons', !st.legendClash, st);
  let a = await tf();
  const t1 = await page.touchscreen.touchStart(200, 620); await t1.move(150, 560); await t1.move(90, 500); await t1.end(); await sleep(120);
  let b = await tf();
  check('phone: one-finger drag pans the map', a !== b, { a, b });
  const scaleOf = s => +/scale\(([\d.]+)\)/.exec(s)[1];
  const f1 = await page.touchscreen.touchStart(150, 500), f2 = await page.touchscreen.touchStart(240, 500);
  await f1.move(110, 500); await f2.move(280, 500); await f1.move(70, 500); await f2.move(320, 500); await f1.end(); await f2.end(); await sleep(120);
  a = await tf();
  check('phone: pinch zooms the map', scaleOf(a) > scaleOf(b) * 1.3, { before: b, after: a });
  await page.click('#home'); await sleep(450);
  await page.tap('.node'); await sleep(500);
  check('phone: tapping a step opens its details', await page.evaluate(() => document.getElementById('drawer').classList.contains('open') && document.getElementById('dtitle').textContent === 'Market Intelligence'));
  await shot(page, 'slicklab-drawer-390');
  await page.tap('#drawerClose'); await sleep(450);
  check('phone: details panel closes', await page.evaluate(() => !document.getElementById('drawer').classList.contains('open')));
  await page.tap('#simBtn'); await sleep(1700);
  const inViewPhone = await page.waitForFunction(() => { const n = document.querySelector('.node.active'); if (!n) return false; const r = n.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }, { timeout: 2500 }).then(() => true, () => false);
  st = { drawer: await page.evaluate(() => document.getElementById('drawer').classList.contains('open')), visible: inViewPhone };
  check('phone: simulation keeps the active step in view without covering the map', st.visible && !st.drawer, st);
  await shot(page, 'slicklab-simulate-390');
  await page.tap('#simBtn');
  check('phone: no script or console errors', log.errors.length === 0, log.errors);
  await page.close();
}

// ======================= HyperNexus, desktop =======================
console.log('TCC HyperNexus · 1360x850');
{
  const ctx = browser.defaultBrowserContext();
  await ctx.overridePermissions(base.slice(0, -1), ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  const { page, log } = await open(HYPER, 1360, 850);
  const txt = id => page.evaluate(i => document.getElementById(i).textContent, id);
  const c = await page.evaluate(() => ({ nodes: document.querySelectorAll('.node').length, edges: document.querySelectorAll('path.edge').length, catalog: document.getElementById('catalogCount').textContent }));
  check('11 components and 15 links are drawn', c.nodes === 11 && c.edges === 15, c);
  check('catalog count is computed from the catalog', c.catalog === '20 options', c.catalog);
  check('background grid paints', (await page.evaluate(() => getComputedStyle(document.body, '::before').backgroundImage)).includes('linear-gradient'));
  const geo = await page.evaluate((geometryFn, sampleFn) => {
    const geometry = new Function('return ' + geometryFn)(), sample = new Function('return ' + sampleFn)();
    const g = document.getElementById('graph'), W = g.offsetWidth, H = g.offsetHeight, boxes = {};
    // components are positioned by their centre (translate -50%), so offsetLeft/Top is the centre point
    document.querySelectorAll('.node').forEach(e => { boxes[e.dataset.id] = { l: e.offsetLeft - e.offsetWidth / 2, r: e.offsetLeft + e.offsetWidth / 2, t: e.offsetTop - e.offsetHeight / 2, b: e.offsetTop + e.offsetHeight / 2 }; });
    const links = [...document.querySelectorAll('path.edge')].map(p => ({ from: p.dataset.from, to: p.dataset.to, pts: sample(p) }));
    const ids = Object.keys(boxes), overlap = [];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) { const a = boxes[ids[i]], b = boxes[ids[j]]; if (a.l < b.r + 8 && b.l < a.r + 8 && a.t < b.b + 8 && b.t < a.b + 8) overlap.push(ids[i] + '/' + ids[j]); }
    const inside = ids.filter(id => { const x = boxes[id]; return x.l < 0 || x.t < 0 || x.r > W || x.b > H; });
    return { ...geometry(boxes, links), overlap, outside: inside };
  }, geometry.toString(), sample.toString());
  check('every arrow ends on the border of its target component', geo.offBorder.length === 0, geo.offBorder);
  check('no link runs through another component', geo.through.length === 0, geo.through);
  check('no two components touch or overlap', geo.overlap.length === 0, geo.overlap);
  check('every component sits inside the map', geo.outside.length === 0, geo.outside);
  await shot(page, 'hyper-1360');

  await page.click('.node[data-id="hermes"]'); await sleep(350);
  check('clicking a component opens its contract', await page.evaluate(() => document.getElementById('drawer').classList.contains('open')) && await txt('dt') === 'HERMES — Execution Harness');
  await page.click('[data-action="closedrawer"]'); await sleep(350);
  check('✕ closes the contract panel', await page.evaluate(() => !document.getElementById('drawer').classList.contains('open')));
  await page.focus('.node[data-id="audit"]'); await page.keyboard.press('Enter'); await sleep(350);
  check('a component can be opened from the keyboard', await txt('dt') === 'AUDIT — Evidence Ledger');
  await page.keyboard.press('Escape'); await sleep(350);
  check('Escape closes the contract panel', await page.evaluate(() => !document.getElementById('drawer').classList.contains('open')));

  // views and search
  await page.click('.toolbar [data-view="catalog"]'); await sleep(100);
  check('Catalog view lists 20 connectors', await page.evaluate(() => document.querySelectorAll('.card').length) === 20);
  check('toolbar marks the active view', await page.evaluate(() => document.querySelector('.toolbar [data-view="catalog"]').classList.contains('on') && document.querySelector('.nav [data-view="catalog"]').classList.contains('on')));
  await page.keyboard.press('/');
  check('/ moves focus to search', await page.evaluate(() => document.activeElement.id === 'search'));
  await page.keyboard.type('vector');
  check('search filters the catalog', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.card h2')].map(x => x.textContent))) === JSON.stringify(['pgvector', 'Qdrant', 'Milvus']));
  await page.click('.toolbar [data-view="infrastructure"]'); await sleep(100);
  check('the same search filters the stack table', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('#infrastructure tbody tr')].filter(t => !t.hidden).map(t => t.cells[0].textContent))) === JSON.stringify(['KGH', 'Data']));
  await page.click('.toolbar [data-view="architecture"]'); await sleep(100);
  check('the same search dims the map', await page.evaluate(() => [...document.querySelectorAll('.node')].filter(n => n.style.opacity === '0.12').length) === 10);
  await page.evaluate(() => { const s = document.getElementById('search'); s.value = 'zzzz'; s.dispatchEvent(new Event('input')); });
  await page.click('.toolbar [data-view="infrastructure"]'); await sleep(100);
  check('stack table says when nothing matches', await page.evaluate(() => !document.getElementById('stackNone').hidden));
  await page.evaluate(() => { const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input')); });

  // SQL view
  await page.click('.toolbar [data-view="sqlview"]'); await sleep(100);
  check('SQL shown on the page is identical to sql/TCC_Integrated_Nexus_Schema.sql', await txt('sqlcode') === SQL_FILE);
  await page.bringToFront();
  await page.click('[data-action="copy"]'); await sleep(400);
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(e => 'ERR ' + e.message));
  check('Copy puts the full schema on the clipboard', clip === SQL_FILE, clip.slice(0, 80));
  const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-dl-'));
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
  await page.click('.sql [data-action="download"]'); await sleep(1500);
  const got = fs.readdirSync(dl);
  check('Download saves the same schema as a .sql file', got.length === 1 && got[0] === 'TCC_Integrated_Nexus_Schema.sql' && fs.readFileSync(path.join(dl, got[0]), 'utf8') === SQL_FILE, got);
  fs.rmSync(dl, { recursive: true, force: true });
  await shot(page, 'hyper-sql-1360');

  // governed flow and emergency stop
  await page.click('.actions [data-action="simulate"]'); await sleep(300);
  let st = await page.evaluate(() => ({ mode: document.getElementById('mode').textContent, running: document.getElementById('graph').classList.contains('running'), view: document.querySelector('.view.on').id }));
  check('Run Flow switches to the map in DRY RUN', st.mode === 'DRY RUN' && st.running && st.view === 'architecture', st);
  await shot(page, 'hyper-running-1360');
  await page.click('aside [data-action="emergency"]'); await sleep(200);
  st = await page.evaluate(() => ({ mode: document.getElementById('mode').textContent, write: document.getElementById('write').textContent, running: document.getElementById('graph').classList.contains('running'), label: document.querySelector('aside [data-action="emergency"]').textContent }));
  check('Emergency Stop halts the flow', st.mode === 'EMERGENCY STOP' && st.write === 'STOPPED' && !st.running && /Clear/.test(st.label), st);
  await sleep(6900);
  check('Emergency Stop stays engaged after the earlier flow timer', await txt('mode') === 'EMERGENCY STOP' && await txt('write') === 'STOPPED');
  await page.click('.actions [data-action="simulate"]'); await sleep(300);
  st = await page.evaluate(() => ({ mode: document.getElementById('mode').textContent, running: document.getElementById('graph').classList.contains('running'), toast: document.getElementById('toast').textContent }));
  check('no flow can start while Emergency Stop is engaged', st.mode === 'EMERGENCY STOP' && !st.running && /engaged/.test(st.toast), st);
  await shot(page, 'hyper-stopped-1360');
  await page.click('aside [data-action="emergency"]'); await sleep(200);
  check('clearing the stop returns to PREFLIGHT with writes disabled', await txt('mode') === 'PREFLIGHT' && await txt('write') === 'DISABLED');
  await page.click('.actions [data-action="simulate"]'); await sleep(300);
  check('flows run again after the stop is cleared', await txt('mode') === 'DRY RUN');
  await sleep(6600);
  check('a flow returns to PREFLIGHT when it ends', await txt('mode') === 'PREFLIGHT' && await page.evaluate(() => !document.getElementById('graph').classList.contains('running')));

  // zoom keeps everything reachable
  for (let i = 0; i < 4; i++) await page.click('[data-action="zoomin"]');
  st = await page.evaluate(() => { const c = document.getElementById('architecture'); c.scrollLeft = 0; const cl = c.getBoundingClientRect().left; const left = Math.min(...[...document.querySelectorAll('.node')].map(n => n.getBoundingClientRect().left)); c.scrollLeft = 1e6; const cr = c.getBoundingClientRect().right; const right = Math.max(...[...document.querySelectorAll('.node')].map(n => n.getBoundingClientRect().right)); return { zoom: getComputedStyle(document.documentElement).getPropertyValue('--zoom').trim(), leftOk: left >= cl - 1, rightOk: right <= cr + 1 }; });
  check('zoomed in, both edges of the map can still be scrolled into view', st.zoom === '1.4' && st.leftOk && st.rightOk, st);
  check('page does not scroll sideways', await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0);
  check('no script or console errors', log.errors.length === 0, log.errors);
  check('no requests leave the page', log.external.length === 0, log.external);
  await page.close();

  // clipboard refused: the page must cope instead of throwing
  const ctx2 = await browser.createBrowserContext();
  const p2 = await open(HYPER, 1200, 800, { context: ctx2 });
  await p2.page.click('.toolbar [data-view="sqlview"]');
  await p2.page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true }); });
  await p2.page.click('[data-action="copy"]'); await sleep(300);
  st = await p2.page.evaluate(() => ({ toast: document.getElementById('toast').textContent, selected: getSelection().toString().length }));
  check('when the browser refuses Copy, the SQL is selected and the user is told', /blocked/.test(st.toast) && st.selected > 5000 && p2.log.errors.length === 0, { ...st, errors: p2.log.errors });
  await ctx2.close();
}

// ======================= HyperNexus, narrow =======================
for (const [w, mobile] of [[1024, false], [390, true]]) {
  console.log(`TCC HyperNexus · ${w}x800`);
  const { page, log } = await open(HYPER, w, 800, { mobile });
  const st = await page.evaluate(() => {
    const c = document.getElementById('architecture').getBoundingClientRect();
    const seen = [...document.querySelectorAll('.node')].filter(n => { const b = n.getBoundingClientRect(); return b.left >= c.left && b.right <= c.right; }).map(n => n.dataset.id);
    return { overflow: document.documentElement.scrollWidth - innerWidth, stop: [...document.querySelectorAll('[data-action="emergency"]')].some(b => b.offsetParent), seen };
  });
  check(`${w}px: page does not scroll sideways`, st.overflow <= 0, st.overflow);
  check(`${w}px: Emergency Stop is reachable`, st.stop);
  check(`${w}px: the owner and core components are in view on load`, st.seen.includes('owner') && st.seen.includes('tcc') && st.seen.includes('hermes'), st.seen);
  await page.evaluate(() => document.getElementById('architecture').scrollIntoView({ behavior: 'instant' })); await sleep(150); // the page scrolls smoothly by default; a tap during that scroll would miss
  await shot(page, 'hyper-' + w);
  if (mobile) {
    await page.tap('.actions [data-action="emergency"]'); await sleep(200);
    check(`${w}px: Emergency Stop works from the header`, await page.evaluate(() => document.getElementById('mode').textContent) === 'EMERGENCY STOP');
  }
  check(`${w}px: no script or console errors`, log.errors.length === 0, log.errors);
  await page.close();
}

// ======================= JavaScript switched off =======================
console.log('no JavaScript');
for (const [f, name] of [[SLICK, 'SlickLab TCC'], [HYPER, 'HyperNexus']]) {
  const page = await browser.newPage();
  await page.setJavaScriptEnabled(false);
  await page.setViewport({ width: 1360, height: 850 });
  await page.goto(base + f, { waitUntil: 'load' });
  const said = await page.evaluate(() => { const n = document.querySelector('noscript'); if (!n) return false; const r = n.firstElementChild ? n.firstElementChild.getBoundingClientRect() : n.getBoundingClientRect(); return /JavaScript/.test(n.textContent) && r.width > 100 && r.top >= 0 && r.bottom <= innerHeight; });
  check(`${name}: with JavaScript off, the page says so instead of showing an empty map`, said);
  await page.close();
}

// ======================= every page at many screen sizes =======================
// Phones, tablets either side of each layout breakpoint, short laptops and a large monitor.
console.log('layout sweep');
{
  const sizes = [[320, 568], [390, 800], [768, 1024], [800, 600], [801, 600], [901, 700], [960, 600], [1024, 768], [1100, 700], [1280, 720], [1366, 650], [1920, 1000]];
  for (const [f, name] of [[SLICK, 'SlickLab TCC'], [HYPER, 'HyperNexus'], ['index.html', 'index']]) {
    const { page, log } = await open(f, 1360, 850);
    for (const [w, h] of sizes) {
      await page.setViewport({ width: w, height: h });
      await page.reload({ waitUntil: 'load' }); await sleep(350);
      const problems = await page.evaluate(() => {
        const out = [], q = s => document.querySelector(s);
        const rect = s => q(s) && q(s).offsetParent ? q(s).getBoundingClientRect() : null;
        const hit = (a, b) => a && b && a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
        const over = document.documentElement.scrollWidth - innerWidth;
        if (over > 0) out.push(`page scrolls sideways by ${over}px`);
        document.querySelectorAll('.stat b').forEach(e => { if (e.getBoundingClientRect().right > e.parentElement.getBoundingClientRect().right + 1) out.push(`"${e.textContent}" spills out of its card`); });
        document.querySelectorAll('.chip, .top-actions .btn, .actions .btn, .toolbar .btn').forEach(e => { if (e.offsetParent && e.getBoundingClientRect().height > 50) out.push(`"${e.textContent.trim()}" is stretched or wrapped`); });
        if (hit(rect('.legend'), rect('.controls'))) out.push('legend overlaps the zoom buttons');
        if (hit(rect('.titlebox'), rect('.chips'))) out.push('title overlaps the filter chips');
        if (hit(rect('.search'), rect('.top-actions'))) out.push('search overlaps the header buttons');
        if (q('#world')) { // the first view must be legible and must start with step 1 clear of the title
          const n = q('.node').getBoundingClientRect(), v = q('#viewport').getBoundingClientRect(), t = q('.titlebox').getBoundingClientRect();
          if (n.width < 100) out.push(`steps open only ${Math.round(n.width)}px wide`);
          if (!(n.left >= v.left && n.right <= v.right && n.top >= t.bottom && n.bottom <= v.bottom)) out.push('step 1 is not fully in view');
        }
        return out;
      });
      check(`${name} ${w}x${h}: nothing overflows, overlaps or opens too small to read`, problems.length === 0, problems);
    }
    check(`${name}: no script or console errors at any size`, log.errors.length === 0, log.errors);
    await page.close();
  }
}

// ======================= landing page =======================
console.log('index.html');
for (const [w, mobile] of [[1360, false], [390, true]]) {
  const { page, log } = await open('index.html', w, 800, { mobile });
  const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')));
  for (const href of links) { const r = await fetch(base + href); check(`index ${w}px: link ${href} resolves`, r.status === 200, r.status); }
  check(`index ${w}px: links to both maps and the schema view`, links.includes(SLICK) && links.includes(HYPER) && links.includes(HYPER + '#sql'), links);
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click(`a[href="${HYPER}#sql"]`)]); await sleep(300);
  check(`index ${w}px: the schema link opens the SQL view`, await page.evaluate(() => document.querySelector('.view.on').id === 'sqlview' && document.getElementById('sqlcode').textContent.length > 5000));
  check(`index ${w}px: page does not scroll sideways`, await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0);
  check(`index ${w}px: no script or console errors`, log.errors.length === 0 && log.external.length === 0, log);
  await shot(page, 'index-' + w);
  await page.close();
}

await browser.close();
server.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach(f => console.log(' - ' + f)); process.exit(1); }
