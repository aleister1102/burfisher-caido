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

let findingsStore: FindingsStore;
let scanner: KingfisherScanner;

export async function init(sdk: SDK) {
  sdk.console.log("[Kingfisher] Backend init starting...");
  
  try {
    findingsStore = new FindingsStore();
    scanner = new KingfisherScanner();
    
    const api = sdk.api as APISDK<KingfisherBackendAPI, Record<string, never>>;

    // Register API: scanRequests
    api.register("scanRequests", async (sdkInstance: SDK, ids: string[]) => {
      const start = Date.now();
      try {
        if (!Array.isArray(ids) || ids.length === 0) {
          return [];
        }

        sdkInstance.console.log(`[Kingfisher] API: scanRequests started for ${ids.length} requests`);
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
          `[Kingfisher] API: scanRequests finished in ${duration}ms. Added ${newFindingsCount} findings to store.`
        );

        return results;
      } catch (error: unknown) {
        sdkInstance.console.error("[Kingfisher] API: scanRequests failed:", error);
        return [];
      }
    });

    // Register API: getFindings
    api.register("getFindings", async (sdkInstance: SDK) => {
      try {
        if (!findingsStore) return [];
        const findings = findingsStore.getAll();
        sdkInstance.console.log(`[Kingfisher] API: getFindings returning ${findings.length} items`);
        return findings;
      } catch (error: unknown) {
        sdkInstance.console.error("[Kingfisher] API: getFindings failed:", error);
        return [];
      }
    });

    // Register API: clearFindings
    api.register("clearFindings", async (sdkInstance: SDK) => {
      try {
        if (!findingsStore) return;
        const count = findingsStore.getAll().length;
        findingsStore.clear();
        sdkInstance.console.log(`[Kingfisher] API: clearFindings removed ${count} items.`);
      } catch (error: unknown) {
        sdkInstance.console.error("[Kingfisher] API: clearFindings failed:", error);
      }
    });

    // Register API: exportFindings
    api.register("exportFindings", async (sdkInstance: SDK) => {
      try {
        if (!findingsStore) return "[]";
        const findings = findingsStore.getAll();
        sdkInstance.console.log(`[Kingfisher] API: exportFindings exporting ${findings.length} items`);
        return JSON.stringify(findings, null, 2);
      } catch (error: unknown) {
        sdkInstance.console.error("[Kingfisher] API: exportFindings failed:", error);
        return "[]";
      }
    });

    // Register API: getStats
    api.register("getStats", async (sdkInstance: SDK) => {
      try {
        if (!findingsStore || !scanner) {
            return { totalScanned: 0, totalFindings: 0 };
        }
        const stats = findingsStore.getStats();
        const version = await scanner.getVersion();
        sdkInstance.console.log(`[Kingfisher] API: getStats (Findings: ${stats.totalFindings}, Scanned: ${stats.totalScanned}, Kingfisher: ${version || "N/A"})`);
        return {
          ...stats,
          kingfisherVersion: version ?? undefined,
        };
      } catch (error: unknown) {
        sdkInstance.console.error("[Kingfisher] API: getStats failed:", error);
        return {
          totalScanned: 0,
          totalFindings: 0,
        };
      }
    });

    // Register API: installKingfisher
    api.register("installKingfisher", async (sdkInstance: SDK) => {
      sdkInstance.console.log("[Kingfisher] API: installKingfisher started");
      const start = Date.now();
      try {
        if (!scanner) throw new Error("Scanner not initialized");
        const result = await scanner.installKingfisher(sdkInstance);
        const duration = Date.now() - start;
        sdkInstance.console.log(`[Kingfisher] API: installKingfisher finished in ${duration}ms (Success: ${result.success})`);
        return result;
      } catch (error: unknown) {
        sdkInstance.console.error("[Kingfisher] API: installKingfisher failed:", error);
        return {
          success: false,
          output: `Error: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    });

    // Check Kingfisher availability on startup
    try {
      const version = await scanner.getVersion();
      sdk.console.log(`[Kingfisher] Backend initialized. Kingfisher version: ${version || "not found"}`);
    } catch (error) {
      sdk.console.warn("[Kingfisher] Kingfisher binary not found. Install will be attempted on first scan.");
    }

    sdk.console.log("[Kingfisher] Backend ready.");
  } catch (error) {
    sdk.console.error("[Kingfisher] Global init error:", error);
  }
}
