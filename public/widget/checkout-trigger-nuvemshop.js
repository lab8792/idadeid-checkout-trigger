(function () {
  "use strict";

  var VERSION = "1.0.2-nuvemshop-gate-rpc";

  var SUPABASE_URL = "https://jrhcgndbpxbhmrgsezdd.supabase.co";
  var SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpyaGNnbmRicHhiaG1yZ3NlemRkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzMjk1OTQsImV4cCI6MjA5MzkwNTU5NH0.kuxOJCvhH3KrxcTPMaf0rvjUmiqm1smonqeOSXtTjf8";

  if (window.top !== window.self) {
    return;
  }

  if (window.__IDADEID_NUVEMSHOP_CHECKOUT_TRIGGER_ACTIVE__) {
    return;
  }

  window.__IDADEID_NUVEMSHOP_CHECKOUT_TRIGGER_ACTIVE__ = true;

  var script = getCurrentScript();

  var state = {
    siteKey: null,
    siteHash: null,
    siteId: null,
    tenantId: null,
    storeId: null,
    storeDomain: null,
    config: null,
    sessionValid: false,
    sessionValidationPromise: null,
    armed: false,
    isResuming: false,
    lastError: null,
    lastAnalysis: null
  };

  readInitialConfig(script);
  boot();

  function hasDebug() {
    try {
      var url = new URL(window.location.href);
      if (url.searchParams.get("idadeid_debug") === "1") return true;
      return localStorage.getItem("idadeid_debug") === "1";
    } catch (err) {
      return false;
    }
  }

  function log(message, data) {
    if (!hasDebug()) return;

    try {
      if (typeof data !== "undefined") {
        console.log("[IdadeID Nuvemshop Checkout] " + message, data);
      } else {
        console.log("[IdadeID Nuvemshop Checkout] " + message);
      }
    } catch (err) {}
  }

  function warn(message, data) {
    try {
      if (typeof data !== "undefined") {
        console.warn("[IdadeID Nuvemshop Checkout] " + message, data);
      } else {
        console.warn("[IdadeID Nuvemshop Checkout] " + message);
      }
    } catch (err) {}
  }

  function hash(str) {
    var h = 0;
    str = String(str || "");

    for (var i = 0; i < str.length; i++) {
      h = (h << 5) - h + str.charCodeAt(i);
      h |= 0;
    }

    return Math.abs(h).toString(36).substring(0, 8);
  }

  function rpc(name, payload) {
    return fetch(SUPABASE_URL + "/rest/v1/rpc/" + name, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: "Bearer " + SUPABASE_ANON_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload || {})
    })
      .then(function (res) {
        return res.json();
      })
      .catch(function (err) {
        state.lastError = err && err.message ? err.message : String(err);
        warn("RPC " + name + " falhou", err);
        return {
          ok: false,
          error: state.lastError
        };
      });
  }

  function rpcWithTimeout(name, payload, ms) {
    ms = ms || 8000;

    return Promise.race([
      rpc(name, payload),
      new Promise(function (_, reject) {
        setTimeout(function () {
          reject(new Error("timeout"));
        }, ms);
      })
    ]).catch(function (err) {
      state.lastError = err && err.message ? err.message : String(err);

      warn("RPC " + name + " timeout/erro", err);

      return {
        ok: false,
        error: state.lastError === "timeout" ? "timeout" : state.lastError
      };
    });
  }

  function boot() {
    log("boot", {
      version: VERSION,
      siteKey: mask(state.siteKey),
      siteId: state.siteId,
      storeId: state.storeId
    });

    if (!resolveSiteKey()) {
      warn("site key ausente; checkout trigger Nuvemshop inativo");
      return;
    }

    document.addEventListener("click", handleCheckoutEvent, true);
    document.addEventListener("submit", handleCheckoutEvent, true);
    state.armed = true;

    loadConfig()
      .then(function () {
        return exchangeCodeIfPresent();
      })
      .then(function (exchanged) {
        if (exchanged) return true;
        return validateStoredSession();
      })
      .then(function (valid) {
        if (valid) {
          return resumePendingCheckout();
        }

        return false;
      })
      .catch(function (err) {
        warn("erro no boot", err);
      });
  }

  function resolveSiteKey() {
    if (state.siteKey) {
      state.siteHash = hash(state.siteKey);
      return state.siteKey;
    }

    var resolved = "";

    if (document.currentScript && document.currentScript.getAttribute) {
      resolved =
        document.currentScript.getAttribute("data-site-key") ||
        document.currentScript.getAttribute("data-public-key") ||
        "";
    }

    if (!resolved) {
      var scripts = document.querySelectorAll(
        'script[src*="checkout-trigger-nuvemshop.js"], script[data-idadeid-loader="checkout-nuvemshop"], script[data-site-key]'
      );

      for (var i = 0; i < scripts.length; i++) {
        resolved =
          scripts[i].getAttribute("data-site-key") ||
          scripts[i].getAttribute("data-public-key") ||
          "";

        if (resolved) break;
      }
    }

    if (!resolved && window.IDADEID_SITE_KEY) {
      resolved = window.IDADEID_SITE_KEY;
    }

    if (!resolved) {
      state.lastError = "missing_site_key";
      return null;
    }

    state.siteKey = resolved;
    state.siteHash = hash(resolved);

    return resolved;
  }

  function loadConfig() {
    if (state.config) {
      return Promise.resolve(state.config);
    }

    return rpcWithTimeout(
      "get_public_widget_config",
      {
        p_public_key: state.siteKey,
        p_origin: window.location.origin,
        p_current_url: window.location.href
      },
      8000
    ).then(function (result) {
      if (!result || result.ok !== true) {
        state.lastError =
          result && result.error ? result.error : "invalid_config";

        warn("config inválida; trigger pode não redirecionar", result);
        return null;
      }

      state.config = result;

      log("config carregada", {
        hasGate: Boolean(result.gate && result.gate.url),
        gateUrl: result.gate && result.gate.url ? result.gate.url : null
      });

      return result;
    });
  }

  function storageKey() {
    return state.siteHash ? "idadeid_as_" + state.siteHash : null;
  }

  function pendingKey() {
    return state.siteHash
      ? "idadeid_pending_checkout_nuvemshop_" + state.siteHash
      : null;
  }

  function resumingKey() {
    return state.siteHash
      ? "idadeid_resuming_checkout_nuvemshop_" + state.siteHash
      : null;
  }

  function getStoredSession() {
    var key = storageKey();
    if (!key) return null;

    try {
      var stored = localStorage.getItem(key);
      return stored ? JSON.parse(stored) : null;
    } catch (err) {
      return null;
    }
  }

  function saveSession(session) {
    var key = storageKey();
    if (!key || !session) return;

    try {
      localStorage.setItem(key, JSON.stringify(session));
      log("sessão salva", {
        key: key,
        id: session.id
      });
    } catch (err) {
      warn("não foi possível salvar sessão", err);
    }
  }

  function clearSession() {
    var key = storageKey();
    if (!key) return;

    try {
      localStorage.removeItem(key);
    } catch (err) {}
  }

  function getUrlCode() {
    try {
      return new URL(window.location.href).searchParams.get("idadeid_code");
    } catch (err) {
      return null;
    }
  }

  function cleanUrlCode() {
    try {
      var url = new URL(window.location.href);
      url.searchParams.delete("idadeid_code");
      window.history.replaceState({}, "", url.toString());
    } catch (err) {}
  }

  function exchangeCodeIfPresent() {
    var code = getUrlCode();

    if (!code) {
      return Promise.resolve(false);
    }

    log("idadeid_code encontrado, fazendo exchange");

    return rpcWithTimeout(
      "exchange_access_code",
      {
        p_public_key: state.siteKey,
        p_access_code: code,
        p_origin: window.location.origin,
        p_current_url: window.location.href
      },
      8000
    ).then(function (result) {
      cleanUrlCode();

      if (!result || result.ok !== true || !result.access_session) {
        clearSession();
        state.sessionValid = false;
        state.lastError =
          result && result.error ? result.error : "exchange_failed";

        warn("exchange falhou", result);
        return false;
      }

      saveSession(result.access_session);

      return validateAccessSession(result.access_session).then(function (valid) {
        if (valid) {
          state.sessionValid = true;
          log("sessão pós-exchange válida");
          return resumePendingCheckout().then(function () {
            return true;
          });
        }

        clearSession();
        state.sessionValid = false;
        state.lastError = "invalid_session_after_exchange";
        return false;
      });
    });
  }

  function validateStoredSession() {
    if (state.sessionValid) {
      return Promise.resolve(true);
    }

    if (state.sessionValidationPromise) {
      return state.sessionValidationPromise;
    }

    state.sessionValidationPromise = new Promise(function (resolve) {
      var stored = getStoredSession();

      if (!stored || !stored.id || !stored.jti) {
        state.sessionValid = false;
        resolve(false);
        return;
      }

      validateAccessSession(stored).then(resolve);
    }).finally(function () {
      state.sessionValidationPromise = null;
    });

    return state.sessionValidationPromise;
  }

  function validateAccessSession(session) {
    if (!session || !session.id || !session.jti) {
      return Promise.resolve(false);
    }

    return rpcWithTimeout(
      "validate_access_session",
      {
        p_public_key: state.siteKey,
        p_access_session_id: session.id,
        p_jti: session.jti,
        p_origin: window.location.origin,
        p_current_url: window.location.href
      },
      8000
    ).then(function (result) {
      if (result && result.ok === true && result.valid === true) {
        state.sessionValid = true;
        return true;
      }

      clearSession();
      state.sessionValid = false;
      return false;
    });
  }

  function handleCheckoutEvent(event) {
    if (window.__IDADEID_NUVEMSHOP_CHECKOUT_BYPASS__) {
      return;
    }

    if (isResuming() || state.sessionValid) {
      return;
    }

    if (!event || event.defaultPrevented) {
      return;
    }

    var context = analyzeNuvemshopCheckoutIntent(event);

    if (!context || !context.intercept) {
      return;
    }

    event.preventDefault();

    if (event.stopImmediatePropagation) {
      event.stopImmediatePropagation();
    }

    if (event.stopPropagation) {
      event.stopPropagation();
    }

    showBlockingOverlay();

    validateStoredSession().then(function (valid) {
      if (valid) {
        log("sessão ficou válida durante clique; retomando checkout");
        resumeOriginalNow(context);
        return;
      }

      redirectToGate(context);
    });
  }

  function analyzeNuvemshopCheckoutIntent(event) {
    var target = event.target;
    var element = null;
    var form = null;

    if (event.type === "submit") {
      form = event.target;
      element =
        event.submitter ||
        (form &&
          form.querySelector(
            'input[name="go_to_checkout"], [data-component="cart.checkout-button"], input[type="submit"], button[type="submit"]'
          ));
    } else if (target && target.closest) {
      element = target.closest(
        'input[name="go_to_checkout"], [data-component="cart.checkout-button"], #ajax-cart-submit-div input[type="submit"], a, button, input, [role="button"]'
      );
      form = getRelatedForm(element);
    }

    var isCheckoutButton = isNuvemshopCheckoutButton(element);
    var isCheckoutForm = isNuvemshopCheckoutForm(form);

    var intercept = Boolean(isCheckoutButton || isCheckoutForm);

    var result = {
      intercept: intercept,
      element: element,
      form: form,
      reason: isCheckoutButton
        ? "nuvemshop_cart_checkout_button"
        : isCheckoutForm
        ? "nuvemshop_cart_checkout_form"
        : "not_checkout",
      formAction: form ? form.getAttribute("action") || "" : "",
      formMethod: form ? form.getAttribute("method") || "post" : "post"
    };

    state.lastAnalysis = {
      intercept: result.intercept,
      reason: result.reason,
      formAction: result.formAction,
      formMethod: result.formMethod
    };

    log("análise checkout Nuvemshop", state.lastAnalysis);

    return result;
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

    var form = getRelatedForm(element);

    if (!isNuvemshopCheckoutForm(form)) {
      return false;
    }

    var text = normalizeText(
      element.innerText ||
        element.textContent ||
        element.value ||
        element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        ""
    );

    return (
      text.indexOf("iniciar compra") >= 0 ||
      text.indexOf("finalizar compra") >= 0 ||
      text.indexOf("checkout") >= 0
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

  function redirectToGate(context) {
    loadConfig().then(function (config) {
      var gateUrl = config && config.gate && config.gate.url;

      if (!gateUrl) {
        state.lastError = "gate_url_missing";
        warn("gate_url ausente; checkout liberado para não quebrar loja");
        resumeOriginalNow(context);
        return;
      }

      savePendingCheckout(context);

      var sep = gateUrl.indexOf("?") !== -1 ? "&" : "?";
      var finalUrl =
        gateUrl + sep + "return_url=" + encodeURIComponent(window.location.href);

      log("redirecionando para gate", finalUrl);

      window.location.href = finalUrl;
    });
  }

  function getRelatedForm(element) {
    if (!element) {
      return null;
    }

    if (element.tagName === "FORM") {
      return element;
    }

    if (element.form) {
      return element.form;
    }

    return element.closest ? element.closest("form") : null;
  }

  function savePendingCheckout(context) {
    var key = pendingKey();
    if (!key) return;

    var form = context.form || null;
    var element = context.element || null;

    var payload = {
      type: context.form ? "form" : "button",
      platform: "nuvemshop",
      reason: context.reason || null,
      formAction: form ? form.getAttribute("action") || "/comprar/" : "/comprar/",
      formMethod: form ? form.getAttribute("method") || "post" : "post",
      created_at: Date.now(),
      page_url: window.location.href,
      elementName: element ? element.getAttribute("name") || null : null,
      elementComponent: element
        ? element.getAttribute("data-component") || null
        : null
    };

    try {
      sessionStorage.setItem(key, JSON.stringify(payload));
      log("pending checkout salvo", payload);
    } catch (err) {
      warn("não foi possível salvar pending checkout", err);
    }
  }

  function getPendingCheckout() {
    var key = pendingKey();
    if (!key) return null;

    try {
      var raw = sessionStorage.getItem(key);
      if (!raw) return null;

      var payload = JSON.parse(raw);
      if (!payload || !payload.created_at) return null;

      if (Date.now() - Number(payload.created_at) > 30 * 60 * 1000) {
        sessionStorage.removeItem(key);
        return null;
      }

      return payload;
    } catch (err) {
      return null;
    }
  }

  function clearPendingCheckout() {
    var key = pendingKey();
    if (!key) return;

    try {
      sessionStorage.removeItem(key);
    } catch (err) {}
  }

  function resumePendingCheckout() {
    var pending = getPendingCheckout();

    if (!pending) {
      return Promise.resolve(false);
    }

    log("retomando checkout Nuvemshop pendente", pending);

    clearPendingCheckout();

    setResuming(true);
    window.__IDADEID_NUVEMSHOP_CHECKOUT_BYPASS__ = true;

    setTimeout(function () {
      resumeNuvemshopCheckout(pending);
    }, 300);

    return Promise.resolve(true);
  }

  function resumeOriginalNow(context) {
    setResuming(true);
    window.__IDADEID_NUVEMSHOP_CHECKOUT_BYPASS__ = true;

    setTimeout(function () {
      try {
        if (context && context.form) {
          submitNuvemshopForm(context.form);
          return;
        }

        if (context && context.element && context.element.click) {
          context.element.setAttribute("data-idadeid-resuming", "true");
          context.element.click();
          return;
        }
      } finally {
        setTimeout(function () {
          setResuming(false);
          window.__IDADEID_NUVEMSHOP_CHECKOUT_BYPASS__ = false;
        }, 1500);
      }
    }, 0);
  }

  function resumeNuvemshopCheckout(pending) {
    var form =
      document.querySelector('form.js-ajax-cart-panel[data-store="cart-form"]') ||
      document.querySelector("form.js-ajax-cart-panel") ||
      document.querySelector('form[data-store="cart-form"]');

    if (form) {
      submitNuvemshopForm(form);
      return;
    }

    var fallbackForm = document.createElement("form");
    fallbackForm.method = (pending && pending.formMethod) || "post";
    fallbackForm.action = (pending && pending.formAction) || "/comprar/";
    fallbackForm.style.display = "none";

    ensureHiddenInput(fallbackForm, "go_to_checkout", "Iniciar Compra");

    document.body.appendChild(fallbackForm);

    try {
      HTMLFormElement.prototype.submit.call(fallbackForm);
    } catch (err) {
      window.location.href = "/comprar/";
    }
  }

  function submitNuvemshopForm(form) {
    if (!form) return false;

    ensureHiddenInput(form, "go_to_checkout", "Iniciar Compra");

    try {
      HTMLFormElement.prototype.submit.call(form);
      return true;
    } catch (err) {
      try {
        form.submit();
        return true;
      } catch (err2) {
        warn("falha ao submeter formulário Nuvemshop", err2);
        return false;
      }
    }
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

  function readInitialConfig(scriptEl) {
    state.siteKey =
      getAttr(scriptEl, "site-key") ||
      getAttr(scriptEl, "public-key") ||
      getAttr(scriptEl, "site_key") ||
      "";

    state.siteId =
      getAttr(scriptEl, "site-id") || getAttr(scriptEl, "site_id") || "";

    state.tenantId =
      getAttr(scriptEl, "tenant-id") ||
      getAttr(scriptEl, "tenant_id") ||
      "";

    state.storeId =
      getAttr(scriptEl, "store-id") ||
      getAttr(scriptEl, "store_id") ||
      getStoreIdFromCurrentScript(scriptEl) ||
      "";

    state.storeDomain =
      getAttr(scriptEl, "store-domain") ||
      getAttr(scriptEl, "store_domain") ||
      window.location.hostname;
  }

  function getCurrentScript() {
    if (document.currentScript) {
      return document.currentScript;
    }

    return (
      document.querySelector('script[data-idadeid-loader="checkout-nuvemshop"]') ||
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

  function setResuming(value) {
    state.isResuming = !!value;

    var key = resumingKey();
    if (!key) return;

    try {
      if (value) {
        sessionStorage.setItem(key, "1");
      } else {
        sessionStorage.removeItem(key);
      }
    } catch (err) {}
  }

  function isResuming() {
    if (state.isResuming) {
      return true;
    }

    var key = resumingKey();
    if (!key) return false;

    try {
      return sessionStorage.getItem(key) === "1";
    } catch (err) {
      return false;
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
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function cssEscape(value) {
    if (window.CSS && window.CSS.escape) {
      return window.CSS.escape(value);
    }

    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function mask(value) {
    if (!value) return null;

    var str = String(value);

    if (str.length <= 12) {
      return str;
    }

    return str.slice(0, 12) + "...";
  }

  window.IdadeIDNuvemshopCheckoutTrigger =
    window.IdadeIDNuvemshopCheckoutTrigger || {};

  window.IdadeIDNuvemshopCheckoutTrigger.debugState = function () {
    return {
      version: VERSION,
      siteHash: state.siteHash,
      siteKey: mask(state.siteKey),
      siteId: state.siteId,
      storeId: state.storeId,
      hasConfig: !!state.config,
      sessionValid: state.sessionValid,
      armed: state.armed,
      isResuming: isResuming(),
      hasPendingCheckout: !!getPendingCheckout(),
      lastAnalysis: state.lastAnalysis,
      lastError: state.lastError,
      origin: window.location.origin,
      href: window.location.href,
      hasCode: !!getUrlCode()
    };
  };
})();
