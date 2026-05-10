#!/usr/bin/env bun

import { file } from "bun";
import { randomBytes } from "crypto";
import { mkdirSync, appendFileSync, existsSync } from "fs";
import { hostname } from "os";
import { join, basename, dirname } from "path";

export const ENV_KEY = "RECHROME_URL";
export const DEFAULT_PORT = 13775;
export const RECH_DIR = join(import.meta.dir, ".rech");
export const LOG_DIR = join(RECH_DIR, "logs");

const envFile = join(import.meta.dir, ".env.local");

async function loadEnvFile(path: string): Promise<boolean> {
  const envRaw = await file(path).text().catch(() => "");
  if (!envRaw) return false;
  let hasKey = false;
  for (const line of envRaw.split("\n")) {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (m) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      if (m[1] === ENV_KEY) hasKey = true;
    }
  }
  return hasKey;
}

async function loadEnv() {
  // Walk up from cwd first — project-local .env.local takes priority
  let dir = process.cwd();
  while (true) {
    if (await loadEnvFile(join(dir, ".env.local"))) break;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to script dir's .env.local
  if (!process.env[ENV_KEY]) await loadEnvFile(envFile);
}
// Shell-set passthrough vars survive .env.local loading
const _shellPassthrough: Record<string, string> = {};
for (const k of ["PLAYWRIGHT_MCP_EXTENSION_ID","PLAYWRIGHT_MCP_EXTENSION_TOKEN","PLAYWRIGHT_MCP_PROFILE_DIRECTORY","PLAYWRIGHT_MCP_USER_DATA_DIR"] as const) {
  if (process.env[k]) _shellPassthrough[k] = process.env[k]!;
}
await loadEnv();
Object.assign(process.env, _shellPassthrough);

import { watch } from "node:fs";
if (existsSync(envFile)) {
  watch(envFile, async () => {
    log(".env.local changed, reloading");
    await loadEnv();
  });
}


export const PASSTHROUGH_ENV_KEYS = [
  "PLAYWRIGHT_MCP_EXTENSION_ID",
  "PLAYWRIGHT_MCP_EXTENSION_TOKEN",
  "PLAYWRIGHT_MCP_PROFILE_DIRECTORY",
  "PLAYWRIGHT_MCP_USER_DATA_DIR",
] as const;

export function log(msg: string) {
  mkdirSync(LOG_DIR, { recursive: true });
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  console.error(line.trimEnd());
  const logFile = join(LOG_DIR, `${ts.slice(0, 10)}.log`);
  appendFileSync(logFile, line);
}

export function parseUrl(raw: string) {
  const u = new URL(raw);
  const scheme = u.protocol.replace(":", "");
  const protocol = scheme === "https" ? "https" : "http";
  const defaultPort = scheme === "https" ? 443 : scheme === "http" ? 80 : DEFAULT_PORT;
  return {
    key: u.username,
    host: u.hostname,
    port: parseInt(u.port) || defaultPort,
    protocol,
    extensionId: u.searchParams.get("extension_id") ?? undefined,
    extensionToken: u.searchParams.get("token") ?? undefined,
    profileDirectory: u.searchParams.get("profile") ?? undefined,
    userDataDir: u.searchParams.get("user_data_dir") ?? undefined,
  };
}

export async function getOrCreateUrl(): Promise<string> {
  if (process.env[ENV_KEY]) return process.env[ENV_KEY];
  const key = randomBytes(9).toString("base64url"); // 12 chars
  const url = `http://${key}@${hostname()}:${DEFAULT_PORT}`;
  const newLine = `${ENV_KEY}=${url}`;
  const envRaw = await file(envFile)
    .text()
    .catch(() => "");
  const content = envRaw.trimEnd() ? envRaw.trimEnd() + "\n" + newLine + "\n" : newLine + "\n";
  Bun.write(envFile, content);
  process.env[ENV_KEY] = url;
  return url;
}

export function authCheck(req: Request, key: string): Response | null {
  const bearer = req.headers.get("authorization")?.replace("Bearer ", "");
  if (bearer !== key) return new Response("Unauthorized", { status: 401 });
  return null;
}

async function getClientIdentity(): Promise<{ gitUrl?: string; hostname?: string; cwd?: string }> {
  const cwd = process.cwd();
  try {
    const remoteProc = Bun.spawn(["git", "remote", "get-url", "origin"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const remoteUrl = (await new Response(remoteProc.stdout).text()).trim();
    await remoteProc.exited;

    const branchProc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const branch = (await new Response(branchProc.stdout).text()).trim();
    await branchProc.exited;

    if (remoteUrl) {
      let gitUrl: string;
      const sshMatch = remoteUrl.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
      const httpsMatch = remoteUrl.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
      if (sshMatch) {
        gitUrl = `https://${sshMatch[1]}/${sshMatch[2]}`;
      } else if (httpsMatch) {
        gitUrl = `https://${httpsMatch[1]}/${httpsMatch[2]}`;
      } else {
        gitUrl = remoteUrl.replace(/\.git$/, "");
      }
      if (branch) gitUrl += `/tree/${branch}`;
      // Strip any embedded credentials from the URL
      try {
        const u = new URL(gitUrl);
        u.username = "";
        u.password = "";
        gitUrl = u.toString();
      } catch {}
      return { gitUrl };
    }
  } catch {}
  return { hostname: hostname(), cwd };
}

function getClientEnv(urlExtras?: { extensionId?: string; extensionToken?: string; profileDirectory?: string; userDataDir?: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (urlExtras?.extensionId)
    env["PLAYWRIGHT_MCP_EXTENSION_ID"] = urlExtras.extensionId;
  if (urlExtras?.extensionToken)
    env["PLAYWRIGHT_MCP_EXTENSION_TOKEN"] = urlExtras.extensionToken;
  if (urlExtras?.profileDirectory)
    env["PLAYWRIGHT_MCP_PROFILE_DIRECTORY"] = urlExtras.profileDirectory;
  if (urlExtras?.userDataDir)
    env["PLAYWRIGHT_MCP_USER_DATA_DIR"] = urlExtras.userDataDir;
  return env;
}

const CHROME_LOCAL_STATE_PATHS = () => {
  const home = process.env.HOME || "~";
  return [
    join(home, "Library/Application Support/Google/Chrome/Local State"),
    join(home, ".config/google-chrome/Local State"),
    join(home, "AppData/Local/Google/Chrome/User Data/Local State"),
  ];
};

async function readChromeProfileCache(): Promise<Record<string, { user_name?: string; name?: string }> | null> {
  for (const statePath of CHROME_LOCAL_STATE_PATHS()) {
    const f = file(statePath);
    if (!(await f.exists())) continue;
    try {
      const data = JSON.parse(await f.text());
      return data?.profile?.info_cache ?? null;
    } catch {}
  }
  return null;
}

async function findChromeUserDataDir(): Promise<string | null> {
  for (const statePath of CHROME_LOCAL_STATE_PATHS()) {
    if (!(await file(statePath).exists())) continue;
    return dirname(statePath);
  }
  return null;
}

export const EXTENSION_DIST_DIR = join(
  import.meta.dir,
  "lib/playwright-multi-tab/lib/playwright-mcp/packages/extension/dist",
);

// Walk all Chrome profiles' Secure Preferences and find an extension
// whose loaded `path` matches our dist directory. The extension ID Chrome
// generates for an unpacked extension is path-dependent, so we cannot rely
// on a hardcoded ID across machines.
async function findInstalledExtension(
  profileDir?: string,
): Promise<{ id: string; profile: string } | null> {
  const userDataDir = await findChromeUserDataDir();
  if (!userDataDir) return null;
  const cache = await readChromeProfileCache();
  const profiles = profileDir ? [profileDir] : (cache ? Object.keys(cache) : []);
  for (const prof of profiles) {
    const prefsPath = join(userDataDir, prof, "Secure Preferences");
    const f = file(prefsPath);
    if (!(await f.exists())) continue;
    try {
      const data = JSON.parse(await f.text());
      const settings = data?.extensions?.settings ?? {};
      for (const [extId, info] of Object.entries(settings as Record<string, any>)) {
        if (info?.path === EXTENSION_DIST_DIR) return { id: extId, profile: prof };
      }
    } catch {}
  }
  return null;
}

function printInstallInstructions(profileDisplay: string): void {
  console.error("");
  console.error("Multi-tab extension is not installed in this Chrome profile.");
  console.error("");
  console.error("To install:");
  console.error("  1. Open chrome://extensions/ in the selected profile");
  console.error(`     (profile: ${profileDisplay})`);
  console.error("  2. Enable \"Developer mode\" (top-right toggle)");
  console.error("  3. Click \"Load unpacked\"");
  console.error("  4. Select this directory:");
  console.error(`       ${EXTENSION_DIST_DIR}`);
  console.error("  5. Re-run `rech setup`");
  console.error("");
}

async function resolveProfileEmail(dir: string): Promise<string> {
  const cache = await readChromeProfileCache();
  if (cache?.[dir]?.user_name) return cache[dir].user_name;
  return dir;
}

async function listProfiles(): Promise<void> {
  const cache = await readChromeProfileCache();
  if (!cache) { console.error("Chrome Local State not found"); process.exit(1); }

  const current = process.env.PLAYWRIGHT_MCP_PROFILE_DIRECTORY;
  // Resolve email/name → dir for current marker
  let currentDir = current;
  if (current && !/^(Default|Profile \d+)$/i.test(current)) {
    for (const [dir, info] of Object.entries(cache)) {
      if (info.user_name === current || info.name === current) { currentDir = dir; break; }
    }
  }

  const rows = Object.entries(cache).map(([dir, info]) => [
    dir,
    info.user_name || "",
    info.name || "",
    dir === currentDir ? "← current" : "",
  ]);
  const widths = rows.reduce((w, r) => r.map((c, i) => Math.max(w[i] ?? 0, c.length)), [] as number[]);
  for (const row of rows) {
    console.log(row.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd());
  }
}

async function callServe(
  url: string,
  args: string[],
  overrideEnv?: Record<string, string>,
): Promise<{ status: number; stdout: string; stderr: string; files?: string[]; existingSession?: boolean }> {
  const { key, host, port, protocol, extensionId, extensionToken, profileDirectory, userDataDir } = parseUrl(url);
  const identity = await getClientIdentity();
  const effectiveProfile = profileDirectory || process.env.PLAYWRIGHT_MCP_PROFILE_DIRECTORY;
  if (effectiveProfile) (identity as any).profile = effectiveProfile;
  const env = { ...getClientEnv({ extensionId, extensionToken, profileDirectory, userDataDir }), ...overrideEnv };
  const res = await fetch(`${protocol}://${host}:${port}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ args, identity, env }),
    signal: AbortSignal.timeout(70_000),
  }).catch((e) => { console.error(`[rech] ${e.message}`); process.exit(1); });
  if (res.status === 401) { console.error("Unauthorized: bad key"); process.exit(1); }
  return res.json();
}

async function run(url: string, args: string[]) {
  const { host, port, protocol } = parseUrl(url);
  const effectiveProfile = parseUrl(url).profileDirectory || process.env.PLAYWRIGHT_MCP_PROFILE_DIRECTORY;
  const displayProfile = effectiveProfile ? await resolveProfileEmail(effectiveProfile) : undefined;
  const identity = await getClientIdentity();
  const profileSuffix = displayProfile ? ` profile:${displayProfile}` : "";
  console.error(
    `[rech] connecting to ${host}:${port} (identity: ${identity.gitUrl || `${identity.hostname}:${identity.cwd}`}${profileSuffix})`,
  );

  const { status, stdout, stderr, files, existingSession } = await callServe(url, args);

  if (existingSession)
    console.error(`[rech] session already has open tabs — listing existing tabs instead of opening a new window`);
  if (stderr) process.stderr.write(stderr);
  if (stdout) process.stdout.write(stdout);

  if (files?.length) {
    const dlDir = join(process.cwd(), ".playwright-cli-multi-tab");
    mkdirSync(dlDir, { recursive: true });
    const gitignorePath = join(dlDir, ".gitignore");
    if (!existsSync(gitignorePath)) await Bun.write(gitignorePath, "*\n");
    for (const name of files) {
      const fileRes = await fetch(`${protocol}://${host}:${port}/files/${name}`, {
        headers: { Authorization: `Bearer ${parseUrl(url).key}` },
      });
      if (!fileRes.ok) continue;
      const dest = join(dlDir, basename(name));
      await Bun.write(dest, fileRes);
      console.error(`[rech] downloaded: ${dest}`);
    }
  }

  process.exit(status);
}

async function setup(): Promise<void> {
  // 1. Require serve to be running
  const url = process.env[ENV_KEY];
  if (!url) {
    console.error(`${ENV_KEY} not set — start the server first:\n  rech serve`);
    process.exit(1);
  }
  const { host, port, protocol } = parseUrl(url);
  const ping = await fetch(`${protocol}://${host}:${port}/`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
  if (!ping) {
    console.error(`rech serve is not running at ${host}:${port}\nStart it with:\n  rech serve`);
    process.exit(1);
  }

  // 2. Interactive profile selection
  const cache = await readChromeProfileCache();
  if (!cache) { console.error("Chrome profiles not found"); process.exit(1); }
  const profiles = Object.entries(cache);
  console.log("\nAvailable Chrome profiles:");
  profiles.forEach(([dir, info], i) =>
    console.log(`  ${String(i + 1).padStart(2)}.  ${(info.user_name || "(no email)").padEnd(32)}  ${(info.name || "").padEnd(20)}  [${dir}]`)
  );
  const { createInterface } = await import("readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(r => rl.question("\nProfile number: ", r));
  rl.close();
  const idx = parseInt(answer.trim()) - 1;
  if (isNaN(idx) || idx < 0 || idx >= profiles.length) { console.error("Invalid selection"); process.exit(1); }
  const [profileDir, profileInfoSel] = profiles[idx];
  const profileEnv = { PLAYWRIGHT_MCP_PROFILE_DIRECTORY: profileDir };
  const profileDisplay = profileInfoSel.user_name || profileInfoSel.name || profileDir;

  // 3. Discover the extension ID. Unpacked extension IDs are derived from the
  //    load path, so look up the actual ID from Chrome's Secure Preferences.
  //    Env override wins if set explicitly.
  let extId = process.env.PLAYWRIGHT_MCP_EXTENSION_ID;
  if (!extId) {
    const found = await findInstalledExtension(profileDir);
    if (found) extId = found.id;
  }

  if (!extId) {
    printInstallInstructions(profileDisplay);
    console.error("Opening chrome://extensions/ in the selected profile...");
    await callServe(url, ["open", "chrome://extensions/"], profileEnv);
    process.exit(1);
  }

  const statusUrl = `chrome-extension://${extId}/status.html`;
  console.log(`\nOpening ${statusUrl}...`);
  const openResult = await callServe(url, ["open", statusUrl], profileEnv);
  if (openResult.status !== 0) { process.stderr.write(openResult.stderr); process.exit(openResult.status); }

  // 4. Read token from extension page localStorage
  const evalResult = await callServe(url, ["eval", `() => localStorage.getItem('auth-token')`], profileEnv);
  const tokenMatch = evalResult.stdout.match(/"([A-Za-z0-9_-]{20,})"/);
  const token = tokenMatch?.[1];
  if (!token) {
    printInstallInstructions(profileDisplay);
    console.error("Tried to read the auth token from the extension's status page but failed.");
    console.error("This usually means the extension is not loaded in this profile.");
    process.exit(1);
  }

  // 5. Write single RECHROME_URL with all params to ~/.env.local
  const home = process.env.HOME!;
  const globalEnvPath = join(home, ".env.local");
  const existing = await file(globalEnvPath).text().catch(() => "");
  const rechUrl = new URL(url);
  rechUrl.searchParams.set("extension_id", extId);
  rechUrl.searchParams.set("token", token);
  // Prefer email for readability, fall back to directory name
  rechUrl.searchParams.set("profile", profileInfoSel.user_name || profileDir);
  const userDataDir = await findChromeUserDataDir();
  if (userDataDir) rechUrl.searchParams.set("user_data_dir", userDataDir);
  const newLine = `RECHROME_URL=${rechUrl.toString()}`;
  // Remove old separate vars and update RECHROME_URL
  const keysToRemove = ["PLAYWRIGHT_MCP_USER_DATA_DIR", "PLAYWRIGHT_MCP_EXTENSION_ID", "PLAYWRIGHT_MCP_EXTENSION_TOKEN", "PLAYWRIGHT_MCP_PROFILE_DIRECTORY"];
  let lines = existing.trimEnd().split("\n").filter(l => !keysToRemove.some(k => l.startsWith(`${k}=`)));
  const rechIdx = lines.findIndex(l => l.startsWith("RECHROME_URL="));
  if (rechIdx >= 0) lines[rechIdx] = newLine;
  else lines.push(newLine);
  await Bun.write(globalEnvPath, lines.join("\n").trim() + "\n");
  console.log(`\nSaved to ${globalEnvPath}:\n  ${newLine}`);
  console.log("\nDone!");
}

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args[0] === "serve") {
    const { serve } = await import("./serve.ts");
    serve();
  } else if (args[0] === "profiles") {
    await listProfiles();
  } else if (args[0] === "setup") {
    await setup();
  } else {
    const url = process.env[ENV_KEY];
    if (!url) {
      console.error(
        `Usage:\n  rech serve\n  ${ENV_KEY}=http://key@host:${DEFAULT_PORT}?extension_id=ID&token=TOKEN rech <playwright-args...>\n  ${ENV_KEY}=https://key@host/path?extension_id=ID&token=TOKEN rech <playwright-args...>`,
      );
      process.exit(1);
    }
    run(url, args);
  }
}
