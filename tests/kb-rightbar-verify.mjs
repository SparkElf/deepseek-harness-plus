import { chromium } from 'playwright'
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'zh-CN' })
await page.goto('http://127.0.0.1:3000/?test=true', { waitUntil:'domcontentloaded', timeout:90000 })
await page.waitForTimeout(8000)
await page.locator('input').nth(0).fill('admin', { force:true })
await page.locator('input[type=password]').fill('DataOps!2026', { force:true })
await page.getByRole('button', { name:'进入工作台', exact:true }).click({ force:true })
await page.waitForTimeout(6000)
await page.goto('http://127.0.0.1:3000/ai/dsh', { waitUntil:'domcontentloaded', timeout:90000 })
let dsh=null
for (let i=0;i<10;i++){ await page.waitForTimeout(6000); dsh=page.frames().find(f=>f!==page.mainFrame()&&/dsh|32000/.test(f.url())); if(dsh&&(await dsh.evaluate(()=>document.querySelectorAll('nav button').length))>0) break }
await dsh.getByText('知识库', { exact:true }).first().click({ timeout:9000 })
await page.waitForTimeout(8000)
const rows = await dsh.evaluate(() => [...document.querySelectorAll('[class*=explorerRow],[role=treeitem]')].map(e=>(e.textContent||'').trim().slice(0,30)).slice(0,10))
const clicked = await dsh.evaluate(() => {
  const r = [...document.querySelectorAll('[class*=explorerRow],[role=treeitem]')].find(e=>/\.md|\.docx/.test(e.textContent||''))
  if (!r) return 'no-file'
  r.click(); return (r.textContent||'').trim().slice(0,30)
})
await page.waitForTimeout(6000)
const after = await dsh.evaluate(() => {
  const txt = document.body.innerText
  const panes = [...document.querySelectorAll('[class*=session],[class*=rightbar],[class*=pane]')].map(e=>({c:String(e.className).slice(0,36),w:Math.round(e.getBoundingClientRect().width)})).filter(p=>p.w>0).slice(0,6)
  return { placeholder: /已在右侧|文件窗口中打开/.test(txt), bodyHead: txt.slice(0,180).replace(/\n/g,' | '), panes }
})
console.log(JSON.stringify({ rows, clicked, after }, null, 1))
await page.screenshot({ path:'/root/projects/dsh-ui-shots/kb-rightbar-after.png' })
await browser.close()
