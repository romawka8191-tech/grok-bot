import { execFile } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { promisify } from "util";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ComputerFile, ComputerState } from "./types";

const execFileAsync = promisify(execFile);

const ROOT = process.env.VERCEL ? path.join("/tmp", "grok-bot") : process.cwd();
export const WORKSPACE = path.resolve(ROOT, "computer/workspace");
export const DATA_DIR = path.resolve(ROOT, ".data");
const STATE_PATH = path.join(DATA_DIR, "computer.json");

export function resolveSafe(rel = ""): string {
  const cleaned = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  const rooted = cleaned === "" || cleaned === "workspace" ? "" : cleaned.replace(/^workspace\/?/, "");
  const abs = path.resolve(WORKSPACE, rooted);
  const root = path.resolve(WORKSPACE);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error("Path escapes the shared workspace");
  }
  return abs;
}

export function toRel(abs: string): string {
  const rel = path.relative(WORKSPACE, abs).split(path.sep).join("/");
  return rel ? `/workspace/${rel}` : "/workspace";
}

export async function ensureWorkspace(): Promise<void> {
  await fs.mkdir(WORKSPACE, { recursive: true });
  await fs.mkdir(path.join(WORKSPACE, "inbox"), { recursive: true });
  await fs.mkdir(path.join(WORKSPACE, "projects"), { recursive: true });
  await fs.mkdir(path.join(WORKSPACE, "drafts"), { recursive: true });
  await fs.mkdir(DATA_DIR, { recursive: true });
  const welcome = path.join(WORKSPACE, "README.md");
  try {
    await fs.access(welcome);
  } catch {
    await fs.writeFile(
      welcome,
      `# Shared computer

This is the shared workspace. Every teammate on this account can see these files.

Keep durable work in project folders. Treat anything outside \`/workspace\` as replaceable.
`,
      "utf8"
    );
  }
}

export async function listDir(rel = ""): Promise<ComputerFile[]> {
  await ensureWorkspace();
  let abs = resolveSafe(rel);
  const st = await fs.stat(abs);
  if (st.isFile()) abs = path.dirname(abs);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const out: ComputerFile[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(abs, e.name);
    const st = await fs.stat(p);
    out.push({
      name: e.name,
      path: toRel(p),
      type: e.isDirectory() ? "dir" : "file",
      size: e.isDirectory() ? undefined : st.size,
      modified: st.mtimeMs,
    });
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return out;
}

export async function readFileSafe(rel: string): Promise<string> {
  const abs = resolveSafe(rel);
  const st = await fs.stat(abs);
  if (st.isDirectory()) throw new Error("Path is a directory");
  if (st.size > 1_500_000) throw new Error("File is too large to open here");
  return fs.readFile(abs, "utf8");
}

export async function writeFileSafe(rel: string, content: string): Promise<string> {
  await ensureWorkspace();
  const abs = resolveSafe(rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  return toRel(abs);
}

export async function mkdirSafe(rel: string): Promise<string> {
  const abs = resolveSafe(rel);
  await fs.mkdir(abs, { recursive: true });
  return toRel(abs);
}

export async function deleteSafe(rel: string): Promise<void> {
  const abs = resolveSafe(rel);
  if (abs === path.resolve(WORKSPACE)) throw new Error("Cannot delete the workspace root");
  await fs.rm(abs, { recursive: true, force: true });
}

const BLOCKED = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\b/,
  /\bsudo\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\bcurl\s+[^\n]*\|\s*(sh|bash)/,
];

export async function execInWorkspace(command: string): Promise<{ stdout: string; stderr: string; code: number }> {
  await ensureWorkspace();
  if (BLOCKED.some((r) => r.test(command))) {
    return { stdout: "", stderr: "That command is blocked on the shared computer.", code: 126 };
  }
  try {
    const { stdout, stderr } = await execFileAsync("bash", ["-lc", command], {
      cwd: WORKSPACE,
      timeout: 20_000,
      maxBuffer: 1024 * 400,
      env: { ...process.env, HOME: WORKSPACE, TERM: "xterm-256color" },
    });
    return { stdout: stdout.slice(0, 12_000), stderr: stderr.slice(0, 4_000), code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      stdout: String(e.stdout || "").slice(0, 12_000),
      stderr: String(e.stderr || e.message || "Command failed").slice(0, 4_000),
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

function isPublicIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split(".").map(Number);
    const [a, b, c] = octets;
    if (octets.length !== 4 || octets.some((n) => n < 0 || n > 255)) return false;
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (version === 6) {
    const ip = address.toLowerCase();
    if (ip === "::" || ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") ||
        ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") ||
        ip.startsWith("feb") || ip.startsWith("ff")) return false;
    const mapped = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPublicIp(mapped[1]) : true;
  }
  return false;
}

async function assertPublicHttpUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http(s) URLs are allowed");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") ||
      host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("Private network addresses are not allowed");
  }
  const version = isIP(host);
  const addresses = version ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => !isPublicIp(entry.address))) {
    throw new Error("Private or non-public network addresses are not allowed");
  }
}

