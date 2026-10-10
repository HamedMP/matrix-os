import { validUrl } from "./shared.mjs";

function cronSummary(fields) {
  const [minute, hour, day, month, weekday] = fields;
  const time = /^\d+$/.test(minute) && /^\d+$/.test(hour) ? `At ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}` : `Minute ${minute}, hour ${hour}`;
  const weekdayText = { "*": "every day of the week", "0": "Sunday", "1": "Monday", "2": "Tuesday", "3": "Wednesday", "4": "Thursday", "5": "Friday", "6": "Saturday", "7": "Sunday", "1-5": "Monday through Friday" }[weekday] ?? `weekday ${weekday}`;
  const date = day === "*" && month === "*" ? `on ${weekdayText}` : `on day ${day}, month ${month}, ${weekdayText}`;
  return `${time} ${date}.`;
}

export function agentTool(slug, input) {
  switch (slug) {
    case "agents-md-checker": {
      const headings = [...input.matchAll(/^#{1,3} .+$/gm)].map((match) => match[0]);
      const feedback = [`Headings: ${headings.length}`, `Characters: ${input.length}`];
      if (!headings.length) feedback.push("Add a clear top-level heading.");
      if (!/\b(test|verify|check)\b/i.test(input)) feedback.push("Consider explaining how to verify changes.");
      if (!/\b(security|secret|safe|permission)\b/i.test(input)) feedback.push("Consider adding safety and credential guidance.");
      if (input.length > 20_000) feedback.push("This file may be too long for routine agent context.");
      return feedback.join("\n");
    }
    case "mcp-config-validator": {
      let config; try { config = JSON.parse(input); } catch (error) { reportToolFailure(error); throw new Error("Enter valid JSON."); }
      const servers = config?.mcpServers;
      if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("Add an mcpServers object.");
      const entries = Object.entries(servers);
      if (entries.length > 100) throw new Error("Use no more than 100 MCP servers.");
      const problems = [];
      for (const [name, server] of entries) {
        if (!server || typeof server !== "object" || Array.isArray(server)) { problems.push(`${name}: expected an object`); continue; }
        if (typeof server.command !== "string" && typeof server.url !== "string") problems.push(`${name}: add command or url`);
        if (typeof server.url === "string") {
          try { validUrl(server.url); } catch (error) { reportToolFailure(error); problems.push(`${name}: URL must be HTTP or HTTPS`); }
        }
        if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== "string"))) problems.push(`${name}: args must be strings`);
      }
      if (problems.length) throw new Error(problems.join("\n"));
      return `${entries.length} MCP server${entries.length === 1 ? "" : "s"} checked.\nCommon structure looks valid.`;
    }
    case "prompt-token-estimator": {
      const chars = [...input].length, words = input.trim().split(/\s+/).length;
      return `Approximate tokens: ${Math.ceil(chars / 4)}\nWords: ${words}\nCharacters: ${chars}\nModel tokenizers vary; this is an estimate.`;
    }
    case "cron-expression-explainer": {
      const fields = input.trim().split(/\s+/);
      if (fields.length !== 5) throw new Error("Enter a five-field cron expression.");
      const names = ["Minute", "Hour", "Day of month", "Month", "Day of week"], max = [59, 23, 31, 12, 7], min = [0, 0, 1, 1, 0];
      fields.forEach((field, index) => {
        for (const part of field.split(",")) {
          const match = part.match(/^(\*|\d+|\d+-\d+)(?:\/(\d+))?$/);
          if (!match) throw new Error(`${names[index]} has unsupported syntax.`);
          if (match[2] && Number(match[2]) < 1) throw new Error(`${names[index]} step must be at least 1.`);
          const values = match[1].match(/\d+/g)?.map(Number) ?? [];
          if (values.some((value) => value < min[index] || value > max[index])) throw new Error(`${names[index]} is out of range.`);
          if (values.length === 2 && values[0] > values[1]) throw new Error(`${names[index]} range is reversed.`);
        }
      });
      return `${cronSummary(fields)}\n${fields.map((field, index) => `${names[index]}: ${field}`).join("\n")}\nCheck timezone and next runs in your scheduler.`;
    }
    default: throw new Error("Unknown agent tool.");
  }
}
import { reportToolFailure } from "./diagnostics.mjs";
