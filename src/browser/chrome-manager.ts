import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export type ChromeSession = {
  process: ChildProcess;
  port: number;
  cdpUrl: string;
  userDataDir: string;
  close: () => Promise<void>;
};

export type ChromeOptions = {
  headless: boolean;
  startUrl?: string;
};

export async function startChrome(options: ChromeOptions): Promise<ChromeSession> {
  const chromePath = resolveChromePath();
  const port = await getFreePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-change-verifier-profile-"));
  const cdpUrl = `http://127.0.0.1:${port}`;

  const args = [
    options.headless ? "--headless=new" : "",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-popup-blocking",
    "--no-first-run",
    "--no-default-browser-check",
    options.startUrl ?? "about:blank"
  ].filter(Boolean);

  const child = spawn(chromePath, args, {
    stdio: "ignore",
    windowsHide: true,
    detached: process.platform !== "win32"
  });

  await waitForCDP(cdpUrl, 15000);

  return {
    process: child,
    port,
    cdpUrl,
    userDataDir,
    close: async () => {
      if (!child.killed) child.kill();
      await new Promise((resolve) => setTimeout(resolve, 500));
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  };
}

function resolveChromePath(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          path.join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
        ]
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];

  const found = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (!found) {
    throw new Error("Chrome executable not found. Set CHROME_PATH in your environment.");
  }
  return found;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a local port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForCDP(cdpUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const version = await httpGetJson(`${cdpUrl}/json/version`);
      if (version.webSocketDebuggerUrl) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Chrome CDP endpoint did not become ready at ${cdpUrl}: ${String(lastError)}`);
}

function httpGetJson(url: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body) as Record<string, unknown>);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(500, () => {
      req.destroy(new Error(`Timeout fetching ${url}`));
    });
  });
}
