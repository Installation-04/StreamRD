const assert = require('node:assert/strict');
const fs = require('node:fs');
async function call(port, route, data, token, method) {
 const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: method || (data ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
 const result = await response.json(); assert.ok(response.ok, `${route}: HTTP ${response.status} ${result.error || ''}`); return result;
}
(async () => {
 const restart = process.env.SMOKE_RESTART === '1';
 const credentials = { email: 'single-container@example.invalid', password: 'single-container-fixture123', displayName: 'Container fixture' };
 const users = [];
 for (const port of [8080,8081]) {
  const session = await call(port, '/api/auth/' + (restart ? 'login' : 'signup'), credentials); users.push(session);
  assert.equal(session.user.role, 'admin');
  const health = await call(port, '/api/admin/system', null, session.token); assert.equal(health.migrations.state, 'current');
  const html = await fetch(`http://127.0.0.1:${port}/login`); assert.ok(html.ok); const text = await html.text(); assert.ok(text.includes('/_next/'));
  if (!restart) {
   const password = fs.readFileSync('/data/secrets/qbittorrent-password','utf8').trim();
   const saved = await call(port, '/api/admin/request-settings', { qbit: { enabled: true, baseUrl:'http://127.0.0.1:8082', username:process.env.QBIT_USERNAME || 'admin', password } }, session.token, 'PUT');
   assert.ok(saved.settings.qbit.passwordConfigured); assert.ok(!JSON.stringify(saved).includes(password));
  }
  assert.equal((await call(port, '/api/admin/request-settings/test', {}, session.token)).ok, true);
 }
 if (restart) {
  const previous=JSON.parse(fs.readFileSync('/data/smoke-sessions.json','utf8'));
  for (const [index,port] of [8080,8081].entries()) assert.equal((await call(port,'/api/account/profile',null,previous[index])).user.email,credentials.email);
 } else fs.writeFileSync('/data/smoke-sessions.json',JSON.stringify(users.map(user=>user.token)),{mode:0o600});
 assert.notEqual(users[0].token, users[1].token);
 assert.equal((await fetch('http://127.0.0.1:8081/api/account/profile',{headers:{Authorization:`Bearer ${users[0].token}`}})).status,401);
 const config=fs.readFileSync('/data/qbittorrent/qBittorrent/config/qBittorrent.conf','utf8');
 assert.ok(config.includes('127.0.0.1')); assert.ok(!config.includes(fs.readFileSync('/data/secrets/qbittorrent-password','utf8').trim()));
 for (const file of ['streamrd-jwt','phosphor-jwt','qbittorrent-password']) assert.equal(fs.statSync('/data/secrets/'+file).mode & 0o777,0o600);
 assert.equal(process.getuid(),1000);
 console.log(restart ? 'Single-container restart persistence, separate sessions and real qBittorrent authentication passed.' : 'Single-container migrations, both same-origin APIs/web pages, isolated accounts and real qBittorrent authentication passed.');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
