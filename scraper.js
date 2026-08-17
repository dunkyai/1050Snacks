const { chromium } = require('playwright');

const DELIVERY_ADDRESS = '1050 Sansome St, San Francisco, CA 94111';

const STORES = [
  { name: 'Costco', slug: 'costco-warehouse' },
];

function parseServings(title, size) {
  const text = `${title} ${size || ''}`;

  const countMatch = text.match(
    /(\d+)\s*(?:count|ct\.?|pack|pcs|pieces|bars?|bags?|pouches?|cups?|bottles?|cans?|snacks?|cookies|crackers|servings?)/i
  ) || text.match(/(\d+)-(?:count|ct|pack)/i) || text.match(/pack\s+of\s+(\d+)/i);
  if (countMatch) return { count: parseInt(countMatch[1], 10), basis: 'count' };

  const lbMatch = text.match(/(\d+(?:\.\d+)?)\s*lb/i);
  if (lbMatch) {
    const oz = Math.round(parseFloat(lbMatch[1]) * 16);
    return { count: oz, basis: `est. ${oz} servings (1/oz)` };
  }

  const ozMatch = text.match(/(\d+(?:\.\d+)?)\s*oz/i);
  if (ozMatch) {
    const count = Math.round(parseFloat(ozMatch[1]));
    return { count, basis: `est. ${count} servings (1/oz)` };
  }

  const gMatch = text.match(/(\d+(?:\.\d+)?)\s*g\b/i);
  if (gMatch) {
    const count = Math.round(parseFloat(gMatch[1]) / 28);
    return { count, basis: `est. ${count} servings (28g each)` };
  }

  return null;
}

// Load the Instacart homepage and extract store URLs from the store list.
// The server IP resolves to SF Bay Area so stores are already shown.
async function loadHomepageAndGetStoreUrls(page) {
  await page.goto('https://www.instacart.com', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: '/tmp/debug-homepage.png' });
  console.log('Homepage loaded, URL:', page.url());

  // Pull all store links visible on the homepage
  const storeLinks = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/store/"]'));
    return links.map(a => ({
      href: a.href,
      text: a.innerText?.trim() || a.getAttribute('aria-label') || '',
    })).filter(l => l.href && !l.href.includes('/search'));
  });

  console.log('Store links found:', storeLinks.map(l => `${l.text}: ${l.href}`).join(' | '));
  return storeLinks;
}

