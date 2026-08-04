/** Yearning 客户端错误类型 */

export class YearningAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YearningAuthError";
  }
}

export class YearningApiError extends Error {
  readonly code: number;

  constructor(message: string, code = 0) {
    super(`[${code}] ${message}`);
    this.name = "YearningApiError";
    this.code = code;
    this.message = message;
  }
}
