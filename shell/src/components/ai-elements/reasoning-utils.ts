export function extractThinking(content: string): {
  thinking: string;
  rest: string;
} {
  const thinkingMatch = content.match(
    /^<thinking>\n?([\s\S]*?)\n?<\/thinking>\n?/,
  );
  if (thinkingMatch) {
    return {
      thinking: thinkingMatch[1],
      rest: content.slice(thinkingMatch[0].length),
    };
  }
  return { thinking: "", rest: content };
}
