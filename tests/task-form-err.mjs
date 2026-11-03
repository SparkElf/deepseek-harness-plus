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
await f.getByLabel('任务中心').first().click({timeout:8000}).catch(()=>{})
await p.waitForTimeout(5000)
try { await f.getByText('详情',{exact:true}).first().click({timeout:6000}) } catch(e){ console.log('no detail btn') }
await p.waitForTimeout(14000)
const t = await f.evaluate(()=>document.body.innerText)
const m = t.match(/流程服务[^\n]{0,20}|加载失败[^\n]{0,30}|超时[^\n]{0,20}|重试/g)
console.log('ERRTEXT:', JSON.stringify(m))
await p.screenshot({path:'/root/projects/dsh-ui-shots/task-form-error.png'})
await b.close()
