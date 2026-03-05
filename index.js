#!/usr/bin/env node

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const readline = require("readline");
const { CONFIG, _als, log, die } = require("./lib/config");
const { createSession } = require("./lib/session");
const { discoverProduct } = require("./lib/discovery");
const {
  getCrumbToken,
  addToCart,
  getCheckoutBootstrap,
  updateShippingLocation,
  selectFulfillmentOption,
  createStripePaymentMethod,
  submitOrder,
} = require("./lib/checkout");
const {
  loadProfiles,
  saveProfiles,
  profileFromConfig,
  ask,
  maskCard,
  credentialsExist,
  collectProfile,
  collectCredentials,
  printProfileSummary,
} = require("./lib/profiles");

// ─── BOT EXECUTION ──────────────────────────────────────────────────

async function runBot(opts = {}) {
  const prefix = opts.prefix ? `[${opts.prefix}]` : "";

  const cfg = { ...CONFIG };
  if (opts.profile) Object.assign(cfg, opts.profile);
  if (opts.itemId) cfg.itemId = opts.itemId;
  if (opts.sku) cfg.sku = opts.sku;
  if (opts.productUrl) cfg.productUrl = opts.productUrl;

  const runner = async () => {
    if (!cfg.email) die("EMAIL is required.");
    if (!cfg.cardNumber) die("CARD_NUMBER is required.");
    if (!cfg.productUrl && !cfg.existingCartToken && !process.env.PRODUCT_SEARCH && !cfg.itemId) {
      die("No product target configured.");
    }

    const session = createSession();

    if (!cfg.itemId || !cfg.sku) {
      if (!cfg.existingCartToken) {
        await discoverProduct(session);
        cfg.itemId = CONFIG.itemId;
        cfg.sku = CONFIG.sku;
        cfg.productUrl = CONFIG.productUrl;
      }
    }

    const crumb = await getCrumbToken(session);
    const cartToken = await addToCart(session, crumb, cfg);
    let bootstrap = await getCheckoutBootstrap(session, cartToken);
    bootstrap.crumb = crumb; // Use crumb (not xsrfToken) for x-csrf-token header

    const totalPrice = parseFloat(bootstrap.grandTotal?.decimalValue || 0);
    if (cfg.maxPrice > 0 && totalPrice > cfg.maxPrice) {
      die(`Price $${totalPrice} exceeds max limit of $${cfg.maxPrice}. Aborting.`);
    }

    bootstrap = await updateShippingLocation(session, bootstrap, cfg);
    bootstrap = await selectFulfillmentOption(session, bootstrap);

    if (cfg.dryRun) {
      const cart = bootstrap.cart || {};
      log("");
      log("DRY RUN — would submit:");
      log(`  Email:    ${cfg.email}`);
      log(`  Cart:     ${bootstrap.cartToken?.substring(0, 15)}...`);
      log(`  Ship to:  ${cfg.address1}, ${cfg.city}, ${cfg.state} ${cfg.zip}`);
      log(`  Card:     ${maskCard(cfg.cardNumber)}`);
      log(`  Subtotal: $${cart.subtotal?.decimalValue || "?"}`);
      log(`  Shipping: $${cart.shippingTotal?.decimalValue || "?"}`);
      log(`  Tax:      $${cart.taxTotal?.decimalValue || "0.00"}`);
      log(`  Total:    $${bootstrap.grandTotal?.decimalValue || "?"}`);
      log("");
      log("Set dry run to 'n' to actually purchase.");
      return { success: true, data: { dryRun: true } };
    }

    const pm = await createStripePaymentMethod(bootstrap, cfg);
    const result = await submitOrder(session, bootstrap, pm, cfg);

    log("");
    if (result.error) {
      log("Order failed — see details above.");
      return { success: false, error: result.data };
    } else {
      log("Purchase complete!");
    }
    return { success: true, data: result };
  };

  return _als.run({ prefix }, runner);
}

// ─── MULTI-TASK ─────────────────────────────────────────────────────

