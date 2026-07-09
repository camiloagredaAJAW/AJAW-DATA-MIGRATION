// Shared client logic for the admin dashboard/mappings/errors pages.
// Vanilla JS, no build step: loaded directly via <script src="/admin/app.js">.

/**
 * `sessionAuth.ts`'s `requireCsrfHeader` only checks that this header is
 * PRESENT (`request.headers[CSRF_HEADER] === undefined`), not its value — see
 * design Decision 2. `"fetch"` is the value the design doc settled on; any
 * non-empty value would satisfy the guard.
 */
const CSRF_HEADER_NAME = "X-Requested-With";
const CSRF_HEADER_VALUE = "fetch";

/**
 * Every admin API call redirects to the login page on 401, not just the
 * first one — the spec only requires it for the initial fetch, but any
 * later call can also observe an expired session (12h `maxAge`, or a
 * server restart wiping the in-memory session store), so treating every
 * 401 uniformly is a strict superset of the required behavior.
 */
async function adminFetch(path, options = {}) {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = { ...(options.headers ?? {}) };
  if (method !== "GET") {
    headers[CSRF_HEADER_NAME] = CSRF_HEADER_VALUE;
  }
  if (options.body !== undefined && headers["Content-Type"] === undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(path, {
    ...options,
    method,
    headers,
    credentials: "same-origin",
  });

  if (response.status === 401) {
    window.location.replace("/admin/login.html");
    throw new Error("unauthenticated");
  }

  return response;
}

async function adminFetchJson(path, options = {}) {
  const response = await adminFetch(path, options);
  const body = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, body };
}

function showError(element, message) {
  if (element === null) return;
  element.textContent = message;
  element.hidden = false;
}

function hideError(element) {
  if (element === null) return;
  element.hidden = true;
}

