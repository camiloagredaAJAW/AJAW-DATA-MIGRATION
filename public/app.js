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

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value ?? "";
  return div.innerHTML;
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
    row.innerHTML = `
      <td>${escapeHtml(checkpoint.countryCode)}</td>
      <td>${checkpoint.lastOffset}</td>
      <td>${escapeHtml(checkpoint.status)}</td>
      <td>${checkpoint.aiSearchId ?? "-"}</td>
    `;
    tbody.appendChild(row);
  }
}

function applyControlGating(runStatus) {
  const isActive = runStatus !== null && RUN_ACTIVE_STATUSES.has(runStatus);
  document.getElementById("start-button").disabled = isActive;
  document.getElementById("pause-button").disabled = runStatus !== "running";
  document.getElementById("resume-button").disabled = runStatus !== "paused";
  document.getElementById("stop-button").disabled = !isActive;
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
    const { run, checkpoints, totals } = body.data;
    renderRunSummary(run);
    renderCheckpoints(checkpoints);
    document.getElementById("error-count").textContent = totals.errors;
    applyControlGating(run === null ? null : run.status);
  } catch (error) {
    if (error.message !== "unauthenticated") {
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
      showError(errorEl, "Could not reach the server.");
    }
  }
}

function initDashboardPage() {
  const runSummary = document.getElementById("run-summary");
  runSummary.insertAdjacentHTML(
    "beforebegin",
    // NOTE: `controller.status()` (adminBffRoutes.ts/controller.ts, PR3)
    // counts every import_errors row for this run, not only unresolved ones
    // — labeled "recorded", not "unresolved", to stay accurate to that
    // existing backend behavior. See errors.html for the resolved/unresolved
    // filter.
    '<p class="muted">Errors recorded for the current run: <strong id="error-count">-</strong> (see the Errors page to filter by resolved status)</p>',
  );

  document.getElementById("start-button").addEventListener("click", () => runControlAction("start"));
  document.getElementById("pause-button").addEventListener("click", () => runControlAction("pause"));
  document.getElementById("resume-button").addEventListener("click", () => runControlAction("resume"));
  document.getElementById("stop-button").addEventListener("click", () => runControlAction("stop"));

  loadDashboard();
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

function renderErrorsTable(rows) {
  const tbody = document.querySelector("#errors-table tbody");
  tbody.innerHTML = "";
  for (const importError of rows) {
    const row = document.createElement("tr");
    row.dataset.id = String(importError.id);
    row.innerHTML = `
      <td>${importError.id}</td>
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

async function loadErrors() {
  const errorEl = document.getElementById("errors-error");
  hideError(errorEl);
  const runId = document.getElementById("filter-run-id").value.trim();
  const countryCode = document.getElementById("filter-country-code").value.trim();
  const resolved = document.getElementById("filter-resolved").value;

  const params = new URLSearchParams();
  if (runId !== "") params.set("runId", runId);
  if (countryCode !== "") params.set("countryCode", countryCode);
  if (resolved !== "") params.set("resolved", resolved);
  const query = params.toString();

  try {
    const { ok, body } = await adminFetchJson(`/admin/api/errors${query ? `?${query}` : ""}`);
    if (!ok) {
      showError(errorEl, "Failed to load import errors.");
      return;
    }
    renderErrorsTable(body.data);
  } catch (error) {
    if (error.message !== "unauthenticated") {
      showError(errorEl, "Could not reach the server.");
    }
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
      resultEl.textContent = "could not reach the server";
    }
  }
}

function initErrorsPage() {
  document.getElementById("filter-button").addEventListener("click", loadErrors);
  document.getElementById("clear-filter-button").addEventListener("click", () => {
    document.getElementById("filter-run-id").value = "";
    document.getElementById("filter-country-code").value = "";
    document.getElementById("filter-resolved").value = "";
    loadErrors();
  });
  document.querySelector("#errors-table tbody").addEventListener("click", (event) => {
    if (event.target.dataset.action !== "retry") return;
    const row = event.target.closest("tr");
    retryError(row);
  });

  loadErrors();
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
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