async function runMultiTask(taskDefs) {
  const discoveries = {};
  for (const def of taskDefs) {
    if (discoveries[def.keyword]) continue;

    process.env.PRODUCT_SEARCH = def.keyword;
    CONFIG.itemId = "";
    CONFIG.sku = "";
    CONFIG.productUrl = "";

    await discoverProduct(createSession());

    discoveries[def.keyword] = {
      itemId: CONFIG.itemId,
      sku: CONFIG.sku,
      productUrl: CONFIG.productUrl,
    };
    log(`Product locked for "${def.keyword}": ${CONFIG.productUrl}`);
  }

  const taskList = [];
  for (const def of taskDefs) {
    for (let i = 0; i < def.count; i++) {
      taskList.push({
        keyword: def.keyword,
        profile: def.profile || null,
        profileName: def.profileName || "default",
        ...discoveries[def.keyword],
      });
    }
  }

  const totalTasks = taskList.length;
  log(`Launching ${totalTasks} checkout task(s) in parallel...\n`);

  const tasks = taskList.map((t, i) => {
    const label = `Task ${i + 1}: ${t.keyword} (${t.profileName})`;
    return runBot({
      prefix: label,
      itemId: t.itemId,
      sku: t.sku,
      productUrl: t.productUrl,
      profile: t.profile,
    }).catch((err) => {
      console.error(`[${label}] FAILED: ${err.message}`);
      return { success: false, error: err.message };
    });
  });

  const results = await Promise.allSettled(tasks);

  console.log("\n" + "=".repeat(50));
  console.log("  MULTI-TASK RESULTS");
  console.log("=".repeat(50));

  let ok = 0;
  for (let i = 0; i < results.length; i++) {
    const val = results[i].status === "fulfilled" ? results[i].value : { success: false };
    if (val?.success) ok++;
    console.log(`  Task ${i + 1} (${taskList[i].keyword}): ${val?.success ? "SUCCESS" : "FAILED"}`);
  }

  console.log(`\n  ${ok}/${totalTasks} tasks succeeded.`);
  console.log("=".repeat(50) + "\n");

  return results;
}

// ─── INTERACTIVE CLI ────────────────────────────────────────────────

function printMenu() {
  const card = maskCard(CONFIG.cardNumber) || "(not set)";
  const addr = CONFIG.address1
    ? `${CONFIG.address1}, ${CONFIG.city}, ${CONFIG.state} ${CONFIG.zip}`
    : "(not set)";
  const profiles = loadProfiles();
  const profileList = Object.keys(profiles);

  console.log(`
  ========================================
   Squarespace Checkout Bot
  ========================================
   Store:    ${CONFIG.storeUrl || "(not set)"}
   Category: ${CONFIG.storePath || "(not set)"}
   Name:     ${CONFIG.firstName} ${CONFIG.lastName}
   Email:    ${CONFIG.email || "(not set)"}
   Ship to:  ${addr}
   Card:     ${card}
   Profiles: ${profileList.length > 0 ? profileList.join(", ") : "(none)"}
  ----------------------------------------
   [1] Start bot (single task)
   [2] Start bot (multi-task)
   [3] Test mode (dry run demo)
   [4] Update credentials
   [5] Manage profiles
   [6] Exit
  ========================================
`);
}

// ─── MAIN ───────────────────────────────────────────────────────────

