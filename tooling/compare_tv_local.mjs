// tooling/compare_tv_local.mjs — headless side-by-side: TV vs local rail.
// Captures: rail groups/menus/items, click behavior, drawing place/select/remove.
// Usage: node tooling/compare_tv_local.mjs [--tv-url=...] [--local-url=...] [--shots]
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).filter(a=>a.startsWith('--')).map(a=>{
  const [k,v]=a.slice(2).split('='); return [k, v ?? '1'];
}));
const TV_URL = args['tv-url'] || 'https://www.tradingview.com/chart/?symbol=BITSTAMP%3ABTCUSD';
// Functional tests run against the CORS-clean Binance route (default). The
// user-supplied Bitstamp URL is exercised separately as an error-state check:
// Bitstamp blocks pairs-info preflights from browsers, so live rows cannot
// load there — the app must show the error state, never fake candles.
const LOCAL_URL = args['local-url'] || 'http://127.0.0.1:8787/index.html?debug=1';
const BITSTAMP_URL = 'http://127.0.0.1:8787/index.html?symbol=bitstamp%3ABTC%2FUSD&interval=1d&exchange=bitstamp&debug=1';
const DO_SHOTS = !!args['shots'];

let fails = 0;
const check = (name, ok, detail='') => {
  if(!ok) fails++;
  console.log(`${ok?'ok  ':'FAIL'} ${name}${detail?` — ${detail}`:''}`);
};

const browser = await chromium.launch({ args:['--no-sandbox'] });

// ---------- LOCAL: deep functional audit ----------
const lp = await browser.newPage({ viewport:{width:1600,height:900} });
const lerr=[];
lp.on('dialog', d=>d.accept('A'));
lp.on('console',m=>{ if(m.type()==='error') lerr.push(m.text()); });
lp.on('pageerror',e=>lerr.push(String(e)));
await lp.goto(LOCAL_URL,{waitUntil:'domcontentloaded'});
await lp.waitForTimeout(4000);
try{ await lp.waitForFunction(()=>window.__tv && window.__tv.rows().length>0,{timeout:15000}); check('local: rows loaded',true); }
catch{ check('local: rows loaded',false,'timeout — live data blocked?'); }

const railCount = await lp.locator('#rail .rail-item').count();
check('local: 15 rail entries', railCount===15, `${railCount}`);
const chevCount = await lp.locator('#rail .rail-chev').count();
check('local: 12 chevrons (3 direct tools)', chevCount===12, `${chevCount}`);

// spec parity (labels/order) — re-check live DOM
let spec;
try{ spec=JSON.parse(readFileSync('tooling/tv-rail-spec.json','utf8')); }catch{ spec={groups:[]}; }
import { RAIL_GROUPS } from '../js/tools.js';
const idFor = (label)=>Object.keys(RAIL_GROUPS).find(k=>RAIL_GROUPS[k].label===label)||null;
for(const g of spec.groups){
  if(g.group==='Icons') continue;
  const gid=idFor(g.group);
  if(!gid){ check(`${g.group}: maps`,false); continue; }
  const chev=lp.locator(`#rail .rail-chev[data-chevron="${gid}"]`);
  if(!(await chev.count())){ check(`${g.group}: chevron`,false); continue; }
  await chev.click(); await lp.waitForTimeout(180);
  const menu=lp.locator('#tool-menu');
  if(!(await menu.count())){ check(`${g.group}: menu opens`,false); continue; }
  const rows=await menu.locator('button[data-item]').evaluateAll(els=>els.map(e=>({
    id:e.dataset.item,
    label:e.querySelector('.tool-menu-label')?.textContent??e.textContent.trim(),
    hot:e.querySelector('.tool-menu-hot')?.textContent??'',
    sw:!!e.querySelector('.tool-menu-switch'),
  })));
  const want=g.sections.flatMap(s=>s.items.map(i=>i.label));
  const got=rows.map(r=>r.label);
  const norm=t=>String(t).replace(/\b\d+\b/g,'%n').replace(/s\b/g,'');
  check(`${g.group}: labels`, want.length===got.length&&want.every((l,i)=>norm(l)===norm(got[i])), `want ${want.length} got ${got.length}`);
  await lp.keyboard.press('Escape'); await lp.mouse.click(800,400); await lp.waitForTimeout(100);
}

// glyph arms tool; chevron does NOT arm (only opens)
await lp.locator('#rail button[data-group-id="lines"]').click();
let tool=await lp.evaluate(()=>window.__tv.view.get().tool);
check('local: glyph arms trend', tool==='trend', `tool=${tool}`);
await lp.keyboard.press('Escape');