/**
 * Escapes for BOTH HTML text-node and (double- or single-quoted) HTML
 * attribute-value contexts — every call site in this file interpolates the
 * result into both (e.g. `value="${escapeHtml(...)}"` as well as plain text
 * nodes). A previous DOM-`textContent`-based implementation only escaped
 * `&`/`<`/`>` (the text-node serialization rules) and left `"`/`'`
 * unescaped, which let an attacker-controlled value (e.g. a saved field
 * mapping's `destinationField`/`transform`, which has no character
 * restriction server-side) break out of a double-quoted attribute and inject
 * arbitrary markup/scripts — a stored-XSS bug. Implemented as a pure string
 * function (no `document` dependency) so it's also unit-testable under
 * Node without a DOM/jsdom dependency — see test/public/app.test.ts.
 */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wireLogout() {
  const logoutButton = document.getElementById("logout-button");
  if (logoutButton === null) return;
  logoutButton.addEventListener("click", async () => {
    try {
      await adminFetch("/admin/logout", { method: "POST" });
    } catch (error) {
      // adminFetch already redirects on 401; any other failure still
      // attempts a client-side redirect so "log out" always feels final.
    }
    window.location.replace("/admin/login.html");
  });
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

const RUN_ACTIVE_STATUSES = new Set(["running", "paused"]);

function renderRunSummary(run) {
  const container = document.getElementById("run-summary");
  if (run === null) {
    container.innerHTML = `<p class="muted">No migration run has started yet.</p>`;
    return;
  }

  container.innerHTML = `
    <p>
      Run #${run.id}
      <span class="status-pill ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span>
    </p>
    <p class="muted">Started: ${escapeHtml(run.startedAt)} · Updated: ${escapeHtml(run.updatedAt)}</p>
  `;
}

function renderCheckpoints(checkpoints) {
  const tbody = document.querySelector("#checkpoints-table tbody");
  tbody.innerHTML = "";
  for (const checkpoint of checkpoints) {
    const row = document.createElement("tr");
    row.dataset.countryCode = checkpoint.countryCode;
    row.dataset.status = checkpoint.status;
    const canRetry = checkpoint.status === "failed" || checkpoint.status === "in_progress";
    row.innerHTML = `
      <td>${escapeHtml(checkpoint.countryCode)}</td>
      <td>${checkpoint.lastOffset}</td>
      <td>${escapeHtml(checkpoint.status)}</td>
      <td>${checkpoint.aiSearchId ?? "-"}</td>
      <td>
        ${canRetry ? `<button data-action="retry-country">Retry</button><span data-role="retry-country-result" class="muted"></span>` : ""}
      </td>
    `;
    tbody.appendChild(row);
  }
}

/**
 * Pure decision function, extracted from `applyControlGating` so the
 * start/pause/resume/stop button-disabled logic (including the fallback for
 * an unrecognized/unexpected `runStatus`) can be unit-tested without a DOM.
 * An unrecognized status (anything other than `"running"`/`"paused"`, e.g. a
 * future backend status value) falls through to the same gating as `null`
 * (no run): start enabled, pause/resume/stop disabled.
 */
function computeControlGating(runStatus) {
  const isActive = runStatus !== null && RUN_ACTIVE_STATUSES.has(runStatus);
  return {
    startDisabled: isActive,
    pauseDisabled: runStatus !== "running",
    resumeDisabled: runStatus !== "paused",
    stopDisabled: !isActive,
  };
}

function applyControlGating(runStatus) {
  const gating = computeControlGating(runStatus);
  document.getElementById("start-button").disabled = gating.startDisabled;
  document.getElementById("pause-button").disabled = gating.pauseDisabled;
  document.getElementById("resume-button").disabled = gating.resumeDisabled;
  document.getElementById("stop-button").disabled = gating.stopDisabled;
}

async function loadDashboard() {
  const errorEl = document.getElementById("dashboard-error");
  hideError(errorEl);
  try {
    const { ok, body } = await adminFetchJson("/admin/api/status");
    if (!ok) {
      showError(errorEl, "Failed to load migration status.");
      return;
    }
    const { run, checkpoints, totals, axelorBaseUrl } = body.data;
    renderRunSummary(run);
    renderCheckpoints(checkpoints);
    document.getElementById("error-count").textContent = totals.errors;
    document.getElementById("axelor-target").textContent = axelorBaseUrl;
    applyControlGating(run === null ? null : run.status);
  } catch (error) {
    if (error.message !== "unauthenticated") {
      console.error(error);
      showError(errorEl, "Could not reach the server.");
    }
  }
}

async function runControlAction(action) {
  const errorEl = document.getElementById("dashboard-error");
  hideError(errorEl);
  try {
    const { ok, body } = await adminFetchJson(`/admin/api/migration/${action}`, { method: "POST" });
    if (!ok) {
      showError(errorEl, body?.error?.message ?? `Could not ${action} the run.`);
    }
    await loadDashboard();
  } catch (error) {
    if (error.message !== "unauthenticated") {
      console.error(error);
      showError(errorEl, "Could not reach the server.");
      // Unlike the `!ok` branch above, a network-level failure here never
      // ran `loadDashboard()`, so the button gating from the previous
      // successful load would otherwise go stale. Re-sync it here too.
      await loadDashboard();
    }
  }
}

/**
 * Pure formatting function so the summary text is unit-testable without a
 * DOM — mirrors the `describeRetryOutcome` pattern above.
 */
function formatRefreshCatalogResult(result) {
  return `Catalog refreshed: ${result.totalCatalogEntries} countries total, ${result.newPairs.length} newly discovered.`;
}

async function refreshCatalog() {
  const button = document.getElementById("refresh-catalog-button");
  const resultEl = document.getElementById("refresh-catalog-result");
  const errorEl = document.getElementById("dashboard-error");
  hideError(errorEl);
  resultEl.classList.remove("success");
  resultEl.textContent = "Refreshing...";
  button.disabled = true;

  try {
    const { ok, body } = await adminFetchJson("/admin/api/catalog/refresh", { method: "POST" });
    if (!ok) {
      resultEl.textContent = "";
      showError(errorEl, body?.error?.message ?? "Could not refresh the catalog.");
      return;
    }
    resultEl.textContent = formatRefreshCatalogResult(body.data);
    resultEl.classList.add("success");
  } catch (error) {
    if (error.message !== "unauthenticated") {
      console.error(error);
      resultEl.textContent = "";
      showError(errorEl, "Could not reach the server.");
    }
  } finally {
    button.disabled = false;
  }
}

/**
 * Pure formatting function so the summary text is unit-testable without a
 * DOM — mirrors `formatRefreshCatalogResult` above. `seed.appliedCount` (not
 * `totalRows`) is used deliberately: on a wiped table every row is a fresh
 * insert, so they're numerically equal in practice, but `appliedCount` is the
 * field that actually means "rows written" per `loadDeducedSeed`'s contract.
 */
function formatFullResetResult(result) {
  return `Reset complete: ${result.seed.appliedCount} field mappings seeded, ${result.catalog.totalCatalogEntries} catalog entries found.`;
}

/**
 * Enables the "Reset Everything" button only once the password field is
 * non-empty — the whole point of requiring the operator to type it is
 * defeated if the button is clickable before they have.
 */
function updateResetButtonState() {
  const passwordInput = document.getElementById("reset-password-input");
  const button = document.getElementById("reset-everything-button");
  button.disabled = passwordInput.value === "";
}

/**
 * The danger-zone form (warning text, password input, confirm button) stays
 * hidden behind a "Reset Everything" reveal button until the operator
 * explicitly asks for it — collapsing it again clears the typed password so
 * it never sits exposed in a hidden field. Used both by the reveal/cancel
 * buttons and to auto-collapse after a successful reset.
 */
function setResetFormVisible(visible) {
  document.getElementById("show-reset-form-button").hidden = visible;
  document.getElementById("reset-form").hidden = !visible;
  if (!visible) {
    document.getElementById("reset-password-input").value = "";
    document.getElementById("reset-everything-result").textContent = "";
    updateResetButtonState();
  }
}

async function resetEverything() {
  const passwordInput = document.getElementById("reset-password-input");
  const button = document.getElementById("reset-everything-button");
  const resultEl = document.getElementById("reset-everything-result");
  const errorEl = document.getElementById("dashboard-error");
  hideError(errorEl);
  resultEl.classList.remove("success");
  resultEl.textContent = "Resetting...";
  button.disabled = true;

  try {
    const { status, ok, body } = await adminFetchJson("/admin/api/reset", {
      method: "POST",
      body: JSON.stringify({ password: passwordInput.value }),
    });
    if (!ok) {
      resultEl.textContent = "";
      // The wrong-password case (403, not 401 — see adminPlugin.ts's
      // POST /admin/api/reset for why) gets a dedicated message and
      // deliberately leaves the password field untouched so the operator can
      // see/correct what they typed, unlike the success path below which
      // clears it. The entered password is never logged here or read back
      // from `body` — the server never echoes it. A 401 here is never
      // reachable: adminFetch already intercepts it and redirects to the
      // login page before this branch runs.
      showError(
        errorEl,
        status === 403
          ? "Incorrect password."
          : (body?.error?.message ?? "Could not reset."),
      );
      return;
    }
    resultEl.textContent = formatFullResetResult(body.data);
    resultEl.classList.add("success");
    passwordInput.value = "";
    await loadDashboard();
  } catch (error) {
    if (error.message !== "unauthenticated") {
      console.error(error);
      resultEl.textContent = "";
      showError(errorEl, "Could not reach the server.");
    }
  } finally {
    updateResetButtonState();
  }
}

// Maps the country-retry endpoint's outcomes (404/409/200 — see
// adminBffRoutes.ts's POST /admin/api/migration/countries/:countryCode/retry)
// to a short human label — mirrors `describeRetryOutcome`'s pattern above.
function describeCountryRetryOutcome(status, body) {
  if (status === 404) return "no history for this country";
  if (status === 409) return body?.error?.message ?? "conflict";
  if (status === 200) return "retry started";
  return `unexpected status ${status}`;
}

async function retryCountry(row) {
  const countryCode = row.dataset.countryCode;
  const resultEl = row.querySelector('[data-role="retry-country-result"]');
  const errorEl = document.getElementById("dashboard-error");
  hideError(errorEl);

  // "in_progress" means this country was halted mid-page — resuming it
  // re-fetches and re-processes that SAME page, which can re-create
  // AiSearchResults records for rows in it that were already individually
  // saved to Axelor before the halt (a known, pre-existing risk this button
  // now makes a single click away). "failed" halts BEFORE any page write
  // (see the outer-catch design), so it carries no such risk and needs no
  // confirmation.
  if (row.dataset.status === "in_progress") {
    const confirmed = window.confirm(
      "This country was paused/stopped mid-page. Resuming it may re-save records from that page that were already written to Axelor. Continue anyway?",
    );
    if (!confirmed) return;
  }

  resultEl.textContent = "starting...";

  try {
    const { status, body } = await adminFetchJson(
      `/admin/api/migration/countries/${encodeURIComponent(countryCode)}/retry`,
      { method: "POST" },
    );
    resultEl.textContent = describeCountryRetryOutcome(status, body);
    // No immediate `loadDashboard()` here on success, unlike `resetEverything`
    // and the Errors page's bulk retry: those are synchronous, already-fully-
    // complete operations by the time their response arrives, so an
    // immediate refresh is correct there. `retryCountry`'s 200 response only
    // means the run was LAUNCHED (fire-and-forget, still in progress) — an
    // immediate `renderCheckpoints()` rebuild would destroy this very
    // `resultEl` (and its "retry started" text) within milliseconds. The
    // pre-existing 10-second auto-refresh in `initDashboardPage()` will pick
    // up the real status once the retry actually progresses.
  } catch (error) {
    if (error.message !== "unauthenticated") {
      console.error(error);
      resultEl.textContent = "could not reach the server";
    }
  }
}

function initDashboardPage() {
  const runSummary = document.getElementById("run-summary");
  runSummary.insertAdjacentHTML(
    "beforebegin",
    // NOTE: `controller.status()` (adminBffRoutes.ts/controller.ts) calls
    // `countImportErrors(db, { resolved: false })` — every UNRESOLVED
    // import_errors row across EVERY run, not scoped to "the current run".
    // Per-run scoping stopped making sense once a single-country retry
    // (retryCountry) can spin up its own tiny run that becomes "most
    // recent" while a much larger run's errors are still outstanding. See
    // errors.html to filter by run, country, or resolved status.
    '<p class="muted">Unresolved errors (all runs): <strong id="error-count">-</strong> (see the Errors page to filter by run, country, or resolved status)</p>',
  );

  document.getElementById("start-button").addEventListener("click", () => runControlAction("start"));
  document.getElementById("pause-button").addEventListener("click", () => runControlAction("pause"));
  document.getElementById("resume-button").addEventListener("click", () => runControlAction("resume"));
  document.getElementById("stop-button").addEventListener("click", () => runControlAction("stop"));
  document.getElementById("refresh-catalog-button").addEventListener("click", refreshCatalog);
  document.getElementById("refresh-dashboard-button").addEventListener("click", loadDashboard);
  document.querySelector("#checkpoints-table tbody").addEventListener("click", (event) => {
    if (event.target.dataset.action !== "retry-country") return;
    const row = event.target.closest("tr");
    retryCountry(row);
  });

  document.getElementById("show-reset-form-button").addEventListener("click", () => setResetFormVisible(true));
  document.getElementById("cancel-reset-button").addEventListener("click", () => setResetFormVisible(false));
  document.getElementById("reset-password-input").addEventListener("input", updateResetButtonState);
  document.getElementById("reset-everything-button").addEventListener("click", resetEverything);

  loadDashboard();
  // Auto-refresh so the dashboard stays current without a manual reload —
  // `loadDashboard()` is a read-only GET already called repeatedly elsewhere
  // in this codebase (e.g. after every control action) with no in-flight
  // guard, so an occasional overlapping poll here is an accepted pattern.
  setInterval(loadDashboard, 10000);
}

// ---------------------------------------------------------------------------
// Field mappings
// ---------------------------------------------------------------------------

function renderMappingsTable(rows) {
  const tbody = document.querySelector("#mappings-table tbody");
  tbody.innerHTML = "";
  for (const mapping of rows) {
    const row = document.createElement("tr");
    row.dataset.id = String(mapping.id);
    row.innerHTML = `
      <td>${escapeHtml(mapping.sourceDb)}</td>
      <td>${escapeHtml(mapping.sourceTable)}</td>
      <td>${escapeHtml(mapping.sourceColumn)}</td>
      <td><input class="cell-input" data-field="destinationField" value="${escapeHtml(mapping.destinationField ?? "")}" /></td>
      <td><input class="cell-input" data-field="transform" value="${escapeHtml(mapping.transform ?? "")}" /></td>
      <td>${escapeHtml(mapping.origin)}</td>
      <td><button data-action="save">Save</button></td>
    `;
    tbody.appendChild(row);
  }
}

async function loadMappings() {
  const errorEl = document.getElementById("mappings-error");
  hideError(errorEl);
  const sourceDb = document.getElementById("filter-source-db").value.trim();
  const sourceTable = document.getElementById("filter-source-table").value.trim();

  const params = new URLSearchParams();
  if (sourceDb !== "") params.set("source_db", sourceDb);
  if (sourceTable !== "") params.set("source_table", sourceTable);
  const query = params.toString();

  try {
    const { ok, body } = await adminFetchJson(`/admin/api/field-mappings${query ? `?${query}` : ""}`);
    if (!ok) {
      showError(errorEl, "Failed to load field mappings.");
      return;
    }
    renderMappingsTable(body.data);
  } catch (error) {
    if (error.message !== "unauthenticated") {
      console.error(error);
      showError(errorEl, "Could not reach the server.");
    }
  }
}

async function saveMappingRow(row) {
  const errorEl = document.getElementById("mappings-error");
  hideError(errorEl);
  const id = row.dataset.id;
  const destinationField = row.querySelector('[data-field="destinationField"]').value;
  const transform = row.querySelector('[data-field="transform"]').value;

  try {
    const { ok, body } = await adminFetchJson(`/admin/api/field-mappings/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        destinationField: destinationField === "" ? null : destinationField,
        transform: transform === "" ? null : transform,
      }),
    });
    if (!ok) {
      showError(errorEl, body?.error?.message ?? "Failed to save the mapping.");
      return;
    }
    await loadMappings();
  } catch (error) {
    if (error.message !== "unauthenticated") {
      console.error(error);
      showError(errorEl, "Could not reach the server.");
    }
  }
}

function initMappingsPage() {
  document.getElementById("filter-button").addEventListener("click", loadMappings);
  document.getElementById("clear-filter-button").addEventListener("click", () => {
    document.getElementById("filter-source-db").value = "";
    document.getElementById("filter-source-table").value = "";
    loadMappings();
  });
  document.querySelector("#mappings-table tbody").addEventListener("click", (event) => {
    if (event.target.dataset.action !== "save") return;
    const row = event.target.closest("tr");
    saveMappingRow(row);
  });

  loadMappings();
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const ERRORS_PAGE_SIZE = 100;
let errorsOffset = 0;
// The last offset that was actually rendered successfully — distinct from
// `errorsOffset`, which a Prev/Next click mutates *before* `loadErrors()` is
// called. If that fetch then fails, `loadErrors()` rolls `errorsOffset` back
// to this value rather than leaving it permanently advanced/retreated.
let confirmedErrorsOffset = 0;
// Last successfully rendered page's row count/total, used to restore correct
// Prev/Next button gating after a failed `loadErrors()` call (see `finally`
// block below) without re-deriving it from a stale DOM read.
let lastErrorsRowCount = 0;
let lastErrorsTotal = 0;

/**
 * Pure decision function for the Prev/Next gating and page-indicator text,
 * extracted so it's unit-testable without a DOM — mirrors
 * `computeControlGating` above. `rowCount` is the current page's row count
 * (not `ERRORS_PAGE_SIZE`) since the last page is typically shorter.
 */
function computeErrorsPaginationState(offset, rowCount, total) {
  if (total === 0) {
    return { prevDisabled: true, nextDisabled: true, indicatorText: "No errors" };
  }
  return {
    prevDisabled: offset === 0,
    nextDisabled: offset + rowCount >= total,
    indicatorText: `Showing ${offset + 1}-${offset + rowCount} of ${total}`,
  };
}

/**
 * When a page empties out from under the current offset (e.g. an operator
 * viewing `resolved=false` errors, page 2, retries the only remaining
 * unresolved error on that page), the next fetch at the same stale offset
 * returns `rowCount === 0` even though earlier pages still have rows —
 * `computeErrorsPaginationState` would then render a nonsensical inverted
 * range (e.g. "Showing 51-50 of 49"). Returns the offset `loadErrors` should
 * retry at (stepping back exactly one page, clamped at 0 — not an exact
 * "true last page" calculation, which isn't needed since one page-size step
 * back is always a valid, in-range offset), or `null` when no correction is
 * needed. Pure and DOM-independent so the correction math is unit-testable
 * without a fetch/DOM harness — see test/public/app.test.ts.
 */
function computeCorrectedErrorsOffset(offset, rowCount, total, pageSize) {
  if (rowCount === 0 && total > 0 && offset > 0) {
    return Math.max(0, offset - pageSize);
  }
  return null;
}

/**
 * Pure offset computation for the Last-page button — mirrors the
 * `computeErrorsPaginationState`/`computeCorrectedErrorsOffset` pattern.
 * `total` is only known after at least one successful `loadErrors()`
 * (`lastErrorsTotal`), same source the First/Last disabled state reads from.
 */
function computeLastPageOffset(total, pageSize) {
  if (total <= 0) return 0;
  return Math.floor((total - 1) / pageSize) * pageSize;
}

/**
 * Pure formatting function, extracted so it's unit-testable without a DOM —
 * mirrors the `computeErrorsPaginationState`/`computeCorrectedErrorsOffset`
 * pattern above. Converts an ISO 8601 timestamp string into a
 * `YYYY-MM-DD HH:mm:ss` local-time string using the `Date` object's local
 * getters (not `toLocaleString()`, which is locale-dependent and would make
 * output/tests fragile across machines). Falls back to returning the input
 * unchanged for a malformed/unparseable string rather than throwing or
 * rendering "Invalid Date". Generic (not error-specific) — shared by the
 * errors table's `createdAt` column and the catalog table's `lastSampledAt`
 * column.
 */
function formatTimestamp(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return isoString;

  const pad = (value) => String(value).padStart(2, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function renderErrorsTable(rows) {
  const tbody = document.querySelector("#errors-table tbody");
  tbody.innerHTML = "";
  for (const importError of rows) {
    const row = document.createElement("tr");
    row.dataset.id = String(importError.id);
    row.innerHTML = `
      <td>${importError.id}</td>
      <td>${escapeHtml(formatTimestamp(importError.createdAt))}</td>
      <td>${importError.runId}</td>
      <td>${escapeHtml(importError.countryCode)}</td>
      <td>${importError.recordOffset ?? "-"}</td>
      <td>${escapeHtml(importError.recordIdentifier ?? "-")}</td>
      <td>${escapeHtml(importError.errorReason)}</td>
      <td>${importError.resolved ? "yes" : "no"}</td>
      <td>
        <button data-action="retry" ${importError.resolved ? "disabled" : ""}>Retry</button>
        <span data-role="retry-result" class="muted"></span>
      </td>
    `;
    tbody.appendChild(row);
  }
}

function applyErrorsPaginationState(rowCount, total) {
  lastErrorsRowCount = rowCount;
  lastErrorsTotal = total;
  const { prevDisabled, nextDisabled, indicatorText } = computeErrorsPaginationState(
    errorsOffset,
    rowCount,
    total,
  );
  document.getElementById("errors-first-button").disabled = prevDisabled;
  document.getElementById("errors-prev-button").disabled = prevDisabled;
  document.getElementById("errors-next-button").disabled = nextDisabled;
  document.getElementById("errors-last-button").disabled = nextDisabled;
  document.getElementById("errors-page-indicator").textContent = indicatorText;
}

/**
 * Disables/re-enables the Prev/Next/Filter/Clear controls while a
 * `loadErrors()` request is in flight — mirrors the disable-during-request
 * pattern already used for `refresh-catalog-button` in `refreshCatalog`.
 * Guards against a slower-resolving earlier request's response landing after
 * a faster-resolving later one (and against a fetch failure leaving
 * `errorsOffset` advanced with no way to correct it): a single admin
 * operator can only have one of these requests in flight at a time.
 */
function setErrorsControlsDisabled(disabled) {
  document.getElementById("errors-first-button").disabled = disabled;
  document.getElementById("errors-prev-button").disabled = disabled;
  document.getElementById("errors-next-button").disabled = disabled;
  document.getElementById("errors-last-button").disabled = disabled;
  document.getElementById("filter-button").disabled = disabled;
  document.getElementById("clear-filter-button").disabled = disabled;
}

/**
 * `isOffsetCorrectionRetry` is only ever passed `true` by the recursive
 * self-call below, guarding against infinite recursion: the correction is
 * applied at most once per user-triggered call.
 */
async function loadErrors(isOffsetCorrectionRetry = false) {
  const errorEl = document.getElementById("errors-error");
  hideError(errorEl);
  const runId = document.getElementById("filter-run-id").value.trim();
  const countryCode = document.getElementById("filter-country-code").value.trim();
  const resolved = document.getElementById("filter-resolved").value;

  const params = new URLSearchParams();
  if (runId !== "") params.set("runId", runId);
  if (countryCode !== "") params.set("countryCode", countryCode);
  if (resolved !== "") params.set("resolved", resolved);
  params.set("limit", String(ERRORS_PAGE_SIZE));
  params.set("offset", String(errorsOffset));
  const query = params.toString();

  setErrorsControlsDisabled(true);

  try {
    const { ok, body } = await adminFetchJson(`/admin/api/errors${query ? `?${query}` : ""}`);
    if (!ok) {
      showError(errorEl, "Failed to load import errors.");
      return;
    }

    const correctedOffset = isOffsetCorrectionRetry
      ? null
      : computeCorrectedErrorsOffset(errorsOffset, body.data.length, body.total, ERRORS_PAGE_SIZE);
    if (correctedOffset !== null) {
      errorsOffset = correctedOffset;
      await loadErrors(true);
      return;
    }

    confirmedErrorsOffset = errorsOffset;
    renderErrorsTable(body.data);
    applyErrorsPaginationState(body.data.length, body.total);
  } catch (error) {
    // A fetch failure after a Prev/Next click already advanced/retreated
    // `errorsOffset` would otherwise leave it permanently pointing at a
    // phantom page. Roll back to the last offset that actually rendered
    // successfully so the next successful `loadErrors()` resumes correctly.
    errorsOffset = confirmedErrorsOffset;
    if (error.message !== "unauthenticated") {
      console.error(error);
      showError(errorEl, "Could not reach the server.");
    }
  } finally {
    setErrorsControlsDisabled(false);
    // Re-derive Prev/Next gating from the last known-good page state: a
    // no-op on the success path (already set above with the same values),
    // and a restoration to the correct enabled/disabled state on failure,
    // where the try block above never called `applyErrorsPaginationState`.
    applyErrorsPaginationState(lastErrorsRowCount, lastErrorsTotal);
  }
}

// Maps the retry endpoint's four outcomes (404/409/200/422 — see
// `adminBffRoutes.ts`) to a short human label, keyed by HTTP status since the
// response body shape differs per case (plain `error` object for 404/409 vs
// `data.outcome` for 200/422).
function describeRetryOutcome(status, body) {
  if (status === 404) return "not found";
  if (status === 409) return body?.error?.message ?? "conflict";
  if (status === 200) return "resolved";
  if (status === 422) return `failed: ${body?.data?.reason ?? "unknown reason"}`;
  return `unexpected status ${status}`;
}

async function retryError(row) {
  const id = row.dataset.id;
  const resultEl = row.querySelector('[data-role="retry-result"]');
  const errorEl = document.getElementById("errors-error");
  hideError(errorEl);
  resultEl.textContent = "retrying...";

  try {
    const { status, body } = await adminFetchJson(`/admin/api/errors/${id}/retry`, { method: "POST" });
    resultEl.textContent = describeRetryOutcome(status, body);
    if (status === 200) {
      await loadErrors();
    }
  } catch (error) {
    if (error.message !== "unauthenticated") {
      console.error(error);
      resultEl.textContent = "could not reach the server";
    }
  }
}

/**
 * Pure formatting function for the analytics table's "% of Total" column —
 * mirrors `formatTimestamp`'s extraction pattern. `percentage` is already
 * rounded to 1 decimal server-side (see `getErrorAnalytics` in
 * importErrorRepo.ts); this just appends the "%" for display.
 */
function formatAnalyticsPercentage(percentage) {
  return `${percentage.toFixed(1)}%`;
}

function renderAnalyticsTable(rows) {
  const tbody = document.querySelector("#analytics-table tbody");
  tbody.innerHTML = "";
  for (const bucket of rows) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${escapeHtml(bucket.day)}</td>
      <td>${escapeHtml(bucket.hour)}</td>
      <td>${bucket.count}</td>
      <td>${formatAnalyticsPercentage(bucket.percentage)}</td>
    `;
    tbody.appendChild(row);
  }
}

/**
 * Whole-table view (see `errors.html`'s Error Analytics section), so unlike
 * `loadErrors()` it takes no filter/pagination params and never re-runs on
 * Filter/Clear/Prev/Next/First/Last.
 */
async function loadAnalytics() {
  const errorEl = document.getElementById("errors-error");
  try {
    const { ok, body } = await adminFetchJson("/admin/api/errors/analytics");
    if (!ok) {
      showError(errorEl, "Failed to load error analytics.");
      return;
    }
    renderAnalyticsTable(body.data);
  } catch (error) {
    if (error.message !== "unauthenticated") {
      console.error(error);
      showError(errorEl, "Could not reach the server.");
    }
  }
}

/**
 * Pure formatting function for the bulk-retry result summary — mirrors
 * `formatRefreshCatalogResult`/`formatFullResetResult`'s extraction pattern.
 * The all-zero case (no matching unresolved rows) needs no special-casing:
 * it naturally reads "Retried 0 of 0 matching in 0 block(s) of 20: 0
 * resolved, 0 still failing." `skippedCount` (rows resolved out from under
 * the sweep by a concurrent single-row retry) and the "more remain" note
 * (when a `BULK_RETRY_MAX_ROWS_PER_CALL` cap left rows unprocessed) are only
 * appended when they apply.
 */
function formatBulkRetrySummary(summary) {
  const { totalMatched, processedCount, resolvedCount, failedCount, skippedCount, blockCount, blockSize } = summary;
  let text = `Retried ${processedCount} of ${totalMatched} matching in ${blockCount} block(s) of ${blockSize}: ${resolvedCount} resolved, ${failedCount} still failing`;
  if (skippedCount > 0) text += `, ${skippedCount} skipped`;
  text += ".";
  if (totalMatched > processedCount) {
    text += ` ${totalMatched - processedCount} remaining — click Retry Failed (Bulk) again to continue.`;
  }
  return text;
}

/**
 * Bulk-retries every unresolved `import_errors` row matching the current
 * runId/countryCode filter (the `resolved` filter value is ignored — the
 * server always forces `resolved: false`, see `retryErrorsBulk` in
 * controller.ts). One synchronous POST; the server processes everything in
 * blocks before responding, so this call can take a while.
 */
async function bulkRetryErrors() {
  const button = document.getElementById("bulk-retry-button");
  const resultEl = document.getElementById("bulk-retry-result");
  const errorEl = document.getElementById("errors-error");
  hideError(errorEl);
  const runId = document.getElementById("filter-run-id").value.trim();
  const countryCode = document.getElementById("filter-country-code").value.trim();

  const payload = {};
  if (runId !== "") payload.runId = Number(runId);
  if (countryCode !== "") payload.countryCode = countryCode;

  resultEl.textContent = "Retrying...";
  button.disabled = true;

  try {
    const { status, body } = await adminFetchJson("/admin/api/errors/retry-bulk", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (status === 409) {
      resultEl.textContent = body?.error?.message ?? "A bulk retry could not be started.";
      return;
    }
    if (status !== 200) {
      resultEl.textContent = body?.error?.message ?? "Could not run the bulk retry.";
      return;
    }
    resultEl.textContent = formatBulkRetrySummary(body.data);
    errorsOffset = 0;
    await loadErrors();
    await loadAnalytics();
  } catch (error) {
    if (error.message !== "unauthenticated") {
      console.error(error);
      resultEl.textContent = "could not reach the server";
    }
  } finally {
    button.disabled = false;
  }
}

function initErrorsPage() {
  document.getElementById("filter-button").addEventListener("click", () => {
    errorsOffset = 0;
    loadErrors();
  });
  document.getElementById("clear-filter-button").addEventListener("click", () => {
    document.getElementById("filter-run-id").value = "";
    document.getElementById("filter-country-code").value = "";
    document.getElementById("filter-resolved").value = "";
    errorsOffset = 0;
    loadErrors();
  });
  document.getElementById("errors-first-button").addEventListener("click", () => {
    errorsOffset = 0;
    loadErrors();
  });
  document.getElementById("errors-prev-button").addEventListener("click", () => {
    errorsOffset = Math.max(0, errorsOffset - ERRORS_PAGE_SIZE);
    loadErrors();
  });
  document.getElementById("errors-next-button").addEventListener("click", () => {
    errorsOffset += ERRORS_PAGE_SIZE;
    loadErrors();
  });
  document.getElementById("errors-last-button").addEventListener("click", () => {
    errorsOffset = computeLastPageOffset(lastErrorsTotal, ERRORS_PAGE_SIZE);
    loadErrors();
  });
  document.querySelector("#errors-table tbody").addEventListener("click", (event) => {
    if (event.target.dataset.action !== "retry") return;
    const row = event.target.closest("tr");
    retryError(row);
  });
  document.getElementById("bulk-retry-button").addEventListener("click", () => bulkRetryErrors());

  loadErrors();
  loadAnalytics();
}

// ---------------------------------------------------------------------------
// Source catalog
// ---------------------------------------------------------------------------

function renderCatalogTable(rows) {
  const tbody = document.querySelector("#catalog-table tbody");
  tbody.innerHTML = "";
  for (const entry of rows) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${escapeHtml(entry.sourceDb)}</td>
      <td>${escapeHtml(entry.sourceTable)}</td>
      <td>${escapeHtml(entry.countryCode ?? "-")}</td>
      <td>${entry.lastSampledAt === null ? "-" : escapeHtml(formatTimestamp(entry.lastSampledAt))}</td>
      <td>${entry.sampledRowCount ?? "-"}</td>
    `;
    tbody.appendChild(row);
  }
}

async function loadCatalog() {
  const errorEl = document.getElementById("catalog-error");
  hideError(errorEl);
  try {
    const { ok, body } = await adminFetchJson("/admin/api/catalog");
    if (!ok) {
      showError(errorEl, "Failed to load the source catalog.");
      return;
    }
    renderCatalogTable(body.data);
  } catch (error) {
    if (error.message !== "unauthenticated") {
      console.error(error);
      showError(errorEl, "Could not reach the server.");
    }
  }
}

function initCatalogPage() {
  document.getElementById("refresh-catalog-button").addEventListener("click", async () => {
    await refreshCatalog();
    await loadCatalog();
  });

  loadCatalog();
}

// ---------------------------------------------------------------------------
// Page dispatch
// ---------------------------------------------------------------------------

function init() {
  wireLogout();
  const page = document.body.dataset.page;
  if (page === "dashboard") initDashboardPage();
  else if (page === "mappings") initMappingsPage();
  else if (page === "errors") initErrorsPage();
  else if (page === "catalog") initCatalogPage();
}

// Guarded on `typeof document !== "undefined"` so this file can also be
// `require()`d from a Node test runner (see test/public/app.test.ts) to unit
// test the pure functions below, without a DOM/jsdom dependency and without
// auto-running the page-init side effects there.
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
}

// Exposes pure, DOM-independent logic for unit testing (see
// test/public/app.test.ts). Guarded so this file still works unmodified as a
// plain `<script src="/admin/app.js">` in the browser, where `module` is
// undefined. `public/package.json` (`"type": "commonjs"`) is what makes
// `module` defined here when this file is `require()`d from a test running
// under this repo's root `"type": "module"` package.json — the browser never
// reads either package.json, so it's unaffected either way.
if (typeof module !== "undefined") {
  module.exports = {
    escapeHtml,
    describeRetryOutcome,
    describeCountryRetryOutcome,
    computeControlGating,
    formatRefreshCatalogResult,
    formatFullResetResult,
    formatBulkRetrySummary,
    computeErrorsPaginationState,
    computeCorrectedErrorsOffset,
    computeLastPageOffset,
    formatTimestamp,
    formatAnalyticsPercentage,
    // `adminFetch` touches only `fetch`/`window.location`, never `document`,
    // so it's testable here without a DOM/jsdom dependency (see
    // test/public/app.test.ts) — used specifically to prove that a 403
    // response (e.g. wrong reset-confirmation password) does NOT trigger the
    // redirect-to-login/throw path that a 401 does, which is exactly the bug
    // fix #3 in the "Reset Everything" 4R review fixed.
    adminFetch,
  };
}
