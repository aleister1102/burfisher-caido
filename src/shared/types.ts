// ============================================================================
// Kingfisher Plugin - Shared Types
// ============================================================================

export interface Finding {
  id: string;
  requestId: string;
  url: string;
  method: string;
  timestamp: number;
  rule: {
    id: string;
    name: string;
    confidence: "low" | "medium" | "high";
  };
  finding: {
    snippet: string;
    rawSnippet: string;
    path: string;
    fingerprint?: string;
  };
  validation?: {
    status: string;
    response?: string;
  };
}

export interface ScanResult {
  requestId: string;
  findings: Finding[];
  error?: string;
  duration: number;
  rawOutput?: string;
}

export interface PluginStats {
  totalScanned: number;
  totalFindings: number;
  lastScanTime?: number;
  kingfisherVersion?: string;
}

export interface PluginState {
  findings: Finding[];
  isScanning: boolean;
  lastScanTime?: number;
  stats: PluginStats;
}

// Backend API interface - used by frontend to call backend
export interface KingfisherBackendAPI {
  scanRequests(ids: string[]): Promise<ScanResult[]>;
  getFindings(): Promise<Finding[]>;
  clearFindings(): Promise<void>;
  exportFindings(): Promise<string>;
  getStats(): Promise<PluginStats>;
  installKingfisher(): Promise<{ success: boolean; output: string }>;
  [key: string]: any;
}

// Kingfisher raw output types
export interface KingfisherRawFinding {
  rule: {
    id: string;
    name: string;
  };
  finding: {
    path: string;
    snippet: string;
    fingerprint?: string;
    confidence: string;
    validation?: {
      status: string;
      response?: string;
    };
  };
}

export interface KingfisherOutput {
  findings?: KingfisherRawFinding[];
  summary?: {
    total: number;
    by_confidence: Record<string, number>;
  };
}
