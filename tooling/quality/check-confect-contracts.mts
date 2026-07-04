import { access, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { descriptorFor } from "./src/check-definitions.mts";
import { isDirectRun } from "./src/direct-run.mts";
import { runStaticCheck } from "./src/gate.mts";

export const descriptor = descriptorFor("confect-contracts");

export type ConfectContractFinding = {
  readonly file: string;
  readonly message: string;
};

const requiredGeneratedFiles = [
  "packages/convex/confect/_generated/refs.ts",
  "packages/convex/confect/_generated/spec.ts",
  "packages/template-core/src/generated/confectManifest.ts",
] as const;

const publicSpecConstructors = [
  "publicQuery",
  "publicMutation",
  "publicAction",
  // Confect node public actions have appeared under this local constructor
  // spelling in plan work; keep it explicit until the upstream API settles.
  "nodePublicAction",
] as const;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function walk(root: string, dir: string): Promise<string[]> {
  const fullDir = join(root, dir);
  if (!(await exists(fullDir))) return [];

  const files: string[] = [];
  const entries = await readdir(fullDir, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = join(fullDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(root, relative(root, entryPath))));
    } else if (entry.isFile()) {
      files.push(relative(root, entryPath));
    }
  }

  return files;
}

function findBalancedCallObject(
  source: string,
  openBraceIndex: number,
): string | undefined {
  let depth = 0;
  let quote: '"' | "'" | "`" | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = openBraceIndex; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (current === "\n") lineComment = false;
      continue;
    }

    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === quote) {
        quote = undefined;
      }
      continue;
    }

    if (current === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }

    if (current === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }

    if (current === '"' || current === "'" || current === "`") {
      quote = current;
      continue;
    }

    if (current === "{") depth += 1;
    if (current === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBraceIndex, index + 1);
    }
  }

  return undefined;
}

export function publicSpecMissingError(source: string): string | undefined {
  for (const constructor of publicSpecConstructors) {
    const pattern = new RegExp(
      `FunctionSpec\\.${constructor}\\s*\\(\\s*\\{`,
      "g",
    );

    for (const match of source.matchAll(pattern)) {
      const openBraceIndex = match.index + match[0].lastIndexOf("{");
      const input = findBalancedCallObject(source, openBraceIndex);

      if (input !== undefined && !/\berror\s*:/.test(input)) {
        return `Public Confect ${constructor} must declare a typed error with \`error:\`.`;
      }
    }
  }

  return undefined;
}

export function ambientDateNow(source: string): string | undefined {
  return /\bDate\s*\.\s*now\s*\(/.test(source)
    ? "Confect impls must not use ambient Date.now(); inject or derive time from typed inputs."
    : undefined;
}

export function plainConvexValueImports(source: string): string | undefined {
  const importPattern =
    /import\s+(?!type\b)([\s\S]*?)\s+from\s+["']convex\/[^"']+["']/g;

  for (const match of source.matchAll(importPattern)) {
    const importClause = match[1].trim();
    const namedImport = importClause.match(/\{([\s\S]*?)\}/);
    if (!namedImport) {
      return "Confect specs must keep convex/* imports type-only for plain Convex component functions.";
    }

    const valueImports = namedImport[1]
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .filter((part) => !part.startsWith("type "));

    if (valueImports.length > 0) {
      return "Confect specs must keep convex/* imports type-only for plain Convex component functions.";
    }
  }

  return undefined;
}

export function requiredGeneratedFilesMissing(
  files: ReadonlySet<string>,
): readonly string[] {
  return requiredGeneratedFiles
    .filter((file) => !files.has(file))
    .map((file) => `${file}: required generated Confect file is missing.`);
}

export async function collectConfectContractFindings(
  repoRoot = process.cwd(),
): Promise<readonly ConfectContractFinding[]> {
  const findings: ConfectContractFinding[] = [];
  const allFiles = await walk(repoRoot, "packages/convex/confect");
  const knownFiles = new Set(
    [
      ...allFiles,
      ...(await Promise.all(
        requiredGeneratedFiles.map(async (file) =>
          (await exists(join(repoRoot, file))) ? file : undefined,
        ),
      )),
    ].filter((file): file is string => file !== undefined),
  );

  for (const message of requiredGeneratedFilesMissing(knownFiles)) {
    const [file] = message.split(":");
    findings.push({ file, message });
  }

  for (const file of allFiles.filter((path) => path.endsWith(".spec.ts"))) {
    const source = await readFile(join(repoRoot, file), "utf8");
    const importMessage = plainConvexValueImports(source);
    const errorMessage = publicSpecMissingError(source);

    if (importMessage) findings.push({ file, message: importMessage });
    if (errorMessage) findings.push({ file, message: errorMessage });
  }

  for (const file of allFiles.filter((path) => path.endsWith(".impl.ts"))) {
    const source = await readFile(join(repoRoot, file), "utf8");
    const message = ambientDateNow(source);
    if (message) findings.push({ file, message });
  }

  return findings;
}

export async function runConfectContractCheck(
  repoRoot = process.cwd(),
): Promise<void> {
  await runStaticCheck(descriptor, repoRoot);

  if (process.exitCode !== undefined && process.exitCode !== 0) return;

  const findings = await collectConfectContractFindings(repoRoot);
  if (findings.length === 0) {
    console.log(`${descriptor.name}: ok (semantic)`);
    return;
  }

  for (const finding of findings) {
    console.error(`${descriptor.name}: ${finding.file}: ${finding.message}`);
  }
  process.exitCode = 1;
}

if (isDirectRun(import.meta.url)) await runConfectContractCheck();
