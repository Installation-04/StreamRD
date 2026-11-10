const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');
(async()=>{
 const report={journeys:[],screenshots:[],pageErrors:[]};
 const directory=process.env.QA_ARTIFACT_DIR;
 assert.ok(directory&&path.isAbsolute(directory));fs.mkdirSync(directory,{recursive:true});
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{}),args:['--no-sandbox']});
 try{
 for(const [product,port] of [['streamrd',process.env.QA_SINGLE_STREAMRD_PORT],['phosphor',process.env.QA_SINGLE_PHOSPHOR_PORT]]){
  assert.match(port,/^\d+$/);const base=`http://127.0.0.1:${port}`;
  const context=await browser.newContext({viewport:{width:1440,height:1050},reducedMotion:'reduce'});const page=await context.newPage();
  page.on('pageerror',error=>report.pageErrors.push({product,message:error.message}));
  const requests=[];page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/'))requests.push(request.url());});
  await page.goto(base+'/admin/request-settings',{waitUntil:'networkidle'});
  await page.waitForURL(url=>url.pathname==='/login');assert.equal(new URL(page.url()).origin,base);
  await page.getByLabel('Email',{exact:true}).fill('single-container@example.invalid');await page.getByLabel('Password',{exact:true}).fill('single-container-fixture123');
  await page.getByRole('button',{name:product==='streamrd'?/sign in/i:/connect/i}).click();await page.waitForURL(url=>!url.pathname.endsWith('/login'));
  const sessionCookie=(await context.cookies()).find(cookie=>cookie.name===(product==='streamrd'?'sr_token':'ph_token'));
  assert.ok(sessionCookie&&sessionCookie.httpOnly&&sessionCookie.sameSite==='Lax','The session must live in an HttpOnly, SameSite=Lax cookie');
  assert.ok(!(await page.evaluate(()=>document.cookie)).includes('_token='),'Page scripts must not be able to read the session token');
  assert.ok(!(await page.evaluate(()=>JSON.stringify([localStorage,sessionStorage]))).includes(sessionCookie.value),'The token must not be in web storage');
  await page.goto(base+'/admin/request-settings',{waitUntil:'networkidle'});
  await page.getByRole('heading',{name:'Download settings.',exact:true}).waitFor();
  await page.getByRole('button',{name:'Test saved qBittorrent connection',exact:true}).click();
  await page.getByRole('status').filter({hasText:'responded successfully'}).waitFor();
  for(const mobile of [false,true]){
   if(mobile)await page.setViewportSize({width:390,height:844});
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   const file=`${product}-single-container${mobile?'-mobile':''}.png`;await page.screenshot({path:path.join(directory,file),fullPage:!mobile,animations:'disabled'});report.screenshots.push(file);
  }
  assert.ok(requests.length>2);assert.ok(requests.every(url=>new URL(url).origin===base),'Browser APIs must use the same origin without extra API ports');
  await page.setViewportSize({width:1440,height:1050});
  await page.goto(base+'/account/'+(product==='streamrd'?'settings':'profile'),{waitUntil:'networkidle'});
  await page.getByRole('button',{name:/sign out|log out|disconnect/i}).first().click();await page.waitForURL(url=>url.pathname==='/login'||url.pathname==='/');
  assert.equal(((await context.cookies()).find(cookie=>cookie.name===(product==='streamrd'?'sr_token':'ph_token'))||{}).value||'', '', 'Signing out must clear the HttpOnly cookie');
  report.journeys.push(`${product}: actual bundled UI login with an HttpOnly cookie session and sign-out, same-origin API requests, real bundled qBittorrent connection and responsive settings`);
  await context.close();
 }
 assert.deepEqual(report.pageErrors,[]);fs.writeFileSync(path.join(directory,'validation.json'),JSON.stringify(report,null,2)+'\n');
 console.log('Both single-container browser journeys passed; four screenshots; no page errors.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