function pickStoreUrl(storeLinks, storeName) {
  const name = storeName.toLowerCase();
  // Exact text match first
  let match = storeLinks.find(l => l.text.toLowerCase().startsWith(name));
  // Slug-based fallback
  if (!match) match = storeLinks.find(l => l.href.toLowerCase().includes(name.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')));
  return match ? match.href.split('?')[0] : null;
}

async function scrapeStore(page, storeLinks, store, query) {
  try {
    // Navigate to the store storefront (click path, not search URL directly)
    const storefrontUrl = pickStoreUrl(storeLinks, store.name)
      || `https://www.instacart.com/store/${store.slug}/storefront`;
    console.log(`[${store.name}] going to storefront: ${storefrontUrl}`);

    await page.goto(storefrontUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `/tmp/debug-${store.slug}-front.png` });
    console.log(`[${store.name}] storefront url after nav: ${page.url()}`);

    // Dismiss any dialog/overlay that may be blocking the search box
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    try {
      const closeBtn = page.locator('[data-dialog-ref] button, [role="dialog"] button[aria-label*="close" i], [role="dialog"] button:first-child').first();
      await closeBtn.click({ timeout: 2000 });
      await page.waitForTimeout(300);
    } catch {}

    // Use the search box on the storefront — avoids direct /search_v3/ URL which 404s without a session
    const searchInput = page.locator('input[placeholder*="Search" i], input[aria-label*="Search" i]').first();
    await searchInput.click({ timeout: 8000 });
    await searchInput.fill(query);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `/tmp/debug-${store.slug}-search.png` });
    console.log(`[${store.name}] search page: ${page.url()} — title: ${await page.title()}`);

    // Scroll to load more products, then wait for them
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, 700));
      await page.waitForTimeout(600);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1000);

    const products = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      // Instacart puts "Current price: $X.XX" in accessibility text on each product card.
      // This reliably identifies the real current price and avoids strikethrough/promo prices.
      const allEls = Array.from(document.querySelectorAll('*'));
      const priceEls = allEls.filter(el => {
        if (el.children.length > 0) return false;
        const t = el.textContent.trim();
        return t.startsWith('Current price:') && /\$[\d.]+/.test(t);
      });

      for (const priceEl of priceEls) {
        const priceMatch = priceEl.textContent.match(/\$([\d,.]+)/);
        if (!priceMatch) continue;
        const price = parseFloat(priceMatch[1].replace(',', ''));
        if (!price || price > 500) continue;

        // Climb up to a card-level container (has an img + enough text)
        let card = priceEl;
        for (let i = 0; i < 10; i++) {
          if (!card.parentElement) break;
          card = card.parentElement;
          if (card.querySelector('img') && (card.innerText || '').length > 30) break;
        }
        if (seen.has(card)) continue;
        seen.add(card);

        const cardText = (card.innerText || '').trim();

        // Product name: prefer an <a> that links into the store (not nav/search/storefront),
        // has real text, and doesn't look like a button ("Add", "View all", etc.)
        const productLink = Array.from(card.querySelectorAll('a[href]')).find(a => {
          const href = a.href || '';
          const text = a.textContent.trim();
          return href.includes('/store/') &&
            !/(storefront|search_v3|aisle|category|department|see_all)/i.test(href) &&
            text.length > 10 &&
            !/^(Add|View|See|Shop|More)/i.test(text);
        });

        let name = productLink?.textContent.trim() || null;

        // Fallback: first innerText line that looks like a product name
        if (!name) {
          const lines = cardText.split('\n').map(l => l.trim()).filter(Boolean);
          name = lines.find(l =>
            l.length > 15 &&
            !/^\$/.test(l) &&
            !/^[★*]/.test(l) &&
            !/(off|stock|delivery|pickup|Current|Original|Add to|Best seller|No artificial|sponsored)/i.test(l) &&
            /[a-zA-Z]{3}/.test(l)
          ) || null;
        }

        if (!name) continue;

        // Find a dedicated size element — one whose entire text IS a size string.
        // This avoids false matches from promo text or nutritional info.
        const sizeEl = Array.from(card.querySelectorAll('*')).find(el => {
          if (el.children.length > 0) return false;
          return /^\d+(\.\d+)?\s*(fl oz|oz|lbs?|lb|kg|g|ct|count|pack|pcs)$/i.test(el.textContent.trim());
        });
        const size = sizeEl?.textContent.trim() || '';
        const productUrl = productLink?.href || null;

        results.push({ name, price, size, productUrl });
      }

      return results.slice(0, 12);
    });

    console.log(`[${store.name}] extracted ${products.length} products`);

    return products
      .filter(p => p.name && p.price && p.price < 500)
      .map(p => {
        // Use the dedicated size element; fall back to parsing the product name itself
        const size = p.size || (p.name.match(/\d+[\s-]*(fl oz|oz|lb|ct|count|pack|g)\b/i) || [])[0] || '';
        const servings = parseServings(p.name, size);
        return {
          name: p.name,
          price: p.price,
          size,
          productUrl: p.productUrl || null,
          servings: servings ? servings.count : null,
          servingsBasis: servings ? servings.basis : null,
          pricePerMeal: servings ? +(p.price / servings.count).toFixed(2) : null,
        };
      })
      .sort((a, b) => (a.pricePerMeal ?? Infinity) - (b.pricePerMeal ?? Infinity));

  } catch (err) {
    console.error(`[${store.name}] scrape error: ${err.message}`);
    await page.screenshot({ path: `/tmp/debug-${store.slug}-error.png` }).catch(() => {});
    return [];
  }
}

