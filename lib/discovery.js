const cheerio = require("cheerio");
const { CONFIG, log, die } = require("./config");

async function discoverProduct(session) {
  const storePath = CONFIG.storePath;

  // Direct URL lookup
  if (CONFIG.productUrl && CONFIG.productUrl.includes("/p/")) {
    log("Auto-discovery: Fetching product details from URL...");
    const sep = CONFIG.productUrl.includes("?") ? "&" : "?";
    const res = await session.get(`${CONFIG.productUrl}${sep}format=json`);
    if (res.status >= 400) die(`Product page returned ${res.status}`);

    const item = res.data.item || res.data;
    if (!item.id) die("Could not parse product from page JSON.");

    const variant = (item.variants || [])[0] || {};
    log(`  Found: "${item.title}"`);
    log(`    ItemID: ${item.id}  SKU: ${variant.sku}  Price: $${variant.priceMoney?.value || "?"}`);

    CONFIG.itemId = item.id;
    CONFIG.sku = variant.sku || "";
    return;
  }

  // Keyword search with polling
  const searchTerm = process.env.PRODUCT_SEARCH || CONFIG.productUrl?.replace(/^\//, "") || "";
  if (!searchTerm) die("No PRODUCT_URL, ITEM_ID, or PRODUCT_SEARCH provided.");

  const needle = searchTerm === "*" ? "" : searchTerm.toLowerCase().replace(/\s+/g, "");
  const scanDays = parseInt(process.env.SCAN_DAYS, 10) || 7;
  const cutoff = Date.now() - scanDays * 24 * 60 * 60 * 1000;
  let attempt = 0;

  while (true) {
    attempt++;
    const tag = attempt > 1 ? ` (attempt ${attempt})` : "";
    log(`Searching recent listings for "${searchTerm}"${tag}...`);

    const matches = [];
    let offset = 0;
    let hitOldListings = false;

    while (!hitOldListings) {
      const p = offset > 0 ? `${storePath}?offset=${offset}&format=json` : `${storePath}?format=json`;
      const res = await session.get(p);
      if (res.status >= 400) break;

      const items = res.data.items || [];
      if (items.length === 0) break;

      for (const item of items) {
        if (item.addedOn && item.addedOn < cutoff) {
          hitOldListings = true;
          break;
        }

        const titleNorm = item.title?.toLowerCase().replace(/\s+/g, "") || "";
        if (!needle || titleNorm.includes(needle)) {
          const variant = (item.variants || [])[0] || {};
          if (variant.unlimited || (variant.qtyInStock && variant.qtyInStock > 0)) {
            matches.push({ item, variant });
          }
        }
      }

      const pag = res.data.pagination || {};
      if (!pag.nextPage) break;
      offset = pag.nextPageOffset || offset + items.length;
      if (offset > 10000) break;
    }

    if (matches.length > 0) {
      matches.sort((a, b) => (b.item.addedOn || 0) - (a.item.addedOn || 0));

      if (matches.length > 1) {
        log(`  Found ${matches.length} matches — picking newest:`);
        for (const m of matches) {
          const added = m.item.addedOn ? new Date(m.item.addedOn).toISOString().split("T")[0] : "?";
          log(`    ${m.item.title}  (added ${added})`);
        }
      }

      const { item, variant } = matches[0];
      const added = item.addedOn ? new Date(item.addedOn).toISOString().split("T")[0] : "?";
      log(`  Selected: "${item.title}" (added ${added})`);
      log(`    ItemID: ${item.id}  SKU: ${variant.sku}  Stock: ${variant.unlimited ? "unlimited" : variant.qtyInStock}`);

      CONFIG.itemId = item.id;
      CONFIG.sku = variant.sku || "";
      CONFIG.productUrl = item.fullUrl || `${storePath}/p/${item.urlId}`;
      return;
    }

    log(`  No match in last ${scanDays} days. Retrying in ${CONFIG.pollInterval}s...`);
    await new Promise((r) => setTimeout(r, CONFIG.pollInterval * 1000));
  }
}

// Scan a Squarespace site's navigation to find all product collection paths
async function discoverStorePaths(session) {
  const res = await session.get("/");
  if (res.status >= 400) return [];

  const $ = cheerio.load(res.data);

  const seen = new Set(["/", ""]);
  const candidates = [];

  $("header a, nav a, [role='navigation'] a, [data-folder] a, footer a").each((_, el) => {
    const raw = $(el).attr("href") || "";
    const href = raw.split("?")[0].split("#")[0];
    if (!href || !href.startsWith("/") || seen.has(href)) return;
    if (href.includes("/p/")) return; // skip individual product pages
    if (/\.\w{2,4}$/.test(href)) return; // skip file links
    seen.add(href);
    candidates.push({ path: href, title: $(el).text().trim().replace(/\s+/g, " ") });
  });

  // Common Squarespace store paths as fallback
  for (const p of ["/store", "/shop", "/products", "/all-products", "/catalog", "/merch"]) {
    if (!seen.has(p)) {
      seen.add(p);
      candidates.push({ path: p, title: "" });
    }
  }

  const collections = [];
  for (const c of candidates) {
    try {
      const r = await session.get(`${c.path}?format=json`, { timeout: 8000 });
      if (r.status >= 400) continue;
      const items = r.data?.items;
      if (!Array.isArray(items) || items.length === 0) continue;
      if (items.some((i) => i.variants && i.variants.length > 0)) {
        collections.push({
          path: c.path,
          title: c.title || r.data?.collection?.title || c.path,
          count: r.data?.pagination?.count || items.length,
        });
      }
    } catch {}
  }

  return collections;
}

module.exports = { discoverProduct, discoverStorePaths };
