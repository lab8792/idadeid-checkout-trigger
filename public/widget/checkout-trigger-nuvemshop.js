(function () {
  "use strict";

  var VERSION = "1.0.0-nuvemshop-adapter";

  if (window.__IDADEID_NUVEMSHOP_CHECKOUT_TRIGGER_ACTIVE__) {
    return;
  }

  window.__IDADEID_NUVEMSHOP_CHECKOUT_TRIGGER_ACTIVE__ = true;

  var script = getCurrentScript();
  var config = readConfig(script);

  var STATE_PREFIX = "idadeid_nuvemshop_checkout:";
  var scopeKey = config.siteKey || config.siteId || config.storeId || "unknown";
  var VERIFIED_KEY = STATE_PREFIX + "verified:" + scopeKey;
  var PENDING_KEY = STATE_PREFIX + "pending:" + scopeKey;
  var IN_PROGRESS_KEY = STATE_PREFIX + "in_progress:" + scopeKey;

  log("loader Nuvemshop carregado", {
    version: VERSION,
    siteKey: mask(config.siteKey),
    siteId: config.siteId || null,
    storeId: config.storeId || null,
    storeDomain: config.storeDomain || null
  });

  boot();

  function boot() {
    document.addEventListener("click", onClickCapture, true);
    document.addEventListener("submit", onSubmitCapture, true);

    var returnedVerified = markVerifiedFromReturnUrl();

    if (returnedVerified || isVerified()) {
      setTimeout(function () {
        resumePendingCheckoutIfAny();
      }, 350);
    }
  }

  function onClickCapture(event) {
    if (window.__IDADEID_NUVEMSHOP_CHECKOUT_BYPASS__) {
      return;
    }

    var target = event.target;

    if (!target || !target.closest) {
      return;
    }

    var element = target.closest(
      'input[name="go_to_checkout"], [data-component="cart.checkout-button"], #ajax-cart-submit-div input[type="submit"], a, button, input, [role="button"]'
    );

    if (!element) {
      return;
    }

    if (!isNuvemshopCheckoutButton(element)) {
      return;
    }

    if (isVerified()) {
      log("checkout liberado: usuário já verificado", {
        reason: "nuvemshop_cart_checkout_button_verified"
      });
      return;
    }

    interceptCheckout(event, {
      element: element,
      form: getRelatedForm(element),
      reason: "nuvemshop_cart_checkout_button"
    });
  }

  function onSubmitCapture(event) {
    if (window.__IDADEID_NUVEMSHOP_CHECKOUT_BYPASS__) {
      return;
    }

    var form = event.target;

    if (!isNuvemshopCheckoutForm(form)) {
      return;
    }

    if (isVerified()) {
      log("submit liberado: usuário já verificado", {
        reason: "nuvemshop_cart_checkout_form_verified"
      });
      return;
    }

    interceptCheckout(event, {
      element:
        event.submitter ||
        form.querySelector(
          'input[name="go_to_checkout"], [data-component="cart.checkout-button"], input[type="submit"], button[type="submit"]'
        ),
      form: form,
      reason: "nuvemshop_cart_checkout_form"
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

    log("checkout Nuvemshop interceptado", {
      reason: context.reason,
      storeId: config.storeId || null,
      siteId: config.siteId || null
    });

    setTimeout(function () {
      window.location.assign(buildVerificationUrl());
    }, 180);
  }

  function isNuvemshopCheckoutButton(element) {
    if (!element) {
      return false;
    }

    if (
      safeMatches(element, 'input[name="go_to_checkout"]') ||
      safeMatches(element, '[data-component="cart.checkout-button"]') ||
      safeMatches(element, '#ajax-cart-submit-div input[type="submit"]')
    ) {
      return true;
    }

    var closest =
      safeClosest(element, 'input[name="go_to_checkout"]') ||
      safeClosest(element, '[data-component="cart.checkout-button"]') ||
      safeClosest(element, "#ajax-cart-submit-div");

    if (closest) {
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

    var form = getRelatedForm(element);

    return (
      isNuvemshopCheckoutForm(form) &&
      (text.indexOf("iniciar compra") >= 0 ||
        text.indexOf("finalizar compra") >= 0 ||
        text.indexOf("checkout") >= 0)
    );
  }

  function isNuvemshopCheckoutForm(form) {
    if (!form || !form.getAttribute) {
      return false;
    }

    var action = normalizeText(form.getAttribute("action") || "");
    var dataStore = normalizeText(form.getAttribute("data-store") || "");
    var className = normalizeText(
      typeof form.className === "string" ? form.className : ""
    );

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

  function getRelatedForm(element) {
    if (!element) {
      return null;
    }

    if (element.tagName === "FORM") {
      return element;
    }

    return element.closest ? element.closest("form") : null;
  }

  function savePendingCheckout(context) {
    var form = context.form;
    var element = context.element;

    var pending = {
      version: VERSION,
      created_at: Date.now(),
      reason: context.reason || null,
      platform: "nuvemshop",
      store_id: config.storeId || null,
      store_domain: config.storeDomain || window.location.hostname,
      site_id: config.siteId || null,
      site_key: config.siteKey || null,
      page_url: window.location.href,
      form_action: form ? form.getAttribute("action") || "/comprar/" : "/comprar/",
      form_method: form ? form.getAttribute("method") || "post" : "post",
      element_name: element ? element.getAttribute("name") || null : null,
      element_value: element ? element.value || element.innerText || null : null,
      element_component: element
        ? element.getAttribute("data-component") || null
        : null
    };

    setStorage(PENDING_KEY, JSON.stringify(pending));
  }

  function resumePendingCheckoutIfAny() {
    var pending = getPendingCheckout();

    if (!pending || !isVerified()) {
      return;
    }

    removeStorage(PENDING_KEY);
    removeStorage(IN_PROGRESS_KEY);

    log("retomando checkout Nuvemshop pendente", {
      reason: pending.reason
    });

    window.__IDADEID_NUVEMSHOP_CHECKOUT_BYPASS__ = true;

    setTimeout(function () {
      resumeNuvemshopCheckout(pending);
    }, 450);
  }

  function resumeNuvemshopCheckout(pending) {
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
    fallbackForm.action = (pending && pending.form_action) || "/comprar/";
    fallbackForm.style.display = "none";

    ensureHiddenInput(fallbackForm, "go_to_checkout", "Iniciar Compra");

    document.body.appendChild(fallbackForm);

    try {
      HTMLFormElement.prototype.submit.call(fallbackForm);
    } catch (err3) {
      window.location.href = "/comprar/";
    }
  }

  function buildVerificationUrl() {
    var returnUrl = new URL(window.location.href);
    returnUrl.searchParams.set("idadeid_checkout_return", "1");
    returnUrl.searchParams.set("idadeid_platform", "nuvemshop");

    if (config.siteKey) {
      returnUrl.searchParams.set("idadeid_site_key", config.siteKey);
    }

    if (config.siteId) {
      returnUrl.searchParams.set("idadeid_site_id", config.siteId);
    }

    if (config.storeId) {
      returnUrl.searchParams.set("idadeid_store_id", config.storeId);
    }

    var base =
      config.verifyUrl ||
      window.__IDADEID_VERIFY_URL__ ||
      "https://verificar.idadeid.com.br/";

    var url = new URL(base, window.location.href);

    if (config.siteKey) {
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
    url.searchParams.set("platform", "nuvemshop");
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

    if (!hasReturnFlag || !approved) {
      return false;
    }

    setVerified();

    try {
      var clean = new URL(window.location.href);

      [
        "idadeid_checkout_return",
        "idadeid_platform",
        "idadeid_site_key",
        "idadeid_site_id",
        "idadeid_store_id",
        "idadeid_verified",
        "idadeid_access",
        "idadeid_status",
        "status",
        "idadeid_access_code",
        "access_code",
        "idadeid_code"
      ].forEach(function (key) {
        clean.searchParams.delete(key);
      });

      window.history.replaceState({}, document.title, clean.toString());
    } catch (err) {}

    return true;
  }

  function setVerified() {
    setStorage(
      VERIFIED_KEY,
      JSON.stringify({
        verified: true,
        created_at: Date.now(),
        expires_at: Date.now() + 1000 * 60 * 60 * 12
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
    if (document.getElementById("idadeid-nuvemshop-checkout-overlay")) {
      return;
    }

    var overlay = document.createElement("div");
    overlay.id = "idadeid-nuvemshop-checkout-overlay";
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
      siteKey:
        getAttr(scriptEl, "site-key") ||
        getAttr(scriptEl, "public-key") ||
        getAttr(scriptEl, "site_key") ||
        "",
      siteId: getAttr(scriptEl, "site-id") || getAttr(scriptEl, "site_id") || "",
      tenantId:
        getAttr(scriptEl, "tenant-id") || getAttr(scriptEl, "tenant_id") || "",
      storeId:
        getAttr(scriptEl, "store-id") ||
        getAttr(scriptEl, "store_id") ||
        getStoreIdFromCurrentScript(scriptEl) ||
        "",
      storeDomain:
        getAttr(scriptEl, "store-domain") ||
        getAttr(scriptEl, "store_domain") ||
        window.location.hostname,
      verifyUrl:
        getAttr(scriptEl, "verify-url") ||
        getAttr(scriptEl, "verify_url") ||
        ""
    };
  }

  function getCurrentScript() {
    if (document.currentScript) {
      return document.currentScript;
    }

    return (
      document.querySelector('script[data-idadeid-loader="checkout"]') ||
      document.querySelector('script[src*="checkout-trigger-nuvemshop.js"]') ||
      null
    );
  }

  function getAttr(el, name) {
    if (!el || !el.getAttribute) {
      return "";
    }

    return el.getAttribute("data-" + name) || el.getAttribute(name) || "";
  }

  function getStoreIdFromCurrentScript(scriptEl) {
    try {
      if (!scriptEl || !scriptEl.src) {
        return "";
      }

      var url = new URL(scriptEl.src);

      return (
        url.searchParams.get("store") ||
        url.searchParams.get("store_id") ||
        url.searchParams.get("user_id") ||
        ""
      );
    } catch (err) {
      return "";
    }
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
      return (
        window.sessionStorage.getItem(key) || window.localStorage.getItem(key)
      );
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
      console.log("[IdadeID Nuvemshop Checkout]", message, data || "");
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