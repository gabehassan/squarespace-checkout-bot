const axios = require("axios");
const cheerio = require("cheerio");
const { CONFIG, log, die } = require("./config");

// Step 1: Visit a page to get the crumb (CSRF) token from cookies
async function getCrumbToken(session) {
  log("Step 1: Getting session cookies & crumb...");

  const url = CONFIG.productUrl || "/";
  const res = await session.get(url);
  if (res.status >= 400) die(`Product page returned ${res.status}`);

  const crumb = session._cookieJar["crumb"];
  if (!crumb) {
    const $ = cheerio.load(res.data);
    const metaCrumb =
      $('meta[name="crumb"]').attr("content") || $('input[name="crumb"]').val();
    if (metaCrumb) {
      session._cookieJar["crumb"] = metaCrumb;
      return metaCrumb;
    }
    die("Could not find crumb token.");
  }

  log(`  Crumb: ${crumb.substring(0, 20)}...`);
  return crumb;
}

// Step 2: Add item to shopping cart
async function addToCart(session, crumb, cfg = CONFIG) {
  log("Step 2: Adding item to cart...");

  if (cfg.existingCartToken) {
    log(`  Using existing cartToken: ${cfg.existingCartToken.substring(0, 15)}...`);
    return cfg.existingCartToken;
  }

  if (!cfg.itemId || !cfg.sku) die("ITEM_ID and SKU are required.");

  const res = await session.post(
    `/api/commerce/shopping-cart/entries?crumb=${encodeURIComponent(crumb)}`,
    { itemId: cfg.itemId, sku: cfg.sku, quantity: cfg.quantity, additionalFields: "null" },
    { headers: { "Content-Type": "application/json", "x-requested-with": "XMLHttpRequest" } },
  );

  if (res.status >= 400) die(`Add-to-cart failed (${res.status}): ${JSON.stringify(res.data)}`);

  const cartToken = res.data?.cartToken || res.data?.shoppingCart?.cartToken;
  if (!cartToken) die("No cartToken in response.");

  log(`  Cart created: ${cartToken.substring(0, 15)}...`);
  return cartToken;
}

// Step 3: Load checkout page and parse bootstrap JSON (Stripe keys, cart state)
async function getCheckoutBootstrap(session, cartToken) {
  log("Step 3: Loading checkout bootstrap...");

  const res = await session.get(`/checkout?cartToken=${cartToken}`);
  if (res.status >= 400) die(`Checkout page returned ${res.status}`);

  const match = res.data.match(/<script[^>]*id="bootstrap"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) die("Could not find bootstrap JSON in checkout page.");

  let bootstrap;
  try {
    bootstrap = JSON.parse(match[1]);
  } catch (e) {
    die(`Bad bootstrap JSON: ${e.message}`);
  }

  const ctx = bootstrap.checkoutBaseContext || {};
  const cfg = bootstrap.checkoutConfig || {};
  const cart = bootstrap.shoppingCart || {};

  const result = {
    xsrfToken: cfg.xsrfToken,
    websiteId: ctx.websiteId,
    stripeKey: cfg.paymentConfig?.testMode
      ? ctx.stripeTestPublicApiKey
      : ctx.stripeLivePublicApiKey,
    stripeUserId: ctx.stripeUserId,
    testMode: !!cfg.paymentConfig?.testMode,
    sqspPayments: !!cfg.paymentConfig?.sqspPaymentsAvailable,
    sqspMerchant: cfg.paymentConfig?.sqspPaymentsMerchantStripeAccountId || null,
    cart,
    cartToken: cart.cartToken,
    fulfillmentOptions: cart.fulfillmentOptions || [],
    amountDue: cart.amountDue,
    grandTotal: cart.grandTotal,
  };

  log("  Bootstrap loaded");
  log(`    Stripe: ${result.stripeKey?.substring(0, 25)}... | SQSP Payments: ${result.sqspPayments}`);
  log(`    Total: $${cart.grandTotal?.decimalValue} ${cart.grandTotal?.currencyCode}`);

  if (result.fulfillmentOptions.length > 0) {
    for (const opt of result.fulfillmentOptions) {
      log(`    - ${opt.name} (${opt.rateType}) — $${opt.price?.decimalValue}`);
    }
  }

  return result;
}

