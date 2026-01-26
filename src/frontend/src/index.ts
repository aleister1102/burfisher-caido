import type { Caido, CommandContext } from "@caido/sdk-frontend";
import type { KingfisherBackendAPI, Finding, PluginStats } from "../../shared/types";

const COMMAND_ID = "kingfisher.scan";
const SIDEBAR_PATH = "/kingfisher";

type KingfisherCaido = Caido<KingfisherBackendAPI>;

// Reactive state
let findingsCache: Finding[] = [];
let statsCache: PluginStats = { totalScanned: 0, totalFindings: 0 };
let isScanning = false;

interface LogEntry {
  timestamp: number;
  level: "info" | "warn" | "error" | "debug";
  message: string;
}

const activityLogs: LogEntry[] = [];
let logContentElement: HTMLElement | null = null;

function addLog(level: "info" | "warn" | "error" | "debug", message: string) {
  activityLogs.push({ timestamp: Date.now(), level, message });
  if (activityLogs.length > 100) activityLogs.shift();
  renderLogs();
}

function renderLogs() {
  if (!logContentElement) return;
  logContentElement.innerHTML = activityLogs.map(log => `
    <div class="kf-log-entry kf-log-${log.level}">
      <span class="kf-log-time">${new Date(log.timestamp).toLocaleTimeString()}</span>
      <span class="kf-log-level">${log.level.toUpperCase()}</span>
      <span class="kf-log-message">${escapeHtml(log.message)}</span>
    </div>
  `).join("");
  logContentElement.scrollTop = logContentElement.scrollHeight;
}

/**
 * Collect request IDs from various context types
 */
function collectRequestIds(context: CommandContext): string[] {
  const ids = new Set<string>();

  if (context.type === "RequestRowContext") {
    context.requests
      .map((request) => request.id)
      .filter(Boolean)
      .forEach((id) => ids.add(id));
  } else if (context.type === "RequestContext") {
    if ("id" in context.request && context.request.id) {
      ids.add(context.request.id);
    }
  } else if (context.type === "ResponseContext") {
    if (context.request.id) {
      ids.add(context.request.id);
    }
  }

  return Array.from(ids);
}

