let globalData = null;
const charts = {};
const predictionCache = new Map();
let latestUpdateToken = 0;
let sliderUpdateTimer = null;

const queryApi = new URLSearchParams(window.location.search).get("api")?.trim() || "";
const metaApi = document.querySelector('meta[name="api-base-url"]')?.getAttribute("content")?.trim() || "";
const windowApi = (window.ORBITAL_API_BASE || "").trim();

if (queryApi) {
  localStorage.setItem("ORBITAL_API_BASE", queryApi);
} else {
  // Avoid stale direct backend endpoints leaking across sessions.
  localStorage.removeItem("ORBITAL_API_BASE");
}

function normalizeBase(base) {
  if (!base) return "";
  return base.replace(/\/$/, "");
}

function uniqueBases(candidates) {
  const seen = new Set();
  const out = [];
  candidates.forEach((candidate) => {
    const normalized = normalizeBase(candidate);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  });
  return out;
}

const explicitCandidates = uniqueBases([queryApi, metaApi, windowApi].filter(Boolean));
const API_CANDIDATES = explicitCandidates.length ? uniqueBases(["", ...explicitCandidates]) : [""];

function showLoading(on = true) {
  const ov = document.getElementById("loading-overlay");
  if (ov) ov.classList.toggle("hidden", !on);
}

function setApiStatus(source, note = "") {
  const el = document.getElementById("api-status");
  const warnBar = document.getElementById("backend-warning-bar");
  if (!el) return;
  el.classList.remove("is-live", "is-fallback", "is-error");
  if (warnBar) warnBar.classList.add("hidden");
  if (source === "checking") {
    el.textContent = "Data source: checking...";
    return;
  }
  if (source === "proxy") {
    el.classList.add("is-live");
    el.textContent = "Data source: Live API via Netlify proxy.";
    return;
  }
  if (source === "direct") {
    el.classList.add("is-live");
    el.textContent = "Data source: Live backend API connected.";
    return;
  }
  if (source === "static") {
    el.classList.add("is-fallback");
    el.textContent = "Data source: Fallback static predictions.json.";
    if (warnBar) warnBar.classList.remove("hidden");
    return;
  }
  el.classList.add("is-error");
  el.textContent = note || "Data source: unavailable.";
  if (warnBar) warnBar.classList.remove("hidden");
}

function normalizePayload(data, cacheHit = false) {
  return {
    ...data,
    model_version: data.model_version || "1.2.0",
    api_version: data.api_version || "v1",
    model_type_used: data.model_type_used || "polynomial_degree_2",
    generated_at_utc: data.generated_at_utc || new Date().toISOString(),
    target_year: data.target_year || 2055,
    cache_hit: cacheHit || Boolean(data.cache_hit),
  };
}

