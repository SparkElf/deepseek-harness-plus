import { chromium } from 'playwright'
const b = await chromium.launch({ executablePath:'/usr/bin/google-chrome', headless:true, args:['--no-sandbox'] })
const p = await b.newPage({ viewport:{width:1680,height:1000}, locale:'zh-CN' })
await p.goto('http://127.0.0.1:3000/?test=true',{waitUntil:'domcontentloaded',timeout:90000})
await p.waitForTimeout(8000)
await p.locator('input').nth(0).fill('admin',{force:true})
await p.locator('input[type=password]').fill('DataOps!2026',{force:true})
await p.getByRole('button',{name:'进入工作台',exact:true}).click({force:true})
await p.waitForTimeout(6000)
await p.goto('http://127.0.0.1:3000/ai/dsh',{waitUntil:'domcontentloaded',timeout:90000})
let f=null
for(let i=0;i<10;i++){await p.waitForTimeout(6000);f=p.frames().find(x=>x!==p.mainFrame()&&/dsh|32000/.test(x.url()));if(f&&(await f.evaluate(()=>document.querySelectorAll('nav button').length))>0)break}
// 打开右侧栏
const openBtn = f.locator('[aria-label*="sidebar" i], [aria-label*="右"]').first()
const btns = await f.evaluate(()=>[...document.querySelectorAll('button')].map(e=>e.getAttribute('aria-label')||'').filter(Boolean).slice(0,30))
console.log('BUTTONS:', JSON.stringify(btns))
await p.screenshot({ path:'/root/projects/dsh-ui-shots/resources-tab-probe.png' })
await b.close()
