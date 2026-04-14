export function shellEscape(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function buildFooterCommand(template: string, input: string): string {
  const escaped = shellEscape(input);
  if (template.includes("${input}")) {
    return template.split("${input}").join(escaped);
  }
  return `${template} ${escaped}`;
}