async function fetchFromApi(base, offsetYears, strength) {
  const prefix = normalizeBase(base);
  const url = `${prefix}/predict?year=${offsetYears}&strength=${strength}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`API failed: ${res.status}`);
  return res.json();
}

async function fetchStaticJson() {
  const res = await fetch("predictions.json");
  if (!res.ok) throw new Error("Static predictions.json not found");
  return res.json();
}

function sourceTypeFromBase(base) {
  if (!base) return "proxy";
  return "direct";
}

async function loadData(params = {}) {
  const { year = 10, strength = 0.01 } = params;
  const cacheKey = `${year}|${strength.toFixed(3)}`;
  if (predictionCache.has(cacheKey)) {
    const cached = predictionCache.get(cacheKey);
    setApiStatus(cached.source, cached.note);
    return normalizePayload(cached.payload, true);
  }

  for (const candidate of API_CANDIDATES) {
    try {
      const payload = await fetchFromApi(candidate, year, strength);
      const source = sourceTypeFromBase(candidate);
      const note = source === "direct" ? "custom endpoint" : "";
      predictionCache.set(cacheKey, { payload, source, note });
      setApiStatus(source, note);
      return normalizePayload(payload);
    } catch (err) {
      const code = /API failed: (\d+)/.exec(err.message)?.[1] || "";
      console.warn(`API request failed for "${candidate || "same-origin"}"${code ? ` (${code})` : ""}.`);
    }
  }

  const staticPayload = await fetchStaticJson();
  predictionCache.set(cacheKey, { payload: staticPayload, source: "static", note: "" });
  setApiStatus("static");
  return normalizePayload(staticPayload);
}

function toNumericSeries(arr) {
  return arr.map((v) => (v === null ? null : Number(v)));
}

function computeStartYearFromOffset(data, offsetYears) {
  const baseYear = data?.years?.[0] ?? 2000;
  return baseYear + Number(offsetYears);
}

function getTargetIndex(data, targetYear = 2055) {
  const years = data.years || [];
  let idx = years.indexOf(targetYear);
  if (idx >= 0) return { idx, exact: true };
  for (let i = years.length - 1; i >= 0; i -= 1) {
    if (years[i] <= targetYear) return { idx: i, exact: false };
  }
  return { idx: years.length - 1, exact: false };
}

function getLatestActualIndex(data) {
  for (let i = data.years.length - 1; i >= 0; i -= 1) {
    if (data.rocket_actual[i] !== null && data.satellites_actual[i] !== null) return i;
  }
  return 0;
}

function makeForecastChart(ctx, labels, actual, predicted, uncertainty, labelActual, labelPred) {
  const lowerBand = predicted.map((v, i) => Math.max(0, Number(v) - Number(uncertainty[i] || 0)));
  const upperBand = predicted.map((v, i) => Number(v) + Number(uncertainty[i] || 0));

  return new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: labelActual,
          data: actual,
          borderColor: "#6ee7b7",
          backgroundColor: "rgba(110,231,183,0.08)",
          tension: 0.3,
          pointRadius: 2,
          spanGaps: true,
          borderWidth: 2.5,
        },
        {
          label: "Confidence lower",
          data: lowerBand,
          borderColor: "rgba(154,208,255,0)",
          pointRadius: 0,
          borderWidth: 0,
        },
        {
          label: "Confidence band",
          data: upperBand,
          borderColor: "rgba(154,208,255,0.25)",
          backgroundColor: "rgba(154,208,255,0.20)",
          fill: "-1",
          pointRadius: 0,
          borderWidth: 1,
          tension: 0.3,
        },
        {
          label: labelPred,
          data: predicted,
          borderColor: "#9ad0ff",
          borderDash: [6, 3],
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: "#cfe6f5", font: { size: 12 } }, align: "end" },
      },
      scales: {
        x: { ticks: { color: "#9aa5b1", font: { size: 11 } } },
        y: { ticks: { color: "#9aa5b1", font: { size: 11 } } },
      },
    },
  });
}

function makeLineChart(ctx, labels, dataA, dataB, labelA, labelB) {
  return new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: labelA,
          data: dataA,
          borderColor: "#ff6b6b",
          tension: 0.3,
          fill: false,
          pointRadius: 0,
          borderWidth: 2,
        },
        {
          label: labelB,
          data: dataB,
          borderColor: "#6ee7b7",
          tension: 0.3,
          fill: false,
          pointRadius: 0,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#cfe6f5", font: { size: 12 } } } },
      scales: {
        x: { ticks: { color: "#9aa5b1" } },
        y: { ticks: { color: "#9aa5b1" } },
      },
    },
  });
}

function makeComparisonChart(ctx, labels, seriesA, seriesB, labelA, labelB, colorA, colorB) {
  return new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: labelA,
          data: seriesA,
          borderColor: colorA,
          backgroundColor: "rgba(110,231,183,0.08)",
          tension: 0.3,
          pointRadius: 1,
          borderWidth: 2,
        },
        {
          label: labelB,
          data: seriesB,
          borderColor: colorB,
          backgroundColor: "rgba(74,144,226,0.08)",
          tension: 0.3,
          pointRadius: 1,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#cfe6f5", font: { size: 12 } } } },
      scales: {
        x: { ticks: { color: "#9aa5b1" } },
        y: { ticks: { color: "#9aa5b1" } },
      },
    },
  });
}

function makeRiskHeatmap(ctx, labels, riskNoAction, riskMit) {
  return new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Risk (no mitigation)",
          data: riskNoAction,
          borderColor: "#ff6b6b",
          backgroundColor: "rgba(255,107,107,0.15)",
          tension: 0.3,
          fill: true,
          pointRadius: 0,
        },
        {
          label: "Risk (with mitigation)",
          data: riskMit,
          borderColor: "#6ee7b7",
          backgroundColor: "rgba(110,231,183,0.15)",
          tension: 0.3,
          fill: true,
          pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#cfe6f5", font: { size: 12 } } } },
      scales: {
        x: { ticks: { color: "#9aa5b1" } },
        y: { ticks: { color: "#9aa5b1" }, min: 0, max: 100 },
      },
    },
  });
}

function makePieChart(ctx, labels, data) {
  return new Chart(ctx, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{ data, backgroundColor: ["#6ee7b7", "#ffd93d", "#ff6b6b", "#4a90e2"] }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#cfe6f5", font: { size: 12 } } } },
    },
  });
}

function computeRiskDistribution(arr) {
  const buckets = [0, 0, 0, 0];
  arr.forEach((r) => {
    if (r < 10) buckets[0] += 1;
    else if (r < 30) buckets[1] += 1;
    else if (r < 50) buckets[2] += 1;
    else buckets[3] += 1;
  });
  return buckets;
}

function updateRiskPanel(finalRisk) {
  let level = "Low";
  let status = "Collision likelihood remains manageable with current assumptions.";
  let recommendation = "Maintain monitoring and preserve mitigation funding.";
  if (finalRisk >= 10 && finalRisk < 30) {
    level = "Moderate";
    status = "Collision likelihood is increasing gradually in key orbital corridors.";
    recommendation = "Advance mitigation start timelines and expand coordination.";
  } else if (finalRisk >= 30 && finalRisk < 50) {
    level = "High";
    status = "Collision likelihood is rising materially and compounds over time.";
    recommendation = "Adopt early mitigation and targeted debris removal immediately.";
  } else if (finalRisk >= 50) {
    level = "Critical";
    status = "Collision likelihood is accelerating with severe long-term sustainability risk.";
    recommendation = "Trigger emergency policy intervention and active cleanup operations.";
  }
  document.getElementById("risk-level").textContent = level;
  document.getElementById("risk-status").textContent = status;
  document.getElementById("risk-recommendation").textContent = recommendation;
}

function updateMetrics(data, mitigationSeries = null) {
  const insights = data.insights;
  const finalNo = Number(insights.final_debris_no_action);
  const finalMit = mitigationSeries
    ? Number(mitigationSeries[mitigationSeries.length - 1])
    : Number(insights.final_debris_mitigation);
  const saved = finalNo - finalMit;
  const pct = finalNo > 0 ? Math.round((100 * saved) / finalNo) : 0;

  document.getElementById("metric-launches").textContent = Math.round(insights.final_rockets);
  document.getElementById("metric-satellites").textContent = Math.round(insights.total_cumulative);
  document.getElementById("metric-debris-saved").textContent = Math.round(saved);
  document.getElementById("metric-debris-pct").textContent = `${pct}% reduction`;
  document.getElementById("metric-risk-reduction").textContent = `${pct}%`;
}

function updateEarlyLateHighlight(data) {
  const { idx, exact } = getTargetIndex(data, 2055);
  const y5 = Number(data.debris_scenarios.mitigation_year_5[idx]);
  const y15 = Number(data.debris_scenarios.mitigation_year_15[idx]);
  const diffPct = y15 > 0 ? ((y15 - y5) / y15) * 100 : 0;

  document.getElementById("highlight-year-5").textContent = `${y5.toFixed(1)} units`;
  document.getElementById("highlight-year-15").textContent = `${y15.toFixed(1)} units`;
  document.getElementById("highlight-diff-pct").textContent = `${diffPct.toFixed(1)}% lower with early start`;
  document.getElementById("highlight-note").textContent = exact
    ? "Values are reported for 2055 exactly."
    : `2055 was not available; using ${data.years[idx]} as the closest year <= 2055.`;
}

function updateCurrentSituation(data) {
  const idx = getLatestActualIndex(data);
  document.getElementById("current-year").textContent = data.years[idx];
  document.getElementById("current-launches").textContent = `${Math.round(Number(data.rocket_actual[idx]))}`;
  document.getElementById("current-satellites").textContent = `${Math.round(Number(data.satellites_actual[idx]))}`;
}

function generateInsights(data) {
  const insights = data.insights;
  const idx = getLatestActualIndex(data);
  const currentYear = data.years[idx];
  const currentLaunches = Math.round(Number(data.rocket_actual[idx]));
  const currentSats = Math.round(Number(data.satellites_actual[idx]));
  const lines = [
    `<strong>Current situation (${currentYear}):</strong>`,
    `- Observed annual rocket launches: <strong>${currentLaunches}</strong>`,
    `- Observed annual satellites launched: <strong>${currentSats}</strong>`,
    `<br><strong>As per this trend, by ${insights.final_year} the model predicts:</strong>`,
    `- <strong>${Math.round(insights.final_rockets)} annual rocket launches</strong>`,
    `- <strong>${Math.round(insights.total_cumulative)} cumulative satellites</strong> in orbit`,
    `- Without mitigation: <strong>${Math.round(insights.final_debris_no_action)} debris pieces</strong>`,
    `- With mitigation: <strong>${Math.round(insights.final_debris_mitigation)} debris pieces</strong> (${Math.round(insights.savings_pct)}% reduction)`,
    `<br><strong>Policy Insight:</strong> earlier intervention reduces long-run debris accumulation more than delayed action.`,
  ];
  document.getElementById("insights-text").innerHTML = lines.join("<br>");
}

function createScenarioChart(ctx, data, labels) {
  const scenarios = data.debris_scenarios;
  return new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "No Action", data: data.debris_no_action, borderColor: "#ff6b6b", tension: 0.3, fill: false, pointRadius: 0 },
        { label: "Start +5", data: scenarios.mitigation_year_5, borderColor: "#ffd93d", tension: 0.3, fill: false, pointRadius: 0 },
        { label: "Start +10", data: scenarios.mitigation_year_10, borderColor: "#6ee7b7", tension: 0.3, fill: false, pointRadius: 0 },
        { label: "Start +15", data: scenarios.mitigation_year_15, borderColor: "#4a90e2", tension: 0.3, fill: false, pointRadius: 0 },
        { label: "Start +20", data: scenarios.mitigation_year_20, borderColor: "#9d4edd", tension: 0.3, fill: false, pointRadius: 0 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#cfe6f5", font: { size: 12 } } } },
      scales: { x: { ticks: { color: "#9aa5b1" } }, y: { ticks: { color: "#9aa5b1" } } },
    },
  });
}

function buildCsvMetadata(data, yearOffset, strength) {
  return [
    `# generated_at_utc=${data.generated_at_utc || new Date().toISOString()}`,
    `# mitigation_start_offset=${yearOffset}`,
    `# mitigation_strength=${strength}`,
    `# model_type=${data.model_type_used || "polynomial_degree_2"}`,
    `# model_version=${data.model_version || "1.2.0"}`,
    `# target_year=${data.target_year || 2055}`,
  ].join("\n");
}

