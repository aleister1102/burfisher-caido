import type { SDK } from "caido:plugin";
import type {
  Finding,
  ScanResult,
  KingfisherRawFinding,
} from "../shared/types";

const BATCH_SIZE = 50;
const SCAN_TIMEOUT_MS = 120_000;
const KINGFISHER_LOCAL_PATH = "~/.local/bin/kingfisher";

/**
 * Kingfisher binary integration for Burfisher plugin.
 * Handles detection, installation, and execution.
 */
export class KingfisherScanner {
  private binaryPath: string | null = null;
  private version: string | null = null;

  /**
   * Get Kingfisher version (and cache binary path)
   */
  async getVersion(): Promise<string | null> {
    if (this.version) return this.version;

    try {
      // Try to find kingfisher
      this.binaryPath = await this.findBinary();
      if (!this.binaryPath) return null;

      // Get version
      const result = await this.exec([this.binaryPath, "--version"]);
      const match = result.stdout.match(/kingfisher[^\d]*(\d+\.\d+\.\d+)/i);
      this.version = match ? match[1] : "unknown";
      return this.version;
    } catch {
      return null;
    }
  }

  /**
   * Scan multiple requests for secrets
   */
  async scan(sdk: SDK, requestIds: string[]): Promise<ScanResult[]> {
    const results: ScanResult[] = [];

    // Ensure binary is available
    const binary = await this.ensureBinary(sdk);
    if (!binary) {
      return requestIds.map((id) => ({
        requestId: id,
        findings: [],
        error: "Kingfisher binary not found and could not be installed",
        duration: 0,
      }));
    }

    // Process in batches
    for (let i = 0; i < requestIds.length; i += BATCH_SIZE) {
      const batch = requestIds.slice(i, i + BATCH_SIZE);
      const batchResults = await this.scanBatch(sdk, binary, batch);
      results.push(...batchResults);
    }

    return results;
  }

  private async scanBatch(
    sdk: SDK,
    binary: string,
    requestIds: string[]
  ): Promise<ScanResult[]> {
    const startTime = Date.now();
    const tempFiles: Map<string, string> = new Map(); // path -> requestId
    const results: ScanResult[] = [];

    try {
      // Create temp files for each request
      for (const id of requestIds) {
        const record = await sdk.requests.get(id);
        if (!record) {
          results.push({
            requestId: id,
            findings: [],
            error: "Request not found",
            duration: 0,
          });
          continue;
        }

        const request = record.request;
        const response = record.response;

        // Combine request and response data
        const rawRequest = request.getRaw().toText();
        const rawResponse = response ? response.getRaw().toText() : "";
        const data = `${rawRequest}\n\n${rawResponse}`;

        // Write to temp file
        const tempPath = await this.writeTempFile(sdk, id, data);
        tempFiles.set(tempPath, id);
      }

      if (tempFiles.size === 0) {
        return results;
      }

      // Run Kingfisher
      const args = [
        binary,
        "scan",
        "--format",
        "json",
        "--no-update-check",
        "--no-ignore",
        "--jobs",
        "4",
        ...Array.from(tempFiles.keys()),
      ];

      const execResult = await this.exec(args, SCAN_TIMEOUT_MS);
      const rawFindings = this.parseOutput(execResult.stdout);

      // Map findings back to request IDs
      const findingsByPath = new Map<string, KingfisherRawFinding[]>();
      for (const raw of rawFindings) {
        const path = raw.finding.path;
        const existing = findingsByPath.get(path) || [];
        existing.push(raw);
        findingsByPath.set(path, existing);
      }

      // Build results
      const duration = Date.now() - startTime;
      for (const [tempPath, requestId] of tempFiles) {
        const rawFindingsForRequest = findingsByPath.get(tempPath) || [];
        const record = await sdk.requests.get(requestId);
        const url = record?.request?.getUrl() || "unknown";
        const method = record?.request?.getMethod() || "GET";

        const findings: Finding[] = rawFindingsForRequest.map((raw) =>
          this.transformFinding(raw, requestId, url, method)
        );

        results.push({
          requestId,
          findings,
          duration,
        });
      }

      // Cleanup temp files
      for (const tempPath of tempFiles.keys()) {
        await this.deleteTempFile(tempPath);
      }

      return results;
    } catch (error: unknown) {
      const duration = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Cleanup temp files on error
      for (const tempPath of tempFiles.keys()) {
        await this.deleteTempFile(tempPath);
      }

      return requestIds.map((id) => ({
        requestId: id,
        findings: [],
        error: errorMsg,
        duration,
      }));
    }
  }

  private transformFinding(
    raw: KingfisherRawFinding,
    requestId: string,
    url: string,
    method: string
  ): Finding {
    const confidence = this.normalizeConfidence(raw.finding.confidence);

    return {
      id: crypto.randomUUID(),
      requestId,
      url,
      method,
      timestamp: Date.now(),
      rule: {
        id: raw.rule.id,
        name: raw.rule.name,
        confidence,
      },
      finding: {
        snippet: this.maskSecret(raw.finding.snippet),
        rawSnippet: raw.finding.snippet,
        path: raw.finding.path,
        fingerprint: raw.finding.fingerprint,
      },
      validation: raw.finding.validation,
    };
  }