// Step 4: Set shipping address on the cart to get fulfillment options
async function updateShippingLocation(session, bootstrap, cfg = CONFIG) {
  log("Step 4: Setting shipping location...");

  const xsrf = bootstrap.crumb;
  const res = await session.put(
    `/api/3/commerce/cart/${bootstrap.cartToken}/shipping/location`,
    {
      line1: cfg.address1,
      line2: cfg.address2,
      city: cfg.city,
      region: cfg.state,
      postalCode: cfg.zip,
      country: cfg.country,
    },
    { headers: { "Content-Type": "application/json", "x-csrf-token": xsrf } },
  );

  if (res.status >= 400) {
    log(`  Warning: ${res.status} — ${JSON.stringify(res.data?.message || res.data)}`);
  } else {
    bootstrap.cart = res.data;
    bootstrap.fulfillmentOptions = res.data.fulfillmentOptions || [];
    bootstrap.amountDue = res.data.amountDue;
    bootstrap.grandTotal = res.data.grandTotal;
    log(`  Shipping location set (${bootstrap.fulfillmentOptions.length} options)`);
    for (const opt of bootstrap.fulfillmentOptions) {
      log(`    - ${opt.name} — $${opt.price?.decimalValue}${opt.isPickup ? " [PICKUP]" : ""}`);
    }
  }

  return bootstrap;
}

// Step 5: Select the cheapest shipping option (never pickup)
async function selectFulfillmentOption(session, bootstrap) {
  log("Step 5: Selecting fulfillment option...");

  const options = bootstrap.fulfillmentOptions;
  if (!options || options.length === 0) {
    log("  No fulfillment options. Skipping.");
    return bootstrap;
  }

  const shippingOptions = options.filter((o) => !o.isPickup);
  if (shippingOptions.length === 0) {
    log("  ERROR: No shipping options available (only pickup listed). Cannot proceed.");
    log("  Make sure your address/zip is complete so the store can calculate shipping rates.");
    return bootstrap;
  }

  const selected = shippingOptions.sort(
    (a, b) => (parseFloat(a.price?.decimalValue) || 0) - (parseFloat(b.price?.decimalValue) || 0),
  )[0];

  log(`  Selecting: "${selected.name}" — $${selected.price?.decimalValue}`);

  const xsrf = bootstrap.crumb;
  const res = await session.put(
    `/api/3/commerce/cart/${bootstrap.cartToken}/shipping/option`,
    { key: selected.key },
    { headers: { "Content-Type": "application/json", "x-csrf-token": xsrf } },
  );

  if (res.status >= 400) {
    log(`  Warning: ${res.status}`);
  } else {
    bootstrap.cart = res.data;
    bootstrap.amountDue = res.data.amountDue || bootstrap.amountDue;
    bootstrap.grandTotal = res.data.grandTotal || bootstrap.grandTotal;
    log(`  Option selected — total: $${bootstrap.grandTotal?.decimalValue}`);
  }

  return bootstrap;
}

