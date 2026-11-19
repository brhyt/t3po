export function selectedArtifactPaths(text: string): readonly string[] {
  return [
    ...new Set(
      text
        .split("\n")
        .map((path) => path.trim())
        .filter(Boolean),
    ),
  ];
}
