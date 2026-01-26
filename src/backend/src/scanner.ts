import type { SDK } from "caido:plugin";
import type {
  Finding,
  ScanResult,
  KingfisherRawFinding,
} from "../../shared/types";

const BATCH_SIZE = 100; // Kingfisher handles large batches efficiently
const MAX_PARALLEL_BATCHES = 3; // Process up to 3 batches concurrently
const SCAN_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 300_000; // 5 minutes for download/install

/**
 * Kingfisher binary integration for Kingfisher plugin.
 * Handles detection, installation, and execution.
 */
export class KingfisherScanner {
  private binaryPath: string | null = null;
  private version: string | null = null;
  private outputFormatSupported: boolean | null = null;

  private async detectCapabilities(sdk: SDK, binary: string) {
    if (this.outputFormatSupported === true) return;

    try {
      const result = await this.exec([`"${binary}"`, "scan", "--help"]);
      const helpOutput = result.stdout + result.stderr;
      // Check for --format or -f flag (not --output-format)
      this.outputFormatSupported = helpOutput.includes("--format") || helpOutput.includes("-f,");
      sdk.console.log(`[Kingfisher] Detected CLI capabilities: formatSupported=${this.outputFormatSupported}`);
    } catch (e) {
      this.outputFormatSupported = false;
      sdk.console.warn(`[Kingfisher] Failed to detect CLI capabilities: ${e}`);
    }
  }

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

