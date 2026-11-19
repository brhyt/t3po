export const BETA_VERSION: string;
export const SERVICE: string;
export function validateRevision(revision: string | undefined): string;
export function shellQuote(value: string): string;
export function serviceDefinition(
  platform: string,
  node: string,
  script: string,
  home: string,
): string;
