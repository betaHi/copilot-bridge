import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

interface PackageJson {
  name?: string
  version?: string
}

const PACKAGE_NAME = "betahi-copilot-bridge"

const readPackageVersion = (): string => {
  let currentDir = dirname(fileURLToPath(import.meta.url))

  while (true) {
    try {
      const packageJsonPath = resolve(currentDir, "package.json")
      const packageJson = JSON.parse(
        readFileSync(packageJsonPath, "utf8"),
      ) as PackageJson

      if (
        packageJson.name === PACKAGE_NAME
        && typeof packageJson.version === "string"
      ) {
        return packageJson.version
      }
    } catch {
      // Keep walking upward; source and dist builds sit at different depths.
    }

    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) {
      return "unknown"
    }

    currentDir = parentDir
  }
}

export const BRIDGE_VERSION = readPackageVersion()