  private normalizeConfidence(value: string): "low" | "medium" | "high" {
    const lower = value?.toLowerCase() || "medium";
    if (lower === "high") return "high";
    if (lower === "low") return "low";
    return "medium";
  }

  private maskSecret(value: string): string {
    if (!value || value.length <= 8) return value;
    const visible = Math.min(4, Math.floor(value.length / 4));
    const masked = value.slice(0, visible) + "█".repeat(value.length - visible * 2) + value.slice(-visible);
    return masked;
  }

  private parseOutput(stdout: string): KingfisherRawFinding[] {
    const s = (stdout || "").trim();
    if (!s) return [];

    const findings: KingfisherRawFinding[] = [];
    let idx = 0;

    // Parse multiple JSON documents
    while (idx < s.length) {
      // Skip whitespace
      while (idx < s.length && /\s/.test(s[idx])) idx++;
      if (idx >= s.length) break;

      try {
        // Find end of JSON object/array
        const start = idx;
        let depth = 0;
        let inString = false;
        let escaped = false;

        while (idx < s.length) {
          const ch = s[idx];

          if (escaped) {
            escaped = false;
          } else if (ch === "\\") {
            escaped = true;
          } else if (ch === '"') {
            inString = !inString;
          } else if (!inString) {
            if (ch === "{" || ch === "[") depth++;
            else if (ch === "}" || ch === "]") {
              depth--;
              if (depth === 0) {
                idx++;
                break;
              }
            }
          }
          idx++;
        }

        const jsonStr = s.slice(start, idx);
        const doc = JSON.parse(jsonStr);

        // Extract findings from document
        if (doc && Array.isArray(doc.findings)) {
          findings.push(...doc.findings);
        } else if (Array.isArray(doc)) {
          findings.push(...doc);
        }
      } catch {
        idx++;
      }
    }

    return findings;
  }

  private async findBinary(): Promise<string | null> {
    // Check if already cached
    if (this.binaryPath) return this.binaryPath;

    // Try PATH
    try {
      const result = await this.exec(["which", "kingfisher"]);
      if (result.exitCode === 0 && result.stdout.trim()) {
        return result.stdout.trim();
      }
    } catch {}

    // Try ~/.local/bin
    const localPath = KINGFISHER_LOCAL_PATH.replace("~", process.env.HOME || "");
    try {
      const result = await this.exec(["test", "-x", localPath]);
      if (result.exitCode === 0) {
        return localPath;
      }
    } catch {}

    return null;
  }

  private async ensureBinary(sdk: SDK): Promise<string | null> {
    const existing = await this.findBinary();
    if (existing) {
      this.binaryPath = existing;
      return existing;
    }

    // Try to install
    sdk.console.log("[Burfisher] Kingfisher binary not found, attempting installation...");
    try {
      await this.exec([
        "curl",
        "-sL",
        "https://raw.githubusercontent.com/mongodb/kingfisher/main/scripts/install-kingfisher.sh",
        "|",
        "bash",
      ]);

      const installed = await this.findBinary();
      if (installed) {
        sdk.console.log(`[Burfisher] Kingfisher installed successfully at ${installed}`);
        this.binaryPath = installed;
        return installed;
      }
    } catch (error) {
      sdk.console.error("[Burfisher] Kingfisher installation failed:", error);
    }

    return null;
  }

  private async writeTempFile(sdk: SDK, id: string, data: string): Promise<string> {
    const tempDir = process.env.TMPDIR || "/tmp";
    const tempPath = `${tempDir}/burfisher-${id}-${Date.now()}.txt`;

    const { writeFile } = await import("fs/promises");
    await writeFile(tempPath, data, "utf-8");

    return tempPath;
  }

  private async deleteTempFile(path: string): Promise<void> {
    try {
      const { unlink } = await import("fs/promises");
      await unlink(path);
    } catch {}
  }

  private async exec(
    args: string[],
    timeout: number = 30_000
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const { spawn } = await import("child_process");

    return new Promise((resolve) => {
      const [command, ...cmdArgs] = args;
      const child = spawn(command, cmdArgs, {
        env: {
          ...process.env,
          PATH: `${process.env.PATH}:${process.env.HOME}/.local/bin`,
        },
        shell: true,
      });

      let stdout = "";
      let stderr = "";

      const timeoutId = setTimeout(() => {
        child.kill();
        resolve({
          stdout,
          stderr: stderr + "\nExecution timed out",
          exitCode: 124,
        });
      }, timeout);

      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        clearTimeout(timeoutId);
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 0,
        });
      });

      child.on("error", (err) => {
        clearTimeout(timeoutId);
        resolve({
          stdout,
          stderr: stderr + "\n" + err.message,
          exitCode: 1,
        });
      });
    });
  }
}
