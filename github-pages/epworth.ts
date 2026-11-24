export const epworthHeading = String.raw`(?:Epworth(?: Sleepiness| Sleep)? (?:Scale|Score)(?:\s*\(ESS\))?|ESS(?: (?:Total(?: Score)?|Score))?)`;
const heading = new RegExp(String.raw`\b${epworthHeading}[ \t]*(?:[:=–-][ \t]*|(?=\r?\n|\d))`, "i");
const prompt = /^How likely (?:is the patient|are you) to doze (?:off )?in the (?:following situations|situations below)\s*[:?]/i;
const ratings: Record<string, number> = { none: 0, slight: 1, moderate: 2, high: 3 };
const score = /^(\d{1,2})(?:\s*\/\s*24)?(?=\s|[.;,]|$)(?![ \t]*[/\d]|[.,]\d|[ \t]*[-–]\s*\d)/;

export function extractEpworth(text: string): string | undefined {
  const normalized = text.replace(/\u00a0/g, " ").replace(/\r\n?/g, "\n");
  const title = heading.exec(normalized);
  const start = title ? title.index + title[0].length : normalized.search(new RegExp(prompt.source, "im"));
  if (start < 0) return;
  const body = normalized.slice(start).trimStart();
  const direct = score.exec(body);
  if (direct) return Number(direct[1]) <= 24 ? direct[0].trim() : undefined;

  const lines = body.replace(prompt, "$&\n").replace(/[ \t]+(?=[-•]\s+)/g, "\n")
    .replace(/[ \t]+((?:total(?: score)?|score)\s*:)/gi, "\n$1").split("\n");
  const answers: string[] = [];
  let introduction = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || /^page \d+(?: (?:of|\/) \d+)?$/i.test(line)) continue;
    if (prompt.test(line)) { introduction = line; continue; }
    const total = /^(?:total(?: score)?|score)\s*:\s*/i.exec(line);
    if (total) {
      const value = score.exec(line.slice(total[0].length) || lines[i + 1]?.trim() || "");
      if (value && Number(value[1]) <= 24) answers.push(total[0].trim() + " " + value[0].trim());
      break;
    }
    // Only questionnaire answers can extend the section into another line or page.
    if (!/^(?:[-•]\s*|(?:sitting|watching|as a passenger|lying|in a car|as a driver|riding|reading|stopped in traffic)\b)/i.test(line)) break;
    let item = line;
    const answer = /:\s*(None|Slight|Moderate|High|[0-3])(?:\s*\([0-3]\))?\s*$/i;
    while (!answer.test(item) && i + 1 < lines.length && !/^\s*[-•]/.test(lines[i + 1]) &&
           (!lines[i + 1].includes(":") || answer.test(lines[i + 1]))) {
      item += " " + lines[++i].trim();
    }
    const match = answer.exec(item);
    if (!match) break;
    const rating = match[1].toLowerCase();
    answers.push(rating in ratings && !item.endsWith(")") ? item + " (" + ratings[rating] + ")" : item);
  }
  return answers.length ? [introduction, ...answers].filter(Boolean).join("\n") : undefined;
}
