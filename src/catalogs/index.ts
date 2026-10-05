import { CreditCatalog } from "../credit.types";

/** The catalog JSON selected for this SDK build. */
function loadBundledCatalog(): CreditCatalog {
  try {
    return require("./catalog.json") as CreditCatalog;
  } catch (error) {
    const missingBundledCatalog =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "MODULE_NOT_FOUND";
    if (!missingBundledCatalog) throw error;

    // Source-tree fallback; profile packages contain catalog.json instead.
    return require("./catalog.kyc.json") as CreditCatalog;
  }
}

export const catalog = loadBundledCatalog();
