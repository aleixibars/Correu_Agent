// Reading a Google API answer: both the Gmail API and the OAuth token endpoint
// report a failure as JSON, in one of a handful of shapes, so one pair of
// helpers serves the whole `./` directory.

export const readJson = async (
  response: Response,
): Promise<Record<string, unknown>> => {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/**
 * The reason Google gives, whichever shape it comes in: `error_description`
 * (token endpoint), a plain `error` string (OAuth) or `error.message` (Gmail).
 */
export const errorDetail = (body: Record<string, unknown>): string => {
  const { error, error_description: description } = body;
  if (typeof description === "string") return description;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return "unknown error";
};
