import type { AppConfig } from "../config.js";
import { YearningClient } from "./rest.js";

export { YearningApiError, YearningAuthError } from "./errors.js";
export { YearningClient } from "./rest.js";

let singleton: YearningClient | null = null;

export function getYearningClient(config: AppConfig["yearning"]): YearningClient {
  if (!singleton) {
    singleton = new YearningClient(config);
  }
  return singleton;
}

export function resetYearningClient(): void {
  singleton = null;
}