// Cookie-Editor exports an array of cookie objects; Playwright wants a slightly different shape.
async function injectSessionCookies(context) {
  const b64 = process.env.INSTACART_COOKIES_B64;
  const raw = b64
    ? Buffer.from(b64, 'base64').toString('utf8')
    : process.env.INSTACART_COOKIES;

  if (!raw) {
    console.log('No session cookies configured — running without login');
    return;
  }

  const exported = JSON.parse(raw);

  // Cookie-Editor sameSite values differ from Playwright's expected values
  const sameSiteMap = { strict: 'Strict', lax: 'Lax', no_restriction: 'None', none: 'None' };

  const cookies = exported
    .map(c => ({
      name: c.name,
      value: c.value,
      // hostOnly cookies must not have a leading dot
      domain: c.hostOnly ? c.domain.replace(/^\./, '') : (c.domain.startsWith('.') ? c.domain : `.${c.domain}`),
      path: c.path || '/',
      expires: c.expirationDate ? Math.floor(c.expirationDate) : -1,
      httpOnly: c.httpOnly ?? false,
      secure: c.secure ?? false,
      sameSite: sameSiteMap[(c.sameSite || '').toLowerCase()] ?? 'Lax',
    }))
    .filter(c => c.name && c.value);

  await context.addCookies(cookies);
  console.log(`Injected ${cookies.length} session cookies`);
}

async function scrapeInstacart(query, onStoreResult) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  await injectSessionCookies(context);
  const page = await context.newPage();

  try {
    const storeLinks = await loadHomepageAndGetStoreUrls(page);

    for (const store of STORES) {
      const products = await scrapeStore(page, storeLinks, store, query);
      onStoreResult({ store: store.name, products });
    }
  } finally {
    await browser.close();
  }
}

// Individual packs: small per-piece size (≤2 oz) in a multipack, or explicit keywords
function isIndividualPack(p) {
  const text = `${p.name} ${p.size || ''}`.toLowerCase();
  const smallMultipack = /\b(0\.\d+|1|1\.[0-9])\s*oz\b/.test(text) &&
    /\b(\d+[\s-]count|pack|variety)\b/.test(text);
  const keywords = /snack\s*pack|individual|single[\s-]serve|fun\s+size|mini\s+bag|on[\s-]the[\s-]go/i.test(text);
  return smallMultipack || keywords;
}

async function rankProducts(products) {
  if (products.length <= 3) return products;

  // Price efficiency: lower cost-per-snack → higher score (1–10)
  const ppmValues = products.map(p => p.pricePerMeal ?? p.price ?? 0);
  const min = Math.min(...ppmValues);
  const max = Math.max(...ppmValues);
  const range = max - min;

  // Tastiness: single Haiku call for all products at once
  const tastiness = {};
  try {
    const list = products.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages: [{
          role: 'user',
          content: `Rate each snack 1-10 for crowd-appeal in a shared office (broad taste, brand recognition, general enjoyability). Return only a JSON array, no extra text: [{"i":1,"s":8}, ...]\n\n${list}`,
        }],
      }),
    });
    const data = await resp.json();
    const scores = JSON.parse(data.content[0].text);
    for (const { i, s } of scores) tastiness[i - 1] = s;
  } catch (err) {
    console.warn('[rank] tastiness scoring failed, using price only:', err.message);
  }

  const scored = products
    .map((p, i) => {
      const t = tastiness[i] ?? 5;
      const ppm = p.pricePerMeal ?? p.price ?? max;
      const priceScore = range > 0 ? 1 + 9 * (max - ppm) / range : 5;
      return { ...p, _score: t * 0.6 + priceScore * 0.4 };
    })
    .sort((a, b) => b._score - a._score);

  const top3 = scored.slice(0, 3);

  // Guarantee at least 1 individual-packet option in the top 3
  const hasIndividual = top3.some(isIndividualPack);
  if (!hasIndividual) {
    const bestIndividual = scored.slice(3).find(isIndividualPack);
    if (bestIndividual) top3[2] = bestIndividual; // replace lowest-ranked slot
  }

  return top3.map(({ _score, ...p }) => p);
}

module.exports = { scrapeInstacart, rankProducts };
