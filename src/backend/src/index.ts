/// <reference types="@caido/sdk-backend" />

import type { APISDK, SDK } from "caido:plugin";
import type {
  Finding,
  ScanResult,
  PluginStats,
  KingfisherBackendAPI,
} from "../../shared/types";
import { KingfisherScanner } from "./scanner";
import { FindingsStore } from "./findings";

// Initialize stores
const findingsStore = new FindingsStore();
const scanner = new KingfisherScanner();

export async function init(sdk: SDK) {
  const api = sdk.api as APISDK<KingfisherBackendAPI, Record<string, never>>;

  // Register API: scanRequests
  api.register("scanRequests", async (sdkInstance: SDK, ids: string[]) => {
    const start = Date.now();
    try {
      if (!Array.isArray(ids) || ids.length === 0) {
        return [];
      }

      sdkInstance.console.log(`[Burfisher] API: scanRequests started for ${ids.length} requests`);
      const results = await scanner.scan(sdkInstance, ids);

      // Store findings
      let newFindingsCount = 0;
      for (const result of results) {
        for (const finding of result.findings) {
          findingsStore.add(finding);
          newFindingsCount++;
        }
      }

      const duration = Date.now() - start;
      sdkInstance.console.log(
        `[Burfisher] API: scanRequests finished in ${duration}ms. Added ${newFindingsCount} findings to store.`
      );

      return results;
    } catch (error: unknown) {
      sdkInstance.console.error("[Burfisher] API: scanRequests failed:", error);
      throw error;
    }
  });

  // Register API: getFindings
  api.register("getFindings", async (sdkInstance: SDK) => {
    const findings = findingsStore.getAll();
    sdkInstance.console.log(`[Burfisher] API: getFindings returning ${findings.length} items`);
    return findings;
  });

  // Register API: clearFindings
  api.register("clearFindings", async (sdkInstance: SDK) => {
    const count = findingsStore.getAll().length;
    findingsStore.clear();
    sdkInstance.console.log(`[Burfisher] API: clearFindings removed ${count} items.`);
  });

  // Register API: exportFindings
  api.register("exportFindings", async (sdkInstance: SDK) => {
    const findings = findingsStore.getAll();
    sdkInstance.console.log(`[Burfisher] API: exportFindings exporting ${findings.length} items`);
    return JSON.stringify(findings, null, 2);
  });

  // Register API: getStats
  api.register("getStats", async (sdkInstance: SDK) => {
    const stats = findingsStore.getStats();
    const version = await scanner.getVersion();
    sdkInstance.console.log(`[Burfisher] API: getStats (Findings: ${stats.totalFindings}, Scanned: ${stats.totalScanned}, Kingfisher: ${version || "N/A"})`);
    return {
      ...stats,
      kingfisherVersion: version,
    };
  });

  // Register API: installKingfisher
  api.register("installKingfisher", async (sdkInstance: SDK) => {
    sdkInstance.console.log("[Burfisher] API: installKingfisher started");
    const start = Date.now();
    const result = await scanner.installKingfisher(sdkInstance);
    const duration = Date.now() - start;
    sdkInstance.console.log(`[Burfisher] API: installKingfisher finished in ${duration}ms (Success: ${result.success})`);
    return result;
  });

  // Check Kingfisher availability on startup
  try {
    const version = await scanner.getVersion();
    sdk.console.log(`[Burfisher] Backend initialized. Kingfisher version: ${version || "not found"}`);
  } catch (error) {
    sdk.console.warn("[Burfisher] Kingfisher binary not found. Install will be attempted on first scan.");
  }

  sdk.console.log("[Burfisher] Backend ready.");
}
