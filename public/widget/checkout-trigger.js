(function () {
  "use strict";

  var VERSION = "1.0.1-nuvemshop-checkout-adapter";

  if (window.__IDADEID_CHECKOUT_TRIGGER_ACTIVE__) {
    return;
  }

  window.__IDADEID_CHECKOUT_TRIGGER_ACTIVE__ = true;

  var script = getCurrentScript();
  var config = readConfig(script);

  var STATE_PREFIX = "idadeid_checkout:";
  var VERIFIED_KEY = STATE_PREFIX + "verified:" + (config.siteKey || config.siteId || "unknown");
  var PENDING_KEY = STATE_PREFIX + "pending:" + (config.siteKey || config.siteId || "unknown");
  var IN_PROGRESS_KEY = STATE_PREFIX + "in_progress:" + (config.siteKey || config.siteId || "unknown");

  log("carregado", {
    version: VERSION,
    siteKey: mask(config.siteKey),
    siteId: config.siteId || null,
    platform: config.platform || null,
    storeId: config.storeId || null
  });

  boot();

  function boot() {
    if (!config.siteKey && !config.siteId) {
      warn("data-site-key/data-site-id ausente. O trigger foi carregado, mas não tem identificação do site.");
    }

    var markedVerified = markVerifiedFromReturnUrl();

    document.addEventListener("click", onClickCapture, true);
    document.addEventListener("submit", onSubmitCapture, true);

    if (markedVerified || isVerified()) {
      setTimeout(function () {
        resumePendingCheckoutIfAny();
      }, 250);
    }
  }

  function onClickCapture(event) {
    if (window.__IDADEID_CHECKOUT_BYPASS__) {
      return;
    }

    var target = event.target;

    if (!target || !target.closest) {
      return;
    }

    var element = target.closest(
      'a, button, input, [role="button"], [onclick], [data-component="cart.checkout-button"]'
    );

    if (!element) {
      return;
    }

    if (!isCheckoutIntentElement(element)) {
      return;
    }

    if (isVerified()) {
      log("checkout liberado: usuário já verificado", {
        reason: detectReason(element),
      });
      return;
    }

    interceptCheckout(event, {
      element: element,
      form: getRelatedForm(element),
      reason: detectReason(element) || "checkout_click",
    });
  }

  function onSubmitCapture(event) {
    if (window.__IDADEID_CHECKOUT_BYPASS__) {
      return;
    }

    var form = event.target;

    if (!form || !isCheckoutIntentForm(form)) {
      return;
    }

    if (isVerified()) {
      log("submit liberado: usuário já verificado", {
        reason: "checkout_form_verified",
      });
      return;
    }

    interceptCheckout(event, {
      element:
        event.submitter ||
        form.querySelector(
          'input[name="go_to_checkout"], [data-component="cart.checkout-button"], button[type="submit"], input[type="submit"]'
        ),
      form: form,
      reason: "checkout_form_submit",
    });
  }

  function interceptCheckout(event, context) {
    try {
      event.preventDefault();
      event.stopPropagation();

      if (event.stopImmediatePropagation) {
        event.stopImmediatePropagation();
      }
    } catch (err) {}

    savePendingCheckout(context);
    setStorage(IN_PROGRESS_KEY, String(Date.now()));

    showBlockingOverlay();

    log("checkout interceptado", {
      reason: context.reason,
      platform: config.platform,
      storeId: config.storeId,
    });

    openVerificationFlow();
  }

  function isCheckoutIntentElement(element) {
    if (!element) {
      return false;
    }

    if (isAddToCartElement(element)) {
      return false;
    }

    if (isNuvemshopCheckoutButton(element)) {
      return true;
    }

    var text = normalizeText(
      element.innerText ||
        element.textContent ||
        element.value ||
        element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        ""
    );

    var href = normalizeText(element.href || element.getAttribute("href") || "");
    var className = normalizeText(typeof element.className === "string" ? element.className : "");
    var id = normalizeText(element.id || "");
    var name = normalizeText(element.getAttribute("name") || "");
    var dataComponent = normalizeText(element.getAttribute("data-component") || "");
    var onclick = normalizeText(element.getAttribute("onclick") || "");

    var haystack = [
      text,
      href,
      className,
      id,
      name,
      dataComponent,
      onclick,
    ].join(" ");

    if (
      haystack.indexOf("iniciar compra") >= 0 ||
      haystack.indexOf("finalizar compra") >= 0 ||
      haystack.indexOf("finalizar pedido") >= 0 ||
      haystack.indexOf("ir para o checkout") >= 0 ||
      haystack.indexOf("checkout") >= 0
    ) {
      return true;
    }

    if (
      href.indexOf("/checkout") >= 0 ||
      href.indexOf("/cart/checkout") >= 0 ||
      href.indexOf("/carrinho/checkout") >= 0
    ) {
      return true;
    }

    return false;
  }

  function isCheckoutIntentForm(form) {
    if (!form) {
      return false;
    }

    if (isNuvemshopCheckoutForm(form)) {
      return true;
    }

    var action = normalizeText(form.getAttribute("action") || "");

    if (
      action.indexOf("/checkout") >= 0 ||
      action.indexOf("/cart/checkout") >= 0 ||
      action.indexOf("/carrinho/checkout") >= 0
    ) {
      return true;
    }

    return false;
  }

  function isNuvemshopCheckoutButton(element) {
    if (!element) {
      return false;
    }

    var direct =
      safeMatches(element, 'input[name="go_to_checkout"]') ||
      safeMatches(element, '[data-component="cart.checkout-button"]') ||
      safeMatches(element, '#ajax-cart-submit-div input[type="submit"]');

    if (direct) {
      return true;
    }

    var closest =
      safeClosest(element, 'input[name="go_to_checkout"]') ||
      safeClosest(element, '[data-component="cart.checkout-button"]') ||
      safeClosest(element, "#ajax-cart-submit-div");

    return Boolean(closest);
  }

  function isNuvemshopCheckoutForm(form) {
    if (!form) {
      return false;
    }

    var action = normalizeText(form.getAttribute("action") || "");
    var dataStore = normalizeText(form.getAttribute("data-store") || "");
    var className = normalizeText(typeof form.className === "string" ? form.className : "");

    var hasCheckoutButton = Boolean(
      form.querySelector(
        'input[name="go_to_checkout"], [data-component="cart.checkout-button"]'
      )
    );

    var isCartForm =
      dataStore === "cart-form" ||
      className.indexOf("js-ajax-cart-panel") >= 0;

    return isCartForm && hasCheckoutButton && action.indexOf("/comprar") >= 0;
  }

  function isAddToCartElement(element) {
    if (!element) {
      return false;
    }

    var form = getRelatedForm(element);
    var formAction = form ? normalizeText(form.getAttribute("action") || "") : "";
    var className = normalizeText(typeof element.className === "string" ? element.className : "");
    var dataComponent = normalizeText(element.getAttribute("data-component") || "");
    var name = normalizeText(element.getAttribute("name") || "");
    var value = normalizeText(element.value || "");

    if (name === "go_to_checkout") {
      return false;
    }

    if (dataComponent === "cart.checkout-button") {
      return false;
    }

    if (
      className.indexOf("js-addtocart") >= 0 ||
      className.indexOf("btn-add-to-cart") >= 0 ||
      dataComponent.indexOf("product.add-to-cart") >= 0
    ) {
      return true;
    }

    if (
      form &&
      form.id === "product_form" &&
      formAction.indexOf("/comprar") >= 0 &&
      !form.querySelector('input[name="go_to_checkout"], [data-component="cart.checkout-button"]')
    ) {
      return true;
    }

    if (value === "comprar" && formAction.indexOf("/comprar") >= 0) {
      return true;
    }

    return false;
  }

  function detectReason(element) {
    if (isNuvemshopCheckoutButton(element)) {
      return "nuvemshop_cart_checkout_button";
    }

    var form = getRelatedForm(element);

    if (isNuvemshopCheckoutForm(form)) {
      return "nuvemshop_cart_checkout_form";
    }

    return "generic_checkout_intent";
  }

  function getRelatedForm(element) {
    if (!element) {
      return null;
    }

    if (element.tagName === "FORM") {
      return element;
    }

    if (element.closest) {
      return element.closest("form");
    }

    return null;
  }

  function savePendingCheckout(context) {
    var form = context.form;
    var element = context.element;

    var pending = {
      version: VERSION,
      created_at: Date.now(),
      reason: context.reason || null,
      platform: config.platform || null,
      store_id: config.storeId || null,
      site_id: config.siteId || null,
      site_key: config.siteKey || null,
      page_url: window.location.href,
      form_action: form ? form.getAttribute("action") || null : null,
      form_method: form ? form.getAttribute("method") || "post" : null,
      is_nuvemshop_cart_form: Boolean(isNuvemshopCheckoutForm(form)),
      element_name: element ? element.getAttribute("name") || null : null,
      element_value: element ? element.value || element.innerText || null : null,
      element_component: element ? element.getAttribute("data-component") || null : null,
    };

    setStorage(PENDING_KEY, JSON.stringify(pending));
  }

  function resumePendingCheckoutIfAny() {
    var pending = getPendingCheckout();

    if (!pending) {
      return;
    }

    if (!isVerified()) {
      return;
    }

    removeStorage(PENDING_KEY);
    removeStorage(IN_PROGRESS_KEY);

    log("retomando checkout pendente", {
      reason: pending.reason,
      platform: pending.platform,
    });

    window.__IDADEID_CHECKOUT_BYPASS__ = true;

    setTimeout(function () {
      if (pending.is_nuvemshop_cart_form || pending.platform === "nuvemshop") {
        resumeNuvemshopCheckout();
        return;
      }

      resumeGenericCheckout(pending);
    }, 350);
  }

  function resumeNuvemshopCheckout() {
    var form =
      document.querySelector('form.js-ajax-cart-panel[data-store="cart-form"]') ||
      document.querySelector("form.js-ajax-cart-panel") ||
      document.querySelector('form[data-store="cart-form"]');

    if (form) {
      ensureHiddenInput(form, "go_to_checkout", "Iniciar Compra");

      try {
        HTMLFormElement.prototype.submit.call(form);
        return;
      } catch (err) {
        try {
          form.submit();
          return;
        } catch (err2) {}
      }
    }

    var fallbackForm = document.createElement("form");
    fallbackForm.method = "post";
    fallbackForm.action = "/comprar/";
    fallbackForm.style.display = "none";

    ensureHiddenInput(fallbackForm, "go_to_checkout", "Iniciar Compra");

    document.body.appendChild(fallbackForm);

    try {
      HTMLFormElement.prototype.submit.call(fallbackForm);
    } catch (err) {
      window.location.href = "/comprar/";
    }
  }

  function resumeGenericCheckout(pending) {
    if (pending && pending.form_action) {
      var form = document.createElement("form");
      form.method = pending.form_method || "post";
      form.action = pending.form_action;
      form.style.display = "none";
      document.body.appendChild(form);

      try {
        HTMLFormElement.prototype.submit.call(form);
        return;
      } catch (err) {}
    }

    window.location.reload();
  }

  function openVerificationFlow() {
    var verificationUrl = buildVerificationUrl();

    log("abrindo verificação", {
      url: verificationUrl,
    });

    window.location.assign(verificationUrl);
  }

  function buildVerificationUrl() {
    var base =
      config.verifyUrl ||
      (config.siteId
        ? "https://verificar.idadeid.com.br/g/" + encodeURIComponent(config.siteId)
        : "https://verificar.idadeid.com.br");

    var url = new URL(base, window.location.href);

    var returnUrl = new URL(window.location.href);
    returnUrl.searchParams.set("idadeid_checkout_return", "1");

    if (config.siteKey) {
      returnUrl.searchParams.set("idadeid_site_key", config.siteKey);
      url.searchParams.set("site_key", config.siteKey);
      url.searchParams.set("public_key", config.siteKey);
    }

    if (config.siteId) {
      url.searchParams.set("site_id", config.siteId);
    }

    if (config.tenantId) {
      url.searchParams.set("tenant_id", config.tenantId);
    }

    if (config.storeId) {
      url.searchParams.set("store_id", config.storeId);
    }

    if (config.storeDomain) {
      url.searchParams.set("store_domain", config.storeDomain);
    }

    url.searchParams.set("source", "checkout");
    url.searchParams.set("platform", config.platform || "unknown");
    url.searchParams.set("mode", "checkout");
    url.searchParams.set("returnTo", returnUrl.toString());
    url.searchParams.set("return_to", returnUrl.toString());
    url.searchParams.set("redirect_uri", returnUrl.toString());

    return url.toString();
  }

  function markVerifiedFromReturnUrl() {
    var params = new URLSearchParams(window.location.search);

    var hasReturnFlag = params.get("idadeid_checkout_return") === "1";

    var approved =
      params.get("idadeid_verified") === "1" ||
      params.get("idadeid_access") === "granted" ||
      params.get("idadeid_status") === "approved" ||
      params.get("status") === "approved" ||
      Boolean(params.get("idadeid_access_code")) ||
      Boolean(params.get("access_code")) ||
      Boolean(params.get("idadeid_code"));

    if (!hasReturnFlag && !approved) {
      return false;
    }

    if (!approved) {
      return false;
    }

    setVerified();

    try {
      var clean = new URL(window.location.href);
      [
        "idadeid_checkout_return",
        "idadeid_site_key",
        "idadeid_verified",
        "idadeid_access",
        "idadeid_status",
        "status",
        "idadeid_access_code",
        "access_code",
        "idadeid_code",
      ].forEach(function (key) {
        clean.searchParams.delete(key);
      });

      window.history.replaceState({}, document.title, clean.toString());
    } catch (err) {}

    return true;
  }

  function setVerified() {
    var expiresAt = Date.now() + 1000 * 60 * 60 * 12;

    setStorage(
      VERIFIED_KEY,
      JSON.stringify({
        verified: true,
        created_at: Date.now(),
        expires_at: expiresAt,
      })
    );
  }

  function isVerified() {
    var raw = getStorage(VERIFIED_KEY);

    if (!raw) {
      return false;
    }

    try {
      var parsed = JSON.parse(raw);

      if (!parsed.verified) {
        return false;
      }

      if (parsed.expires_at && Number(parsed.expires_at) < Date.now()) {
        removeStorage(VERIFIED_KEY);
        return false;
      }

      return true;
    } catch (err) {
      removeStorage(VERIFIED_KEY);
      return false;
    }
  }

  function getPendingCheckout() {
    var raw = getStorage(PENDING_KEY);

    if (!raw) {
      return null;
    }

    try {
      var pending = JSON.parse(raw);
      var age = Date.now() - Number(pending.created_at || 0);

      if (age > 1000 * 60 * 30) {
        removeStorage(PENDING_KEY);
        return null;
      }

      return pending;
    } catch (err) {
      removeStorage(PENDING_KEY);
      return null;
    }
  }

  function showBlockingOverlay() {
    if (document.getElementById("idadeid-checkout-overlay")) {
      return;
    }

    var overlay = document.createElement("div");
    overlay.id = "idadeid-checkout-overlay";
    overlay.setAttribute("aria-live", "polite");

    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.zIndex = "2147483647";
    overlay.style.background = "rgba(255, 255, 255, 0.82)";
    overlay.style.backdropFilter = "blur(4px)";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.fontFamily =
      "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";

    overlay.innerHTML =
      '<div style="width:min(420px,calc(100vw - 32px));background:#fff;border:1px solid rgba(15,23,42,.12);box-shadow:0 20px 60px rgba(15,23,42,.14);border-radius:24px;padding:28px;text-align:center;color:#0f172a;">' +
      '<div style="font-weight:800;font-size:18px;margin-bottom:8px;">IdadeID</div>' +
      '<div style="font-weight:700;font-size:20px;margin-bottom:8px;">Verificação necessária</div>' +
      '<div style="font-size:14px;color:#475569;line-height:1.45;">Você será redirecionado para validar a idade antes de continuar a compra.</div>' +
      "</div>";

    document.body.appendChild(overlay);
  }

  function ensureHiddenInput(form, name, value) {
    var input = form.querySelector('input[name="' + cssEscape(name) + '"]');

    if (!input) {
      input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      form.appendChild(input);
    }

    input.value = value;
  }

  function readConfig(scriptEl) {
    return {
      siteKey: getAttr(scriptEl, "site-key") || getAttr(scriptEl, "public-key"),
      siteId: getAttr(scriptEl, "site-id"),
      tenantId: getAttr(scriptEl, "tenant-id"),
      storeId: getAttr(scriptEl, "store-id"),
      storeDomain: getAttr(scriptEl, "store-domain"),
      platform: getAttr(scriptEl, "platform") || detectPlatform(),
      verifyUrl: getAttr(scriptEl, "verify-url"),
    };
  }

  function getCurrentScript() {
    if (document.currentScript) {
      return document.currentScript;
    }

    return (
      document.querySelector('script[data-idadeid-loader="checkout"]') ||
      document.querySelector('script[src*="checkout-trigger.js"]') ||
      null
    );
  }

  function getAttr(el, name) {
    if (!el || !el.getAttribute) {
      return "";
    }

    return (
      el.getAttribute("data-" + name) ||
      el.getAttribute(name) ||
      ""
    );
  }

  function detectPlatform() {
    var host = String(window.location.hostname || "").toLowerCase();

    if (
      host.indexOf("lojavirtualnuvem.com.br") >= 0 ||
      host.indexOf("mitiendanube.com") >= 0 ||
      host.indexOf("tiendanube.com") >= 0
    ) {
      return "nuvemshop";
    }

    if (host.indexOf("myshopify.com") >= 0) {
      return "shopify";
    }

    return "custom";
  }

  function safeMatches(el, selector) {
    try {
      return Boolean(el && el.matches && el.matches(selector));
    } catch (err) {
      return false;
    }
  }

  function safeClosest(el, selector) {
    try {
      return el && el.closest ? el.closest(selector) : null;
    } catch (err) {
      return null;
    }
  }

  function normalizeText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function cssEscape(value) {
    if (window.CSS && window.CSS.escape) {
      return window.CSS.escape(value);
    }

    return String(value).replace(/"/g, '\\"');
  }

  function setStorage(key, value) {
    try {
      window.sessionStorage.setItem(key, value);
      return;
    } catch (err) {}

    try {
      window.localStorage.setItem(key, value);
    } catch (err2) {}
  }

  function getStorage(key) {
    try {
      return window.sessionStorage.getItem(key) || window.localStorage.getItem(key);
    } catch (err) {
      return null;
    }
  }

  function removeStorage(key) {
    try {
      window.sessionStorage.removeItem(key);
    } catch (err) {}

    try {
      window.localStorage.removeItem(key);
    } catch (err2) {}
  }

  function log(message, data) {
    try {
      console.log("[IdadeID Checkout]", message, data || "");
    } catch (err) {}
  }

  function warn(message, data) {
    try {
      console.warn("[IdadeID Checkout]", message, data || "");
    } catch (err) {}
  }

  function mask(value) {
    if (!value) {
      return null;
    }

    var str = String(value);

    if (str.length <= 12) {
      return str;
    }

    return str.slice(0, 12) + "...";
  }
})();
