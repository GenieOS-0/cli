#!/usr/bin/env node

// ../sdk-node/dist/index.js
var GenieOSError = class extends Error {
  type;
  code;
  status;
  requestId;
  context;
  constructor(opts) {
    super(opts.message);
    this.name = "GenieOSError";
    this.type = opts.type;
    this.code = opts.code;
    this.status = opts.status;
    this.requestId = opts.requestId;
    this.context = opts.context;
  }
};
var GenieOSAuthError = class extends GenieOSError {
  constructor(opts) {
    super(opts);
    this.name = "GenieOSAuthError";
  }
};
var GenieOSRateLimitError = class extends GenieOSError {
  retryAfterSec;
  constructor(opts) {
    super(opts);
    this.name = "GenieOSRateLimitError";
    this.retryAfterSec = opts.retryAfterSec;
  }
};
var GenieOSValidationError = class extends GenieOSError {
  constructor(opts) {
    super(opts);
    this.name = "GenieOSValidationError";
  }
};
var GenieOSIdempotencyConflictError = class extends GenieOSError {
  constructor(opts) {
    super(opts);
    this.name = "GenieOSIdempotencyConflictError";
  }
};
var GenieOSNetworkError = class extends Error {
  cause;
  constructor(message, cause) {
    super(message);
    this.name = "GenieOSNetworkError";
    this.cause = cause;
  }
};
var SDK_VERSION = "0.1.3";
var DEFAULT_BASE = "https://api.genieos.pro";
var RETRYABLE_STATUSES = /* @__PURE__ */ new Set([408, 425, 429, 500, 502, 503, 504]);
var Transport = class {
  apiKey;
  baseUrl;
  timeoutMs;
  maxRetries;
  initialBackoffMs;
  fetchImpl;
  defaultHeaders;
  userAgent;
  constructor(opts) {
    if (!opts.apiKey) throw new Error("GenieOS SDK: apiKey is required.");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 3e4;
    this.maxRetries = opts.maxRetries ?? 3;
    this.initialBackoffMs = opts.initialBackoffMs ?? 200;
    this.fetchImpl = opts.fetch ?? fetch;
    this.defaultHeaders = opts.defaultHeaders ?? {};
    const tag = opts.appName ? `${opts.appName}${opts.appVersion ? `/${opts.appVersion}` : ""}` : "";
    this.userAgent = `genieos-node/${SDK_VERSION}${tag ? " " + tag : ""}`;
  }
  async request(opts) {
    const url = this.buildUrl(opts.path, opts.query);
    const headers = this.buildHeaders(opts);
    const bodyString = opts.body !== void 0 && opts.method !== "GET" && opts.method !== "DELETE" ? JSON.stringify(opts.body) : void 0;
    const maxRetries = opts.maxRetries ?? this.maxRetries;
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const signal = opts.signal ? mergeSignals(controller.signal, opts.signal) : controller.signal;
      try {
        const res = await this.fetchImpl(url, {
          method: opts.method,
          headers,
          body: bodyString,
          signal
        });
        clearTimeout(timer);
        if (res.status >= 200 && res.status < 300) {
          if (res.status === 204) return void 0;
          return await safeJson(res);
        }
        const requestId = res.headers.get("x-request-id") ?? void 0;
        const errBody = await parseErrorBody(res);
        const err = buildError(res.status, errBody, requestId, res.headers);
        if (RETRYABLE_STATUSES.has(res.status) && attempt < maxRetries) {
          lastError = err;
          await sleep(this.backoffFor(attempt, res.headers.get("retry-after")));
          continue;
        }
        throw err;
      } catch (e) {
        clearTimeout(timer);
        if (e instanceof GenieOSError) throw e;
        const isAbort = e.name === "AbortError";
        const wrapped = new GenieOSNetworkError(
          isAbort ? `Request timed out after ${timeoutMs}ms` : `Network error: ${e.message}`,
          e
        );
        if (attempt < maxRetries) {
          lastError = wrapped;
          await sleep(this.backoffFor(attempt));
          continue;
        }
        throw wrapped;
      }
    }
    throw lastError ?? new Error("GenieOS SDK: exhausted retries with no captured error");
  }
  buildUrl(path, query) {
    const url = new URL(`${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === void 0 || v === null) continue;
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }
  buildHeaders(opts) {
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "User-Agent": this.userAgent,
      ...this.defaultHeaders,
      ...opts.headers
    };
    if (opts.body !== void 0 && opts.method !== "GET" && opts.method !== "DELETE") {
      headers["Content-Type"] = "application/json";
    }
    if (isMutatingMethod(opts.method)) {
      headers["Idempotency-Key"] = opts.idempotencyKey ?? generateIdempotencyKey();
    }
    return headers;
  }
  backoffFor(attempt, retryAfter) {
    if (retryAfter) {
      const parsed = Number(retryAfter);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed * 1e3;
    }
    const base = this.initialBackoffMs * Math.pow(2, attempt);
    const jitter = Math.random() * base * 0.25;
    return base + jitter;
  }
};
function isMutatingMethod(method) {
  return method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE";
}
function generateIdempotencyKey() {
  const t = Date.now().toString(36);
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(8))).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `gos_${t}_${rand}`;
}
function buildError(status, body, requestId, headers) {
  const ctx = { status, code: body.code, message: body.message, type: body.type, requestId, context: body.context };
  if (status === 401 || status === 403) return new GenieOSAuthError(ctx);
  if (status === 409 && body.code === "idempotency_conflict") {
    return new GenieOSIdempotencyConflictError(ctx);
  }
  if (status === 422 || status === 400) return new GenieOSValidationError(ctx);
  if (status === 429) {
    const ra = headers.get("retry-after");
    return new GenieOSRateLimitError({
      ...ctx,
      retryAfterSec: ra ? Number(ra) : void 0
    });
  }
  return new GenieOSError(ctx);
}
async function parseErrorBody(res) {
  try {
    const json = await res.json();
    if (json.error) return json.error;
  } catch {
  }
  return {
    type: "api_error",
    code: `http_${res.status}`,
    message: `HTTP ${res.status} ${res.statusText}`.trim()
  };
}
async function safeJson(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function mergeSignals(a, b) {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const ctrl = new AbortController();
  const fwd = (signal) => () => ctrl.abort(signal.reason);
  a.addEventListener("abort", fwd(a), { once: true });
  b.addEventListener("abort", fwd(b), { once: true });
  return ctrl.signal;
}
var GenieOS = class {
  transport;
  workspace;
  templates;
  sequences;
  events;
  webhooks;
  keys;
  audit;
  brand;
  pages;
  connectors;
  /** Transactional SMS — `/v1/messaging/transactional/*`. */
  messaging;
  /** Alias of `messaging` for callers who think in SMS. */
  sms;
  /** Organic + transactional social. */
  social;
  marketing;
  creations;
  lists;
  approvals;
  links;
  /** Alias of `sequences` for callers raised on the legacy "flows" name. */
  flows;
  constructor(opts) {
    this.transport = new Transport(opts);
    this.workspace = new WorkspaceResource(this.transport);
    this.templates = new TemplatesResource(this.transport);
    this.sequences = new SequencesResource(this.transport);
    this.flows = this.sequences;
    this.events = new EventsResource(this.transport);
    this.webhooks = new WebhooksResource(this.transport);
    this.keys = new KeysResource(this.transport);
    this.audit = new AuditResource(this.transport);
    this.brand = new BrandResource(this.transport);
    this.pages = new PagesResource(this.transport);
    this.connectors = new ConnectorsResource(this.transport);
    this.messaging = new MessagingResource(this.transport);
    this.sms = this.messaging;
    this.social = new SocialResource(this.transport);
    this.marketing = new MarketingResource(this.transport);
    this.creations = new CreationsResource(this.transport);
    this.lists = new ListsResource(this.transport);
    this.approvals = new ApprovalsResource(this.transport);
    this.links = new LinksResource(this.transport);
  }
  /**
   * Escape hatch — issue a raw request against the API. Useful for
   * preview features that haven't been promoted to a typed resource.
   */
  request(opts) {
    return this.transport.request(opts);
  }
};
var WorkspaceResource = class {
  constructor(t) {
    this.t = t;
  }
  t;
  /** GET /v1/workspace — resolves the bearer token's home workspace. */
  get() {
    return this.t.request({ method: "GET", path: "/v1/workspace" });
  }
};
var PagesResource = class {
  constructor(t) {
    this.t = t;
  }
  t;
  /** GET /v1/pages — list landing pages (read-only; blueprints excluded). */
  list() {
    return this.t.request({ method: "GET", path: "/v1/pages" }).then((r) => r.data);
  }
  /** Async iterator over every page in the workspace. */
  async *iter() {
    const items = await this.list();
    for (const item of items) yield item;
  }
  /** GET /v1/pages/:idOrSlug — one page's metadata + section summary. */
  get(idOrSlug) {
    return this.t.request({
      method: "GET",
      path: `/v1/pages/${encodeURIComponent(idOrSlug)}`
    });
  }
  compose(idOrSlug, body) {
    return this.t.request({
      method: "POST",
      path: `/v1/pages/${encodeURIComponent(idOrSlug)}/compose`,
      body
    });
  }
  publish(idOrSlug, body = {}) {
    return this.t.request({
      method: "POST",
      path: `/v1/pages/${encodeURIComponent(idOrSlug)}/publish`,
      body
    }).then((r) => r.data);
  }
  unpublish(idOrSlug) {
    return this.t.request({
      method: "POST",
      path: `/v1/pages/${encodeURIComponent(idOrSlug)}/unpublish`,
      body: {}
    });
  }
};
var TemplatesResource = class {
  constructor(t) {
    this.t = t;
  }
  t;
  list() {
    return this.t.request({ method: "GET", path: "/v1/templates" }).then((r) => r.data);
  }
  /**
   * Async iterator over every template in the workspace. The REST
   * endpoint does not paginate today (workspaces have O(100) templates),
   * but we expose the iterator now so SDK users don't have to migrate
   * when cursors land.
   */
  async *iter() {
    const items = await this.list();
    for (const item of items) yield item;
  }
  get(key) {
    return this.t.request({
      method: "GET",
      path: `/v1/templates/${encodeURIComponent(key)}`
    });
  }
  /** Create a blank draft email template. */
  create(body = {}) {
    return this.t.request({ method: "POST", path: "/v1/templates", body }).then((r) => r.data);
  }
  /** Compose from a brief and persist. Charges compose-template credits. */
  compose(body) {
    return this.t.request({ method: "POST", path: "/v1/templates/compose", body }).then((r) => r.data);
  }
  render(key, body = {}) {
    return this.t.request({
      method: "POST",
      path: `/v1/templates/${encodeURIComponent(key)}/render`,
      body
    });
  }
  send(key, body, opts = {}) {
    return this.t.request({
      method: "POST",
      path: `/v1/templates/${encodeURIComponent(key)}/send`,
      body,
      idempotencyKey: opts.idempotencyKey
    });
  }
  schema(key) {
    return this.t.request({
      method: "GET",
      path: `/v1/templates/${encodeURIComponent(key)}/schema`
    });
  }
};
var SequencesResource = class {
  constructor(t) {
    this.t = t;
    this.runs = new SequenceRunsResource(t);
  }
  t;
  runs;
  list() {
    return this.t.request({ method: "GET", path: "/v1/sequences" }).then((r) => r.data);
  }
  get(keyOrId) {
    return this.t.request({
      method: "GET",
      path: `/v1/sequences/${encodeURIComponent(keyOrId)}`
    });
  }
  listRuns(keyOrId, opts = {}) {
    return this.t.request({
      method: "GET",
      path: `/v1/sequences/${encodeURIComponent(keyOrId)}/runs`,
      query: { limit: opts.limit }
    }).then((r) => r.data);
  }
  enroll(keyOrId, body, opts = {}) {
    return this.t.request({
      method: "POST",
      path: `/v1/sequences/${encodeURIComponent(keyOrId)}/enroll`,
      body,
      idempotencyKey: opts.idempotencyKey
    });
  }
};
var SequenceRunsResource = class {
  constructor(t) {
    this.t = t;
  }
  t;
  get(runId) {
    return this.t.request({
      method: "GET",
      path: `/v1/sequence-runs/${encodeURIComponent(runId)}`
    });
  }
  cancel(runId) {
    return this.t.request({
      method: "POST",
      path: `/v1/sequence-runs/${encodeURIComponent(runId)}/cancel`
    });
  }
};
var EventsResource = class {
  constructor(t) {
    this.t = t;
  }
  t;
  emit(body, opts = {}) {
    return this.t.request({
      method: "POST",
      path: "/v1/events",
      body,
      idempotencyKey: opts.idempotencyKey
    });
  }
};
var WebhooksResource = class {
  constructor(t) {
    this.t = t;
  }
  t;
  list() {
    return this.t.request({ method: "GET", path: "/v1/webhooks" }).then((r) => r.data);
  }
  get(id) {
    return this.t.request({
      method: "GET",
      path: `/v1/webhooks/${encodeURIComponent(id)}`
    });
  }
  create(body) {
    return this.t.request({
      method: "POST",
      path: "/v1/webhooks",
      body
    });
  }
  update(id, body) {
    return this.t.request({
      method: "PATCH",
      path: `/v1/webhooks/${encodeURIComponent(id)}`,
      body
    });
  }
  delete(id) {
    return this.t.request({
      method: "DELETE",
      path: `/v1/webhooks/${encodeURIComponent(id)}`
    });
  }
};
var KeysResource = class {
  constructor(t) {
    this.t = t;
  }
  t;
  list() {
    return this.t.request({ method: "GET", path: "/v1/keys" }).then((r) => r.data);
  }
  get(id) {
    return this.t.request({ method: "GET", path: `/v1/keys/${encodeURIComponent(id)}` });
  }
};
var AuditResource = class {
  constructor(t) {
    this.t = t;
  }
  t;
  list(opts = {}) {
    return this.t.request({
      method: "GET",
      path: "/v1/audit",
      query: { limit: opts.limit }
    }).then((r) => r.data);
  }
};
var BrandResource = class {
  constructor(t) {
    this.t = t;
  }
  t;
  list() {
    return this.t.request({ method: "GET", path: "/v1/brand" }).then((r) => r.data);
  }
  get(idOrDefault = "default") {
    return this.t.request({ method: "GET", path: `/v1/brand/${encodeURIComponent(idOrDefault)}` });
  }
};
var ConnectorsResource = class {
  constructor(t) {
    this.t = t;
  }
  t;
  /** Public catalog — no auth required, but the SDK call still
   *  attaches the bearer token (the API ignores it for this route). */
  catalog() {
    return this.t.request({ method: "GET", path: "/v1/connectors/catalog" });
  }
  list() {
    return this.t.request({ method: "GET", path: "/v1/connectors" });
  }
};
var MessagingResource = class {
  constructor(t) {
    this.t = t;
  }
  t;
  /** GET /v1/messaging/transactional/kit — workspace SMS template views. */
  kit() {
    return this.t.request({
      method: "GET",
      path: "/v1/messaging/transactional/kit"
    }).then((r) => r.data);
  }
  /** GET /v1/messaging/transactional/catalog — platform SMS definitions. */
  catalog() {
    return this.t.request({
      method: "GET",
      path: "/v1/messaging/transactional/catalog"
    }).then((r) => r.data);
  }
  preview(body) {
    return this.t.request({
      method: "POST",
      path: "/v1/messaging/transactional/preview",
      body
    });
  }
  send(body, opts = {}) {
    return this.t.request({
      method: "POST",
      path: "/v1/messaging/transactional",
      body,
      idempotencyKey: opts.idempotencyKey ?? body.idempotencyKey
    });
  }
  listDeliveries(opts = {}) {
    return this.t.request({
      method: "GET",
      path: "/v1/messaging/transactional/deliveries",
      query: { templateKey: opts.templateKey, limit: opts.limit }
    }).then((r) => Array.isArray(r) ? r : r.data ?? []);
  }
};
var SocialResource = class {
  constructor(t) {
    this.t = t;
    this.transactional = new TransactionalSocialResource(t);
  }
  t;
  transactional;
  /** Company-only connected networks (`{ profileStatus, networks }`). */
  listNetworks() {
    return this.t.request({
      method: "GET",
      path: "/v1/social/networks"
    });
  }
  refreshNetworks() {
    return this.t.request({ method: "POST", path: "/v1/social/networks/refresh" });
  }
  list(opts = {}) {
    return this.t.request({
      method: "GET",
      path: "/v1/social/posts",
      query: {
        status: opts.status,
        channelId: opts.channelId,
        groupId: opts.groupId,
        from: opts.from,
        to: opts.to,
        limit: opts.limit
      }
    }).then((r) => Array.isArray(r) ? r : r.data ?? []);
  }
  get(postId) {
    return this.t.request({
      method: "GET",
      path: `/v1/social/posts/${encodeURIComponent(postId)}`
    }).then((r) => r.data);
  }
  create(body, opts = {}) {
    return this.t.request({
      method: "POST",
      path: "/v1/social/posts",
      body,
      idempotencyKey: opts.idempotencyKey ?? body.idempotencyKey
    });
  }
  update(postId, body) {
    return this.t.request({
      method: "PATCH",
      path: `/v1/social/posts/${encodeURIComponent(postId)}`,
      body
    }).then((r) => r.data);
  }
  schedule(postId, body, opts = {}) {
    return this.t.request({
      method: "POST",
      path: `/v1/social/posts/${encodeURIComponent(postId)}/schedule`,
      body,
      idempotencyKey: opts.idempotencyKey
    });
  }
  publish(postId, body = {}, opts = {}) {
    return this.t.request({
      method: "POST",
      path: `/v1/social/posts/${encodeURIComponent(postId)}/publish`,
      body,
      idempotencyKey: opts.idempotencyKey
    });
  }
  delete(postId, opts = {}) {
    return this.t.request({
      method: "DELETE",
      path: `/v1/social/posts/${encodeURIComponent(postId)}`,
      query: opts.fromProvider ? { fromProvider: "true" } : void 0
    });
  }
  analytics(postId, opts = {}) {
    return this.t.request({
      method: "GET",
      path: `/v1/social/posts/${encodeURIComponent(postId)}/analytics`,
      query: opts.refresh ? { refresh: "true" } : void 0
    });
  }
};
var MarketingResource = class {
  constructor(t) {
    this.t = t;
  }
  t;
  strategy(opts = {}) {
    return this.t.request({
      method: "GET",
      path: "/v1/marketing/strategy",
      query: opts.detail === "full" ? { detail: "full" } : void 0
    });
  }
  listIcps(opts = {}) {
    return this.t.request({
      method: "GET",
      path: "/v1/marketing/icps",
      query: opts.detail === "full" ? { detail: "full" } : void 0
    }).then((r) => r.data);
  }
  getIcp(icpId) {
    return this.t.request({
      method: "GET",
      path: `/v1/marketing/icps/${encodeURIComponent(icpId)}`
    }).then((r) => r.data);
  }
  creationDefaults() {
    return this.t.request({
      method: "GET",
      path: "/v1/marketing/creation-defaults"
    }).then((r) => r.data);
  }
  patchStrategy(patch) {
    return this.t.request({
      method: "PATCH",
      path: "/v1/marketing/strategy",
      body: { patch }
    });
  }
  setCreationDefaults(body) {
    return this.t.request({
      method: "PATCH",
      path: "/v1/marketing/creation-defaults",
      body
    });
  }
  createIcp(body) {
    return this.t.request({ method: "POST", path: "/v1/marketing/icps", body });
  }
  updateIcp(icpId, body) {
    return this.t.request({
      method: "PATCH",
      path: `/v1/marketing/icps/${encodeURIComponent(icpId)}`,
      body
    });
  }
};
var CreationsResource = class {
  constructor(t) {
    this.t = t;
  }
  t;
  list(opts = {}) {
    return this.t.request({
      method: "GET",
      path: "/v1/creations",
      query: { status: opts.status, limit: opts.limit }
    }).then((r) => r.data);
  }
  get(creationId, opts = {}) {
    return this.t.request({
      method: "GET",
      path: `/v1/creations/${encodeURIComponent(creationId)}`,
      query: opts.detail === "full" ? { detail: "full" } : void 0
    }).then((r) => r.data);
  }
  spawn(body, opts = {}) {
    return this.t.request({
      method: "POST",
      path: "/v1/creations",
      body,
      idempotencyKey: opts.idempotencyKey
    });
  }
  approveStrategy(creationId) {
    return this.t.request({
      method: "POST",
      path: `/v1/creations/${encodeURIComponent(creationId)}/approve-strategy`,
      body: {}
    });
  }
};
var ListsResource = class {
  constructor(t) {
    this.t = t;
  }
  t;
  list() {
    return this.t.request({ method: "GET", path: "/v1/lists" }).then((r) => r.data);
  }
  get(listId) {
    return this.t.request({
      method: "GET",
      path: `/v1/lists/${encodeURIComponent(listId)}`
    }).then((r) => r.data);
  }
  create(body) {
    return this.t.request({ method: "POST", path: "/v1/lists", body }).then((r) => r.data);
  }
  update(listId, body) {
    return this.t.request({
      method: "PATCH",
      path: `/v1/lists/${encodeURIComponent(listId)}`,
      body
    }).then((r) => r.data);
  }
  delete(listId) {
    return this.t.request({
      method: "DELETE",
      path: `/v1/lists/${encodeURIComponent(listId)}`
    });
  }
  addMembers(listId, contactIds) {
    return this.t.request({
      method: "POST",
      path: `/v1/lists/${encodeURIComponent(listId)}/members`,
      body: { contactIds }
    }).then((r) => r.data);
  }
  removeMembers(listId, contactIds) {
    return this.t.request({
      method: "POST",
      path: `/v1/lists/${encodeURIComponent(listId)}/members/remove`,
      body: { contactIds }
    }).then((r) => r.data);
  }
};
var ApprovalsResource = class {
  constructor(t) {
    this.t = t;
  }
  t;
  listPolicies() {
    return this.t.request({ method: "GET", path: "/v1/approvals/policies" }).then((r) => r.data);
  }
  listPending(opts = {}) {
    return this.t.request({
      method: "GET",
      path: "/v1/approvals/pending",
      query: { limit: opts.limit }
    }).then((r) => r.data);
  }
  managePolicy(surfaceKind, body) {
    return this.t.request({
      method: "PUT",
      path: `/v1/approvals/policies/${encodeURIComponent(surfaceKind)}`,
      body
    });
  }
  decide(requestId, body) {
    return this.t.request({
      method: "POST",
      path: `/v1/approvals/pending/${encodeURIComponent(requestId)}/decide`,
      body
    });
  }
};
var LinksResource = class {
  constructor(t) {
    this.t = t;
  }
  t;
  list(opts = {}) {
    return this.t.request({
      method: "GET",
      path: "/v1/links",
      query: {
        includeArchived: opts.includeArchived ? "true" : void 0,
        limit: opts.limit
      }
    }).then((r) => r.data);
  }
  utmSuggestions(opts = {}) {
    return this.t.request({
      method: "GET",
      path: "/v1/links/utm-suggestions",
      query: {
        field: opts.field,
        includeCounts: opts.includeCounts === false ? "false" : void 0
      }
    }).then((r) => r.data);
  }
  create(body, opts = {}) {
    return this.t.request({
      method: "POST",
      path: "/v1/links",
      body,
      idempotencyKey: opts.idempotencyKey
    }).then((r) => r.data);
  }
};
var TransactionalSocialResource = class {
  constructor(t) {
    this.t = t;
  }
  t;
  catalog() {
    return this.t.request({
      method: "GET",
      path: "/v1/social/transactional/catalog"
    }).then((r) => r.data);
  }
  listTemplates() {
    return this.t.request({
      method: "GET",
      path: "/v1/social/transactional/templates"
    }).then((r) => r.data);
  }
  preview(body) {
    return this.t.request({
      method: "POST",
      path: "/v1/social/transactional/preview",
      body
    });
  }
  trigger(body, opts = {}) {
    return this.t.request({
      method: "POST",
      path: "/v1/social/transactional/events",
      body,
      idempotencyKey: opts.idempotencyKey ?? body.idempotencyKey
    });
  }
  listEvents(opts = {}) {
    return this.t.request({
      method: "GET",
      path: "/v1/social/transactional/events",
      query: { eventKey: opts.eventKey, limit: opts.limit }
    }).then((r) => r.data);
  }
};

// src/cli.ts
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { createInterface } from "readline/promises";
import process from "process";
var VERSION = "0.1.0";
function credentialsPath() {
  return join(homedir(), ".genieos", "credentials.json");
}
function loadCredentials() {
  try {
    return JSON.parse(readFileSync(credentialsPath(), "utf-8"));
  } catch {
    return {};
  }
}
function saveCredentials(c) {
  const path = credentialsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 448 });
  writeFileSync(path, JSON.stringify(c, null, 2) + "\n", { mode: 384 });
}
function resolveApiKey() {
  const env = process.env.GENIEOS_API_KEY?.trim();
  if (env) return env;
  const file = loadCredentials();
  return file.apiKey?.trim() ?? "";
}
function resolveApiUrl() {
  return process.env.GENIEOS_API_URL?.trim() || loadCredentials().apiUrl?.trim() || "https://api.genieos.pro";
}
function makeClient() {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    fail(
      "Not logged in.\n  Run `genie login`, or set GENIEOS_API_KEY in your shell."
    );
  }
  return new GenieOS({ apiKey, baseUrl: resolveApiUrl() });
}
var isTTY = process.stdout.isTTY;
var COLORS = {
  reset: "\x1B[0m",
  bold: "\x1B[1m",
  dim: "\x1B[2m",
  red: "\x1B[31m",
  green: "\x1B[32m",
  yellow: "\x1B[33m",
  cyan: "\x1B[36m"
};
function paint(text, color) {
  if (!isTTY) return text;
  return `${COLORS[color]}${text}${COLORS.reset}`;
}
function fail(msg, code = 1) {
  process.stderr.write(paint("error: ", "red") + msg + "\n");
  process.exit(code);
}
function ok(msg) {
  process.stdout.write(paint("\u2713 ", "green") + msg + "\n");
}
function info(msg) {
  process.stdout.write(msg + "\n");
}
function dim(msg) {
  return paint(msg, "dim");
}
function asJson(value) {
  return JSON.stringify(value, null, 2);
}
function table(rows, cols) {
  if (rows.length === 0) return dim("  (no rows)");
  const widths = cols.map(
    (c, i) => Math.max(c.header.length, ...rows.map((r) => cols[i].get(r).length))
  );
  const header = cols.map((c, i) => c.header.padEnd(widths[i])).join("  ");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  const body = rows.map((r) => cols.map((c, i) => c.get(r).padEnd(widths[i])).join("  ")).join("\n");
  return [paint(header, "bold"), dim(sep), body].join("\n");
}
function parse(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const name = a.slice(2);
        const next = argv[i + 1];
        if (next !== void 0 && !next.startsWith("--")) {
          flags[name] = next;
          i++;
        } else {
          flags[name] = true;
        }
      }
    } else if (a.startsWith("-") && a.length > 1) {
      const name = a.slice(1);
      flags[name] = true;
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}
function flag(args, name, alias) {
  const v = args.flags[name] ?? (alias ? args.flags[alias] : void 0);
  if (typeof v === "string") return v;
  if (v === true) return "";
  return void 0;
}
function bool(args, name, alias) {
  return Boolean(args.flags[name] ?? (alias ? args.flags[alias] : void 0));
}
function requireFlag(args, name) {
  const v = flag(args, name);
  if (v === void 0 || v === "") fail(`Missing required flag --${name}`);
  return v;
}
async function cmdLogin(args) {
  let apiKey = flag(args, "api-key");
  if (!apiKey) {
    if (!process.stdin.isTTY) {
      fail("No API key supplied and stdin is not a TTY. Use --api-key=<token>.");
    }
    info("Open https://app.genieos.pro/settings/api-keys, create a key, and paste it here.");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    apiKey = (await rl.question(paint("API key: ", "cyan"))).trim();
    rl.close();
    if (!apiKey) fail("No API key entered.");
  }
  const apiUrl = flag(args, "api-url");
  const probe = new GenieOS({
    apiKey,
    baseUrl: apiUrl ?? "https://api.genieos.pro"
  });
  try {
    const ws = await probe.workspace.get();
    saveCredentials({ apiKey, apiUrl });
    ok(`Logged in to ${paint(ws.name, "bold")} (workspace ${ws.id}, plan: ${ws.plan}).`);
    info(dim(`Credentials written to ${credentialsPath()}.`));
  } catch (e) {
    fail(formatError(e));
  }
}
function cmdLogout() {
  try {
    saveCredentials({});
    ok("Logged out. Credentials cleared.");
  } catch (e) {
    fail(formatError(e));
  }
}
async function cmdWhoami() {
  const gos = makeClient();
  const ws = await gos.workspace.get();
  info(`${paint(ws.name, "bold")} (${ws.id})`);
  info(`  plan:       ${ws.plan}`);
  info(`  scopes:     ${ws.scopes.join(", ") || dim("(none)")}`);
  info(`  rate limit: ${ws.rateLimitPerMinute}/min`);
}
async function cmdKeys(args) {
  const sub = args.positionals.shift();
  const gos = makeClient();
  if (sub === "list" || sub === void 0) {
    const keys = await gos.keys.list();
    info(
      table(keys, [
        { header: "ID", get: (k) => k.id },
        { header: "NAME", get: (k) => k.name },
        { header: "PREFIX", get: (k) => k.prefix },
        { header: "SCOPES", get: (k) => k.scopes.join(",") },
        { header: "LAST USED", get: (k) => formatDate(k.lastUsedAt) }
      ])
    );
    return;
  }
  if (sub === "get") {
    const id = args.positionals.shift();
    if (!id) fail("genie keys get <id>");
    info(asJson(await gos.keys.get(id)));
    return;
  }
  fail(`Unknown subcommand: keys ${sub}
  Available: list, get`);
}
async function cmdWebhooks(args) {
  const sub = args.positionals.shift();
  const gos = makeClient();
  if (sub === "list" || sub === void 0) {
    const items = await gos.webhooks.list();
    info(
      table(items, [
        { header: "ID", get: (w) => w.id },
        { header: "URL", get: (w) => w.url },
        { header: "EVENTS", get: (w) => w.events.length ? w.events.join(",") : "*" },
        {
          header: "STATUS",
          get: (w) => w.disabledAt ? paint("disabled", "yellow") : w.lastDeliveryStatus === "failure" ? paint("failing", "red") : paint("healthy", "green")
        }
      ])
    );
    return;
  }
  if (sub === "create") {
    const url = requireFlag(args, "url");
    const events = flag(args, "events");
    const description = flag(args, "description");
    const created = await gos.webhooks.create({
      url,
      events: events ? events.split(",").map((s) => s.trim()) : void 0,
      description
    });
    ok(`Created webhook ${created.webhook.id}`);
    info(
      paint(
        "\n  Save this secret now \u2014 it will be masked on subsequent reads:",
        "yellow"
      )
    );
    info(`  ${created.webhook.secret}
`);
    return;
  }
  if (sub === "delete") {
    const id = args.positionals.shift();
    if (!id) fail("genie webhooks delete <id>");
    await gos.webhooks.delete(id);
    ok(`Deleted webhook ${id}`);
    return;
  }
  fail(`Unknown subcommand: webhooks ${sub}
  Available: list, create, delete`);
}
async function cmdTemplates(args) {
  const sub = args.positionals.shift();
  const gos = makeClient();
  if (sub === "list" || sub === void 0) {
    const items = await gos.templates.list();
    info(
      table(items, [
        { header: "KEY", get: (t) => t.key },
        { header: "NAME", get: (t) => t.name },
        { header: "SUBJECT", get: (t) => (t.subject ?? "").slice(0, 50) },
        { header: "V", get: (t) => String(t.version) },
        { header: "UPDATED", get: (t) => formatDate(t.updatedAt) }
      ])
    );
    return;
  }
  if (sub === "get") {
    const key = args.positionals.shift();
    if (!key) fail("genie templates get <key>");
    info(asJson(await gos.templates.get(key)));
    return;
  }
  if (sub === "render") {
    const key = args.positionals.shift();
    if (!key) fail("genie templates render <key> [--vars=<json>]");
    const vars = parseJsonFlag(args, "vars");
    const out = await gos.templates.render(key, { variables: vars });
    info(paint("Subject:", "bold") + " " + out.subject);
    if (out.warnings?.length) {
      info(paint("\nWarnings:", "yellow"));
      for (const w of out.warnings) info("  - " + w);
    }
    info(paint("\nHTML:", "bold"));
    info(out.html);
    return;
  }
  if (sub === "send") {
    const key = args.positionals.shift();
    if (!key) fail("genie templates send <key> --to=<email> [--vars=<json>]");
    const to = requireFlag(args, "to");
    const vars = parseJsonFlag(args, "vars");
    const out = await gos.templates.send(key, { to, variables: vars });
    ok(`Queued send ${out.id}`);
    return;
  }
  if (sub === "create") {
    const name = flag(args, "name");
    const key = flag(args, "key");
    const out = await gos.templates.create({
      ...name ? { name } : {},
      ...key ? { key } : {}
    });
    ok(`Created template ${out.key ?? out.id ?? ""}`.trim());
    info(asJson(out));
    return;
  }
  if (sub === "compose") {
    const prompt = args.positionals.shift() || flag(args, "prompt");
    if (!prompt) fail('genie templates compose "<brief>" [--key=\u2026] [--name=\u2026]');
    const key = flag(args, "key");
    const name = flag(args, "name");
    const out = await gos.templates.compose({
      prompt,
      ...key ? { key } : {},
      ...name ? { name } : {}
    });
    ok(`Composed template ${out.key ?? out.id ?? ""}`.trim());
    if (out.subject) info(paint("Subject:", "bold") + " " + out.subject);
    info(asJson(out));
    return;
  }
  fail(`Unknown subcommand: templates ${sub}
  Available: list, get, render, send, create, compose`);
}
async function cmdEvents(args) {
  const sub = args.positionals.shift();
  const gos = makeClient();
  if (sub === "emit") {
    const name = args.positionals.shift() ?? requireFlag(args, "name");
    const userId = flag(args, "user-id");
    const email = flag(args, "email");
    const traits = parseJsonFlag(args, "traits");
    const out = await gos.events.emit({ name, userId, email, traits });
    ok(`Recorded event ${out.eventId}`);
    if (out.enrollments?.length) {
      info(`  Enrolled into ${out.enrollments.length} sequence(s):`);
      for (const e of out.enrollments) info(`  - ${e.sequenceKey} (${e.runId})`);
    }
    return;
  }
  fail(`Unknown subcommand: events ${sub}
  Available: emit`);
}
async function cmdLogs(args) {
  const sub = args.positionals.shift();
  if (sub !== "tail" && sub !== void 0) {
    fail(`Unknown subcommand: logs ${sub}
  Available: tail`);
  }
  const gos = makeClient();
  const intervalMs = Number(flag(args, "interval") ?? "5000");
  const limit = Number(flag(args, "limit") ?? "50");
  let seen = /* @__PURE__ */ new Set();
  try {
    const initial = await gos.audit.list({ limit });
    seen = new Set(initial.map((e) => e.id));
    info(dim(`Tailing audit log (every ${intervalMs}ms, ^C to stop) \u2014 primed with ${seen.size} entries.`));
  } catch (e) {
    fail(formatError(e));
  }
  const stop = { v: false };
  process.on("SIGINT", () => {
    stop.v = true;
    process.stdout.write("\n");
    info(dim("Stopped."));
    process.exit(0);
  });
  while (!stop.v) {
    try {
      const page = await gos.audit.list({ limit });
      const fresh = page.filter((e) => !seen.has(e.id)).reverse();
      for (const e of fresh) {
        seen.add(e.id);
        info(
          [
            dim(formatDate(e.occurredAt)),
            paint(e.action, "cyan"),
            e.target ? dim(e.target) : "",
            e.actor
          ].filter(Boolean).join("  ")
        );
      }
    } catch (e) {
      info(paint(`audit poll failed: ${formatError(e)}`, "yellow"));
    }
    await sleep2(intervalMs);
  }
}
async function cmdSequences(args) {
  const sub = args.positionals.shift();
  const gos = makeClient();
  if (sub === "list" || sub === void 0) {
    const items = await gos.sequences.list();
    if (bool(args, "json")) {
      info(asJson(items));
      return;
    }
    info(
      table(items, [
        { header: "KEY", get: (s) => s.key },
        { header: "NAME", get: (s) => s.name },
        { header: "STATUS", get: (s) => s.status },
        { header: "ENROLLED", get: (s) => String(s.enrolledCount) }
      ])
    );
    return;
  }
  if (sub === "get") {
    const key = args.positionals.shift();
    if (!key) fail("genie sequences get <keyOrId>");
    info(asJson(await gos.sequences.get(key)));
    return;
  }
  if (sub === "enroll") {
    const key = args.positionals.shift();
    if (!key) fail("genie sequences enroll <keyOrId> --email=...");
    const email = flag(args, "email");
    const userId = flag(args, "user-id");
    if (!email && !userId) fail("Provide --email or --user-id");
    const result = await gos.sequences.enroll(key, {
      contact: { email, userId, traits: parseJsonFlag(args, "traits") },
      variables: parseJsonFlag(args, "vars")
    });
    ok(`Enrolled run ${result.runId} on ${result.sequenceKey}`);
    if (bool(args, "json")) info(asJson(result));
    return;
  }
  fail(`Unknown subcommand: sequences ${sub}
  Available: list, get, enroll`);
}
async function cmdPages(args) {
  const sub = args.positionals.shift();
  const gos = makeClient();
  if (sub === "list" || sub === void 0) {
    const items = await gos.pages.list();
    if (bool(args, "json")) {
      info(asJson(items));
      return;
    }
    info(
      table(items, [
        { header: "ID", get: (p) => p.id },
        { header: "SLUG", get: (p) => p.slug },
        { header: "STATUS", get: (p) => p.status },
        { header: "TITLE", get: (p) => p.title }
      ])
    );
    return;
  }
  if (sub === "get") {
    const id = args.positionals.shift();
    if (!id) fail("genie pages get <idOrSlug>");
    info(asJson(await gos.pages.get(id)));
    return;
  }
  if (sub === "publish") {
    const id = args.positionals.shift();
    if (!id) fail("genie pages publish <idOrSlug>");
    info(asJson(await gos.pages.publish(id, flag(args, "slug") ? { slug: flag(args, "slug") } : {})));
    return;
  }
  if (sub === "unpublish") {
    const id = args.positionals.shift();
    if (!id) fail("genie pages unpublish <idOrSlug>");
    info(asJson(await gos.pages.unpublish(id)));
    return;
  }
  fail(`Unknown subcommand: pages ${sub}
  Available: list, get, publish, unpublish`);
}
async function cmdBrand(args) {
  const sub = args.positionals.shift();
  const gos = makeClient();
  if (sub === "list" || sub === void 0) {
    const items = await gos.brand.list();
    if (bool(args, "json")) {
      info(asJson(items));
      return;
    }
    info(
      table(items, [
        { header: "ID", get: (b) => b.id },
        { header: "NAME", get: (b) => b.name },
        { header: "DEFAULT", get: (b) => b.isDefault ? "yes" : "" },
        { header: "DOMAIN", get: (b) => b.domain ?? "\u2014" }
      ])
    );
    return;
  }
  if (sub === "get") {
    const id = args.positionals.shift() ?? "default";
    info(asJson(await gos.brand.get(id)));
    return;
  }
  fail(`Unknown subcommand: brand ${sub}
  Available: list, get`);
}
async function cmdSms(args) {
  const sub = args.positionals.shift();
  const gos = makeClient();
  if (sub === "kit" || sub === "catalog") {
    const items = sub === "kit" ? await gos.messaging.kit() : await gos.messaging.catalog();
    info(asJson(items));
    return;
  }
  if (sub === "send") {
    const templateKey = requireFlag(args, "template");
    const to = flag(args, "to");
    const result = await gos.messaging.send({
      templateKey,
      to,
      variables: parseJsonFlag(args, "vars")
    });
    ok(`SMS ${result.status} \xB7 delivery ${result.deliveryId}`);
    if (bool(args, "json")) info(asJson(result));
    return;
  }
  if (sub === "deliveries") {
    info(
      asJson(
        await gos.messaging.listDeliveries({
          templateKey: flag(args, "template"),
          limit: Number(flag(args, "limit") ?? 50)
        })
      )
    );
    return;
  }
  fail(`Unknown subcommand: sms ${sub}
  Available: kit, catalog, send, deliveries`);
}
async function cmdMarketing(args) {
  const sub = args.positionals.shift();
  const gos = makeClient();
  if (sub === "strategy" || sub === void 0) {
    info(asJson(await gos.marketing.strategy({ detail: bool(args, "full") ? "full" : "summary" })));
    return;
  }
  if (sub === "icps") {
    info(asJson(await gos.marketing.listIcps({ detail: bool(args, "full") ? "full" : "summary" })));
    return;
  }
  if (sub === "defaults") {
    info(asJson(await gos.marketing.creationDefaults()));
    return;
  }
  if (sub === "set-defaults") {
    const body = {};
    const kind = flag(args, "coordination-kind");
    const emailCount = flag(args, "email-count");
    const goal = flag(args, "goal");
    const askMode = flag(args, "ask-mode");
    const strategyMode = flag(args, "strategy-mode");
    if (kind) body.coordinationKind = kind;
    if (emailCount) body.emailCount = Number(emailCount);
    if (goal) body.goal = goal;
    if (askMode) body.askMode = askMode;
    if (strategyMode) body.strategyMode = strategyMode;
    info(asJson(await gos.marketing.setCreationDefaults(body)));
    return;
  }
  fail(
    `Unknown subcommand: marketing ${sub}
  Available: strategy, icps, defaults, set-defaults`
  );
}
async function cmdCreations(args) {
  const sub = args.positionals.shift();
  const gos = makeClient();
  if (sub === "list" || sub === void 0) {
    info(asJson(await gos.creations.list({ status: flag(args, "status"), limit: Number(flag(args, "limit") ?? 25) })));
    return;
  }
  if (sub === "get") {
    const id = args.positionals.shift();
    if (!id) fail("genie creations get <creationId>");
    info(asJson(await gos.creations.get(id, { detail: bool(args, "full") ? "full" : "summary" })));
    return;
  }
  if (sub === "spawn") {
    const brief = flag(args, "brief") ?? args.positionals.shift();
    if (!brief) fail('genie creations spawn --brief "\u2026"');
    info(
      asJson(
        await gos.creations.spawn({
          brief,
          ...flag(args, "strategy-mode") ? { strategyMode: flag(args, "strategy-mode") } : {}
        })
      )
    );
    return;
  }
  if (sub === "approve") {
    const id = args.positionals.shift();
    if (!id) fail("genie creations approve <creationId>");
    info(asJson(await gos.creations.approveStrategy(id)));
    return;
  }
  fail(`Unknown subcommand: creations ${sub}
  Available: list, get, spawn, approve`);
}
async function cmdLists(args) {
  const sub = args.positionals.shift();
  const gos = makeClient();
  if (sub === "list" || sub === void 0) {
    info(asJson(await gos.lists.list()));
    return;
  }
  if (sub === "get") {
    const id = args.positionals.shift();
    if (!id) fail("genie lists get <listId>");
    info(asJson(await gos.lists.get(id)));
    return;
  }
  if (sub === "create") {
    const name = flag(args, "name") ?? args.positionals.shift();
    if (!name) fail('genie lists create --name "\u2026"');
    info(asJson(await gos.lists.create({ name })));
    return;
  }
  if (sub === "add-members") {
    const id = args.positionals.shift();
    const ids = flag(args, "contact-ids");
    if (!id || !ids) fail("genie lists add-members <listId> --contact-ids id1,id2");
    info(asJson(await gos.lists.addMembers(id, ids.split(",").map((s) => s.trim()).filter(Boolean))));
    return;
  }
  fail(`Unknown subcommand: lists ${sub}
  Available: list, get, create, add-members`);
}
async function cmdLinks(args) {
  const sub = args.positionals.shift();
  const gos = makeClient();
  if (sub === "list") {
    const limitRaw = flag(args, "limit");
    info(
      asJson(
        await gos.links.list({
          includeArchived: bool(args, "include-archived"),
          ...limitRaw ? { limit: Number(limitRaw) } : {}
        })
      )
    );
    return;
  }
  if (sub === "utm-suggestions" || sub === "utm") {
    const field = flag(args, "field");
    info(
      asJson(
        await gos.links.utmSuggestions({
          ...field ? { field } : {},
          includeCounts: !bool(args, "no-counts")
        })
      )
    );
    return;
  }
  if (sub === "create" || sub === void 0) {
    const url = flag(args, "url") ?? args.positionals.shift();
    if (!url) fail("genie links create --url https://\u2026 [--slug=\u2026] [--label=\u2026] [--utm-source=\u2026] \u2026");
    const utmSource = flag(args, "utm-source");
    const utmMedium = flag(args, "utm-medium");
    const utmCampaign = flag(args, "utm-campaign");
    const utmContent = flag(args, "utm-content");
    const utmTerm = flag(args, "utm-term");
    const utm = utmSource || utmMedium || utmCampaign || utmContent || utmTerm ? {
      ...utmSource ? { source: utmSource } : {},
      ...utmMedium ? { medium: utmMedium } : {},
      ...utmCampaign ? { campaign: utmCampaign } : {},
      ...utmContent ? { content: utmContent } : {},
      ...utmTerm ? { term: utmTerm } : {}
    } : void 0;
    const tagsRaw = flag(args, "tags");
    const tags = tagsRaw ? tagsRaw.split(",").map((s) => s.trim()).filter(Boolean) : void 0;
    info(
      asJson(
        await gos.links.create({
          destinationUrl: url,
          ...flag(args, "slug") ? { slug: flag(args, "slug") } : {},
          ...flag(args, "label") ? { label: flag(args, "label") } : {},
          ...flag(args, "campaign-id") ? { campaignId: flag(args, "campaign-id") } : {},
          ...flag(args, "domain") ? { domain: flag(args, "domain") } : {},
          ...tags?.length ? { tags } : {},
          ...utm ? { utm } : {}
        })
      )
    );
    return;
  }
  fail(`Unknown subcommand: links ${sub}
  Available: list, utm-suggestions, create`);
}
async function cmdSocial(args) {
  const sub = args.positionals.shift();
  const gos = makeClient();
  if (sub === "networks") {
    const action = args.positionals.shift();
    if (action === "refresh") {
      info(asJson(await gos.social.refreshNetworks()));
      return;
    }
    info(asJson(await gos.social.listNetworks()));
    return;
  }
  if (sub === "posts" || sub === "list") {
    const items = await gos.social.list({
      status: flag(args, "status"),
      channelId: flag(args, "channel"),
      limit: Number(flag(args, "limit") ?? 25)
    });
    if (bool(args, "json")) {
      info(asJson(items));
      return;
    }
    info(
      table(items, [
        { header: "ID", get: (p) => p.id },
        { header: "CHANNEL", get: (p) => String(p.channelId ?? "\u2014") },
        { header: "STATUS", get: (p) => String(p.status) },
        {
          header: "CAPTION",
          get: (p) => {
            const c = String(p.caption ?? "");
            return c.length > 48 ? `${c.slice(0, 45)}\u2026` : c || "\u2014";
          }
        }
      ])
    );
    return;
  }
  if (sub === "get") {
    const id = args.positionals.shift();
    if (!id) fail("genie social get <postId>");
    info(asJson(await gos.social.get(id)));
    return;
  }
  if (sub === "create") {
    const channelsRaw = requireFlag(args, "channels");
    const channels = channelsRaw.split(",").map((s) => s.trim()).filter(Boolean);
    const mode = flag(args, "mode") ?? "copy";
    const result = await gos.social.create({
      mode,
      channels,
      caption: flag(args, "caption"),
      brief: flag(args, "brief"),
      scheduleAt: flag(args, "schedule-at"),
      publish: bool(args, "publish")
    });
    ok(`Created social post group ${result.groupId ?? "(see JSON)"}`);
    info(asJson(result));
    return;
  }
  if (sub === "schedule") {
    const id = args.positionals.shift();
    if (!id) fail("genie social schedule <postId> --at=<ISO>");
    const at = requireFlag(args, "at");
    info(asJson(await gos.social.schedule(id, { scheduledAt: at })));
    return;
  }
  if (sub === "publish") {
    const id = args.positionals.shift();
    if (!id) fail("genie social publish <postId>");
    info(asJson(await gos.social.publish(id)));
    return;
  }
  if (sub === "delete") {
    const id = args.positionals.shift();
    if (!id) fail("genie social delete <postId>");
    info(asJson(await gos.social.delete(id, { fromProvider: bool(args, "from-provider") })));
    return;
  }
  fail(
    `Unknown subcommand: social ${sub}
  Available: networks, posts, get, create, schedule, publish, delete`
  );
}
function cmdHelp() {
  info(`genie v${VERSION}  \u2014  GenieOS command-line client

USAGE
  genie <command> [subcommand] [flags]

COMMANDS
  login                Authenticate with an API key (saved to ~/.genieos/credentials.json)
  logout               Forget the saved API key
  whoami               Print the current workspace and plan

  keys list            List API keys for the workspace
  keys get <id>        Inspect a single API key

  webhooks list                              List webhook subscriptions
  webhooks create --url=... [--events=a,b]   Create a subscription
  webhooks delete <id>                       Delete a subscription

  templates list                                                       List templates
  templates get <key>                                                  Inspect a template
  templates create [--name=\u2026] [--key=\u2026]                                Create a blank draft
  templates compose "<brief>" [--key=\u2026] [--name=\u2026]                     Compose from a brief
  templates render <key> [--vars='{...}']                              Render to HTML
  templates send <key> --to=<email> [--vars='{...}']                   Send a transactional email

  sequences list|get|enroll                                            Sequences
  pages list|get|publish|unpublish                                     Landing pages
  brand list|get                                                       Brand kit (read)

  sms kit|catalog|send|deliveries                                      Transactional SMS
  social networks|posts|get|create|schedule|publish|delete             Organic social

  marketing strategy|icps|defaults|set-defaults                        Marketing OS
  creations list|get|spawn|approve                                     Campaigns
  lists list|get|create|add-members                                    Contact lists
  links list|utm-suggestions|create [--utm-source=\u2026] \u2026                 Short links

  events emit <name> [--email=...] [--user-id=...] [--traits='{...}']  Emit a customer event

  logs tail [--interval=5000] [--limit=50]                             Stream the audit log

GLOBAL FLAGS
  --api-key=<token>    Override the saved key for one invocation
  --api-url=<url>      Point at a custom GenieOS API host (default https://api.genieos.pro)
  --json               Print raw JSON responses where supported
  -h, --help           Show this message
`);
}
function parseJsonFlag(args, name) {
  const v = flag(args, name);
  if (!v) return void 0;
  try {
    const parsed = JSON.parse(v);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      fail(`--${name} must be a JSON object, got ${typeof parsed}`);
    }
    return parsed;
  } catch (e) {
    fail(`--${name}: invalid JSON (${e.message})`);
  }
}
function formatDate(iso) {
  if (!iso) return dim("\u2014");
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
  } catch {
    return iso;
  }
}
function formatError(e) {
  if (e instanceof GenieOSError) {
    return `${e.message} (${e.code}${e.status ? `, HTTP ${e.status}` : ""})`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
function sleep2(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
    cmdHelp();
    return;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    info(`genie v${VERSION}`);
    return;
  }
  const command = argv.shift();
  const args = parse(argv);
  switch (command) {
    case "login":
      await cmdLogin(args);
      break;
    case "logout":
      cmdLogout();
      break;
    case "whoami":
      await cmdWhoami();
      break;
    case "keys":
      await cmdKeys(args);
      break;
    case "webhooks":
      await cmdWebhooks(args);
      break;
    case "templates":
      await cmdTemplates(args);
      break;
    case "events":
      await cmdEvents(args);
      break;
    case "sequences":
      await cmdSequences(args);
      break;
    case "pages":
      await cmdPages(args);
      break;
    case "brand":
      await cmdBrand(args);
      break;
    case "sms":
      await cmdSms(args);
      break;
    case "social":
      await cmdSocial(args);
      break;
    case "marketing":
      await cmdMarketing(args);
      break;
    case "creations":
      await cmdCreations(args);
      break;
    case "lists":
      await cmdLists(args);
      break;
    case "links":
      await cmdLinks(args);
      break;
    case "logs":
      await cmdLogs(args);
      break;
    default:
      fail(`Unknown command: ${command}
  Run \`genie help\` for usage.`);
  }
}
main().catch((e) => {
  fail(formatError(e));
});
