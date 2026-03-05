#!/usr/bin/env node

/**
 * Squarespace Product Finder
 *
 * Every Squarespace page supports ?format=json — this gives us the full
 * product catalog without authentication or scraping.
 *
 * Usage:
 *   node find-products.js                                # list all products
 *   node find-products.js --search "keyword"              # search by name
 *   node find-products.js --in-stock                     # only in-stock items
 *   node find-products.js --url /store/p/some-slug       # one product's details
 *   node find-products.js --env "keyword"                # print .env lines for bot
 *   node find-products.js --monitor "keyword"            # poll until it appears
 *   node find-products.js --json                         # raw JSON output
 */

require("dotenv").config();
const axios = require("axios");

const STORE_URL = process.env.STORE_URL || "";
const STORE_PATH = process.env.STORE_PATH || "/store";

// ─── CLI ARGS ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    const key = args[i].replace(/^--/, "");
    const next = args[i + 1];
    flags[key] = next && !next.startsWith("--") ? (i++, next) : true;
  }
}

// ─── FETCH JSON ──────────────────────────────────────────────────────
async function fetchJson(path) {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${STORE_URL}${path}${sep}format=json`;

  const res = await axios.get(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Accept: "application/json",
    },
    timeout: 15000,
  });
  return res.data;
}

// ─── PARSE ONE PRODUCT ───────────────────────────────────────────────
function parseProduct(item) {
  const variants = (item.variants || []).map((v) => ({
    variantId: v.id,
    sku: v.sku || "",
    price: v.priceMoney ? v.priceMoney.value : v.price ? (v.price / 100).toFixed(2) : null,
    currency: v.priceMoney?.currency || "USD",
    onSale: !!v.onSale,
    salePrice: v.salePriceMoney?.value || null,
    inStock: v.unlimited ? true : (v.qtyInStock === null ? true : v.qtyInStock > 0),
    qtyInStock: v.unlimited ? "∞" : v.qtyInStock,
    attributes: v.attributes || {},
    optionValues: v.optionValues || [],
  }));

  const firstVariant = variants[0] || {};
  const slug = item.urlId || "";
  const sc = item.structuredContent || {};

  return {
    // ── What the bot needs ──
    itemId: item.id,
    sku: firstVariant.sku,
    productUrl: item.fullUrl || `${STORE_PATH}/p/${slug}`,

    // ── Display info ──
    title: item.title || "Untitled",
    price: firstVariant.price,
    currency: firstVariant.currency,
    onSale: firstVariant.onSale,
    salePrice: firstVariant.salePrice,
    inStock: variants.some((v) => v.inStock),
    totalStock: variants.reduce((sum, v) => {
      if (v.qtyInStock === "∞") return Infinity;
      return sum + (typeof v.qtyInStock === "number" ? v.qtyInStock : 0);
    }, 0),
    tags: item.tags || [],
    categories: item.categories || [],
    addedOn: item.addedOn ? new Date(item.addedOn).toISOString() : null,
    updatedOn: item.updatedOn ? new Date(item.updatedOn).toISOString() : null,
    productType: sc.productType,
    variants,
  };
}

// ─── GET ALL PRODUCTS (with pagination) ──────────────────────────────
async function getAllProducts() {
  const products = [];
  let offset = 0;

  while (true) {
    const path = offset > 0 ? `${STORE_PATH}?offset=${offset}` : STORE_PATH;
    process.stderr.write(`  Fetching ${STORE_URL}${path}?format=json …\n`);

    const data = await fetchJson(path);
    const items = data.items || [];

    if (items.length === 0) break;

    for (const item of items) {
      products.push(parseProduct(item));
    }

    // Pagination
    const pag = data.pagination || {};
    if (!pag.nextPage) break;
    offset = pag.nextPageOffset || offset + items.length;

    // Safety
    if (offset > 10000) break;
  }

  return products;
}

// ─── GET SINGLE PRODUCT ──────────────────────────────────────────────
async function getProductByUrl(productUrl) {
  const data = await fetchJson(productUrl);
  const item = data.item || data;
  if (!item.id) throw new Error(`No product found at ${productUrl}`);
  return parseProduct(item);
}

// ─── DISPLAY ─────────────────────────────────────────────────────────
function printProduct(p, index) {
  const stock = p.inStock
    ? p.totalStock === Infinity
      ? "✓ In Stock (unlimited)"
      : `✓ In Stock (${p.totalStock})`
    : "✗ OUT OF STOCK";

  const price = p.onSale
    ? `$${p.salePrice} (was $${p.price})`
    : `$${p.price}`;

  console.log(`\n${"─".repeat(60)}`);
  if (index !== undefined) console.log(`  #${index + 1}`);
  console.log(`  ${p.title}`);
  console.log(`  ${price} ${p.currency}  │  ${stock}`);
  console.log(`  URL:     ${p.productUrl}`);
  console.log(`  ItemID:  ${p.itemId}`);
  console.log(`  SKU:     ${p.sku}`);

  if (p.variants.length > 1) {
    console.log(`  Variants (${p.variants.length}):`);
    for (const v of p.variants) {
      const label = v.optionValues.map((o) => o.value).join(", ") ||
                    Object.values(v.attributes).join(", ") ||
                    v.sku;
      const vStock = v.inStock ? `${v.qtyInStock} avail` : "SOLD OUT";
      console.log(`    • ${label}  —  SKU: ${v.sku}  (${vStock})`);
    }
  }
}

