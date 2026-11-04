// Quick check that a CloudFront 403 page is detected. Run: node scripts/test-block-detection.js
const { chromium } = require('playwright');
const { assertNotBlocked, proxyFromEnv } = require('../instacart-net');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  await p.route('**/*', route => route.request().url().endsWith('/blocked')
    ? route.fulfill({ status: 403, contentType: 'text/html', body: '<html><head><title>ERROR: The request could not be satisfied</title></head><body>403 ERROR Request blocked.</body></html>' })
    : route.fulfill({ status: 200, contentType: 'text/html', body: '<html><head><title>Milk</title></head><body>Current price: $3.99</body></html>' }));
  let r = await p.goto(`https://www.instacart.com/ok`); console.log('ok page ->', await assertNotBlocked(p, r, 'ok'));
  r = await p.goto(`https://www.instacart.com/blocked`);
  try { await assertNotBlocked(p, r, 'blocked'); console.log('FAIL: not detected'); } catch (e) { console.log('blocked ->', e.name, '|', e.message); }
  console.log('proxy parse ->', JSON.stringify(proxyFromEnv({ INSTACART_PROXY_URL: 'http://u%40x:p@us.example.com:8000' })).replace(/"password":"[^"]*"/,'"password":"***"'));
  await b.close();
})();
