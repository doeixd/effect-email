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
  for (const target of Object.values(pkg.exports)) {
    if (!existsSync(join(packageRoot, target))) {
      throw new Error(`missing packaged export target: ${target}`)
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
