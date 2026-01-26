import type { SDK } from "caido:plugin";
import type {
  Finding,
  ScanResult,
  KingfisherRawFinding,
} from "../../shared/types";

const BATCH_SIZE = 50;
const SCAN_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 300_000; // 5 minutes for download/install

/**
 * Kingfisher binary integration for Caidofisher plugin.
 * Handles detection, installation, and execution.
 */
export class KingfisherScanner {
  private binaryPath: string | null = null;
  private version: string | null = null;

  private async getIsWindows() {
    try {
      const os = await import("os");
      return os.platform() === "win32";
    } catch (e) {
      return false;
    }
  }

  private async getBinaryName() {
    return (await this.getIsWindows()) ? "kingfisher.exe" : "kingfisher";
  }

  private async getInstallDir() {
    try {
      const os = await import("os");
      const path = await import("path");
      return path.join(os.homedir(), ".local", "bin");
    } catch (e) {
      return ".local/bin";
    }
  }

  private async getTempDir() {
    try {
      const os = await import("os");
      return os.tmpdir();
    } catch (e) {
      return "/tmp";
    }
  }

  /**
   * Get Kingfisher version (and cache binary path)
   */
  async getVersion(): Promise<string | undefined> {
    if (this.version) return this.version;

    try {
      // Try to find kingfisher
      this.binaryPath = await this.findBinary();
      if (!this.binaryPath) return undefined;

      // Get version
      const result = await this.exec([this.binaryPath, "--version"]);
      const match = result.stdout.match(/kingfisher[^\d]*(\d+\.\d+\.\d+)/i);
      this.version = match ? match[1] : "unknown";
      return this.version;
    } catch {
      return undefined;
    }
  }

  /**
   * Install or upgrade Kingfisher binary
   */
  async installKingfisher(sdk: SDK): Promise<{ success: boolean; output: string }> {
    sdk.console.log("[Caidofisher] Attempting to install/upgrade Kingfisher binary...");
    try {
      if (await this.getIsWindows()) {
        return await this.installWindows(sdk);
      }

      const result = await this.exec([
        "curl -sL https://raw.githubusercontent.com/mongodb/kingfisher/main/scripts/install-kingfisher.sh | bash",
      ], INSTALL_TIMEOUT_MS);

      const output = result.stdout + (result.stderr ? "\nSTDERR:\n" + result.stderr : "");
      
      const installed = await this.findBinary();
      if (installed) {
        this.binaryPath = installed;
        this.version = null; // Reset version to force re-detection
        const newVersion = await this.getVersion();
        sdk.console.log(`[Caidofisher] Kingfisher installed successfully at ${installed} (v${newVersion})`);
        return { success: true, output: `Successfully installed Kingfisher v${newVersion}\n\n${output}` };
      }

      return { success: false, output: `Installation failed: binary not found after script execution\n\n${output}` };
    } catch (error: any) {
      const msg = error instanceof Error ? error.message : String(error);
      sdk.console.error("[Caidofisher] Kingfisher installation failed:", msg);
      return { success: false, output: `Installation failed: ${msg}` };
    }
  }

