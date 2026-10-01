import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

export const PACKAGE_ENV_PATH = fileURLToPath(
  new URL("../../.env", import.meta.url),
);

export function loadPackageEnv(
  load: (path: string) => void = loadEnvFile,
): boolean {
  try {
    load(PACKAGE_ENV_PATH);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}