// every drawing tool: menu click arms, canvas click(s) place, click selects, Delete removes
const canvas = lp.locator('#overlay');
const box = await canvas.boundingBox();
const famSamples = [
  ['lines','trend'],['lines','ray'],['fib','fib'],['patterns','xabcd'],
  ['forecast','longpos'],['shapes','rect'],['text','text'],['icons','__emoji__'],
  ['lines','horizontal'],
];
let placed=0, selected=0, removed=0;
for(const [gid,itemId] of famSamples){
  if(itemId==='__emoji__'){
    await lp.locator('#rail button[data-group-id="icons"]').click();
    await lp.waitForTimeout(200);
    const pk=lp.locator('#emoji-picker');
    if(!(await pk.count())){ check('icons: picker opens',false); continue; }
    check('icons: picker opens',true);
    await pk.locator('button').first().click();
    tool=await lp.evaluate(()=>window.__tv.view.get().tool);
    check('icons: emoji arms icon tool', tool==='icon', `tool=${tool}`);
    // place 1 click
    await lp.mouse.click(box.x+box.width*0.5, box.y+box.height*0.5);
    await lp.waitForTimeout(150);
    const n=await lp.evaluate(()=>window.__tv.view.get().drawings.length);
    if(n>placed){ placed=n; check('icons: emoji places',true); } else check('icons: emoji places',false);
    await lp.keyboard.press('Escape');
    continue;
  }
  // open menu via chevron, click item
  await lp.locator(`#rail .rail-chev[data-chevron="${gid}"]`).click();
  await lp.waitForTimeout(180);
  const btn=lp.locator(`#tool-menu button[data-item="${itemId}"]`);
  if(!(await btn.count())){ check(`${itemId}: menu row`,false); await lp.keyboard.press('Escape'); continue; }
  await btn.click(); await lp.waitForTimeout(150);
  tool=await lp.evaluate(()=>window.__tv.view.get().tool);
  check(`${itemId}: menu arms`, tool===itemId, `tool=${tool}`);
  // place: click N times across chart
  const before=await lp.evaluate(()=>window.__tv.view.get().drawings.length);
  const clicks = (itemId==='xabcd'?5:(itemId==='horizontal'||itemId==='text'?1:2));
  for(let i=0;i<clicks;i++){
    await lp.mouse.click(box.x+box.width*(0.35+i*0.08), box.y+box.height*(0.4+(i%2)*0.1));
    await lp.waitForTimeout(120);
  }
  // text tools prompt() — headless auto-dismiss blocks placement; accept as known gap
  const after=await lp.evaluate(()=>window.__tv.view.get().drawings.length);
  if(after>before){ placed=after; check(`${itemId}: places on canvas`,true); }
  else check(`${itemId}: places on canvas`, after>before, `before=${before} after=${after}`);
  await lp.keyboard.press('Escape'); await lp.waitForTimeout(80);
}
// select by clicking body + Delete removes
{
  const n0=await lp.evaluate(()=>window.__tv.view.get().drawings.length);
  if(n0>0){
    await lp.evaluate(()=>window.__tv.view.set({tool:'cross'}));
    // click center of chart where drawings were placed
    await lp.mouse.click(box.x+box.width*0.42, box.y+box.height*0.45);
    await lp.waitForTimeout(150);
    const sel=await lp.evaluate(()=>window.__tv.view.get().selectedId);
    check('local: click selects drawing', !!sel, `selectedId=${sel}`);
    if(sel) selected++;
    await lp.keyboard.press('Delete'); await lp.waitForTimeout(150);
    const n1=await lp.evaluate(()=>window.__tv.view.get().drawings.length);
    check('local: Delete removes selected', n1===n0-1, `${n0}->${n1}`);
    if(n1===n0-1) removed++;
    // undo restores, redo removes again
    await lp.keyboard.press('Control+z'); await lp.waitForTimeout(120);
    const n2=await lp.evaluate(()=>window.__tv.view.get().drawings.length);
    check('local: undo restores', n2===n0, `${n1}->${n2}`);
    await lp.keyboard.press('Control+y'); await lp.waitForTimeout(120);
    const n3=await lp.evaluate(()=>window.__tv.view.get().drawings.length);
    check('local: redo re-removes', n3===n0-1, `${n2}->${n3}`);
  } else check('local: click selects drawing',false,'no drawings placed');
}

