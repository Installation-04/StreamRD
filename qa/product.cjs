const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');
const automaticLibraries=require('./automatic-libraries.cjs');
const serverSharing=require('./server-sharing.cjs');
const maintenance=require('./maintenance.cjs');
const mediaRequests=require('./media-requests.cjs');
if(process.env.QA_DISPOSABLE_FIXTURES!=='1')throw Error('Use infra/run-browser-qa.sh: tests require fresh disposable services.');
const products=(process.env.QA_PRODUCT==='both'?['streamrd','phosphor']:[process.env.QA_PRODUCT]);
if(products.some(p=>!['streamrd','phosphor'].includes(p)))throw Error('Invalid QA product');
const output=process.env.QA_ARTIFACT_DIR; if(!output||!path.isAbsolute(output))throw Error('Set an absolute artifact directory');
fs.mkdirSync(output,{recursive:true});
const report={journeys:[],pageErrors:[],screenshots:[]};
const credentials={email:'community-demo@example.invalid',password:'community-fixture-password123',displayName:'Alex Morgan'};
async function call(port,route,data,token,method){const res=await fetch(`http://127.0.0.1:${port}${route}`,{method:method||(data?'POST':'GET'),headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(data?{body:JSON.stringify(data)}:{})});const body=await res.json();assert.ok(res.ok,`${route}: ${res.status} ${body.error||''}`);return body;}
(async()=>{
 let activePage;
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{}),args:['--no-sandbox']});
 try {
 for(const product of products){
  const sr=product==='streamrd',api=sr?47821:61337,web=sr?3000:3100,url=`http://localhost:${web}`;
  const admin=await call(api,'/api/auth/signup',credentials);
  const member=await call(api,'/api/auth/signup',{...credentials,email:'member@example.invalid',displayName:'Community member'});
  if(!sr) await call(api,'/api/admin/indexers',{name:'Local demo fixture',baseUrl:'http://127.0.0.1:9191/api',apiKey:'fixture-only'},admin.token);
  const setup=await call(api,'/api/account/setup',null,member.token);assert.equal(setup.connectionVerified,false);assert.ok(setup.checks.every(c=>!c.href?.startsWith('/admin')));
  const context=await browser.newContext({viewport:{width:1440,height:1050},colorScheme:'dark',reducedMotion:'reduce'}),page=await context.newPage();
  activePage=page;
  page.on('pageerror',error=>report.pageErrors.push({product,message:error.message}));
  const shot=async name=>{await page.evaluate(()=>{window.scrollTo(0,0);return document.fonts.ready;});await page.screenshot({path:path.join(output,`${product}-${name}.png`),fullPage:!name.endsWith('mobile')&&!name.startsWith('discover'),animations:'disabled'});report.screenshots.push(`${product}-${name}.png`);};
  async function noOverflow(label){const size=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,viewport:innerWidth}));assert.ok(size.scroll<=size.viewport+1,`${product} ${label} horizontal overflow: ${JSON.stringify(size)}`);}
  await page.goto(`${url}/login`,{waitUntil:'networkidle'});
  await page.getByLabel('Email',{exact:true}).fill(credentials.email);await page.getByLabel('Password',{exact:true}).fill(credentials.password);
  await page.getByRole('button',{name:sr?/sign in/i:/connect/i}).click();await page.waitForURL(u=>!u.pathname.includes('/login'));await page.waitForLoadState('networkidle');
  report.journeys.push(`${product}: actual UI login`);
  assert.equal((await call(api,'/api/health')).version,require('../server/package.json').version);
  const readiness=await call(api,'/api/admin/system',null,admin.token);assert.equal(readiness.migrations.state,'current');assert.equal(readiness.migrations.pending.length,0);assert.equal(readiness.upgrade.backupPolicy,'verified-before-changes');
  await page.goto(`${url}/admin/system`,{waitUntil:'networkidle'});await page.getByRole('heading',{name:'System & upgrades',exact:true}).waitFor();await page.getByRole('region',{name:'Upgrade readiness'}).waitFor();await noOverflow('desktop system');await shot('system');
  await page.setViewportSize({width:390,height:844});await noOverflow('mobile system');await shot('system-mobile');await page.setViewportSize({width:1440,height:1050});
  // Screenshots above use the real managed database. Exercise failure presentation
  // separately so stale checks and unavailable storage cannot appear healthy.
  const statusPattern='**/api/admin/system',systemAlert=page.getByRole('alert').filter({hasText:'System check needs attention'});
  await page.route(statusPattern,route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'fixture service unavailable'})}));
  await page.getByRole('button',{name:'Refresh status',exact:true}).click();await systemAlert.waitFor();await page.getByText('LAST SUCCESSFUL SNAPSHOT',{exact:true}).waitFor();
  await page.unroute(statusPattern);
  await page.getByRole('button',{name:'Try again',exact:true}).click();await page.getByText('Database upgrades are current.',{exact:true}).waitFor();assert.equal(await systemAlert.count(),0);
  await page.route(statusPattern,route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...readiness,database:{status:'down'},migrations:{...readiness.migrations,state:'unavailable'}})}));
  await page.getByRole('button',{name:'Refresh status',exact:true}).click();await page.getByText('The database is unavailable.',{exact:true}).waitFor();await page.getByText('Not verified',{exact:true}).waitFor();
  await page.unroute(statusPattern);await page.getByRole('button',{name:'Refresh status',exact:true}).click();await page.getByText('Database upgrades are current.',{exact:true}).waitFor();
  report.journeys.push(`${product}: real migration readiness desktop/mobile and simulated failure recovery`);
  await page.goto(`${url}/setup`,{waitUntil:'networkidle'});await page.getByRole('heading',{name:'Make yourself at home.'}).waitFor();await page.getByRole('progressbar',{name:'Essentials configured'}).waitFor();await noOverflow('desktop setup');await shot('setup');report.journeys.push(`${product}: private configuration checklist`);
  await page.setViewportSize({width:390,height:844});await noOverflow('mobile setup');await shot('setup-mobile');
  await page.goto(`${url}/admin/library`,{waitUntil:'networkidle'});await page.getByRole('checkbox',{name:'Select Big.Buck.Bunny.2008.mp4',exact:true}).waitFor();await noOverflow('mobile library');await shot('library-mobile');
  await page.setViewportSize({width:1440,height:1050});
  await page.getByRole('checkbox',{name:'Select Big.Buck.Bunny.2008.mp4',exact:true}).check();await page.getByRole('checkbox',{name:'Select Example.Show.S01E02.mkv',exact:true}).check();
  const movie=page.getByRole('group',{name:'Review Big Buck Bunny',exact:true}),episode=page.getByRole('group',{name:'Review Example Show',exact:true});
  assert.equal(await movie.getByLabel('Movie or series name',{exact:true}).inputValue(),'Big Buck Bunny');assert.equal(await episode.getByLabel('Episode',{exact:true}).inputValue(),'2');
  await page.getByRole('button',{name:/^Export 2 files/}).click();await page.getByRole('status').filter({hasText:'2 files exported'}).waitFor();
  let exported=await call(api,'/api/admin/library',null,admin.token);assert.equal(exported.entries.length,2);assert.ok(exported.entries.every(e=>e.linked&&e.sourceAvailable));
  await page.getByRole('button',{name:'Check & repair links',exact:true}).click();await page.getByRole('status').filter({hasText:'0 need attention'}).waitFor();await noOverflow('desktop library');await shot('library');
  const search=page.getByRole('searchbox',{name:'Search exported files'});await search.fill('Example Show');assert.equal(await page.getByRole('button',{name:'Remove export for Big Buck Bunny',exact:true}).count(),0);await search.fill('');
  report.journeys.push(`${product}: mount browsing, reviewed movie/episode batch, real link status, repair and export search`);
  await page.getByRole('button',{name:'Remove export for Example Show',exact:true}).click();await page.getByRole('button',{name:'Remove export',exact:true}).click();await page.getByRole('status').filter({hasText:'Source media was kept'}).waitFor();assert.equal((await call(api,'/api/admin/library',null,admin.token)).entries.length,1);
  report.journeys.push(`${product}: explicit link removal`);
  // Media server onboarding: tokens are saved (encrypted) from the page; launching needs the helper, which is not installed here.
  await page.getByRole('region',{name:'Media servers',exact:true}).waitFor();await page.getByText('One quick step, once.', { exact: true }).waitFor();
  const plexCard=page.getByRole('article',{name:'Plex media server'});
  await plexCard.getByLabel('Plex token',{exact:false}).fill('qa-plex-token-9876');await plexCard.getByLabel('Plex port',{exact:false}).fill('32410');await plexCard.getByRole('button',{name:'Save settings',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Plex settings saved.'}).waitFor();
  const mediaServers=await call(api,'/api/admin/media-servers',null,admin.token);assert.equal(mediaServers.servers.plex.port,32410);assert.equal(mediaServers.servers.plex.secretHint,'****9876');assert.equal(mediaServers.manager.available,false);assert.ok(!JSON.stringify(mediaServers).includes('qa-plex-token'));
  assert.equal(await plexCard.getByRole('button',{name:'Launch Plex',exact:true}).isDisabled(),true);
  assert.equal((await fetch(`http://127.0.0.1:${api}/api/admin/media-servers`,{headers:{Authorization:`Bearer ${member.token}`}})).status,403);
  await noOverflow('desktop media servers');await shot('media-servers');
  report.journeys.push(`${product}: media server onboarding, token saved encrypted, launch off without the helper`);

  await page.goto(`${url}${sr?'/':'/search'}`,{waitUntil:'networkidle'});
  if(sr){await page.getByRole('heading',{name:/^Welcome back/}).waitFor();await shot('discover');await page.getByRole('button',{name:/^Theme:/}).click();assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),'light');await shot('discover-light');await page.getByRole('button',{name:/^Theme:/}).click();await page.getByRole('button',{name:/^Theme:/}).click();await page.setViewportSize({width:390,height:844});await noOverflow('mobile discover');await shot('discover-mobile');await page.setViewportSize({width:1440,height:1050});report.journeys.push('streamrd: home page, theme switch and mobile layout');for(const retired of ['/search','/title/x','/watch/x','/account/profiles','/admin/catalog']){const gone=await page.goto(`${url}${retired}`,{waitUntil:'networkidle'});assert.equal(gone.status(),404,`${retired} must be gone`);}await page.goto(`${url}/`,{waitUntil:'networkidle'});}
  else {
   await page.getByRole('searchbox',{name:'Search query'}).fill('Blender');await page.getByRole('button',{name:/Search indexers/}).click();await page.getByRole('heading',{name:'Big Buck Bunny — open movie fixture',exact:true}).waitFor();
   await page.getByRole('button',{name:/Save search/}).click();await page.getByLabel('Name this search').fill('Open movie picks');await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByRole('button',{name:/Open movie picks/}).first().waitFor();await shot('discover');await page.getByRole('button',{name:/^Color theme:/}).click();assert.equal(await page.evaluate(()=>document.documentElement.dataset.phosphor),'amber');await shot('discover-amber');await page.getByRole('button',{name:/^Color theme:/}).click();assert.equal(await page.evaluate(()=>document.documentElement.dataset.phosphor),'white');await shot('discover-white');await page.getByRole('button',{name:/^Color theme:/}).click();await page.setViewportSize({width:390,height:844});await noOverflow('mobile search');await shot('discover-mobile');await page.setViewportSize({width:1440,height:1050});
   await page.goto(`${url}/downloads`,{waitUntil:'networkidle'});await page.getByRole('heading',{name:'Good things are worth finding.'}).waitFor();await shot('queue');
   await page.route('**/api/downloads',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Temporary fixture outage'})}));await page.reload({waitUntil:'networkidle'});await page.getByRole('alert').filter({hasText:'Temporary fixture outage'}).waitFor();await page.unroute('**/api/downloads');await page.getByRole('button',{name:'Try again',exact:true}).click();await page.getByRole('heading',{name:'Good things are worth finding.'}).waitFor();report.journeys.push('phosphor: real local-indexer search, saved search, queue empty/error/retry states');
  }
  await automaticLibraries({product,page,url,api,admin,member,call,shot,noOverflow,report});
  await serverSharing({product,page,url,api,admin,member,call,shot,noOverflow,report});
  await mediaRequests({product,page,url,api,admin,member,call,shot,noOverflow,report});
  await maintenance({product,page,url,api,admin,member,call,shot,noOverflow,report});
  await page.keyboard.press('Tab');assert.ok(await page.evaluate(()=>document.activeElement!==document.body),'Keyboard focus must reach an interactive control');
  // A member session must not expose the filesystem administration interface.
  await context.clearCookies();await context.addCookies([{name:sr?'sr_token':'ph_token',value:member.token,domain:'localhost',path:'/'},{name:sr?'sr_role':'ph_role',value:'user',domain:'localhost',path:'/'}]);
  await page.goto(`${url}/admin/library`,{waitUntil:'networkidle'});assert.ok(!new URL(page.url()).pathname.startsWith('/admin'));await context.close();
  const newContext=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'}),signupPage=await newContext.newPage();
  signupPage.on('pageerror',error=>report.pageErrors.push({product,message:error.message}));
  await signupPage.goto(`${url}/signup`,{waitUntil:'networkidle'});await signupPage.getByLabel(/Display name/i).fill('New community member');await signupPage.getByLabel('Email',{exact:true}).fill('new-member@example.invalid');await signupPage.getByLabel(/^Password/).fill(credentials.password);await signupPage.getByRole('button',{name:/^(create account|sign up)$/i}).click();await signupPage.waitForURL(/\/setup$/);await signupPage.getByRole('heading',{name:'Make yourself at home.'}).waitFor();await newContext.close();report.journeys.push(`${product}: mobile signup routes into guided setup`);
 }
 assert.deepEqual(report.pageErrors,[],'Browser page errors must be resolved');
 console.log(`Passed ${report.journeys.length} browser journeys; ${report.screenshots.length} screenshots; no page errors.`);
 }catch(error){report.failure=error.message;if(activePage)await activePage.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});throw error;}finally{await browser.close();fs.writeFileSync(path.join(output,'validation.json'),JSON.stringify(report,null,2)+'\n');}
})().catch(error=>{console.error(error);process.exitCode=1;});
