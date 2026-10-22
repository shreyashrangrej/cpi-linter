import JSZip from "jszip";
import type { ArtifactRef, ArtifactSummary, SourceFile } from "./types";

export interface ExtractedPackage {
  package?: { id?: string; name?: string; version?: string; description?: string };
  artifacts: ArtifactSummary[];
  files: SourceFile[];
  warnings: string[];
}

export const LIMITS = {
  maxDepth: 4,
  maxEntries: 20_000,
  maxTotalBytes: 300 * 1024 * 1024,
  maxTextFileBytes: 10 * 1024 * 1024,
};

/** Extensions we read as text and lint. */
const TEXT_EXTENSIONS = new Set([
  "iflw",
  "groovy",
  "gsh",
  "gy",
  "js",
  "prop",
  "properties",
  "xml",
  "xsl",
  "xslt",
  "mmap",
  "json",
  "txt",
  "yaml",
  "yml",
  "env",
  "edmx",
  "wsdl",
]);

const BUNDLE_TYPES: Record<string, string> = {
  IntegrationFlow: "IFlow",
  ScriptCollection: "ScriptCollection",
  MessageMapping: "MessageMapping",
  ValueMapping: "ValueMapping",
};

export const extensionOf = (path: string) => {
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
};

const isZip = (b: Uint8Array) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

const isBinary = (b: Uint8Array) => {
  const n = Math.min(b.length, 8000);
  for (let i = 0; i < n; i++) if (b[i] === 0) return true;
  return false;
};

const utf8 = new TextDecoder("utf-8");
const decodeText = (b: Uint8Array) => utf8.decode(b).replace(/^﻿/, "");

class Budget {
  entries = 0;
  bytes = 0;
  charge(entries: number, bytes: number) {
    this.entries += entries;
    this.bytes += bytes;
    if (this.entries > LIMITS.maxEntries) throw new Error(`Archive has more than ${LIMITS.maxEntries} entries.`);
    if (this.bytes > LIMITS.maxTotalBytes)
      throw new Error(`Archive expands to more than ${LIMITS.maxTotalBytes / 1024 / 1024} MB; refusing to continue.`);
  }
}

interface Entry {
  path: string;
  bytes: Uint8Array;
}

async function readZip(bytes: Uint8Array, budget: Budget): Promise<Entry[]> {
  const zip = await JSZip.loadAsync(bytes);
  const files = Object.values(zip.files).filter((f) => !f.dir);
  budget.charge(files.length, 0);
  const entries: Entry[] = [];
  for (const f of files) {
    const data = await f.async("uint8array");
    budget.charge(0, data.length);
    entries.push({ path: f.name.replace(/\\/g, "/").replace(/^\/+/, ""), bytes: data });
  }
  return entries;
}

function parseManifest(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let last = "";
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(" ") && last) out[last] += line.slice(1);
    else {
      const i = line.indexOf(":");
      if (i > 0) {
        last = line.slice(0, i).trim();
        out[last] = line.slice(i + 1).trim();
      }
    }
  }
  return out;
}

