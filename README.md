# Squarespace Checkout Bot

Automated checkout for any Squarespace store using reverse-engineered HTTP APIs. No browser automation — completes purchases in 2-5 seconds via direct API calls.

## How It Works

The bot reverse-engineers Squarespace's checkout flow into 7 HTTP requests:

```
1. GET  store page           → Extract crumb (CSRF) token from cookies
2. POST add-to-cart          → Get cart token
3. GET  /checkout?cartToken  → Parse bootstrap JSON (Stripe keys, cart state, shipping)
4. PUT  shipping/location    → Set shipping address, get fulfillment options
5. PUT  shipping/option      → Select cheapest shipping rate
6. POST Stripe API           → Create PaymentMethod (card data goes to Stripe, not the store)
7. POST /api/2/commerce/orders → Submit the order
```

## Setup

```bash
git clone https://github.com/gabehassan/squarespace-checkout-bot.git
cd squarespace-checkout-bot
npm install
node index.js
```

The interactive setup will walk you through entering your store URL, shipping address, and payment info on first run. You can also configure everything manually via `.env` (see `.env.example`).

## Usage

### Interactive Mode

Run `node index.js` to get the interactive menu:

- **[1] Single task** — Search for a product by keyword and check out when it appears. Polls until the product drops.
- **[2] Multi-task** — Run multiple parallel checkouts with different keywords/profiles.
- **[3] Test mode** — Dry run with dummy credentials to verify the flow works.
- **[4] Update credentials** — Re-enter store URL, shipping, and payment info. Auto-discovers product collections on any Squarespace site.
- **[5] Manage profiles** — Save multiple shipping/payment profiles for multi-task mode.

### Headless Mode (Environment Variables)

Set all variables in `.env` and the bot runs without prompts:

```bash
PRODUCT_SEARCH="album name" DRY_RUN=false node index.js
```

For parallel tasks:
```bash
PRODUCT_SEARCH="keyword1,keyword2" TASK_COUNT=4 node index.js
```

### Product Finder

Browse a store's catalog without checking out:

```bash
node find-products.js                          # list all products
node find-products.js --search "keyword"       # search by name
node find-products.js --in-stock               # only in-stock items
node find-products.js --url /store/p/slug      # single product details
node find-products.js --monitor "keyword"      # poll until product appears
node find-products.js --json                   # raw JSON output
```

## Architecture

```
index.js              Entry point — CLI menu, bot orchestration
lib/
  config.js           Configuration from environment variables
  session.js          HTTP session with automatic cookie management
  discovery.js        Product search + store collection auto-discovery
  checkout.js         7-step checkout flow (crumb → cart → bootstrap → shipping → payment → order)
  profiles.js         Profile management, credentials collection, .env persistence
find-products.js      Standalone product catalog browser
```

## Store Auto-Discovery

When setting up a new store, the bot automatically scans the site's navigation for product collections. It checks each path with Squarespace's `?format=json` API and identifies which pages contain purchasable products. You can also enter a store URL with a path (e.g. `mystore.com/shop`) to skip discovery.

## API Reference

All Squarespace pages support `?format=json` for structured data access.

### Product Discovery
```
GET /<collection>?format=json                    → Product catalog (paginated)
GET /<collection>?offset=N&format=json           → Next page
GET /<collection>/p/<slug>?format=json           → Single product detail
```

### Cart Operations
```
POST /api/commerce/shopping-cart/entries?crumb=   → Add item to cart
PUT  /api/3/commerce/cart/{token}/shipping/location → Set shipping address
PUT  /api/3/commerce/cart/{token}/shipping/option   → Select shipping rate
```

### Checkout
```
GET  /checkout?cartToken={token}                  → Checkout page (bootstrap JSON)
POST /api/2/commerce/orders                       → Submit order
```

### Payment
Card details are sent directly to Stripe's API (`https://api.stripe.com/v1/payment_methods`) using the store's public key — they never touch Squarespace's servers.

Payment token types:
- **SQSP_PAYMENTS** — Stores using Squarespace Payments (most common)
- **STRIPE** — Stores with direct Stripe Connect integration

## Limitations

- **3D Secure** — If a card triggers 3DS, the order fails (requires browser popup). ~5% of US cards.
- **Apple Pay / Google Pay** — Require browser-native payment sheet APIs.
- **PayPal** — Requires browser redirect flow.
- **reCAPTCHA** — If a store enables it, invisible reCAPTCHA requires a browser. Most stores have it disabled.

## Tested With

Verified working across different Squarespace store types:

| Store | Category | Products |
|-------|----------|----------|
| [Vertigo Vinyl](https://vertigovinyl.com) | Vinyl records | 200+ limited pressings |

The bot works with any Squarespace Commerce store.

## License

MIT