  private async installWindows(sdk: SDK): Promise<{ success: boolean; output: string }> {
    const { writeFile, mkdir, readFile, readdir, stat } = await import("fs/promises");
    const path = await import("path");
    const installDir = await this.getInstallDir();
    const tempDir = await this.getTempDir();
    const zipPath = path.join(tempDir, `kingfisher-windows-${Date.now()}.zip`);
    const extractDir = path.join(tempDir, `kingfisher-extract-${Date.now()}`);
    const downloadUrl = "https://github.com/mongodb/kingfisher/releases/latest/download/kingfisher-windows-x64.zip";
    
    try {
      await mkdir(installDir, { recursive: true });
      await mkdir(extractDir, { recursive: true });

      sdk.console.log(`[Caidofisher] Downloading Kingfisher from ${downloadUrl}...`);
      const downloadCmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference = 'SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${downloadUrl}' -OutFile '${zipPath}' -UseBasicParsing"`;
      
      const downloadResult = await this.exec([downloadCmd], INSTALL_TIMEOUT_MS);
      if (downloadResult.exitCode !== 0) {
        throw new Error(`Download failed (code ${downloadResult.exitCode}): ${downloadResult.stderr || downloadResult.stdout}`);
      }

      sdk.console.log("[Caidofisher] Extracting Kingfisher archive...");
      const extractCmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force -ErrorAction Stop"`;
      
      const extractResult = await this.exec([extractCmd], INSTALL_TIMEOUT_MS);
      if (extractResult.exitCode !== 0) {
        throw new Error(`Extraction failed (code ${extractResult.exitCode}): ${extractResult.stderr || extractResult.stdout}`);
      }

      // Find the extracted binary (may be in a subdirectory)
      const findBinaryInDir = async (dir: string): Promise<string | null> => {
        const entries = await readdir(dir);
        for (const entry of entries) {
          const fullPath = path.join(dir, entry);
          if (entry === "kingfisher.exe") return fullPath;
          const s = await stat(fullPath);
          if (s.isDirectory()) {
            const found = await findBinaryInDir(fullPath);
            if (found) return found;
          }
        }
        return null;
      };

      const extractedBinary = await findBinaryInDir(extractDir);
      if (!extractedBinary) {
        throw new Error("Could not find kingfisher.exe in the extracted archive");
      }

      const targetBinary = path.join(installDir, "kingfisher.exe");
      
      sdk.console.log(`[Caidofisher] Moving binary to ${targetBinary}...`);
      // Move binary
      await writeFile(targetBinary, await readFile(extractedBinary));
      
      try {
        const { unlink, rm } = await import("fs/promises");
        await unlink(zipPath);
        await rm(extractDir, { recursive: true, force: true });
      } catch (e) {
        sdk.console.warn(`[Caidofisher] Cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      this.binaryPath = targetBinary;
      this.version = null;
      const newVersion = await this.getVersion();
      
      return { success: true, output: `Successfully installed Kingfisher v${newVersion} for Windows.` };
    } catch (error: any) {
      const msg = error instanceof Error ? error.message : String(error);
      sdk.console.error("[Caidofisher] Windows installation failed:", msg);
      return { success: false, output: `Windows installation failed: ${msg}` };
    }
  }

  /**
   * Scan multiple requests for secrets
   */
  async scan(sdk: SDK, requestIds: string[]): Promise<ScanResult[]> {
    sdk.console.log(`[Caidofisher] Starting scan of ${requestIds.length} request(s)`);
    const results: ScanResult[] = [];

    // Ensure binary is available
    const binary = await this.ensureBinary(sdk);
    if (!binary) {
      sdk.console.error("[Caidofisher] Scanning aborted: binary unavailable");
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

    const totalFindings = results.reduce((sum, r) => sum + r.findings.length, 0);
    sdk.console.log(`[Caidofisher] Scan completed. Found ${totalFindings} finding(s) total.`);
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
        `"${binary}"`,
        "scan",
        "--format",
        "json",
        "--no-update-check",
        "--no-ignore",
        "--jobs",
        "4",
        ...Array.from(tempFiles.keys()).map(p => `"${p}"`),
      ];

      sdkInstance.console.log(`[Caidofisher] Executing Kingfisher: ${args.join(" ")}`);
      const execResult = await this.exec(args, SCAN_TIMEOUT_MS);
      sdkInstance.console.log(`[Caidofisher] Kingfisher finished with code ${execResult.exitCode}`);
      
      if (execResult.stderr) {
        sdkInstance.console.warn(`[Caidofisher] Kingfisher STDERR: ${execResult.stderr}`);
      }

      const rawFindings = this.parseOutput(execResult.stdout);
      sdkInstance.console.log(`[Caidofisher] Parsed ${rawFindings.length} findings from output`);

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
      id: Math.random().toString(36).substring(2) + Date.now().toString(36),
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
    const fs = await import("fs");
    const { access: accessPromise } = await import("fs/promises");
    const path = await import("path");
    
    // Check if already cached
    if (this.binaryPath) return this.binaryPath;

    const name = await this.getBinaryName();
    let paths: string[] = [];
    
    // Add local install dir to search paths
    paths.unshift(await this.getInstallDir());

    for (const p of paths) {
      const fullPath = path.join(p, name);
      try {
        await accessPromise(fullPath, fs.constants.X_OK || 1);
        return fullPath;
      } catch {
        continue;
      }
    }

    return null;
  }

  private async ensureBinary(sdk: SDK): Promise<string | null> {
    const existing = await this.findBinary();
    if (existing) {
      this.binaryPath = existing;
      return existing;
    }

    // Try to install
    sdk.console.log("[Caidofisher] Kingfisher binary not found, attempting installation...");
    try {
      const result = await this.installKingfisher(sdk);
      if (result.success) {
        return this.binaryPath;
      }
    } catch (error) {
      sdk.console.error("[Caidofisher] Kingfisher installation failed:", error);
    }

    return null;
  }

  private async writeTempFile(sdk: SDK, id: string, data: string): Promise<string> {
    const { writeFile } = await import("fs/promises");
    const path = await import("path");
    const tempPath = path.join(await this.getTempDir(), `caidofisher-${id}-${Date.now()}.txt`);
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
    const path = await import("path");
    const installDir = await this.getInstallDir();

    return new Promise((resolve) => {
      const command = args.join(" ");
      const child = spawn(command, {
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
