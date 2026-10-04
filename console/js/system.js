// System tab: GET /v1/system, this console's key, the API description's version, a connection
// test (5 × GET /v1/health) and a plain-text diagnostics report for support.
// The report never contains the API key or a pairing code.

import { API_PORT } from "../api-client.js";
import { byId, copyWithFeedback, formatTime, h, setMessage } from "./dom.js";
import { call, connect, notify, send, state } from "./session.js";

const content = byId("system-content");
const message = byId("system-message");
const healthButton = byId("health-run");
const healthResult = byId("health-result");
const refreshButton = byId("system-refresh");
const copyButton = byId("diag-copy");

let health = null; // { runs: [ms|null], errors: [text], at }

const show = (value) => (value === null || value === undefined || value === "" ? "—" : String(value));

function sections() {
  const system = state.system || {};
  const bridge = system.bridge || {};
  const controller = system.controller || {};
  const location = system.location || {};
  const inventory = system.inventory || {};
  const lifecycle = system.lifecycle || {};
  const spec = state.spec;
  const specVersion = spec?.info?.version;
  return [
    {
      title: "Bridge",
      rows: [
        ["Version", show(bridge.version)],
        ["API version", show(bridge.api_version)],
        ["Status", show(bridge.status)],
        ["Detail", show(bridge.detail)],
        ["Started", bridge.started_at ? `${formatTime(bridge.started_at)} (${bridge.started_at})` : "—"],
      ],
    },
    {
      title: "Controller",
      rows: [
        ["Address", state.host ? `http://${state.host}:${API_PORT}` : "—"],
        ["Platform", show(controller.platform)],
        ["OS version", show(controller.os_version)],
        ["Model", show(controller.model)],
      ],
    },
    {
      title: "Location",
      rows: [
        ["City", show(location.city)],
        ["Country", location.country || location.country_code ? `${show(location.country)} (${show(location.country_code)})` : "—"],
        ["Time zone", show(location.timezone)],
        ["Coordinates", location.latitude !== null && location.latitude !== undefined ? `${location.latitude}, ${location.longitude}` : "—"],
      ],
    },
    {
      title: "Inventory",
      rows: [
        ["Rooms", show(inventory.rooms)],
        ["Devices", show(inventory.devices)],
        ["Supported devices", show(inventory.supported_devices)],
        ["Lights", show(inventory.lights)],
        ["Thermostats", show(inventory.thermostats)],
        ["Fans", show(inventory.fans)],
        ["Blinds", show(inventory.blinds)],
        ["Cameras", show(inventory.cameras)],
        ["Relays", show(inventory.relays)],
        ["Refrigerators", show(inventory.refrigerators)],
      ],
    },
    {
      title: "Driver lifecycle",
      rows: [
        ["Reload count", show(lifecycle.reload_count)],
        ["Last init", lifecycle.last_init_type ? `${lifecycle.last_init_type} · ${show(lifecycle.last_init_time)}` : "—"],
        ["Last destroy", lifecycle.last_destroy_type ? `${lifecycle.last_destroy_type} · ${show(lifecycle.last_destroy_time)}` : "—"],
      ],
    },
    {
      title: "This console's key",
      rows: [
        ["Name", show(state.key?.name)],
        ["ID", show(state.key?.id)],
        ["Role", show(state.role)],
        ["Created", state.key?.created_at ? formatTime(state.key.created_at) : "—"],
      ],
    },
    {
      title: "API description",
      rows: [
        ["Title", show(spec?.info?.title)],
        ["Version", show(specVersion)],
        ["OpenAPI", show(spec?.openapi)],
        ["Operations", spec ? String(countOperations(spec)) : "—"],
      ],
      warning:
        spec && bridge.version === "dev"
          ? `The bridge is a development build (dev); its API description says ${specVersion}.`
          : spec && bridge.version && specVersion && specVersion !== bridge.version
            ? `The API description is version ${specVersion} but the bridge reports ${bridge.version}. The driver package may be mixed up; reinstall it from a release.`
            : !spec && state.apiKey
            ? "The bridge did not serve its API description (GET /v1/openapi.json)."
            : null,
    },
  ];
}

function countOperations(spec) {
  let count = 0;
  for (const item of Object.values(spec.paths || {})) {
    for (const method of ["get", "post", "put", "patch", "delete"]) if (item[method]) count += 1;
  }
  return count;
}