function printEnvLines(p, variantIndex = 0) {
  const v = p.variants[variantIndex] || p.variants[0];
  console.log(`\n# ── .env lines for: ${p.title} ──`);
  console.log(`PRODUCT_URL=${p.productUrl}`);
  console.log(`ITEM_ID=${p.itemId}`);
  console.log(`SKU=${v?.sku || p.sku}`);
  if (p.variants.length > 1 && variantIndex > 0) {
    const label = v.optionValues.map((o) => o.value).join(", ");
    console.log(`# Variant: ${label}`);
  }
}

// ─── MONITOR MODE ────────────────────────────────────────────────────
async function monitorForProduct(searchTerm) {
  const interval = parseInt(flags.interval || "10", 10) * 1000;
  console.log(`Monitoring for "${searchTerm}" every ${interval / 1000}s …`);
  console.log("Press Ctrl+C to stop.\n");

  while (true) {
    try {
      const products = await getAllProducts();
      const needle = searchTerm.toLowerCase();
      const matches = products.filter(
        (p) =>
          p.title.toLowerCase().includes(needle) ||
          p.tags.some((t) => t.toLowerCase().includes(needle))
      );

      if (matches.length > 0) {
        console.log(`\n🎯 FOUND ${matches.length} match(es)!\n`);
        for (const m of matches) {
          printProduct(m);
          printEnvLines(m);
        }
        // Optional: play a beep
        process.stdout.write("\x07");
        return matches;
      }

      process.stderr.write(
        `  [${new Date().toISOString()}] ${products.length} products, no match. Retrying in ${interval / 1000}s…\n`
      );
    } catch (err) {
      process.stderr.write(`  Error: ${err.message}. Retrying…\n`);
    }

    await new Promise((r) => setTimeout(r, interval));
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────
(async () => {
  try {
    // Single product lookup
    if (flags.url) {
      const p = await getProductByUrl(flags.url);
      if (flags.json) {
        console.log(JSON.stringify(p, null, 2));
      } else {
        printProduct(p);
        printEnvLines(p);
      }
      return;
    }

    // Monitor mode
    if (flags.monitor) {
      await monitorForProduct(flags.monitor);
      return;
    }

    // List / search
    console.log(`Fetching products from ${STORE_URL}${STORE_PATH} …\n`);
    const products = await getAllProducts();
    console.log(`\nFound ${products.length} total products.\n`);

    let filtered = products;

    // Filter: search
    if (flags.search) {
      const needle = flags.search.toLowerCase();
      filtered = filtered.filter(
        (p) =>
          p.title.toLowerCase().includes(needle) ||
          p.sku?.toLowerCase().includes(needle) ||
          p.tags.some((t) => t.toLowerCase().includes(needle))
      );
      console.log(`${filtered.length} matching "${flags.search}":`);
    }

    // Filter: in-stock only
    if (flags["in-stock"]) {
      filtered = filtered.filter((p) => p.inStock);
      console.log(`${filtered.length} in stock:`);
    }

    // Output
    if (flags.json) {
      console.log(JSON.stringify(filtered, null, 2));
    } else if (flags.env) {
      // Print .env lines for matching products
      const needle = flags.env === true ? "" : flags.env.toLowerCase();
      const matches = needle
        ? filtered.filter((p) => p.title.toLowerCase().includes(needle))
        : filtered;

      if (matches.length === 0) {
        console.log("No matches found.");
      } else {
        for (const m of matches) {
          printEnvLines(m);
        }
      }
    } else {
      for (let i = 0; i < filtered.length; i++) {
        printProduct(filtered[i], i);
      }
    }
  } catch (err) {
    console.error("Error:", err.message);
    if (err.response) {
      console.error(`HTTP ${err.response.status}: ${err.response.statusText}`);
    }
    process.exit(1);
  }
})();
