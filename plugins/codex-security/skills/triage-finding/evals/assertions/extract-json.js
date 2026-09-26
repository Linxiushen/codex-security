module.exports = function extractJson(output, schemaVersion) {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  const fencedBlocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) =>
    match[1].trim(),
  );
  const candidates = fencedBlocks.length > 0 ? fencedBlocks : [text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && parsed.schema_version === schemaVersion) {
        return parsed;
      }
    } catch {
      // Keep trying other candidates.
    }
  }

  throw new Error(`Could not find a parseable ${schemaVersion} JSON block.`);
};