(async () => {
  // Headless mode: if all env vars are set, run immediately without CLI
  const hasTarget =
    CONFIG.productUrl || CONFIG.existingCartToken || process.env.PRODUCT_SEARCH || CONFIG.itemId;
  if (hasTarget && CONFIG.email && CONFIG.cardNumber) {
    try {
      const taskCount = parseInt(process.env.TASK_COUNT, 10) || 1;
      if (taskCount > 1) {
        const rawKeyword = process.env.PRODUCT_SEARCH || CONFIG.productUrl;
        const keywords = rawKeyword
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean);
        const copiesEach = Math.max(1, Math.ceil(taskCount / keywords.length));
        await runMultiTask(keywords.map((kw) => ({ keyword: kw, count: copiesEach })));
      } else {
        await runBot();
      }
    } catch (err) {
      console.error(`FATAL: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  // Interactive mode
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  if (!credentialsExist()) {
    console.log("\n  Welcome! Let's set up your checkout credentials.\n");
    await collectCredentials(rl);
  } else {
    const profiles = loadProfiles();
    if (!profiles["default"]) {
      profiles["default"] = profileFromConfig();
      saveProfiles(profiles);
    }
  }

  while (true) {
    printMenu();
    const choice = await ask(rl, "Choose", "1");

    if (choice === "1") {
      const profiles = loadProfiles();
      const profileNames = Object.keys(profiles);

      console.log(`
  The bot searches ${CONFIG.storeUrl}${CONFIG.storePath} for recent
  products matching your keyword. It only looks at listings
  added within the last few days (to avoid matching old items).
  If the drop isn't live yet, it keeps checking every few
  seconds until it appears, then instantly checks out.
  Spaces don't matter — "kitty craft" and "kittycraft" both work.
  Use "*" to match any product.
`);
      let selectedProfile = null;
      if (profileNames.length > 1) {
        console.log("  Available profiles:");
        for (const name of profileNames)
          console.log(`    ${printProfileSummary(name, profiles[name])}`);
        console.log("");
        const profileName = await ask(rl, "Profile", "default");
        if (profiles[profileName]) {
          selectedProfile = profiles[profileName];
          console.log(`  Using profile: ${profileName}\n`);
        } else {
          console.log(`  Profile "${profileName}" not found. Using default.\n`);
          selectedProfile = profiles["default"] || null;
        }
      }

      const keyword = await ask(rl, "Search keyword");
      if (!keyword) {
        console.log("\n  Keyword is required.\n");
        continue;
      }
      const scanDays = parseInt(
        await ask(rl, "Only look at products added in the last N days", "7"),
        10,
      );
      process.env.SCAN_DAYS = String(scanDays);
      CONFIG.pollInterval = parseInt(
        await ask(rl, "Poll interval (seconds between checks)", "5"),
        10,
      );
      CONFIG.maxPrice = parseFloat(
        await ask(rl, "Max price safety limit ($, 0 = no limit)", String(CONFIG.maxPrice || 0)),
      );
      const dr = await ask(rl, "Dry run? Test without buying (y/n)", "n");
      CONFIG.dryRun = dr.toLowerCase().startsWith("y");
      process.env.PRODUCT_SEARCH = keyword;
      CONFIG.itemId = "";
      CONFIG.sku = "";
      CONFIG.productUrl = "";
      rl.close();
      try {
        await runBot({ profile: selectedProfile });
      } catch (err) {
        console.error(`FATAL: ${err.message}`);
        process.exit(1);
      }
      return;
    } else if (choice === "2") {
      const profiles = loadProfiles();
      const profileNames = Object.keys(profiles);
      if (profileNames.length === 0) {
        console.log("\n  No profiles. Create one first (option 4).\n");
        continue;
      }

      console.log(`
  Multi-task mode: run multiple checkouts in parallel.
  Each task searches for a keyword, waits for the drop,
  and checks out independently. You can assign different
  profiles to different tasks.

  Available profiles:`);
      for (const name of profileNames)
        console.log(`    ${printProfileSummary(name, profiles[name])}`);

      console.log("\n  Set up each task. Type 'done' when finished.\n");
      const taskDefs = [];
      let taskNum = 1;
      while (true) {
        console.log(`  --- Task ${taskNum} ---`);
        const kw = await ask(rl, "  Keyword (or 'done')");
        if (kw.toLowerCase() === "done") break;
        if (!kw) continue;
        const profileName = await ask(rl, "  Profile", "default");
        if (!profiles[profileName]) {
          console.log(`    Not found. Available: ${profileNames.join(", ")}`);
          continue;
        }
        const copies = parseInt(await ask(rl, "  Parallel copies", "1"), 10);
        taskDefs.push({
          keyword: kw,
          count: Math.max(1, copies),
          profile: profiles[profileName],
          profileName,
        });
        taskNum++;
      }

      if (taskDefs.length === 0) {
        console.log("\n  No tasks defined.\n");
        continue;
      }
      const scanDays = parseInt(
        await ask(rl, "Only look at products added in the last N days", "7"),
        10,
      );
      process.env.SCAN_DAYS = String(scanDays);
      CONFIG.pollInterval = parseInt(
        await ask(rl, "Poll interval (seconds between checks)", "5"),
        10,
      );
      CONFIG.maxPrice = parseFloat(
        await ask(rl, "Max price safety limit ($, 0 = no limit)", String(CONFIG.maxPrice || 0)),
      );
      const dr = await ask(rl, "Dry run? Test without buying (y/n)", "n");
      CONFIG.dryRun = dr.toLowerCase().startsWith("y");

      console.log("\n  Task summary:");
      for (const td of taskDefs)
        console.log(`    "${td.keyword}" x${td.count} (profile: ${td.profileName})`);
      const confirm = await ask(rl, "\n  Launch? (y/n)", "y");
      if (!confirm.toLowerCase().startsWith("y")) continue;
      rl.close();
      try {
        await runMultiTask(taskDefs);
      } catch (err) {
        console.error(`FATAL: ${err.message}`);
        process.exit(1);
      }
      return;
    } else if (choice === "3") {
      if (!CONFIG.storeUrl) {
        console.log("\n  Set up your store first (option 4).\n");
        continue;
      }
      console.log(`
  Running a dry run test against ${CONFIG.storeUrl}.
  This uses dummy info — nothing will be charged.
  It picks the first available product from ${CONFIG.storePath || "/"}.
`);

      const testCfg = {
        email: "test@example.com",
        firstName: "Test",
        lastName: "User",
        phone: "5551234567",
        address1: "123 Test St",
        address2: "",
        city: "Scottsdale",
        state: "AZ",
        zip: "85251",
        country: "US",
        cardNumber: "4242424242424242",
        cardExpMonth: 12,
        cardExpYear: 2027,
        cardCvc: "123",
      };

      Object.assign(CONFIG, testCfg);
      CONFIG.dryRun = true;
      CONFIG.pollInterval = 5;
      process.env.SCAN_DAYS = "365";
      process.env.PRODUCT_SEARCH = "*";
      CONFIG.itemId = "";
      CONFIG.sku = "";
      CONFIG.productUrl = "";

      rl.close();
      console.log("");

      try {
        await runBot();
        console.log("\n  Test complete! Everything is working.");
        console.log("  When you're ready for a real drop, run the bot again");
        console.log("  and use option [1] or [2] with dry run set to 'n'.\n");
      } catch (err) {
        console.error(`FATAL: ${err.message}`);
        process.exit(1);
      }
      return;
    } else if (choice === "4") {
      await collectCredentials(rl);
    } else if (choice === "5") {
      const profiles = loadProfiles();
      const names = Object.keys(profiles);
      console.log("\n  Current profiles:");
      if (names.length === 0) {
        console.log("    (none)");
      } else {
        for (const n of names) console.log(`    ${printProfileSummary(n, profiles[n])}`);
      }
      console.log("\n  [a] Add profile  [d] Delete profile  [b] Back\n");
      const action = await ask(rl, "Action", "b");
      if (action.toLowerCase() === "a") {
        const name = await ask(rl, "Profile name (e.g. 'friend', 'alt')");
        if (!name) continue;
        profiles[name] = await collectProfile(rl, profiles[name] || {});
        saveProfiles(profiles);
        console.log(`\n  Profile "${name}" saved.\n`);
      } else if (action.toLowerCase() === "d") {
        const name = await ask(rl, "Profile name to delete");
        if (name && profiles[name]) {
          delete profiles[name];
          saveProfiles(profiles);
          console.log("\n  Deleted.\n");
        } else {
          console.log("\n  Not found.\n");
        }
      }
    } else if (choice === "6") {
      rl.close();
      return;
    }
  }
})();
