Promise.all(['http://127.0.0.1:8080/healthz'].map(async url => {
 const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
 if (!response.ok || !(await response.json()).ok) throw Error('Unhealthy');
})).catch(() => { process.exitCode = 1; });