      // Get version (quote path for Windows compatibility)
      const result = await this.exec([`"${this.binaryPath}"`, "--version"]);
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
    sdk.console.log("[Kingfisher] Attempting to install/upgrade Kingfisher binary...");
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
        this.outputFormatSupported = null; // Reset capabilities to force re-detection
        const newVersion = await this.getVersion();
        sdk.console.log(`[Kingfisher] Kingfisher installed successfully at ${installed} (v${newVersion})`);
        return { success: true, output: `Successfully installed Kingfisher v${newVersion}\n\n${output}` };
      }

      return { success: false, output: `Installation failed: binary not found after script execution\n\n${output}` };
    } catch (error: any) {
      const msg = error instanceof Error ? error.message : String(error);
      sdk.console.error("[Kingfisher] Kingfisher installation failed:", msg);
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

      sdk.console.log(`[Kingfisher] Downloading Kingfisher from ${downloadUrl}...`);
      const downloadCmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference = 'SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${downloadUrl}' -OutFile '${zipPath}' -UseBasicParsing"`;
      
      const downloadResult = await this.exec([downloadCmd], INSTALL_TIMEOUT_MS);
      if (downloadResult.exitCode !== 0) {
        throw new Error(`Download failed (code ${downloadResult.exitCode}): ${downloadResult.stderr || downloadResult.stdout}`);
      }

      sdk.console.log("[Kingfisher] Extracting Kingfisher archive...");
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
      
      sdk.console.log(`[Kingfisher] Moving binary to ${targetBinary}...`);
      // Move binary
      await writeFile(targetBinary, await readFile(extractedBinary));
      
      try {
        const { unlink, rm } = await import("fs/promises");
        await unlink(zipPath);
        await rm(extractDir, { recursive: true, force: true });
      } catch (e) {
        sdk.console.warn(`[Kingfisher] Cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      this.binaryPath = targetBinary;
      this.version = null;
      const newVersion = await this.getVersion();
      
      return { success: true, output: `Successfully installed Kingfisher v${newVersion} for Windows.` };
    } catch (error: any) {
      const msg = error instanceof Error ? error.message : String(error);
      sdk.console.error("[Kingfisher] Windows installation failed:", msg);
      return { success: false, output: `Windows installation failed: ${msg}` };
    }
  }

  /**
   * Scan multiple requests for secrets
   */
  async scan(sdk: SDK, requestIds: string[]): Promise<ScanResult[]> {
    sdk.console.log(`[Kingfisher] Starting scan of ${requestIds.length} request(s)`);
    const results: ScanResult[] = [];

    // Ensure binary is available
    const binary = await this.ensureBinary(sdk);
    if (!binary) {
      sdk.console.error("[Kingfisher] Scanning aborted: binary unavailable");
      return requestIds.map((id) => ({
        requestId: id,
        findings: [],
        error: "Kingfisher binary not found and could not be installed",
        duration: 0,
      }));
    }

    // Split into batches
    const batches: string[][] = [];
    for (let i = 0; i < requestIds.length; i += BATCH_SIZE) {
      batches.push(requestIds.slice(i, i + BATCH_SIZE));
    }

    // Process batches in parallel (limited concurrency)
    for (let i = 0; i < batches.length; i += MAX_PARALLEL_BATCHES) {
      const parallelBatches = batches.slice(i, i + MAX_PARALLEL_BATCHES);
      const batchPromises = parallelBatches.map(batch => this.scanBatch(sdk, binary, batch));
      const batchResultsArray = await Promise.all(batchPromises);
      for (const batchResults of batchResultsArray) {
        results.push(...batchResults);
      }
    }

    const totalFindings = results.reduce((sum, r) => sum + r.findings.length, 0);
    sdk.console.log(`[Kingfisher] Scan completed. Found ${totalFindings} finding(s) total.`);
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
    let outputFilePath: string | null = null;

    try {
      // Ensure capabilities are detected
      await this.detectCapabilities(sdk, binary);

      // Create temp files for each request in parallel
      const tempFilePromises = requestIds.map(async (id) => {
        const record = await sdk.requests.get(id);
        if (!record) {
          return { id, tempPath: null, error: "Request not found" };
        }

        const request = record.request;
        const response = record.response;

        // Combine request and response data
        const rawRequest = request.getRaw().toText();
        const rawResponse = response ? response.getRaw().toText() : "";
        const data = `${rawRequest}\n\n${rawResponse}`;

        // Write to temp file
        const tempPath = await this.writeTempFile(sdk, id, data);
        return { id, tempPath, error: null };
      });

      const tempFileResults = await Promise.all(tempFilePromises);
      
      for (const result of tempFileResults) {
        if (result.error || !result.tempPath) {
          results.push({
            requestId: result.id,
            findings: [],
            error: result.error || "Failed to create temp file",
            duration: 0,
          });
        } else {
          tempFiles.set(result.tempPath, result.id);
        }
      }

      if (tempFiles.size === 0) {
        return results;
      }

      // Run Kingfisher
      const args = [`"${binary}"`, "scan"];
      
      const path = await import("path");
      outputFilePath = path.join(await this.getTempDir(), `kingfisher-output-${Date.now()}.txt`);
      args.push("--output", `"${outputFilePath}"`);

      if (this.outputFormatSupported) {
        args.push("--format", "json");
      }
      
      args.push(...Array.from(tempFiles.keys()).map(p => `"${p}"`));

      sdk.console.log(`[Kingfisher] Executing Kingfisher: ${args.join(" ")}`);
      const execResult = await this.exec(args, SCAN_TIMEOUT_MS);
      sdk.console.log(`[Kingfisher] Kingfisher finished with code ${execResult.exitCode}`);
      
      let finalStdout = execResult.stdout;
      if (outputFilePath) {
        const { readFile } = await import("fs/promises");
        try {
          finalStdout = await readFile(outputFilePath, "utf-8");
        } catch (e) {
          sdk.console.error(`[Kingfisher] Failed to read output file ${outputFilePath}: ${e}`);
        }
      }

      if (execResult.stdout && this.outputFormatSupported) {
        sdk.console.log(`[Kingfisher] Kingfisher STDOUT (first 1000 chars): ${execResult.stdout.substring(0, 1000)}`);
      }

      if (execResult.stderr) {
        sdk.console.warn(`[Kingfisher] Kingfisher STDERR: ${execResult.stderr}`);
      }

      let rawFindings = this.parseOutput(finalStdout);
      sdk.console.log(`[Kingfisher] Parsed ${rawFindings.length} findings from JSON output`);

      // If no findings parsed from JSON, try parsing pretty output as fallback
      // Detect pretty format by looking for emoji markers or the Findings line
      const hasPrettyFormat = /[🔓🔒]/.test(finalStdout) || /\|Finding\.+:/.test(finalStdout);
      if (rawFindings.length === 0 && hasPrettyFormat) {
        sdk.console.log(`[Kingfisher] Detected pretty format output, using fallback parser`);
        const fallbackFindings = this.parsePrettyOutput(finalStdout);
        sdk.console.log(`[Kingfisher] Fallback parser found ${fallbackFindings.length} findings`);
        if (fallbackFindings.length > 0) {
          rawFindings = fallbackFindings;
        }
      }

      // Combined output for debugging
      const combinedOutput = `STDOUT:\n${execResult.stdout}\n\nSTDERR:\n${execResult.stderr}${outputFilePath ? `\n\nOUTPUT FILE CONTENT:\n${finalStdout}` : ""}`;

      // Map findings back to request IDs
      const findingsByPath = new Map<string, KingfisherRawFinding[]>();
      for (const raw of rawFindings) {
        const path = raw.finding.path;
        const existing = findingsByPath.get(path) || [];
        existing.push(raw);
        findingsByPath.set(path, existing);
      }

      // Build results in parallel
      const duration = Date.now() - startTime;
      const resultPromises = Array.from(tempFiles.entries()).map(async ([tempPath, requestId]) => {
        const rawFindingsForRequest = findingsByPath.get(tempPath) || [];
        const record = await sdk.requests.get(requestId);
        const url = record?.request?.getUrl() || "unknown";
        const method = record?.request?.getMethod() || "GET";

        const findings: Finding[] = rawFindingsForRequest.map((raw) =>
          this.transformFinding(raw, requestId, url, method)
        );

        return {
          requestId,
          findings,
          duration,
          rawOutput: combinedOutput,
        };
      });

      const builtResults = await Promise.all(resultPromises);
      results.push(...builtResults);

      // Cleanup temp files in parallel
      const cleanupPromises = Array.from(tempFiles.keys()).map(p => this.deleteTempFile(p));
      if (outputFilePath) {
        cleanupPromises.push(this.deleteTempFile(outputFilePath));
      }
      await Promise.all(cleanupPromises);

      return results;
    } catch (error: unknown) {
      const duration = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Cleanup temp files on error (parallel)
      const errorCleanupPromises = Array.from(tempFiles.keys()).map(p => this.deleteTempFile(p));
      if (outputFilePath) {
        errorCleanupPromises.push(this.deleteTempFile(outputFilePath));
      }
      await Promise.all(errorCleanupPromises).catch(() => {});

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

  private parsePrettyOutput(text: string): KingfisherRawFinding[] {
    const findings: KingfisherRawFinding[] = [];
    const lines = text.split(/\r?\n/);
    
    let currentFinding: any = null;

    for (const line of lines) {
      // Match start of a new finding (e.g., "🔓 JSON WEB TOKEN (BASE64URL-ENCODED) => [KINGFISHER.JWT.1]")
      // Allow optional whitespace before the emoji
      const ruleMatch = line.match(/^\s*[🔓🔒]\s+(.+?)\s+=>\s+\[(.+?)\]/);
      if (ruleMatch) {
        // Push previous finding if valid
        if (currentFinding && currentFinding.finding.snippet && currentFinding.finding.path) {
          findings.push(currentFinding);
        }
        currentFinding = {
          rule: {
            id: ruleMatch[2].trim(),
            name: ruleMatch[1].trim(),
          },
          finding: {
            snippet: "",
            path: "",
            confidence: "medium",
          }
        };
        continue;
      }

      // Also try matching without emoji (e.g., if emoji got stripped)
      // Pattern: "RULE_NAME => [RULE.ID]"
      const ruleMatchNoEmoji = line.match(/^\s*([A-Z][A-Z0-9 _().-]+)\s+=>\s+\[([A-Z0-9_.]+)\]/i);
      if (ruleMatchNoEmoji && !currentFinding) {
        currentFinding = {
          rule: {
            id: ruleMatchNoEmoji[2].trim(),
            name: ruleMatchNoEmoji[1].trim(),
          },
          finding: {
            snippet: "",
            path: "",
            confidence: "medium",
          }
        };
        continue;
      }

      if (!currentFinding) continue;

      // Match property lines (e.g., " |Finding.......: eyJhbGci...")
      // Pattern: optional space, pipe, key with dots, colon, value
      const propertyMatch = line.match(/^\s*\|([A-Za-z_]+)\.+:\s*(.*)$/);
      if (propertyMatch) {
        const key = propertyMatch[1].trim().toLowerCase();
        const value = propertyMatch[2].trim();

        if (key === "finding") {
          currentFinding.finding.snippet = value;
        } else if (key === "path") {
          currentFinding.finding.path = value;
        } else if (key === "confidence") {
          currentFinding.finding.confidence = value.toLowerCase();
        } else if (key === "fingerprint") {
          currentFinding.finding.fingerprint = value;
        } else if (key === "validation") {
          currentFinding.finding.validation = {
            status: value.toLowerCase().includes("active") || value.toLowerCase().includes("valid") ? "valid" : "invalid",
            response: ""
          };
        }
        continue;
      }

      // Match nested property lines (e.g., " |__Response....: ...")
      const nestedMatch = line.match(/^\s*\|__([A-Za-z_]+)\.+:\s*(.*)$/);
      if (nestedMatch && currentFinding) {
        const key = nestedMatch[1].trim().toLowerCase();
        const value = nestedMatch[2].trim();
        if (key === "response" && currentFinding.finding.validation) {
          currentFinding.finding.validation.response = value;
        }
      }
    }

    // Push the last finding if valid
    if (currentFinding && currentFinding.finding.snippet && currentFinding.finding.path) {
      findings.push(currentFinding);
    }

    return findings;
  }

  private async findBinary(): Promise<string | null> {
    const fs = await import("fs");
    const { access: accessPromise, stat } = await import("fs/promises");
    const path = await import("path");
    
    // Check if already cached and still exists
    if (this.binaryPath) {
      try {
        await accessPromise(this.binaryPath);
        return this.binaryPath;
      } catch {
        this.binaryPath = null; // Reset cache if file no longer exists
      }
    }

    const name = await this.getBinaryName();
    const isWindows = await this.getIsWindows();
    const searchPaths: string[] = [];
    
    // Add local install dir to search paths
    searchPaths.push(await this.getInstallDir());

    for (const p of searchPaths) {
      const fullPath = path.join(p, name);
      try {
        // On Windows, just check if file exists and is a file
        // On Unix, check for execute permission
        if (isWindows) {
          const stats = await stat(fullPath);
          if (stats.isFile()) {
            return fullPath;
          }
        } else {
          await accessPromise(fullPath, fs.constants.X_OK);
          return fullPath;
        }
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
    sdk.console.log("[Kingfisher] Kingfisher binary not found, attempting installation...");
    try {
      const result = await this.installKingfisher(sdk);
      if (result.success) {
        return this.binaryPath;
      }
    } catch (error) {
      sdk.console.error("[Kingfisher] Kingfisher installation failed:", error);
    }

    return null;
  }

  private async writeTempFile(sdk: SDK, id: string, data: string): Promise<string> {
    const { writeFile } = await import("fs/promises");
    const path = await import("path");
    const tempPath = path.join(await this.getTempDir(), `kingfisher-${id}-${Date.now()}.txt`);
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
