/**
 * IdadeID Smart Checkout Trigger v1.0.0
 * Camada externa de acionamento antes do checkout.
 * NÃO substitui o widget de acesso. NÃO altera o loader v2.0.14-clean.
 */
(function () {
  'use strict';

  var VERSION = '1.0.0';
  var SUPABASE_URL = 'https://jrhcgndbpxbhmrgsezdd.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpyaGNnbmRicHhiaG1yZ3NlemRkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzMjk1OTQsImV4cCI6MjA5MzkwNTU5NH0.kuxOJCvhH3KrxcTPMaf0rvjUmiqm1smonqeOSXtTjf8';

  if (window.top !== window.self) {
    return;
  }

  window.IdadeIDCheckoutTrigger = window.IdadeIDCheckoutTrigger || {};
  if (window.IdadeIDCheckoutTrigger.__booted) {
    return;
  }
  window.IdadeIDCheckoutTrigger.__booted = true;
  window.IdadeIDCheckoutTrigger.version = VERSION;

  var state = {
    siteKey: null,
    siteHash: null,
    config: null,
    sessionValid: false,
    sessionValidationStarted: false,
    sessionValidationPromise: null,
    armed: false,
    isResuming: false,
    lastAnalysis: null,
    lastError: null,
  };

  function hasDebug() {
    try {
      var url = new URL(window.location.href);
      if (url.searchParams.get('idadeid_debug') === '1') return true;
      return localStorage.getItem('idadeid_debug') === '1';
    } catch (e) {
      return false;
    }
  }

  function log(message, data) {
    if (!hasDebug()) return;
    if (typeof data !== 'undefined') {
      console.log('[IdadeID Checkout] ' + message, data);
    } else {
      console.log('[IdadeID Checkout] ' + message);
    }
  }

  function warn(message, data) {
    if (!hasDebug()) return;
    if (typeof data !== 'undefined') {
      console.warn('[IdadeID Checkout] ' + message, data);
    } else {
      console.warn('[IdadeID Checkout] ' + message);
    }
  }

  function hash(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) - h) + str.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h).toString(36).substring(0, 8);
  }

  function rpc(name, payload) {
    return fetch(SUPABASE_URL + '/rest/v1/rpc/' + name, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload || {}),
    })
      .then(function (res) { return res.json(); })
      .catch(function (err) {
        state.lastError = err && err.message ? err.message : String(err);
        warn('RPC ' + name + ' failed', err);
        return { ok: false, error: state.lastError };
      });
  }

  function rpcWithTimeout(name, payload, ms) {
    ms = ms || 8000;
    return Promise.race([
      rpc(name, payload),
      new Promise(function (_, reject) {
        setTimeout(function () { reject(new Error('timeout')); }, ms);
      }),
    ]).catch(function (err) {
      state.lastError = err && err.message ? err.message : String(err);
      warn('RPC ' + name + ' timeout/error', err);
      return { ok: false, error: state.lastError === 'timeout' ? 'timeout' : state.lastError };
    });
  }

  function resolveSiteKey() {
    var resolved = null;
    var scripts;

    if (document.currentScript && document.currentScript.dataset && document.currentScript.dataset.siteKey) {
      resolved = document.currentScript.dataset.siteKey;
    }

    if (!resolved && document.currentScript && document.currentScript.getAttribute('data-site-key')) {
      resolved = document.currentScript.getAttribute('data-site-key');
    }

    if (!resolved) {
      scripts = document.querySelectorAll('script[src*="checkout-trigger.js"]');
      for (var i = 0; i < scripts.length; i++) {
        if (scripts[i].getAttribute('data-site-key')) {
          resolved = scripts[i].getAttribute('data-site-key');
          break;
        }
      }
    }

    if (!resolved) {
      var publicKeyScript = document.querySelector('script[data-public-key]');
      if (publicKeyScript) resolved = publicKeyScript.getAttribute('data-public-key');
    }

    if (!resolved && window.IDADEID_SITE_KEY) {
      resolved = window.IDADEID_SITE_KEY;
    }

    if (!resolved) {
      state.lastError = 'missing_site_key';
      warn('site key não encontrada');
      return null;
    }

    state.siteKey = resolved;
    state.siteHash = hash(resolved);
    log('site key resolvida', { siteHash: state.siteHash });
    return resolved;
  }

  function storageKey() {
    return state.siteHash ? 'idadeid_as_' + state.siteHash : null;
  }

  function pendingKey() {
    return state.siteHash ? 'idadeid_pending_checkout_' + state.siteHash : null;
  }

  function resumingKey() {
    return state.siteHash ? 'idadeid_resuming_checkout_' + state.siteHash : null;
  }

  function getStoredSession() {
    var key = storageKey();
    if (!key) return null;
    try {
      var stored = localStorage.getItem(key);
      return stored ? JSON.parse(stored) : null;
    } catch (e) {
      return null;
    }
  }

  function saveSession(session) {
    var key = storageKey();
    if (!key || !session) return;
    try {
      localStorage.setItem(key, JSON.stringify(session));
      log('sessão salva', { key: key, id: session.id });
    } catch (e) {
      warn('não foi possível salvar sessão', e);
    }
  }

  function clearSession() {
    var key = storageKey();
    if (!key) return;
    try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  function getUrlCode() {
    try {
      return new URL(window.location.href).searchParams.get('idadeid_code');
    } catch (e) {
      return null;
    }
  }

  function cleanUrlCode() {
    try {
      var url = new URL(window.location.href);
      url.searchParams.delete('idadeid_code');
      window.history.replaceState({}, '', url.toString());
    } catch (e) { /* ignore */ }
  }

  async function loadConfig() {
    if (state.config) return state.config;

    var result = await rpcWithTimeout('get_public_widget_config', {
      p_public_key: state.siteKey,
      p_origin: window.location.origin,
      p_current_url: window.location.href,
    }, 8000);

    if (!result || result.ok !== true) {
      state.lastError = result && result.error ? result.error : 'invalid_config';
      warn('config inválida; trigger ficará inativo', result);
      return null;
    }

    state.config = result;
    log('config carregada', result);
    return result;
  }

  async function validateStoredSession() {
    if (state.sessionValid) return true;
    if (state.sessionValidationPromise) return state.sessionValidationPromise;

    state.sessionValidationStarted = true;
    state.sessionValidationPromise = (async function () {
      var stored = getStoredSession();
      if (!stored || !stored.id || !stored.jti) {
        log('sem sessão local');
        state.sessionValid = false;
        return false;
      }

      var result = await rpcWithTimeout('validate_access_session', {
        p_public_key: state.siteKey,
        p_access_session_id: stored.id,
        p_jti: stored.jti,
        p_origin: window.location.origin,
        p_current_url: window.location.href,
      }, 8000);

      if (result && result.ok === true && result.valid === true) {
        state.sessionValid = true;
        log('sessão local válida');
        return true;
      }

      log('sessão local inválida, limpando', result);
      state.sessionValid = false;
      clearSession();
      return false;
    })().finally(function () {
      state.sessionValidationPromise = null;
    });

    return state.sessionValidationPromise;
  }

  async function exchangeCodeIfPresent() {
    var code = getUrlCode();
    if (!code) return false;

    log('idadeid_code encontrado, fazendo exchange');

    var result = await rpcWithTimeout('exchange_access_code', {
      p_public_key: state.siteKey,
      p_access_code: code,
      p_origin: window.location.origin,
      p_current_url: window.location.href,
    }, 8000);

    cleanUrlCode();

    if (!result || result.ok !== true || !result.access_session) {
      clearSession();
      state.sessionValid = false;
      state.lastError = result && result.error ? result.error : 'exchange_failed';
      warn('exchange falhou', result);
      return false;
    }

    saveSession(result.access_session);

    var validateResult = await rpcWithTimeout('validate_access_session', {
      p_public_key: state.siteKey,
      p_access_session_id: result.access_session.id,
      p_jti: result.access_session.jti,
      p_origin: window.location.origin,
      p_current_url: window.location.href,
    }, 8000);

    if (validateResult && validateResult.ok === true && validateResult.valid === true) {
      state.sessionValid = true;
      log('sessão pós-exchange válida');
      await resumePendingCheckout();
      return true;
    }

    clearSession();
    state.sessionValid = false;
    state.lastError = 'invalid_session_after_exchange';
    warn('sessão pós-exchange inválida', validateResult);
    return false;
  }

  function normalizeText(value) {
    return String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function elementText(el) {
    if (!el) return '';
    var parts = [];
    var attrs = ['aria-label', 'title', 'name', 'id', 'class', 'value', 'data-testid', 'data-test', 'data-action', 'data-checkout'];
    try { parts.push(el.innerText || el.textContent || ''); } catch (e) { /* ignore */ }
    attrs.forEach(function (attr) {
      try { parts.push(el.getAttribute(attr) || ''); } catch (e) { /* ignore */ }
    });
    return normalizeText(parts.join(' '));
  }

  function closestCandidate(target) {
    if (!target || !target.closest) return null;
    return target.closest('a, button, input[type="button"], input[type="submit"], [role="button"], [data-checkout], form');
  }

  function nearestForm(el) {
    if (!el) return null;
    if (el.tagName && el.tagName.toLowerCase() === 'form') return el;
    if (el.form) return el.form;
    return el.closest ? el.closest('form') : null;
  }

  function isInCartContext(el) {
    var node = el;
    var depth = 0;
    while (node && node !== document && depth < 6) {
      var info = normalizeText([
        node.id || '',
        node.className || '',
        node.getAttribute ? (node.getAttribute('aria-label') || '') : '',
        node.getAttribute ? (node.getAttribute('data-section') || '') : '',
        node.getAttribute ? (node.getAttribute('data-testid') || '') : '',
      ].join(' '));

      if (/cart|carrinho|minicart|mini cart|drawer|sacola|bag/.test(info)) return true;
      node = node.parentNode;
      depth++;
    }
    return false;
  }

  function addScore(scores, points, reason) {
    scores.total += points;
    scores.reasons.push({ points: points, reason: reason });
  }

  function analyzeCheckoutIntent(target, event) {
    var candidate = closestCandidate(target);
    var form = nearestForm(candidate || target);
    var href = '';
    var formAction = '';
    var text = '';
    var scores = { total: 0, reasons: [] };

    if (!candidate && form) candidate = form;
    if (!candidate) {
      return { intercept: false, score: 0, reasons: [], candidate: null, type: 'unknown' };
    }

    try {
      if (candidate.tagName && candidate.tagName.toLowerCase() === 'a') href = candidate.href || candidate.getAttribute('href') || '';
    } catch (e) { /* ignore */ }

    try {
      if (form) formAction = form.action || form.getAttribute('action') || '';
    } catch (e) { /* ignore */ }

    text = normalizeText([
      elementText(candidate),
      form ? elementText(form) : '',
      href,
      formAction,
    ].join(' '));

    if (/\/checkout\b|\/checkout\//.test(normalizeText(href))) addScore(scores, 100, 'href /checkout');
    if (/\/checkout\b|\/checkout\//.test(normalizeText(formAction))) addScore(scores, 100, 'form action /checkout');
    if (/\bcheckout\b/.test(text)) addScore(scores, 80, 'texto/atributo checkout');
    if (/finalizar compra|finalizar pedido|concluir compra/.test(text)) addScore(scores, 90, 'finalizar compra');
    if (/comprar agora|buy now|comprar ja|compra agora/.test(text)) addScore(scores, 80, 'comprar agora/buy now');
    if (/ir para pagamento|continuar para pagamento|prosseguir para pagamento|fechar pedido/.test(text)) addScore(scores, 80, 'pagamento/fechar pedido');
    if (/\bname checkout\b|\bid checkout\b/.test(text)) addScore(scores, 90, 'name/id checkout');
    if (/class.*checkout|checkout.*button|btn.*checkout/.test(text)) addScore(scores, 60, 'class checkout');
    if (isInCartContext(candidate)) addScore(scores, 25, 'contexto carrinho/minicart');

    if (/adicionar ao carrinho|add to cart|colocar no carrinho|por no carrinho/.test(text)) addScore(scores, -90, 'add to cart não bloqueia');
    if (/continuar comprando|continue shopping/.test(text)) addScore(scores, -100, 'continuar comprando');
    if (/remover|remove|excluir|delete/.test(text)) addScore(scores, -100, 'remover item');
    if (/atualizar carrinho|update cart|recalcular|calcular frete|cupom|coupon|discount/.test(text)) addScore(scores, -80, 'ação auxiliar de carrinho');

    var type = 'button';
    if (href) type = 'link';
    else if (form && (!candidate || candidate === form || (event && event.type === 'submit'))) type = 'form';

    var result = {
      intercept: scores.total >= 70,
      score: scores.total,
      reasons: scores.reasons,
      candidate: candidate,
      form: form,
      href: href,
      formAction: formAction,
      type: type,
      text: text.slice(0, 300),
    };

    state.lastAnalysis = {
      intercept: result.intercept,
      score: result.score,
      reasons: result.reasons,
      type: result.type,
      href: result.href,
      formAction: result.formAction,
      text: result.text,
    };

    return result;
  }

  function cssEscape(value) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function getElementSelector(el) {
    if (!el || !el.tagName) return null;
    if (el.id) return '#' + cssEscape(el.id);

    var testAttrs = ['data-testid', 'data-test', 'data-action', 'data-checkout', 'name'];
    for (var i = 0; i < testAttrs.length; i++) {
      var attr = testAttrs[i];
      var val = el.getAttribute && el.getAttribute(attr);
      if (val) return el.tagName.toLowerCase() + '[' + attr + '="' + String(val).replace(/"/g, '\\"') + '"]';
    }

    var path = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && node !== document.body && depth < 5) {
      var tag = node.tagName.toLowerCase();
      var parent = node.parentNode;
      if (!parent) break;
      var siblings = Array.prototype.filter.call(parent.children || [], function (child) {
        return child.tagName && child.tagName.toLowerCase() === tag;
      });
      if (siblings.length > 1) {
        tag += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      path.unshift(tag);
      node = parent;
      depth++;
    }
    return path.length ? path.join(' > ') : null;
  }

  function savePendingCheckout(analysis) {
    var key = pendingKey();
    if (!key) return;

    var form = analysis.form || null;
    var payload = {
      type: analysis.type || 'button',
      href: analysis.href || '',
      formAction: analysis.formAction || '',
      candidateSelector: getElementSelector(analysis.candidate),
      formSelector: form ? getElementSelector(form) : null,
      page_url: window.location.href,
      created_at: Date.now(),
    };

    try {
      sessionStorage.setItem(key, JSON.stringify(payload));
      log('pending checkout salvo', payload);
    } catch (e) {
      warn('não foi possível salvar pending checkout', e);
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
      if (Date.now() - payload.created_at > 15 * 60 * 1000) {
        sessionStorage.removeItem(key);
        return null;
      }
      return payload;
    } catch (e) {
      return null;
    }
  }

  function clearPendingCheckout() {
    var key = pendingKey();
    if (!key) return;
    try { sessionStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  function setResuming(value) {
    state.isResuming = !!value;
    var key = resumingKey();
    if (!key) return;
    try {
      if (value) sessionStorage.setItem(key, '1');
      else sessionStorage.removeItem(key);
    } catch (e) { /* ignore */ }
  }

  function isResuming() {
    if (state.isResuming) return true;
    var key = resumingKey();
    if (!key) return false;
    try { return sessionStorage.getItem(key) === '1'; } catch (e) { return false; }
  }

  async function redirectToGate(analysis) {
    var config = state.config || await loadConfig();
    var gateUrl = config && config.gate && config.gate.url;

    if (!gateUrl) {
      state.lastError = 'gate_url_missing';
      warn('gate_url ausente; checkout liberado para não quebrar loja');
      return resumeOriginalNow(analysis);
    }

    savePendingCheckout(analysis);

    var sep = gateUrl.indexOf('?') !== -1 ? '&' : '?';
    var finalUrl = gateUrl + sep + 'return_url=' + encodeURIComponent(window.location.href);
    log('redirecionando para gate', finalUrl);
    window.location.href = finalUrl;
  }

  function findElement(selector) {
    if (!selector) return null;
    try { return document.querySelector(selector); } catch (e) { return null; }
  }

  function submitForm(form, submitter) {
    if (!form) return false;
    try {
      if (submitter && form.requestSubmit) {
        form.requestSubmit(submitter);
        return true;
      }
      if (form.requestSubmit) {
        form.requestSubmit();
        return true;
      }
      form.submit();
      return true;
    } catch (e) {
      warn('falha ao submeter form', e);
      return false;
    }
  }

  function resumeOriginalNow(analysis) {
    if (!analysis) return;
    setResuming(true);
    setTimeout(function () {
      try {
        if (analysis.href) {
          window.location.href = analysis.href;
          return;
        }
        if (analysis.form) {
          submitForm(analysis.form, analysis.candidate);
          return;
        }
        if (analysis.candidate && analysis.candidate.click) {
          analysis.candidate.setAttribute('data-idadeid-resuming', 'true');
          analysis.candidate.click();
          return;
        }
      } finally {
        setTimeout(function () { setResuming(false); }, 1500);
      }
    }, 0);
  }

  async function resumePendingCheckout() {
    var pending = getPendingCheckout();
    if (!pending) {
      log('sem pending checkout para retomar');
      return false;
    }

    log('retomando checkout pending', pending);
    clearPendingCheckout();
    setResuming(true);

    setTimeout(function () {
      try {
        if (pending.href) {
          window.location.href = pending.href;
          return;
        }

        var form = findElement(pending.formSelector);
        var button = findElement(pending.candidateSelector);

        if (pending.type === 'form' && form) {
          if (submitForm(form, button)) return;
        }

        if (button && button.click) {
          button.setAttribute('data-idadeid-resuming', 'true');
          button.click();
          return;
        }

        if (form && submitForm(form, null)) return;

        if (pending.formAction) {
          window.location.href = pending.formAction;
          return;
        }

        warn('não foi possível retomar automaticamente; usuário deverá clicar novamente');
      } finally {
        setTimeout(function () { setResuming(false); }, 1500);
      }
    }, 150);

    return true;
  }

  async function handleCheckoutEvent(event) {
    if (isResuming() || state.sessionValid) return;
    if (event && event.defaultPrevented) return;

    var analysis = analyzeCheckoutIntent(event.target, event);
    log('análise checkout', {
      intercept: analysis.intercept,
      score: analysis.score,
      reasons: analysis.reasons,
      type: analysis.type,
      href: analysis.href,
      formAction: analysis.formAction,
      text: analysis.text,
    });

    if (!analysis.intercept) return;

    if (analysis.candidate && analysis.candidate.getAttribute && analysis.candidate.getAttribute('data-idadeid-resuming') === 'true') {
      return;
    }

    event.preventDefault();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    if (event.stopPropagation) event.stopPropagation();

    var valid = await validateStoredSession();
    if (valid) {
      log('sessão ficou válida durante clique; retomando ação original');
      resumeOriginalNow(analysis);
      return;
    }

    await redirectToGate(analysis);
  }

  function armCheckoutTrigger() {
    if (state.armed) return;
    state.armed = true;

    document.addEventListener('click', handleCheckoutEvent, true);
    document.addEventListener('submit', handleCheckoutEvent, true);
    log('trigger armado');
  }

  async function boot() {
    log('boot v' + VERSION);

    if (!resolveSiteKey()) return;

    await loadConfig();

    var exchanged = await exchangeCodeIfPresent();
    if (exchanged) return;

    await validateStoredSession();

    if (!state.sessionValid) {
      armCheckoutTrigger();
      return;
    }

    log('sessão já válida; checkout liberado');
  }

  window.IdadeIDCheckoutTrigger.debugState = function () {
    return {
      version: VERSION,
      booted: !!window.IdadeIDCheckoutTrigger.__booted,
      siteHash: state.siteHash,
      hasConfig: !!state.config,
      sessionValid: state.sessionValid,
      armed: state.armed,
      isResuming: isResuming(),
      hasPendingCheckout: !!getPendingCheckout(),
      lastAnalysis: state.lastAnalysis,
      lastError: state.lastError,
      origin: window.location.origin,
      href: window.location.href,
      hasCode: !!getUrlCode(),
    };
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
