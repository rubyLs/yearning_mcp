/** JSON → Markdown 渲染辅助 */

const STATUS_MARKS: Record<string, string> = {
  running: "🔄",
  executing: "🔄",
  succeeded: "✅",
  success: "✅",
  complete: "✅",
  failed: "❌",
  terminated: "⏹️",
  suspending: "⏸️",
  suspended: "⏸️",
  pending: "⏳",
  initializing: "⏳",
  "2": "⏳",
  "1": "🔄",
  "0": "❌",
  "3": "✅",
  "4": "⏹️",
  "5": "🔄",
  "6": "↩️",
};

export function toJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function fmtStatus(value: unknown): string {
  const s = String(value ?? "");
  const mark = STATUS_MARKS[s] || STATUS_MARKS[s.toLowerCase()];
  return mark ? `${mark} ${s}` : s;
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    const text = JSON.stringify(v);
    return text.length <= 120 ? text : text.slice(0, 117) + "...";
  }
  return String(v).replace(/\n/g, " ");
}

export function renderKv(title: string, data: Record<string, unknown>): string {
  const out = title
    ? [`# ${title}`, "", "| 属性 | 值 |", "|------|-----|"]
    : ["| 属性 | 值 |", "|------|-----|"];
  for (const [k, v] of Object.entries(data)) {
    if (k.startsWith("_")) continue;
    let val: unknown = v;
    if (
      (k.toLowerCase().endsWith("status") || k.toLowerCase().endsWith("phase")) &&
      typeof v === "string"
    ) {
      val = fmtStatus(v);
    }
    out.push(`| ${k} | ${cell(val)} |`);
  }
  return out.join("\n");
}

export function renderList(
  title: string,
  rows: unknown[],
  columns: Array<[string, string]>,
  total?: unknown,
): string {
  const countLine =
    total !== undefined && total !== null ? `共 ${total} 条` : `共 ${rows.length} 条`;
  const headers = columns.map(([, h]) => h);
  const lines = [
    `# ${title}`,
    "",
    countLine,
    "",
    "| " + headers.join(" | ") + " |",
    "|" + headers.map(() => "------").join("|") + "|",
  ];

  for (const r of rows || []) {
    const row = r && typeof r === "object" ? (r as Record<string, unknown>) : {};
    const cells = columns.map(([field]) => {
      let v = row[field] ?? "";
      if ((field === "status" || field === "phase") && typeof v === "string") {
        v = fmtStatus(v);
      }
      return cell(v);
    });
    lines.push("| " + cells.join(" | ") + " |");
  }
  if (!rows?.length) lines.push("（无数据）");
  return lines.join("\n");
}
