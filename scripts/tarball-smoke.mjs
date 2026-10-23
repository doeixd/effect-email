import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync
} from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const root = process.cwd()
const sourcePackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const work = join(root, ".tarball-smoke")
let tarball
const npm = (args) =>
  process.platform === "win32"
    ? execFileSync(
        process.env.ComSpec ?? "cmd.exe",
        ["/d", "/s", "/c", ["npm", ...args].join(" ")],
        { cwd: root, encoding: "utf8" }
      )
    : execFileSync("npm", args, { cwd: root, encoding: "utf8" })

rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

try {
  execFileSync(process.execPath, ["scripts/build.mjs"], {
    cwd: root,
    stdio: "inherit"
  })
  const packed = JSON.parse(
    npm(["pack", "--json", "--ignore-scripts"])
  )
  tarball = join(root, packed[0].filename)
  execFileSync("tar", ["-xzf", tarball, "-C", work], {
    cwd: root
  })

  const packageRoot = join(work, "package")
  const pkg = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8")
  )
  if (pkg.name !== sourcePackage.name || pkg.version !== sourcePackage.version) {
    throw new Error("packaged name/version differs from the release manifest")
  }
  for (const target of Object.values(pkg.exports)) {
    if (!existsSync(join(packageRoot, target))) {
      throw new Error(`missing packaged export target: ${target}`)
    }
    if (target.endsWith(".js") && !existsSync(join(packageRoot, target.replace(/\.js$/, ".d.ts")))) {
      throw new Error(`missing packaged declarations: ${target}`)
    }
  }

  const readme = readFileSync(join(packageRoot, "README.md"), "utf8")
  for (const match of readme.matchAll(/\]\((\.\.?\/[^)#]+)(?:#[^)]*)?\)/g)) {
    if (!existsSync(join(packageRoot, match[1]))) {
      throw new Error(`missing README-linked package content: ${match[1]}`)
    }
  }
  for (let migration = 1; migration <= 8; migration++) {
    const prefix = String(migration).padStart(4, "0") + "_"
    if (!packed[0].files.some(({ path }) => path.startsWith(`migrations/${prefix}`))) {
      throw new Error(`missing packaged migration: ${prefix}`)
    }
  }

  const modules = [
    "dist/index.js",
    "dist/providers/Resend.js",
    "dist/server/Gateway.js",
    "dist/workflow/Submissions.js",
    "dist/smtp/Node.js"
  ]
  for (const module of modules) {
    await import(pathToFileURL(join(packageRoot, module)).href)
  }

  console.log("tarball smoke test passed")
} finally {
  rmSync(work, { recursive: true, force: true })
  if (tarball !== undefined) {
    rmSync(tarball, { force: true })
  }
}
