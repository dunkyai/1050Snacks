// Read-only diagnostic: why does /snacks find nothing on the server?
// Runs inside the 1050snacks container. Prints no cookie values.
const { chromium } = require('playwright');

function loadCookies() {
  const b64 = process.env.INSTACART_COOKIES_B64;
  const raw = b64 ? Buffer.from(b64, 'base64').toString('utf8') : process.env.INSTACART_COOKIES;
  if (!raw) return null;
  return JSON.parse(raw);
}

async function probe(label, cookies, query) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote', '--single-process'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });
  if (cookies) {
    const sameSiteMap = { strict: 'Strict', lax: 'Lax', no_restriction: 'None', none: 'None' };
    await context.addCookies(cookies.map(c => ({
      name: c.name, value: c.value,
      domain: c.hostOnly ? c.domain.replace(/^\./, '') : (c.domain.startsWith('.') ? c.domain : `.${c.domain}`),
      path: c.path || '/', expires: c.expirationDate ? Math.floor(c.expirationDate) : -1,
      httpOnly: c.httpOnly ?? false, secure: c.secure ?? false,
      sameSite: sameSiteMap[(c.sameSite || '').toLowerCase()] ?? 'Lax',
    })).filter(c => c.name && c.value));
  }
  const page = await context.newPage();
  try {
    const home = await page.goto('https://www.instacart.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log(`[${label}] home status=${home && home.status()} url=${page.url()}`);
    await page.waitForTimeout(2000);
    for (const slug of ['costco', 'safeway']) {
      const resp = await page.goto(`https://www.instacart.com/store/${slug}/s?k=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(4000);
      const info = await page.evaluate(() => {
        const leaves = [...document.querySelectorAll('*')].filter(e => e.children.length === 0);
        return {
          title: document.title,
          currentPrice: leaves.filter(e => e.textContent.trim().startsWith('Current price')).length,
          productLinks: document.querySelectorAll('a[href*="/products/"]').length,
          text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 600),
        };
      });
      console.log(`[${label}] ${slug} status=${resp && resp.status()} url=${page.url()} title=${JSON.stringify(info.title)} currentPrice=${info.currentPrice} productLinks=${info.productLinks}`);
      console.log(`[${label}] ${slug} text: ${info.text}`);
    }
  } catch (e) {
    console.log(`[${label}] ERROR ${e.message}`);
  } finally {
    await browser.close();
  }
}

(async () => {
  let cookies = null;
  try { cookies = loadCookies(); } catch (e) { console.log('cookie parse error:', e.message); }
  if (cookies) {
    const now = Date.now() / 1000;
    const expired = cookies.filter(c => c.expirationDate && c.expirationDate < now);
    console.log(`cookies: ${cookies.length} total, ${expired.length} expired`);
    for (const c of cookies) {
      const exp = c.expirationDate ? new Date(c.expirationDate * 1000).toISOString() : 'session';
      console.log(`  cookie ${c.name} domain=${c.domain} expires=${exp}${c.expirationDate && c.expirationDate < now ? ' EXPIRED' : ''}`);
    }
  } else console.log('cookies: none configured');
  await probe('with-cookies', cookies, 'milk');
  await probe('no-cookies', null, 'milk');
})();