export async function browseUrl(url: string): Promise<{ title: string; text: string; url: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }

  let res: Response | undefined;
  for (let redirects = 0; redirects <= 5; redirects++) {
    await assertPublicHttpUrl(parsed);
    res = await fetch(parsed.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(12_000),
      headers: { "User-Agent": "open-teammate-bots/0.1 (+shared-computer)" },
    });
    if (![301, 302, 303, 307, 308].includes(res.status)) break;
    const location = res.headers.get("location");
    if (!location || redirects === 5) throw new Error("Too many or invalid redirects");
    parsed = new URL(location, parsed);
  }

  if (!res || !res.ok) throw new Error(`Page request failed: ${res?.status || "unknown"}`);
  const contentType = res.headers.get("content-type") || "";
  if (!/text\/(html|plain)|application\/(json|xml|xhtml\+xml)/i.test(contentType)) {
    throw new Error("Only HTML, text, JSON, and XML pages can be opened");
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("The page returned an empty response");
  const decoder = new TextDecoder();
  let html = "";
  let bytes = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 1_000_000) {
      await reader.cancel();
      throw new Error("Page is too large (1 MB maximum)");
    }
    html += decoder.decode(value, { stream: true });
  }
  html += decoder.decode();

  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || parsed.hostname)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 8_000);
  return { title, text, url: parsed.toString() };
}

export function defaultComputerState(): ComputerState {
  return {
    status: "idle",
    app: "desktop",
    cwd: "/workspace",
    url: "",
    termLines: [
      { kind: "out", text: "Shared computer · workspace at /workspace" },
      { kind: "out", text: "Type a command, or ask a Bot to use the terminal." },
    ],
  };
}

export async function readComputerState(): Promise<ComputerState> {
  await ensureWorkspace();
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    return { ...defaultComputerState(), ...JSON.parse(raw) };
  } catch {
    return defaultComputerState();
  }
}

export async function writeComputerState(partial: Partial<ComputerState>): Promise<ComputerState> {
  const prev = await readComputerState();
  const next = { ...prev, ...partial };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
}

export type SavedSettings = {
  apiKey?: string;
  theme?: string;
  accountName?: string;
  activeProvider?: string;
  providers?: Record<string, { key?: string; model?: string; baseUrl?: string }>;
  pluginCreds?: Record<string, Record<string, string>>;
};

export async function readSettingsFile(): Promise<SavedSettings> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    return JSON.parse(await fs.readFile(path.join(DATA_DIR, "settings.json"), "utf8"));
  } catch {
    return {};
  }
}

export async function writeSettingsFile(data: Record<string, unknown>): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const prev = await readSettingsFile();
  await fs.writeFile(path.join(DATA_DIR, "settings.json"), JSON.stringify({ ...prev, ...data }, null, 2), "utf8");
}

export function resolveApiKey(headerKey?: string | null): string | undefined {
  return headerKey || process.env.XAI_API_KEY || undefined;
}

export async function resolveApiKeyAsync(headerKey?: string | null): Promise<string | undefined> {
  if (headerKey) return headerKey;
  if (process.env.XAI_API_KEY) return process.env.XAI_API_KEY;
  const s = await readSettingsFile();
  return s.apiKey || s.providers?.xai?.key || undefined;
}