function exportToCSV(data) {
  const yearOffset = Number(document.getElementById("slider-mitigation-year").value);
  const strength = Number(document.getElementById("slider-mitigation-strength").value);
  const metadata = buildCsvMetadata(data, yearOffset, strength);
  let csv =
    "Year,Rocket_Actual,Rocket_Predicted,Satellites_Actual,Satellites_Predicted,Cumulative_Satellites,Debris_No_Action,Debris_Mitigation,Risk_No_Action,Risk_Mitigation\n";
  for (let i = 0; i < data.years.length; i += 1) {
    csv += `${data.years[i]},${data.rocket_actual[i] || ""},${data.rocket_predicted[i] || ""},${data.satellites_actual[i] || ""},${data.satellites_predicted[i] || ""},${data.cumulative_satellites[i]},${data.debris_no_action[i]},${data.debris_mitigation[i]},${data.risk_no_action[i]},${data.risk_mitigation[i]}\n`;
  }
  const blob = new Blob([`${metadata}\n${csv}`], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "astraforecast_export.csv";
  a.click();
  URL.revokeObjectURL(url);
}

function updateSplitDebrisRiskCharts(data) {
  if (charts.splitCurrentDebrisRisk) {
    charts.splitCurrentDebrisRisk.data.labels = data.years;
    charts.splitCurrentDebrisRisk.data.datasets[0].data = data.debris_no_action.map(Number);
    charts.splitCurrentDebrisRisk.data.datasets[1].data = data.risk_no_action.map(Number);
    charts.splitCurrentDebrisRisk.update();
  }
  if (charts.splitPredictedDebrisRisk) {
    charts.splitPredictedDebrisRisk.data.labels = data.years;
    charts.splitPredictedDebrisRisk.data.datasets[0].data = data.debris_mitigation.map(Number);
    charts.splitPredictedDebrisRisk.data.datasets[1].data = data.risk_mitigation.map(Number);
    charts.splitPredictedDebrisRisk.update();
  }
}

function setSplitTab(tabName) {
  const isLaunches = tabName === "launches";
  const leftTitle = document.getElementById("split-left-title");
  const rightTitle = document.getElementById("split-right-title");
  const helper = document.getElementById("split-tab-helper");

  document.querySelectorAll(".split-tab-btn").forEach((btn) => {
    const active = btn.dataset.splitTab === tabName;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });

  document.querySelector('[data-tab-panel="launches-left"]').classList.toggle("hidden", !isLaunches);
  document.querySelector('[data-tab-panel="launches-right"]').classList.toggle("hidden", !isLaunches);
  document.querySelector('[data-tab-panel="debris-left"]').classList.toggle("hidden", isLaunches);
  document.querySelector('[data-tab-panel="debris-right"]').classList.toggle("hidden", isLaunches);

  if (isLaunches) {
    leftTitle.textContent = "Current Data (Observed Launches & Satellites)";
    rightTitle.textContent = "Predicted Data (Forecast Launches & Satellites)";
    helper.textContent = "Launches & Satellites: observed history on the left, projected trend on the right.";
  } else {
    leftTitle.textContent = "Current Data (No-Action Baseline: Debris & Risk)";
    rightTitle.textContent = "Predicted Data (Mitigation Scenario: Debris & Risk)";
    helper.textContent = "Debris & Risk: current baseline on the left, model prediction under selected mitigation on the right.";
  }

  Object.values(charts).forEach((chart) => {
    if (chart && typeof chart.resize === "function") chart.resize();
  });
}

async function updateDynamicCharts() {
  const requestToken = ++latestUpdateToken;
  const offsetYears = parseInt(document.getElementById("slider-mitigation-year").value, 10);
  const strength = parseFloat(document.getElementById("slider-mitigation-strength").value);
  showLoading(true);
  try {
    const data = await loadData({ year: offsetYears, strength });
    if (requestToken !== latestUpdateToken) return;
    globalData = data;
    const mitigationSeries = data.debris_mitigation.map(Number);

    charts.debris.data.datasets[1].data = mitigationSeries;
    charts.debris.update();
    charts.risk.data.datasets[1].data = data.risk_mitigation.map(Number);
    charts.risk.update();

    let customDs = charts.scenarios.data.datasets.find((d) => d.label.startsWith("Custom "));
    const yearLabel = computeStartYearFromOffset(data, offsetYears);
    const customLabel = `Custom ${yearLabel} / ${(strength * 100).toFixed(1)}%`;
    if (!customDs) {
      customDs = {
        label: customLabel,
        data: mitigationSeries,
        borderColor: "#00ff88",
        tension: 0.3,
        fill: false,
        pointRadius: 0,
      };
      charts.scenarios.data.datasets.push(customDs);
    } else {
      customDs.label = customLabel;
      customDs.data = mitigationSeries;
    }
    charts.scenarios.update();

    updateSplitDebrisRiskCharts(data);

    updateMetrics(data, mitigationSeries);
    updateCurrentSituation(data);
    updateRiskPanel(Number(data.risk_mitigation[data.risk_mitigation.length - 1] || 0));
    updateEarlyLateHighlight(data);
    generateInsights(data);
  } finally {
    if (requestToken === latestUpdateToken) {
      showLoading(false);
    }
  }
}

function scheduleDynamicUpdate() {
  clearTimeout(sliderUpdateTimer);
  sliderUpdateTimer = setTimeout(() => {
    updateDynamicCharts().catch((err) => {
      console.error(err);
      setApiStatus("error", "Data source: request failed.");
      document.getElementById("insights-text").textContent =
        "Error loading predictions data. Run backend first or keep predictions.json available.";
    });
  }, 150);
}

async function init() {
  showLoading(true);
  setApiStatus("checking");
  globalData = await loadData();
  showLoading(false);

  const labels = globalData.years;

  charts.rockets = makeForecastChart(
    document.getElementById("chart-rockets"),
    labels,
    toNumericSeries(globalData.rocket_actual),
    globalData.rocket_predicted.map(Number),
    globalData.rocket_uncertainty,
    "Launches (actual)",
    "Launches (predicted)"
  );

  charts.satellites = makeForecastChart(
    document.getElementById("chart-satellites"),
    labels,
    toNumericSeries(globalData.satellites_actual),
    globalData.satellites_predicted.map(Number),
    globalData.satellites_uncertainty,
    "Satellites (actual)",
    "Satellites (predicted)"
  );

  charts.debris = makeLineChart(
    document.getElementById("chart-debris"),
    labels,
    globalData.debris_no_action.map(Number),
    globalData.debris_mitigation.map(Number),
    "No Mitigation",
    "With Mitigation"
  );

  charts.risk = makeRiskHeatmap(
    document.getElementById("chart-risk"),
    labels,
    globalData.risk_no_action.map(Number),
    globalData.risk_mitigation.map(Number)
  );

  charts.riskDist = makePieChart(
    document.getElementById("chart-risk-dist"),
    ["Low", "Moderate", "High", "Critical"],
    computeRiskDistribution(globalData.risk_mitigation)
  );

  charts.scenarios = createScenarioChart(document.getElementById("chart-scenarios"), globalData, labels);

  const latestIdx = getLatestActualIndex(globalData);
  const currentLabels = globalData.years.slice(0, latestIdx + 1);
  const forecastLabels = globalData.years.slice(latestIdx);

  charts.splitCurrentLaunchesSatellites = makeComparisonChart(
    document.getElementById("chart-current-launches-satellites"),
    currentLabels,
    globalData.rocket_actual.slice(0, latestIdx + 1).map(Number),
    globalData.satellites_actual.slice(0, latestIdx + 1).map(Number),
    "Rocket Launches (actual)",
    "Satellites Launched (actual)",
    "#6ee7b7",
    "#ffd93d"
  );

  charts.splitPredictedLaunchesSatellites = makeComparisonChart(
    document.getElementById("chart-predicted-launches-satellites"),
    forecastLabels,
    globalData.rocket_predicted.slice(latestIdx).map(Number),
    globalData.satellites_predicted.slice(latestIdx).map(Number),
    "Rocket Launches (predicted)",
    "Satellites Launched (predicted)",
    "#4a90e2",
    "#9ad0ff"
  );

  charts.splitCurrentDebrisRisk = makeComparisonChart(
    document.getElementById("chart-current-debris-risk"),
    labels,
    globalData.debris_no_action.map(Number),
    globalData.risk_no_action.map(Number),
    "Debris (no action)",
    "Risk index (no action)",
    "#ff6b6b",
    "#f59e0b"
  );

  charts.splitPredictedDebrisRisk = makeComparisonChart(
    document.getElementById("chart-predicted-debris-risk"),
    labels,
    globalData.debris_mitigation.map(Number),
    globalData.risk_mitigation.map(Number),
    "Debris (mitigation)",
    "Risk index (mitigation)",
    "#6ee7b7",
    "#4a90e2"
  );

  document.querySelectorAll(".split-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => setSplitTab(btn.dataset.splitTab));
  });

  document.getElementById("btn-export-csv").addEventListener("click", () => exportToCSV(globalData));

  const toggleBtn = document.getElementById("btn-toggle-mode");
  toggleBtn.addEventListener("click", () => {
    const chartsSection = document.querySelector(".charts-container");
    const scenarioSection = document.getElementById("scenario-section");
    const riskHeatmapSection = document.getElementById("risk-heatmap-section");
    chartsSection.classList.toggle("hidden");
    scenarioSection.classList.toggle("hidden");
    riskHeatmapSection.classList.toggle("hidden");
    toggleBtn.textContent = chartsSection.classList.contains("hidden") ? "Back to Charts" : "Compare Scenarios";
  });

  const yearSlider = document.getElementById("slider-mitigation-year");
  const strengthSlider = document.getElementById("slider-mitigation-strength");
  yearSlider.addEventListener("input", (e) => {
    const offset = Number(e.target.value);
    document.getElementById("mitigation-year-display").textContent =
      `+${offset} years (Year ${computeStartYearFromOffset(globalData, offset)})`;
    scheduleDynamicUpdate();
  });
  strengthSlider.addEventListener("input", (e) => {
    document.getElementById("mitigation-strength-display").textContent = `${(Number(e.target.value) * 100).toFixed(1)}%/year`;
    scheduleDynamicUpdate();
  });

  document.querySelectorAll(".scenario-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".scenario-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const offset = parseInt(btn.dataset.scenario.split("_")[1], 10);
      yearSlider.value = offset;
      strengthSlider.value = 0.01;
      document.getElementById("mitigation-year-display").textContent =
        `+${offset} years (Year ${computeStartYearFromOffset(globalData, offset)})`;
      document.getElementById("mitigation-strength-display").textContent = "1.0%/year";
      scheduleDynamicUpdate();
    });
  });

  const initialOffset = Number(yearSlider.value);
  document.getElementById("mitigation-year-display").textContent =
    `+${initialOffset} years (Year ${computeStartYearFromOffset(globalData, initialOffset)})`;
  updateMetrics(globalData);
  updateCurrentSituation(globalData);
  updateRiskPanel(Number(globalData.risk_mitigation[globalData.risk_mitigation.length - 1] || 0));
  updateEarlyLateHighlight(globalData);
  generateInsights(globalData);
  setSplitTab("launches");
  await updateDynamicCharts();
}

init().catch((err) => {
  console.error(err);
  setApiStatus("error", "Data source: request failed.");
  document.getElementById("insights-text").textContent = "Error loading predictions data. Run backend first or keep predictions.json available.";
});