/** resources.cnt is base64-encoded JSON (older exports: plain JSON). */
function parseResourcesCnt(bytes: Uint8Array): Record<string, unknown> | null {
  const raw = decodeText(bytes).trim();
  const candidates = [raw];
  try {
    const bin = atob(raw.replace(/\s+/g, ""));
    candidates.push(decodeText(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch {
    /* not base64 */
  }
  for (const c of candidates) {
    try {
      const json = JSON.parse(c);
      if (json && typeof json === "object") return json as Record<string, unknown>;
    } catch {
      /* try next */
    }
  }
  return null;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/**
 * Turn the entries of one artifact (an iFlow zip, a script collection zip, ...)
 * into lintable source files.
 */
function artifactFromEntries(entries: Entry[], ref: ArtifactRef, warnings: string[]): { summary: ArtifactSummary; files: SourceFile[] } {
  const manifestEntry = entries.find((e) => /(^|\/)META-INF\/MANIFEST\.MF$/i.test(e.path));
  if (manifestEntry) {
    const mf = parseManifest(decodeText(manifestEntry.bytes));
    const bundleType = BUNDLE_TYPES[mf["SAP-BundleType"] ?? ""];
    if (bundleType && (ref.type === "Unknown" || !ref.type)) ref.type = bundleType;
    if (!ref.name || ref.name === ref.id) ref.name = mf["Bundle-Name"] || mf["Bundle-SymbolicName"]?.split(";")[0] || ref.name;
    if (!ref.version && mf["Bundle-Version"]) ref.version = mf["Bundle-Version"];
  }

  const files: SourceFile[] = [];
  for (const e of entries) {
    const ext = extensionOf(e.path);
    if (!TEXT_EXTENSIONS.has(ext)) continue;
    if (e.bytes.length > LIMITS.maxTextFileBytes) {
      warnings.push(`Skipped ${ref.name}/${e.path}: larger than ${LIMITS.maxTextFileBytes / 1024 / 1024} MB.`);
      continue;
    }
    if (isBinary(e.bytes)) continue;
    files.push({ artifact: ref, path: e.path, text: decodeText(e.bytes) });
  }

  if (ref.type === "Unknown" && files.some((f) => f.path.endsWith(".iflw"))) ref.type = "IFlow";

  return {
    summary: {
      ...ref,
      files: files.map((f) => f.path),
      iflows: files.filter((f) => f.path.endsWith(".iflw")).length,
      scripts: files.filter((f) => ["groovy", "gsh", "gy", "js"].includes(extensionOf(f.path))).length,
    },
    files,
  };
}

export async function extractPackage(input: Uint8Array | ArrayBuffer, fileName: string): Promise<ExtractedPackage> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const warnings: string[] = [];
  const budget = new Budget();
  const baseName = fileName.replace(/\.[^.]+$/, "");

  // A loose file (.iflw, .groovy, ...) rather than an archive
  if (!isZip(bytes)) {
    const ref: ArtifactRef = { id: fileName, name: fileName, type: fileName.endsWith(".iflw") ? "IFlow" : "File" };
    const { summary, files } = artifactFromEntries([{ path: fileName, bytes }], ref, warnings);
    if (files.length === 0) throw new Error(`Unsupported file type: ${fileName}. Upload a CPI package/iFlow .zip, .iflw or .groovy file.`);
    return { artifacts: [summary], files, warnings };
  }

  const top = await readZip(bytes, budget);
  const artifacts: ArtifactSummary[] = [];
  const files: SourceFile[] = [];
  const pushArtifact = (r: { summary: ArtifactSummary; files: SourceFile[] }) => {
    artifacts.push(r.summary);
    files.push(...r.files);
  };

  const expand = async (entry: Entry, ref: ArtifactRef, depth: number) => {
    if (depth > LIMITS.maxDepth) {
      warnings.push(`Skipped ${entry.path}: nested deeper than ${LIMITS.maxDepth} levels.`);
      return;
    }
    let inner: Entry[];
    try {
      inner = await readZip(entry.bytes, budget);
    } catch (e) {
      if (/refusing|entries/.test((e as Error).message)) throw e;
      warnings.push(`Could not open ${entry.path} as a zip archive: ${(e as Error).message}`);
      return;
    }
    // artifacts don't normally contain zips, but bundles of exports do
    const nested = inner.filter((e) => isZip(e.bytes) && !e.path.endsWith(".jar"));
    if (nested.length && !inner.some((e) => e.path.endsWith(".iflw") || /MANIFEST\.MF$/i.test(e.path))) {
      for (const n of nested) await expand(n, { id: n.path, name: n.path.replace(/\.zip$/i, ""), type: "Unknown" }, depth + 1);
      return;
    }
    pushArtifact(artifactFromEntries(inner, ref, warnings));
  };

  const cntEntry = top.find((e) => e.path === "resources.cnt" || e.path.endsWith("/resources.cnt"));
  let pkg: ExtractedPackage["package"];

  if (cntEntry) {
    // ── Integration package export ──
    const cnt = parseResourcesCnt(cntEntry.bytes);
    const resources = (Array.isArray(cnt?.resources) ? cnt.resources : []) as Record<string, unknown>[];
    if (!cnt) warnings.push("resources.cnt could not be decoded; artifact names may be missing.");

    const pkgInfo = resources.find((r) => r.resourceType === "ContentPackage") ?? cnt ?? {};
    pkg = {
      id: str(pkgInfo.id) ?? str(pkgInfo.technicalName),
      name: str(pkgInfo.displayName) ?? str(pkgInfo.name) ?? baseName,
      version: str(pkgInfo.version),
      description: str(pkgInfo.shortText) ?? str(pkgInfo.description),
    };

    const used = new Set<Entry>([cntEntry]);
    for (const r of resources) {
      const id = str(r.id);
      if (!id || r.resourceType === "ContentPackage") continue;
      const free = top.filter((e) => !used.has(e));
      const entry = free.find((e) => e.path === `${id}_content`) ?? free.find((e) => e.path.startsWith(id));
      if (!entry) continue;
      used.add(entry);
      const ref: ArtifactRef = {
        id: str(r.uniqueId) ?? id,
        name: str(r.displayName) ?? str(r.name) ?? id,
        type: str(r.resourceType) ?? "Unknown",
        version: str(r.version) ?? str(r.semanticVersion),
      };
      if (isZip(entry.bytes)) await expand(entry, ref, 1);
      else pushArtifact(artifactFromEntries([{ path: str(r.name) ?? entry.path, bytes: entry.bytes }], ref, warnings));
    }
    // anything resources.cnt didn't describe
    for (const e of top) {
      if (used.has(e) || !isZip(e.bytes)) continue;
      await expand(e, { id: e.path, name: e.path.replace(/_content$/, ""), type: "Unknown" }, 1);
    }
  } else if (top.some((e) => e.path.endsWith(".iflw") || /(^|\/)META-INF\/MANIFEST\.MF$/i.test(e.path))) {
    // ── Single artifact export (Download from the iFlow editor) ──
    pushArtifact(artifactFromEntries(top, { id: baseName, name: baseName, type: "Unknown" }, warnings));
  } else {
    // ── A zip of exports, or a zip of loose sources ──
    for (const e of top.filter((x) => isZip(x.bytes))) {
      await expand(e, { id: e.path, name: e.path.replace(/\.zip$/i, "").split("/").pop()!, type: "Unknown" }, 1);
    }
    const loose = top.filter((x) => !isZip(x.bytes));
    if (loose.length) {
      const r = artifactFromEntries(loose, { id: baseName, name: baseName, type: "Unknown" }, warnings);
      if (r.files.length) pushArtifact(r);
    }
  }

  if (files.length === 0) warnings.push("No lintable files (.iflw, .groovy, .js, parameters.prop, ...) were found in the archive.");
  return { package: pkg, artifacts, files, warnings };
}
