const fs = require("fs");
const path = require("path");
const { CONFIG } = require("./config");
const { createSession } = require("./session");
const { discoverStorePaths } = require("./discovery");

const ROOT = path.join(__dirname, "..");
const PROFILES_FILE = path.join(ROOT, "profiles.json");

function loadProfiles() {
  try {
    return JSON.parse(fs.readFileSync(PROFILES_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveProfiles(p) {
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(p, null, 2) + "\n");
}

function profileFromConfig() {
  return {
    email: CONFIG.email,
    firstName: CONFIG.firstName,
    lastName: CONFIG.lastName,
    phone: CONFIG.phone,
    address1: CONFIG.address1,
    address2: CONFIG.address2,
    city: CONFIG.city,
    state: CONFIG.state,
    zip: CONFIG.zip,
    country: CONFIG.country,
    cardNumber: CONFIG.cardNumber,
    cardExpMonth: CONFIG.cardExpMonth,
    cardExpYear: CONFIG.cardExpYear,
    cardCvc: CONFIG.cardCvc,
  };
}

function ask(rl, question, defaultVal, displayOverride) {
  return new Promise((resolve) => {
    const hint = displayOverride || defaultVal || "";
    const suffix = hint ? ` [${hint}]` : "";
    rl.question(`  ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultVal || "");
    });
  });
}

function maskCard(num) {
  if (!num || num.length < 4) return "";
  return "**** " + num.slice(-4);
}

function credentialsExist() {
  return !!(CONFIG.email && CONFIG.cardNumber && CONFIG.firstName && CONFIG.address1);
}

function saveEnv() {
  const lines = [
    `STORE_URL=${CONFIG.storeUrl}`,
    `STORE_PATH=${CONFIG.storePath}`,
    `EMAIL=${CONFIG.email}`,
    `FIRST_NAME=${CONFIG.firstName}`,
    `LAST_NAME=${CONFIG.lastName}`,
    `PHONE=${CONFIG.phone}`,
    `ADDRESS1=${CONFIG.address1}`,
    `ADDRESS2=${CONFIG.address2}`,
    `CITY=${CONFIG.city}`,
    `STATE=${CONFIG.state}`,
    `ZIP=${CONFIG.zip}`,
    `COUNTRY=${CONFIG.country}`,
    `CARD_NUMBER=${CONFIG.cardNumber}`,
    `CARD_EXP_MONTH=${CONFIG.cardExpMonth}`,
    `CARD_EXP_YEAR=${CONFIG.cardExpYear}`,
    `CARD_CVC=${CONFIG.cardCvc}`,
  ];
  fs.writeFileSync(path.join(ROOT, ".env"), lines.join("\n") + "\n");
}

async function collectProfile(rl, existing = {}) {
  const p = {};
  console.log("\n  -- Personal --");
  p.email = await ask(rl, "Email", existing.email);
  p.firstName = await ask(rl, "First name", existing.firstName);
  p.lastName = await ask(rl, "Last name", existing.lastName);
  p.phone = await ask(rl, "Phone", existing.phone);
  console.log("\n  -- Shipping Address --");
  p.address1 = await ask(rl, "Address line 1", existing.address1);
  p.address2 = await ask(rl, "Address line 2", existing.address2);
  p.city = await ask(rl, "City", existing.city);
  p.state = await ask(rl, "State", existing.state);
  p.zip = await ask(rl, "ZIP", existing.zip);
  p.country = await ask(rl, "Country", existing.country || "US");
  console.log("\n  -- Payment --");
  p.cardNumber = await ask(rl, "Card number", existing.cardNumber, maskCard(existing.cardNumber));
  p.cardExpMonth = parseInt(
    await ask(rl, "Exp month (MM)", String(existing.cardExpMonth || 12)),
    10,
  );
  p.cardExpYear = parseInt(
    await ask(rl, "Exp year (YYYY)", String(existing.cardExpYear || 2027)),
    10,
  );
  p.cardCvc = await ask(rl, "CVC", existing.cardCvc, existing.cardCvc ? "***" : "");
  return p;
}

async function collectCredentials(rl) {
  console.log("\n  -- Store --");
  let rawUrl = await ask(rl, "Store URL (e.g. mystore.com)", CONFIG.storeUrl);
  if (!rawUrl) {
    console.log("  Store URL is required.\n");
    return;
  }
  if (!rawUrl.startsWith("http")) rawUrl = "https://" + rawUrl;
  rawUrl = rawUrl.replace(/\/+$/, "");

  // If the user entered a URL with a path, extract it as the store path
  let suggestedPath = "";
  try {
    const parsed = new URL(rawUrl);
    CONFIG.storeUrl = `${parsed.protocol}//${parsed.host}`;
    if (parsed.pathname && parsed.pathname !== "/") {
      suggestedPath = parsed.pathname.replace(/\/+$/, "");
    }
  } catch {
    CONFIG.storeUrl = rawUrl;
  }

  if (suggestedPath) {
    CONFIG.storePath = suggestedPath;
    console.log(`\n  Store: ${CONFIG.storeUrl}  Path: ${CONFIG.storePath}\n`);
  } else {
    // Auto-discover product collections
    console.log("\n  Scanning for product collections...\n");
    const tempSession = createSession();
    let collections = [];
    try {
      collections = await discoverStorePaths(tempSession);
    } catch (e) {
      console.log(`  Discovery failed: ${e.message}\n`);
    }

    if (collections.length > 0) {
      console.log("  Product collections found:");
      collections.forEach((c, i) => {
        console.log(`    [${i + 1}] ${c.title} — ${c.count} products (${c.path})`);
      });
      console.log(`    [0] Enter path manually\n`);

      const pick = await ask(rl, "Select collection", "1");
      if (pick === "0") {
        CONFIG.storePath = await ask(rl, "Category path", "/store");
      } else {
        const idx = parseInt(pick, 10) - 1;
        if (idx >= 0 && idx < collections.length) {
          CONFIG.storePath = collections[idx].path;
          console.log(`\n  Using: ${collections[idx].title} (${CONFIG.storePath})\n`);
        } else {
          CONFIG.storePath = await ask(rl, "Category path", "/store");
        }
      }
    } else {
      CONFIG.storePath = await ask(
        rl,
        "Category path (e.g. /store, /shop)",
        CONFIG.storePath || "/store",
      );
    }
  }

  const profile = await collectProfile(rl, profileFromConfig());
  Object.assign(CONFIG, profile);
  saveEnv();
  const profiles = loadProfiles();
  profiles["default"] = profile;
  saveProfiles(profiles);
  console.log("\n  Credentials saved.\n");
}

function printProfileSummary(name, p) {
  return `${name}: ${p.firstName} ${p.lastName} | ${p.email} | ${maskCard(p.cardNumber)} | ${p.city}, ${p.state}`;
}

module.exports = {
  loadProfiles,
  saveProfiles,
  profileFromConfig,
  ask,
  maskCard,
  credentialsExist,
  saveEnv,
  collectProfile,
  collectCredentials,
  printProfileSummary,
};
