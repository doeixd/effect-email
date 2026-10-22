import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const require = createRequire(import.meta.url)
const root = process.cwd()
const dist = join(root, "dist")

rmSync(dist, { recursive: true, force: true })
execFileSync(
  process.execPath,
  [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.build.json"],
  { stdio: "inherit" }
)

const withExtension = (specifier) =>
  /\.(js|mjs|cjs|json|node)$/.test(specifier)
    ? specifier
    : `${specifier}.js`

const rewrite = (file) => {
  const source = readFileSync(file, "utf8")
  const next = source.replace(
    /(["'])(\.\.?\/[^"']*)\1/g,
    (match, quote, specifier) =>
      `${quote}${withExtension(specifier)}${quote}`
  )
  if (next !== source) {
    writeFileSync(file, next)
  }
}

const visit = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      visit(path)
    } else if (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts")) {
      rewrite(path)
    }
  }
}

visit(dist)
