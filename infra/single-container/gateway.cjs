const http = require('node:http');

/**
 * The container's front door: /api/* goes to the API, everything else to the web app, and /healthz answers for the container.
 *
 * The timeout on the connection to the program behind it protects against a program that does not answer. It must stop counting once the
 * answer has begun: a video that is played while it is converted is one long answer, and a browser stops reading it for as long as it has
 * enough picture buffered (Firefox does, for much of the video). A timer that kept running then cut the stream after thirty quiet seconds
 * and the player stopped with a network error a minute into every converted video.
 */
function createGateway({ port, webPort, apiPort, health, host = '0.0.0.0', waitMs = 30_000, streamWaitMs = 120_000 }) {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/healthz') {
      const ok = await health(); res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ ok })); return;
    }
    const toApi = req.url === '/api' || req.url.startsWith('/api/'), target = toApi ? apiPort : webPort;
    const upstream = http.request({ host: '127.0.0.1', port: target, path: req.url, method: req.method, headers: { ...req.headers, host: req.headers.host || `127.0.0.1:${target}`, 'x-forwarded-host': req.headers.host || '', 'x-forwarded-proto': process.env.TRUST_PROXY === 'true' && /^(https|http)$/.test(req.headers['x-forwarded-proto'] || '') ? req.headers['x-forwarded-proto'] : req.socket.encrypted ? 'https' : 'http' } }, response => {
      upstream.setTimeout(0);   // the answer has begun: it may be paused for as long as the browser likes
      res.writeHead(response.statusCode, { 'x-content-type-options': 'nosniff', 'x-frame-options': 'SAMEORIGIN', 'referrer-policy': 'same-origin', ...response.headers }); response.pipe(res);
      response.on('error', () => res.destroy());
    });
    // Until the first byte comes back: a converted video's first bytes can take a while when the provider is slow.
    upstream.setTimeout(req.url.startsWith('/api/stream/') ? streamWaitMs : waitMs, () => upstream.destroy());
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Service is starting or unavailable' })); });
    req.on('aborted', () => upstream.destroy()); res.on('close', () => { if (!res.writableFinished) upstream.destroy(); }); req.pipe(upstream);
  });
  server.listen(port, host);
  return server;
}
module.exports = { createGateway };