export const init = (caido: KingfisherCaido) => {
  // Create and register the dashboard page
  const dashboard = createDashboard(caido);
  caido.navigation.addPage(SIDEBAR_PATH, {
    body: dashboard.element,
    onEnter: dashboard.refresh,
  });

  // Register the scan command
  caido.commands.register(COMMAND_ID, {
    name: "Scan with Kingfisher",
    run: async (context: CommandContext) => {
      const requestIds = collectRequestIds(context);
      caido.log.debug(`[Kingfisher] Scan command invoked, context type: ${context.type}`);
      addLog("debug", `Scan command invoked, context type: ${context.type}`);

      if (requestIds.length === 0) {
        caido.log.warn("[Kingfisher] No requests selected to scan.");
        caido.window.showToast("No requests selected to scan.", { variant: "warning" });
        addLog("warn", "No requests selected to scan.");
        return;
      }

      caido.log.info(`[Kingfisher] Scanning ${requestIds.length} request(s): ${requestIds.join(", ")}`);
      caido.window.showToast(`Scanning ${requestIds.length} request(s)...`, { variant: "info" });
      addLog("info", `Initiating scan for ${requestIds.length} request(s)...`);
      isScanning = true;

      try {
        addLog("debug", "Calling backend.scanRequests...");
        const start = Date.now();
        const results = await caido.backend.scanRequests(requestIds);
        const duration = Date.now() - start;
        const totalFindings = results.reduce((sum, r) => sum + r.findings.length, 0);

        caido.log.info(`[Kingfisher] Scan complete: ${totalFindings} finding(s) in ${results.length} request(s) (${duration}ms)`);
        addLog("info", `Scan complete: Found ${totalFindings} finding(s) in ${results.length} request(s) (${duration}ms)`);
        
        // Show raw output from the first result (it's the same for all in a batch)
        if (results.length > 0 && results[0].rawOutput) {
          addLog("debug", "Raw output received from backend.");
          addLog("info", "Raw Kingfisher Output:\n" + results[0].rawOutput);
        }

        if (totalFindings > 0) {
          caido.window.showToast(`Found ${totalFindings} secret(s)!`, { variant: "success" });
          caido.navigation.goTo(SIDEBAR_PATH);
        } else {
          caido.window.showToast("No secrets found.", { variant: "info" });
        }

        // Refresh dashboard
        addLog("debug", "Refreshing dashboard after scan...");
        dashboard.refresh();
      } catch (error) {
        caido.log.error(`[Kingfisher] Scan failed for requests ${requestIds.join(", ")}:`, error);
        caido.window.showToast("Scan failed. Check console for details.", { variant: "error" });
        addLog("error", `Scan failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        isScanning = false;
      }
    },
  });

  // Register context menu items
  caido.log.debug("[Kingfisher] Registering context menu items");
  caido.menu.registerItem({ type: "RequestRow", commandId: COMMAND_ID, leadingIcon: "fas fa-crow" });
  caido.menu.registerItem({ type: "Request", commandId: COMMAND_ID, leadingIcon: "fas fa-crow" });
  caido.menu.registerItem({ type: "Response", commandId: COMMAND_ID, leadingIcon: "fas fa-crow" });

  // Register sidebar item
  caido.log.debug("[Kingfisher] Registering sidebar item");
  caido.sidebar.registerItem("Kingfisher", SIDEBAR_PATH, {
    icon: "fas fa-crow",
    group: "Plugins",
  });

  // Register command to open Kingfisher UI
  const OPEN_UI_COMMAND = "kingfisher.openUI";
  caido.commands.register(OPEN_UI_COMMAND, {
    name: "Kingfisher: Open Dashboard",
    run: () => {
      caido.navigation.goTo(SIDEBAR_PATH);
    },
  });
  caido.commandPalette.register(OPEN_UI_COMMAND);

  caido.log.info("Kingfisher frontend loaded.");
};

/**
 * Create the main dashboard component
 */
function createDashboard(caido: KingfisherCaido) {
  const container = document.createElement("div");
  container.className = "kingfisher-dashboard";

  // Inject styles
  const style = document.createElement("style");
  style.textContent = getDashboardStyles();
  container.appendChild(style);

  // Header
  const header = document.createElement("div");
  header.className = "kf-header";
  header.innerHTML = `
    <div class="kf-header-left">
      <i class="fas fa-crow kf-logo"></i>
      <div>
        <h1>Kingfisher</h1>
        <p class="kf-subtitle">Secrets scanner powered by MongoDB Kingfisher</p>
      </div>
    </div>
  `;
  container.appendChild(header);

  // Stats bar
  const statsBar = document.createElement("div");
  statsBar.className = "kf-stats-bar";
  container.appendChild(statsBar);

  // Actions bar
  const actionsBar = document.createElement("div");
  actionsBar.className = "kf-actions-bar";

  const clearBtn = caido.ui.button({ variant: "tertiary", label: "Clear All", size: "small" });
  const exportBtn = caido.ui.button({ variant: "tertiary", label: "Export JSON", size: "small" });
  const refreshBtn = caido.ui.button({ variant: "tertiary", label: "Refresh", size: "small" });
  const installBtn = caido.ui.button({ variant: "tertiary", label: "Install/Upgrade Kingfisher", size: "small" });

  actionsBar.appendChild(clearBtn);
  actionsBar.appendChild(exportBtn);
  actionsBar.appendChild(refreshBtn);
  actionsBar.appendChild(installBtn);
  container.appendChild(actionsBar);

  // Findings table
  const tableContainer = document.createElement("div");
  tableContainer.className = "kf-table-container";
  container.appendChild(tableContainer);

  // Empty state (shown when no findings)
  const emptyState = document.createElement("div");
  emptyState.className = "kf-empty-state";
  emptyState.innerHTML = `
    <i class="fas fa-search"></i>
    <h3>No findings yet</h3>
    <p>Right-click on requests in History and select "Scan with Kingfisher" to start.</p>
  `;
  container.appendChild(emptyState);

  // Details panel (shown when a finding is selected)
  const detailsPanel = document.createElement("div");
  detailsPanel.className = "kf-details-panel";
  detailsPanel.style.display = "none";
  container.appendChild(detailsPanel);

  // Log panel (sticks to bottom)
  const logPanel = document.createElement("div");
  logPanel.className = "kf-log-panel";
  logPanel.innerHTML = `
    <div class="kf-log-header">
      <div class="kf-log-header-left">
        <i class="fas fa-chevron-down kf-log-toggle"></i>
        <span>Activity Log</span>
      </div>
      <div class="kf-log-header-actions">
        <button class="kf-log-copy-btn">Copy Logs</button>
        <button class="kf-log-clear-btn">Clear Logs</button>
      </div>
    </div>
    <div class="kf-log-content"></div>
  `;
  container.appendChild(logPanel);

  logContentElement = logPanel.querySelector(".kf-log-content") as HTMLElement;
  const logToggle = logPanel.querySelector(".kf-log-toggle") as HTMLElement;
  const logHeader = logPanel.querySelector(".kf-log-header") as HTMLElement;
  const logClearBtn = logPanel.querySelector(".kf-log-clear-btn") as HTMLElement;
  const logCopyBtn = logPanel.querySelector(".kf-log-copy-btn") as HTMLElement;

  // Start collapsed by default
  let isLogExpanded = false;
  if (logContentElement) logContentElement.style.display = "none";
  logToggle.style.transform = "rotate(-90deg)";

  logHeader.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".kf-log-header-actions")) return;
    isLogExpanded = !isLogExpanded;
    if (logContentElement) logContentElement.style.display = isLogExpanded ? "block" : "none";
    logToggle.style.transform = isLogExpanded ? "rotate(0deg)" : "rotate(-90deg)";
  });

  logCopyBtn.addEventListener("click", () => {
    if (activityLogs.length === 0) {
      caido.window.showToast("Log is empty", { variant: "info" });
      return;
    }
    const text = activityLogs.map(e => 
      `[${formatTime(e.timestamp)}] [${e.level.toUpperCase()}] ${e.message}`
    ).join("\n");
    navigator.clipboard.writeText(text);
    caido.window.showToast("Log copied to clipboard", { variant: "success" });
  });

  logClearBtn.addEventListener("click", () => {
    activityLogs.length = 0;
    addLog("info", "Activity log cleared.");
    renderLogs();
  });

  let selectedFinding: Finding | null = null;

  let binaryCheckDone = false;

  async function refresh() {
    caido.log.debug("[Kingfisher] Refreshing findings dashboard");
    addLog("debug", "Refreshing findings dashboard...");
    try {
      addLog("debug", "Fetching findings from backend...");
      try {
        findingsCache = await caido.backend.getFindings();
        addLog("debug", `Fetched ${findingsCache.length} findings.`);
      } catch (err) {
        caido.log.error("[Kingfisher] Failed to fetch findings:", err);
        addLog("error", "Failed to fetch findings. Backend might be unavailable.");
      }
      
      addLog("debug", "Fetching stats from backend...");
      try {
        statsCache = await caido.backend.getStats();
        addLog("debug", `Stats: Scanned=${statsCache.totalScanned}, Findings=${statsCache.totalFindings}`);
        
        // Check for Kingfisher binary on first load
        if (!binaryCheckDone) {
          binaryCheckDone = true;
          if (statsCache.kingfisherVersion) {
            addLog("info", `Kingfisher v${statsCache.kingfisherVersion} detected.`);
          } else {
            addLog("warn", "Kingfisher binary not found. Click 'Install/Upgrade Kingfisher' to install.");
            caido.window.showToast("Kingfisher binary not found. Please install it.", { variant: "warning" });
          }
        }
      } catch (err) {
        caido.log.error("[Kingfisher] Failed to fetch stats:", err);
        addLog("error", "Failed to fetch stats.");
      }
      
      render();
      addLog("debug", "Dashboard render complete.");
    } catch (error) {
      caido.log.error("[Kingfisher] Failed to refresh findings:", error);
      addLog("error", `Failed to refresh dashboard: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function render() {
    // Update stats
    statsBar.innerHTML = `
      <div class="kf-stat">
        <span class="kf-stat-value">${statsCache.totalFindings}</span>
        <span class="kf-stat-label">Findings</span>
      </div>
      <div class="kf-stat">
        <span class="kf-stat-value">${statsCache.totalScanned}</span>
        <span class="kf-stat-label">Scanned</span>
      </div>
      ${statsCache.lastScanTime ? `
        <div class="kf-stat">
          <span class="kf-stat-value">${formatRelativeTime(statsCache.lastScanTime)}</span>
          <span class="kf-stat-label">Last Scan</span>
        </div>
      ` : ""}
      ${statsCache.kingfisherVersion ? `
        <div class="kf-stat">
          <span class="kf-stat-value">v${statsCache.kingfisherVersion}</span>
          <span class="kf-stat-label">Kingfisher</span>
        </div>
      ` : ""}
    `;

    // Show/hide empty state
    if (findingsCache.length === 0) {
      emptyState.style.display = "flex";
      tableContainer.style.display = "none";
      detailsPanel.style.display = "none";
    } else {
      emptyState.style.display = "none";
      tableContainer.style.display = "block";
      renderTable();
    }
  }

  function renderTable() {
    tableContainer.innerHTML = `
      <table class="kf-table">
        <thead>
          <tr>
            <th>Confidence</th>
            <th>Rule</th>
            <th>URL</th>
            <th>Method</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          ${findingsCache.map((f) => `
            <tr data-id="${f.id}" class="${selectedFinding?.id === f.id ? "selected" : ""}">
              <td><span class="kf-badge kf-badge-${f.rule.confidence}">${f.rule.confidence.toUpperCase()}</span></td>
              <td>${escapeHtml(f.rule.name)}</td>
              <td class="kf-url" title="${escapeHtml(f.url)}">${escapeHtml(truncateUrl(f.url))}</td>
              <td><span class="kf-method">${f.method}</span></td>
              <td>${formatTime(f.timestamp)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;

    // Add click handlers
    const rows = tableContainer.querySelectorAll("tbody tr");
    rows.forEach((row) => {
      row.addEventListener("click", () => {
        const id = row.getAttribute("data-id");
        const finding = findingsCache.find((f) => f.id === id);
        if (finding) {
          selectedFinding = finding;
          renderDetails(finding);
          render();
        }
      });
    });
  }

  function renderDetails(finding: Finding) {
    detailsPanel.style.display = "block";
    detailsPanel.innerHTML = `
      <div class="kf-details-header">
        <h3>${escapeHtml(finding.rule.name)}</h3>
        <span class="kf-badge kf-badge-${finding.rule.confidence}">${finding.rule.confidence.toUpperCase()}</span>
        <button class="kf-close-btn">&times;</button>
      </div>
      <div class="kf-details-body">
        <div class="kf-detail-row">
          <label>Rule ID:</label>
          <span>${escapeHtml(finding.rule.id)}</span>
        </div>
        <div class="kf-detail-row">
          <label>URL:</label>
          <span>${escapeHtml(finding.url)}</span>
        </div>
        <div class="kf-detail-row">
          <label>Method:</label>
          <span>${finding.method}</span>
        </div>
        <div class="kf-detail-row">
          <label>Matched Secret:</label>
          <code class="kf-secret">${escapeHtml(finding.finding.snippet)}</code>
        </div>
        ${finding.validation ? `
          <div class="kf-detail-row">
            <label>Validation:</label>
            <span class="kf-validation-${finding.validation.status}">${finding.validation.status}</span>
          </div>
        ` : ""}
      </div>
      <div class="kf-details-actions">
        <button class="kf-btn kf-btn-copy">Copy Full Value</button>
      </div>
    `;

    // Close button
    detailsPanel.querySelector(".kf-close-btn")?.addEventListener("click", () => {
      selectedFinding = null;
      detailsPanel.style.display = "none";
      render();
    });

    // Copy button
    detailsPanel.querySelector(".kf-btn-copy")?.addEventListener("click", () => {
      navigator.clipboard.writeText(finding.finding.rawSnippet);
      caido.window.showToast("Copied to clipboard", { variant: "success" });
    });
  }

  // Event handlers
  clearBtn.addEventListener("click", async () => {
    if (!confirm("Clear all findings?")) return;
    caido.log.info("[Kingfisher] Clearing all findings");
    addLog("info", "Clearing all findings");
    await caido.backend.clearFindings();
    await refresh();
    caido.window.showToast("Findings cleared", { variant: "info" });
  });

  exportBtn.addEventListener("click", async () => {
    caido.log.info("[Kingfisher] Exporting findings to JSON");
    addLog("info", "Exporting findings to JSON");
    const json = await caido.backend.exportFindings();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `kingfisher-findings-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    caido.window.showToast("Exported findings", { variant: "success" });
  });

  refreshBtn.addEventListener("click", refresh);

  installBtn.addEventListener("click", async () => {
    caido.window.showToast("Attempting to install/upgrade Kingfisher...", { variant: "info" });
    addLog("info", "Starting Kingfisher installation/upgrade...");
    try {
      const result = await caido.backend.installKingfisher();
      if (result.success) {
        caido.window.showToast(result.output.split('\n')[0], { variant: "success" });
        addLog("info", result.output);
      } else {
        caido.window.showToast("Installation failed. Check activity log.", { variant: "error" });
        addLog("error", result.output);
      }
      await refresh();
    } catch (error) {
      caido.log.error("[Kingfisher] Install failed:", error);
      addLog("error", `Installation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  return { element: container, refresh };
}

// Utility functions
function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function truncateUrl(url: string, maxLen = 50): string {
  if (url.length <= maxLen) return url;
  return url.slice(0, maxLen - 3) + "...";
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString();
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

function getDashboardStyles(): string {
  return `
    .kingfisher-dashboard {
      padding: 24px;
      width: 100%;
      height: 100%;
      box-sizing: border-box;
      font-family: var(--font-family, system-ui, sans-serif);
      color: var(--color-text, #e0e0e0);
      background: var(--color-bg, #1a1a1a);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .kf-header {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
    }

    .kf-header-left {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .kf-logo {
      font-size: 32px;
      color: #10b981;
    }

    .kf-header h1 {
      margin: 0;
      font-size: 24px;
      font-weight: 600;
    }

    .kf-subtitle {
      margin: 4px 0 0;
      opacity: 0.6;
      font-size: 14px;
    }

    .kf-stats-bar {
      flex-shrink: 0;
      display: flex;
      gap: 32px;
      margin-bottom: 16px;
      padding: 16px;
      background: rgba(255, 255, 255, 0.03);
      border-radius: 8px;
    }

    .kf-stat {
      display: flex;
      flex-direction: column;
    }

    .kf-stat-value {
      font-size: 20px;
      font-weight: 600;
      color: #10b981;
    }

    .kf-stat-label {
      font-size: 12px;
      opacity: 0.6;
      text-transform: uppercase;
    }

    .kf-actions-bar {
      flex-shrink: 0;
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
    }

    .kf-table-container {
      flex: 1;
      overflow: auto;
      min-height: 0;
      margin-bottom: 16px;
    }

    .kf-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }

    .kf-table th,
    .kf-table td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }

    .kf-table th {
      font-weight: 600;
      text-transform: uppercase;
      font-size: 12px;
      opacity: 0.6;
    }

    .kf-table tbody tr {
      cursor: pointer;
      transition: background 0.15s;
    }

    .kf-table tbody tr:hover {
      background: rgba(255, 255, 255, 0.05);
    }

    .kf-table tbody tr.selected {
      background: rgba(16, 185, 129, 0.1);
    }

    .kf-badge {
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
    }

    .kf-badge-high {
      background: rgba(239, 68, 68, 0.2);
      color: #ef4444;
    }

    .kf-badge-medium {
      background: rgba(245, 158, 11, 0.2);
      color: #f59e0b;
    }

    .kf-badge-low {
      background: rgba(59, 130, 246, 0.2);
      color: #3b82f6;
    }

    .kf-url {
      max-width: 300px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: monospace;
      font-size: 13px;
    }

    .kf-method {
      font-family: monospace;
      font-weight: 600;
    }

    .kf-empty-state {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 64px;
      text-align: center;
      opacity: 0.6;
    }

    .kf-empty-state i {
      font-size: 48px;
      margin-bottom: 16px;
    }

    .kf-empty-state h3 {
      margin: 0 0 8px;
    }

    .kf-empty-state p {
      margin: 0;
      max-width: 300px;
    }

    .kf-details-panel {
      flex-shrink: 0;
      margin-top: 16px;
      padding: 16px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      max-height: 350px;
      overflow-y: auto;
    }

    .kf-details-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
    }

    .kf-details-header h3 {
      margin: 0;
      flex: 1;
    }

    .kf-close-btn {
      background: none;
      border: none;
      color: inherit;
      font-size: 24px;
      cursor: pointer;
      opacity: 0.6;
    }

    .kf-close-btn:hover {
      opacity: 1;
    }

    .kf-details-body {
      display: grid;
      gap: 12px;
    }

    .kf-detail-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .kf-detail-row label {
      font-weight: 600;
      min-width: 120px;
      opacity: 0.6;
    }

    .kf-detail-row .kf-secret {
      flex: 1 1 100%;
      margin-top: 4px;
    }

    .kf-secret {
      display: block;
      padding: 12px;
      background: rgba(0, 0, 0, 0.3);
      border-radius: 4px;
      font-family: monospace;
      font-size: 12px;
      word-break: break-all;
      white-space: pre-wrap;
      max-height: 200px;
      overflow-y: auto;
      line-height: 1.5;
    }

    .kf-details-actions {
      display: flex;
      gap: 8px;
      margin-top: 16px;
    }

    .kf-btn {
      padding: 8px 16px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 4px;
      background: transparent;
      color: inherit;
      cursor: pointer;
      font-size: 14px;
    }

    .kf-btn:hover {
      background: rgba(255, 255, 255, 0.1);
    }

    .kf-validation-valid {
      color: #10b981;
    }

    .kf-validation-invalid {
      color: #ef4444;
    }

    .kf-validation-unknown {
      color: #6b7280;
    }

    .kf-log-panel {
      flex-shrink: 0;
      margin-top: auto;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 8px;
      overflow: hidden;
    }

    .kf-log-header {
      padding: 12px 16px;
      background: rgba(255, 255, 255, 0.03);
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
      user-select: none;
    }

    .kf-log-header-left {
      display: flex;
      align-items: center;
      gap: 12px;
      font-weight: 600;
      font-size: 13px;
      text-transform: uppercase;
      opacity: 0.8;
    }

    .kf-log-header-actions {
      display: flex;
      gap: 8px;
    }

    .kf-log-toggle {
      transition: transform 0.2s;
    }

    .kf-log-clear-btn,
    .kf-log-copy-btn {
      background: transparent;
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: inherit;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
      opacity: 0.6;
    }

    .kf-log-clear-btn:hover,
    .kf-log-copy-btn:hover {
      opacity: 1;
      background: rgba(255, 255, 255, 0.05);
    }

    .kf-log-content {
      max-height: 200px;
      overflow-y: auto;
      padding: 8px 0;
      font-family: monospace;
      font-size: 12px;
    }

    .kf-log-entry {
      padding: 4px 16px;
      display: flex;
      gap: 16px;
      border-left: 3px solid transparent;
    }

    .kf-log-entry:hover {
      background: rgba(255, 255, 255, 0.02);
    }

    .kf-log-time {
      opacity: 0.4;
      white-space: nowrap;
    }

    .kf-log-level {
      font-weight: 600;
      width: 50px;
      text-align: center;
    }

    .kf-log-info { border-left-color: #10b981; }
    .kf-log-info .kf-log-level { color: #10b981; }

    .kf-log-warn { border-left-color: #f59e0b; }
    .kf-log-warn .kf-log-level { color: #f59e0b; }

    .kf-log-error { border-left-color: #ef4444; }
    .kf-log-error .kf-log-level { color: #ef4444; }

    .kf-log-debug { border-left-color: #6b7280; }
    .kf-log-debug .kf-log-level { color: #6b7280; }

    .kf-log-message {
      opacity: 0.9;
      word-break: break-all;
      white-space: pre-wrap;
    }
  `;
}
