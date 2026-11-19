// A small JSON Schema subset, enough for tool inputs, with the checking done
// here rather than trusted to the client: a model may send anything.

/** One property of a tool's input. */
export interface PropertySchema {
  readonly type: "string" | "boolean" | "integer";
  readonly description: string;
  readonly enum?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly maxLength?: number;
}

/** A tool's input: an object with named properties and nothing else. */
export interface ObjectSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, PropertySchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

/** The input was wrong; the message says how, in terms a model can act on. */
export class ToolInputError extends Error {
  /**
   * Create the error.
   *
   * @param message - What was wrong with the arguments, in terms a model can act on.
   */
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/**
 * Check a tool's arguments against its schema.
 *
 * @param schema - The tool's input schema.
 * @param input - What the client sent.
 * @returns The arguments, typed as the schema says.
 * @throws {ToolInputError} Listing every problem.
 */
export const validateArgs = (schema: ObjectSchema, input: unknown): Record<string, unknown> => {
  const given = input ?? {};
  if (typeof given !== "object" || Array.isArray(given))
    throw new ToolInputError("The arguments must be a JSON object.");
  const args = given as Record<string, unknown>;
  const problems: string[] = [];
  for (const name of schema.required ?? [])
    if (args[name] === undefined) problems.push(`"${name}" is required`);
  for (const [name, value] of Object.entries(args)) {
    const property = schema.properties[name];
    if (!property) {
      problems.push(
        `"${name}" is not a known argument (known: ${Object.keys(schema.properties).join(", ") || "none"})`,
      );
      continue;
    }
    if (value === undefined) continue;
    const bad = check(property, value);
    if (bad) problems.push(`"${name}" ${bad}`);
  }
  if (problems.length > 0) throw new ToolInputError(`Invalid arguments: ${problems.join("; ")}.`);
  return args;
};

const check = (property: PropertySchema, value: unknown): string | undefined => {
  switch (property.type) {
    case "string":
      if (typeof value !== "string") return "must be a string";
      if (property.enum && !property.enum.includes(value))
        return `must be one of ${property.enum.join(", ")}`;
      if (property.maxLength !== undefined && value.length > property.maxLength)
        return `must be at most ${String(property.maxLength)} characters`;
      return undefined;
    case "boolean":
      return typeof value === "boolean" ? undefined : "must be true or false";
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return "must be a whole number";
      if (property.minimum !== undefined && value < property.minimum)
        return `must be at least ${String(property.minimum)}`;
      if (property.maximum !== undefined && value > property.maximum)
        return `must be at most ${String(property.maximum)}`;
      return undefined;
  }
};