// Step 6: Create a Stripe PaymentMethod from card details (card data goes to Stripe, not the store)
async function createStripePaymentMethod(bootstrap, cfg = CONFIG) {
  log("Step 6: Creating Stripe PaymentMethod...");

  if (!cfg.cardNumber) die("Card number is required.");
  if (!bootstrap.stripeKey) die("No Stripe key found.");

  const params = new URLSearchParams();
  params.append("type", "card");
  params.append("card[number]", cfg.cardNumber);
  params.append("card[exp_month]", cfg.cardExpMonth.toString());
  params.append("card[exp_year]", cfg.cardExpYear.toString());
  params.append("card[cvc]", cfg.cardCvc);
  params.append("billing_details[name]", `${cfg.firstName} ${cfg.lastName}`);
  params.append("billing_details[email]", cfg.email);
  params.append("billing_details[address][line1]", cfg.address1);
  params.append("billing_details[address][line2]", cfg.address2 || "");
  params.append("billing_details[address][city]", cfg.city);
  params.append("billing_details[address][state]", cfg.state);
  params.append("billing_details[address][postal_code]", cfg.zip);
  params.append("billing_details[address][country]", cfg.country);
  if (cfg.phone) params.append("billing_details[phone]", cfg.phone);

  const res = await axios.post("https://api.stripe.com/v1/payment_methods", params.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${bootstrap.stripeKey}`,
    },
    validateStatus: (s) => s < 500,
  });

  if (res.status >= 400) {
    const err = res.data?.error || res.data || {};
    die(
      `Stripe failed (${res.status}): ${err.code || err.type || "UNKNOWN"} — ${err.message || JSON.stringify(err)}`,
    );
  }

  log(`  PaymentMethod: ${res.data.id} (${res.data.card?.brand} *${res.data.card?.last4})`);
  return res.data;
}

// Step 7: Submit the order to Squarespace
async function submitOrder(session, bootstrap, paymentMethod, cfg = CONFIG) {
  log("Step 7: Submitting order...");

  const shippingAddress = {
    firstName: cfg.firstName,
    lastName: cfg.lastName,
    line1: cfg.address1,
    line2: cfg.address2 || "",
    city: cfg.city,
    region: cfg.state,
    postalCode: cfg.zip,
    country: cfg.country,
    phoneNumber: cfg.phone || "",
  };

  const cardType = (paymentMethod.card?.brand || "visa").toUpperCase();
  let paymentToken;
  if (bootstrap.sqspPayments) {
    paymentToken = {
      token: paymentMethod.id,
      type: "SQSP_PAYMENTS",
      isPaymentRequired: true,
      isSqspPaymentsEnabled: true,
      stripePaymentTokenType: null,
      sqspPaymentsPaymentMethodType: "CARD",
      sqspPaymentsCheckoutSubmitType: "INITIAL_SUBMISSION",
      cardType,
      chargeId: null,
    };
  } else {
    paymentToken = {
      token: paymentMethod.id,
      type: "STRIPE",
      isPaymentRequired: true,
      isSqspPaymentsEnabled: false,
      stripePaymentTokenType: "PAYMENT_METHOD_ID",
      sqspPaymentsPaymentMethodType: "CARD",
      sqspPaymentsCheckoutSubmitType: "INITIAL_SUBMISSION",
      cardType,
      chargeId: null,
    };
  }

  const orderPayload = {
    email: cfg.email,
    subscribeToList: false,
    shippingAddress,
    billToShippingAddress: true,
    billingAddress: shippingAddress,
    createNewUser: false,
    newUserPassword: null,
    saveShippingAddress: false,
    makeDefaultShippingAddress: false,
    customFormData: null,
    shippingAddressId: null,
    proposedAmountDue: bootstrap.amountDue || bootstrap.grandTotal,
    cartToken: bootstrap.cartToken,
    paymentToken,
    savePaymentInfo: false,
    makeDefaultPayment: false,
    paymentCardId: null,
    universalPaymentElementEnabled: true,
  };

  const xsrf = bootstrap.crumb;
  const res = await session.post("/api/2/commerce/orders", orderPayload, {
    headers: { "Content-Type": "application/json", "x-csrf-token": xsrf },
  });

  if (res.status >= 400) {
    const data = res.data || {};
    log(`  Order failed (${res.status})`);
    log(`    Type: ${data.failureType || "UNKNOWN"} | Key: ${data.errorKey || "N/A"}`);
    log(`    Message: ${JSON.stringify(data.message || data)}`);
    if (data.failureType === "EXTRA_PAYMENT_AUTHENTICATION_REQUIRED") {
      log("  3D Secure required — this card needs browser-based auth.");
    }
    return { error: true, data };
  }

  log("  ORDER SUBMITTED SUCCESSFULLY!");
  log(`    Order ID: ${res.data?.orderId || "N/A"}`);
  return res.data;
}

module.exports = {
  getCrumbToken,
  addToCart,
  getCheckoutBootstrap,
  updateShippingLocation,
  selectFulfillmentOption,
  createStripePaymentMethod,
  submitOrder,
};
