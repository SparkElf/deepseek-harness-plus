import { chromium } from 'playwright'
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'zh-CN' })
const bad = []
page.on('response', async r => { const u = r.url(); if (r.status() >= 400 && (u.includes('/api/') || u.includes('task') || u.includes('dsh'))) { let t=''; try { t = (await r.text()).slice(0,150) } catch {} ; bad.push(r.status()+' '+r.request().method()+' '+u.slice(0,110)+' :: '+t) } })
page.on('console', m => { if (m.type()==='error') bad.push('console: '+m.text().slice(0,140)) })
await page.goto('http://127.0.0.1:3000/?test=true', { waitUntil:'domcontentloaded', timeout:90000 })
await page.waitForTimeout(8000)
await page.locator('input').nth(0).fill('admin', { force:true })
await page.locator('input[type=password]').fill('DataOps!2026', { force:true })
await page.getByRole('button', { name:'进入工作台', exact:true }).click({ force:true })
await page.waitForTimeout(6000)
await page.goto('http://127.0.0.1:3000/ai/dsh', { waitUntil:'domcontentloaded', timeout:90000 })
let dsh=null
for (let i=0;i<10;i++){ await page.waitForTimeout(6000); dsh = page.frames().find(f=>f!==page.mainFrame() && /dsh|32000/.test(f.url())); if (dsh && (await dsh.evaluate(()=>document.querySelectorAll('nav button').length))>0) break }
await dsh.getByLabel('任务中心').first().click({ timeout:8000 }).catch(async()=>{ await dsh.getByText('任务中心').first().click({timeout:8000}) })
await page.waitForTimeout(6000)
try { await dsh.getByText('详情', { exact:true }).first().click({ timeout:6000 }); await page.waitForTimeout(9000) } catch(e) { console.log('detail click failed') }
const body = await dsh.evaluate(()=>document.body.innerText.slice(0,400).replace(/\n/g,' | '))
console.log('BODY:', body)
console.log('FAILS:\n' + (bad.slice(0,8).join('\n') || 'none'))
await page.screenshot({ path:'/root/projects/dsh-ui-shots/task-form-fail.png' })
await browser.close()
