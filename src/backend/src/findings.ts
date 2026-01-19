import type { Finding, PluginStats } from "../../shared/types";

/**
 * In-memory store for findings.
 * Findings persist for the duration of the Caido session.
 */
export class FindingsStore {
  private findings: Map<string, Finding> = new Map();
  private totalScanned: number = 0;
  private lastScanTime?: number;

  add(finding: Finding): void {
    this.findings.set(finding.id, finding);
    this.lastScanTime = Date.now();
  }

  addMany(findings: Finding[]): void {
    for (const finding of findings) {
      this.add(finding);
    }
  }

  get(id: string): Finding | undefined {
    return this.findings.get(id);
  }

  getAll(): Finding[] {
    return Array.from(this.findings.values()).sort(
      (a, b) => b.timestamp - a.timestamp
    );
  }

  getByRequestId(requestId: string): Finding[] {
    return this.getAll().filter((f) => f.requestId === requestId);
  }

  remove(id: string): boolean {
    return this.findings.delete(id);
  }

  clear(): void {
    this.findings.clear();
  }

  incrementScanned(count: number = 1): void {
    this.totalScanned += count;
    this.lastScanTime = Date.now();
  }

  getStats(): PluginStats {
    return {
      totalScanned: this.totalScanned,
      totalFindings: this.findings.size,
      lastScanTime: this.lastScanTime,
    };
  }
}
