import { epworthHeading, extractEpworth } from "./epworth";

type FollowUpFields = { sleepQuestionnaire?: string; ess?: string; allergies?: string; socialHistory?: string };

const socialHeading = "(?:Patient reports the following social history|Social History|SHx)";
const intakeSectionLabels = [
  "(?:Past )?(?:Medical|Surgical) History", "PMHx?", "PSHx?", "Sleep Questionnaire",
  "Family (?:Medical )?History", "FHx?", "Patient has had a sleep study",
  "(?:Active |Current )?Medications", "(?:(?:Medication|Drug) )?Allergies", epworthHeading,
  "Weight Health", "Vitals", "Review of Systems", "Assessment", "Plan", "Recent Symptoms", "Objective",
  "Daytime (?:&|and) Nighttime Experiences(?: \\(PLATO\\))?", "Since Last Visit", "Therapy Usage",
].join("|");
const intakeHistoryEndLabels = [intakeSectionLabels, socialHeading].join("|");

function intakeSectionPattern(heading: string, endLabels: string, preamble = "") {
  // PDF.js may emit two labeled fields on one line, or put the heading on a line of its own.
  return new RegExp(
    String.raw`(?:\b(?:${heading})[ \t]*:|(?:^|\n)[ \t]*(?:${heading})[ \t]*(?=\r?\n))${preamble}([\s\S]*?)` +
    String.raw`(?=\n[ \t]*(?:${endLabels})[ \t]*(?::|\r?\n|$)|\s+(?:${endLabels})[ \t]*:|$)`, "i",
  );
}
const allergySection = intakeSectionPattern("(?:(?:Medication|Drug) )?Allergies", intakeHistoryEndLabels,
  String.raw`(?:\s*The patient is allergic to the following medications[ \t]*:)?`);
// The form can put marital status and a second social-history question inside the same section.
const socialSection = intakeSectionPattern(socialHeading, intakeSectionLabels);
const sleepSection = intakeSectionPattern("Sleep Questionnaire", intakeHistoryEndLabels);

export function parseFollowUp(text: string, kind: "intake" | "cpap"): FollowUpFields {
  const normalized = text.replace(/[\u00a0 \t]+/g, " ");
  const readSection = (pattern: RegExp) => pattern.exec(normalized)?.[1]
    ?.split(/\r?\n/).map(line => line.trim()).filter(Boolean).join("\n") || undefined;
  const ess = extractEpworth(normalized);
  const sleepQuestionnaire = readSection(sleepSection);
  if (kind === "intake") {
    return { ess, sleepQuestionnaire, allergies: readSection(allergySection), socialHistory: readSection(socialSection) };
  }
  const fields: FollowUpFields = {};
  if (ess) fields.ess = ess;
  if (sleepQuestionnaire) fields.sleepQuestionnaire = sleepQuestionnaire;
  return fields;
}
