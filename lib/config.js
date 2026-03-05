const { AsyncLocalStorage } = require("async_hooks");

const _als = new AsyncLocalStorage();

const CONFIG = {
  storeUrl: process.env.STORE_URL || "",
  productUrl: process.env.PRODUCT_URL || "",
  itemId: process.env.ITEM_ID || "",
  sku: process.env.SKU || "",
  email: process.env.EMAIL || "",
  firstName: process.env.FIRST_NAME || "",
  lastName: process.env.LAST_NAME || "",
  address1: process.env.ADDRESS1 || "",
  address2: process.env.ADDRESS2 || "",
  city: process.env.CITY || "",
  state: process.env.STATE || "",
  zip: process.env.ZIP || "",
  country: process.env.COUNTRY || "US",
  phone: process.env.PHONE || "",
  cardNumber: process.env.CARD_NUMBER || "",
  cardExpMonth: parseInt(process.env.CARD_EXP_MONTH, 10) || 12,
  cardExpYear: parseInt(process.env.CARD_EXP_YEAR, 10) || 2027,
  cardCvc: process.env.CARD_CVC || "",
  quantity: parseInt(process.env.QUANTITY, 10) || 1,
  dryRun: process.env.DRY_RUN === "true",
  preferPickup: process.env.PREFER_PICKUP === "true",
  existingCartToken: process.env.CART_TOKEN || "",
  pollInterval: parseInt(process.env.POLL_INTERVAL, 10) || 10,
  storePath: process.env.STORE_PATH || "/store",
  maxPrice: parseFloat(process.env.MAX_PRICE) || 0,
};

function log(msg) {
  const prefix = _als.getStore()?.prefix || "";
  console.log(`[${new Date().toISOString()}]${prefix} ${msg}`);
}

function die(msg) {
  throw new Error(msg);
}

module.exports = { CONFIG, _als, log, die };