function healthSummary() {
  if (!health) return null;
  const times = health.runs.filter((value) => value !== null);
  const failures = health.runs.length - times.length;
  if (!times.length) return { text: `All ${health.runs.length} requests failed.`, failures, times };
  const min = Math.min(...times);
  const max = Math.max(...times);
  const avg = Math.round(times.reduce((sum, value) => sum + value, 0) / times.length);
  return { text: `min ${min} ms · avg ${avg} ms · max ${max} ms · ${failures} failed of ${health.runs.length}`, failures, times, min, max, avg };
}

function renderHealth() {
  const result = healthSummary();
  if (!result) {
    healthResult.replaceChildren();
    return;
  }
  healthResult.replaceChildren(
    h("p", { class: `health-summary${result.failures ? " is-error" : " is-ok"}` }, result.text),
    h(
      "ol",
      { class: "health-runs" },
      health.runs.map((value, index) => h("li", {}, value === null ? `failed — ${health.errors[index] || "no answer"}` : `${value} ms`))
    )
  );
}

export function renderSystem() {
  if (!state.apiKey) {
    setMessage(message, "Connect first.", "info");
    content.replaceChildren();
    return;
  }
  setMessage(message, state.system ? "" : "No system information loaded yet — press Refresh.", state.system ? "" : "info");
  content.replaceChildren(
    ...sections().map((section) =>
      h(
        "section",
        { class: "card system-card" },
        h("h2", {}, section.title),
        section.warning ? h("p", { class: "message message-warn" }, section.warning) : null,
        h(
          "dl",
          { class: "facts" },
          section.rows.map(([label, value]) => h("div", { class: "fact" }, h("dt", {}, label), h("dd", {}, value)))
        )
      )
    )
  );
  renderHealth();
}

async function runHealth() {
  healthButton.disabled = true;
  health = { runs: [], errors: [], at: new Date().toISOString() };
  healthResult.replaceChildren(h("p", { class: "help" }, "Testing…"));
  for (let index = 0; index < 5; index += 1) {
    try {
      const result = await send("/v1/health", { auth: false, timeoutMs: 5000 });
      health.runs.push(result.ok ? result.durationMs : null);
      health.errors.push(result.ok ? "" : `HTTP ${result.status}`);
    } catch (error) {
      health.runs.push(null);
      health.errors.push(error.code === "TIMEOUT" ? "timed out" : "unreachable");
    }
    renderHealth();
  }
  healthButton.disabled = false;
}

// Plain text for a support request. Built only from the fields below: no key, no pairing code.
export function diagnosticsText() {
  const lines = [
    "DirectorLink Console diagnostics",
    `Generated: ${new Date().toISOString()}`,
    `Console: ${window.location.origin}`,
    `Browser: ${navigator.userAgent}`,
    `Connection: ${state.status}`,
    "",
  ];
  for (const section of sections()) {
    lines.push(`[${section.title}]`);
    for (const [label, value] of section.rows) lines.push(`${label}: ${value}`);
    if (section.warning) lines.push(`Warning: ${section.warning}`);
    lines.push("");
  }
  lines.push("[Connection test]");
  const result = healthSummary();
  if (result) {
    lines.push(`Run at: ${health.at}`);
    lines.push(`Result: ${result.text}`);
    lines.push(`Runs: ${health.runs.map((value, index) => (value === null ? `failed (${health.errors[index]})` : `${value} ms`)).join(", ")}`);
  } else {
    lines.push("Not run");
  }
  return lines.join("\n") + "\n";
}

healthButton.addEventListener("click", runHealth);

refreshButton.addEventListener("click", async () => {
  refreshButton.disabled = true;
  try {
    state.system = await call("/v1/system");
    const current = await send("/v1/api-keys/current");
    if (current.ok) {
      state.key = current.data;
      state.role = current.data.role;
    }
    notify();
    setMessage(message, "Refreshed.", "success");
  } catch (error) {
    if (state.apiKey && !state.system) await connect();
    setMessage(message, error.message, "error");
  } finally {
    refreshButton.disabled = false;
  }
});

copyButton.addEventListener("click", () => copyWithFeedback(copyButton, diagnosticsText()));