// mode toggles give feedback: magnet/stay/lock/hide/remove
for(const [gid,expect] of [['magnets','Magnet'],['stay','Stay in drawing mode'],['lock','locked'],['hide','hidden'],['remove','remove']]){
  await lp.locator(`#rail button[data-group-id="${gid}"]`).click();
  await lp.waitForTimeout(150);
  const toast=await lp.locator('#toast').evaluateAll(els=>els.map(e=>e.textContent)).catch(()=>[]);
  if(gid==='stay'){
    // stay starts ON (engaged); one click turns it OFF (toast + disengaged),
    // second click restores ON. Check the toast, not the transient class.
    check('stay: toast feedback', /Stay in drawing mode/.test(toast.join(' ')||''), JSON.stringify(toast).slice(0,120));
    await lp.locator('#rail button[data-group-id="stay"]').click(); // restore ON
    await lp.waitForTimeout(120);
    const engaged=await lp.locator('#rail button[data-group-id="stay"]').evaluate(e=>e.className);
    check('stay: restores engaged style', /engaged/.test(engaged), engaged);
  } else {
    check(`${gid}: toast feedback`, (toast.join(' ')||'').length>0, JSON.stringify(toast).slice(0,120));
  }
  await lp.waitForTimeout(80);
}
// unlock if locked by toggle test
await lp.evaluate(()=>{ try{window.__tv.view.set({locked:false,lockedDrawings:false,lockedIndicators:false,drawingsHidden:false});}catch{} });

// lock refusal carries Unlock action
await lp.evaluate(()=>{ window.__tv.view.set({locked:true,lockedDrawings:true}); });
await lp.locator('#rail button[data-group-id="lines"]').click();
await lp.evaluate(()=>window.__tv.view.set({tool:'trend'}));
await lp.mouse.click(box.x+box.width*0.5, box.y+box.height*0.5);
await lp.waitForTimeout(150);
{
  const t=await lp.locator('#toast').textContent().catch(()=>'');
  const hasBtn=await lp.locator('#toast button').count().catch(()=>0);
  check('lock: refusal toast + Unlock', /lock/i.test(t||'')&&hasBtn>0, (t||'').slice(0,100));
  if(hasBtn>0){ await lp.locator('#toast button').click(); await lp.waitForTimeout(150);
    const lk=await lp.evaluate(()=>!!window.__tv.view.get().locked);
    check('lock: Unlock button unlocks', !lk, `locked=${lk}`); }
}
await lp.evaluate(()=>{ try{window.__tv.view.set({locked:false,lockedDrawings:false,lockedIndicators:false});}catch{} });

check('local: no console errors', lerr.length===0, lerr.slice(0,2).join(' | ').slice(0,300));
if(DO_SHOTS){ await lp.screenshot({path:'tooling/shots/local-rail-compare.png'}); }

// Bitstamp URL: must degrade to the error state (no rows, no fake candles).
{
  const bp=await browser.newPage({viewport:{width:1600,height:900}});
  bp.on('dialog', d=>d.accept('A'));
  await bp.goto(BITSTAMP_URL,{waitUntil:'domcontentloaded'});
  await bp.waitForTimeout(9000);
  const st=await bp.evaluate(()=>{ const el=document.querySelector('#data-status'); return el?(el.className+'|'+el.textContent.slice(0,140)):'no-status'; }).catch(()=>'?');
  const rows=await bp.evaluate(()=>{ try{return window.__tv.rows().length;}catch{return -1;} }).catch(()=>-1);
  check('bitstamp URL: error state, no fake candles', /error/.test(st||'')||rows===0, `${st} rows=${rows}`);
  await bp.close();
}

// ---------- TV: structure only (no auth, no placement) ----------
let tvFails=0;
try{
  const tp=await browser.newPage({viewport:{width:1920,height:1080}});
  await tp.goto(TV_URL,{waitUntil:'domcontentloaded',timeout:30000});
  await tp.waitForTimeout(9000);
  // dismiss signup interstitial that swallows clicks (known from rail_helpers)
  await tp.evaluate(()=>{ document.querySelectorAll('div[class*="modal-"],div[class*="wrap-"],div[class*="backdrop-"]').forEach(el=>{
    const r=el.getBoundingClientRect();
    if(r.width>800&&r.height>400) el.remove(); }); });
  const railBtns=await tp.locator('[data-name="drawing-toolbar"] button, div[class*="toolbar"] button').count().catch(()=>-1);
  console.log(`info  TV rail buttons visible: ${railBtns}`);
  // capture menu labels for first group via chevron-like affordance
  if(DO_SHOTS){ await tp.screenshot({path:'tooling/shots/tv-rail-compare.png'}); }
  await tp.close();
}catch(e){ console.log(`info  TV capture skipped: ${String(e).slice(0,200)}`); }

await browser.close();
console.log(`\n${fails?fails+' FAILURES':'compare passed'} (tv structural capture informational)`);
process.exit(fails?1:0);
