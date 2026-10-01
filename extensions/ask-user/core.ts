export interface QuestionOption {
  label: string;
  description?: string;
}

export interface UserQuestion {
  id: string;
  label: string;
  question: string;
  mode: "single" | "multiple";
  options: QuestionOption[];
}

export interface SelectedAnswer {
  label: string;
  custom: boolean;
}

export interface QuestionAnswer {
  id: string;
  question: string;
  skipped: boolean;
  answers: SelectedAnswer[];
}

export interface AskUserResult {
  questions: UserQuestion[];
  answers: QuestionAnswer[];
  cancelled: boolean;
}

export interface RawQuestion {
  id: string;
  label?: string;
  question: string;
  mode?: "single" | "multiple";
  options?: QuestionOption[];
}

export function normalizeQuestions(rawQuestions: RawQuestion[]): UserQuestion[] {
  if (rawQuestions.length === 0) throw new Error("At least one question is required");

  const ids = new Set<string>();
  return rawQuestions.map((raw, index) => {
    const id = raw.id.trim();
    const question = raw.question.trim();
    if (!id) throw new Error(`Question ${index + 1} requires an id`);
    if (ids.has(id)) throw new Error(`Duplicate question id: ${id}`);
    if (!question) throw new Error(`Question ${id} requires question text`);
    ids.add(id);

    const labels = new Set<string>();
    const options = (raw.options ?? []).map((option) => {
      const label = option.label.trim();
      if (!label) throw new Error(`Question ${id} has an empty option`);
      if (labels.has(label)) {
        throw new Error(`Question ${id} has duplicate option: ${label}`);
      }
      labels.add(label);
      return {
        label,
        description: option.description?.trim() || undefined,
      };
    });

    return {
      id,
      label: raw.label?.trim() || `Q${index + 1}`,
      question,
      mode: raw.mode ?? "single",
      options,
    };
  });
}

export function formatAskUserResult(result: AskUserResult): string {
  if (result.cancelled) return "User cancelled the questionnaire";

  return result.answers
    .map((answer) => {
      if (answer.skipped) return `${answer.id}: skipped`;
      const values = answer.answers
        .map((value) => (value.custom ? `${value.label} (free text)` : value.label))
        .join(", ");
      return `${answer.id}: ${values || "no answer"}`;
    })
    .join("\n");
}
