import type { SlackRuleDefinition } from "@matrix-os/contracts";
const normalize = (text: string) => text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NEW_MESSAGES = /(?:every|all|ordinary|new)\s+(?:new\s+)?messages?|每条|所有.*消息|普通.*消息/u;
const OWNER_MENTION = /(?:mention(?:s|ed)?\s+me|@me|mentions?\s+of\s+me|@我|提及我)/u;
const IMMEDIATE = /\bimmediate(?:ly)?\b|立即/u;
const WINDOW = /\b(?:group|batch|coalesce|window|wait)\b|合并|聚合|窗口/u;
/** Recognized fields must consume the entire instruction. Unknown qualifiers are
 * clarification, never authorization inferred from words elsewhere in the text. */
function affirmativeFields(clause: string, definition: SlackRuleDefinition, label: string): boolean {
    // Focus is report data, not a second policy language. Conditional phrases
    // there are ambiguous too; the owner must restate an unconditional rule.
    if (/\b(?:if|unless|until|when|once|before|after|provided|pending)\b|(?:仅当|如果|除非|直到|之后|之前|批准后|确认后)/u.test(normalize(definition.focus))
        || !/\bsummariz[es]\b|整理|总结/u.test(clause)) return false;
    let rest = clause;
    const take = (pattern: RegExp) => { rest = rest.replace(pattern, " "); };
    take(/^(?:from now on|whenever|every time|always|以后|从现在起|每当)\s*/u);
    take(/^(?:create|set(?: up)?|update)\s+(?:(?:a|my|the|standing|slack|summary)\s+)*rule\b/u);
    take(/^(?:创建|更新)(?:我的)?\s*(?:slack\s*)?(?:摘要|总结)?规则/u);
    take(/(?:\bfocus(?:ing)?\s+(?:on\s+)?|重点(?:是|为|在于)?\s*)([^,;，；]+)/u);
    take(new RegExp(`(?:\\b(?:in|from|for)\\s+|把\\s*|在\\s*|来自\\s*)${escape(normalize(label))}(?![\\p{L}\\p{N}_-])`, "u"));
    const aliases = definition.language.toLowerCase() === "english" ? ["english", "英文"]
        : definition.language.toLowerCase() === "chinese" ? ["chinese", "中文"] : [normalize(definition.language)];
    const language = aliases.map(escape).join("|");
    take(new RegExp(`(?:\\b(?:in|using)\\s+|用|以)\\s*(?:${language})(?:\\s*输出)?|(?:${language})\\s+(?:summary|summaries|output)`, "u"));
    if (definition.trigger === "new_message") {
        take(/\bsummariz[es]\s+(?:every|all)\s+(?:(?:new|ordinary)\s+)?messages?\b/u);
        take(/(?:每条(?:新)?消息|所有(?:新)?消息)/u);
    } else {
        take(/\bsummariz[es]\s+(?:only\s+)?(?:messages?\s+that\s+mention\s+me|mentions?\s+of\s+me|@me)\b/u);
        take(/\b(?:teammates?|people|someone|others)\s+mentions?\s+me\b/u);
        take(/(?:有人)?(?:@我|提及我)/u);
        take(/\bsummariz[es]\b/u);
    }
    take(/(?:整理|总结)/u);
    if (definition.cadence.kind === "immediate") take(/\bimmediate(?:ly)?\b|立即/u);
    else {
        take(/\b(?:group|batch|coalesce|wait)\s+(?:each\s+thread\s+)?(?:for\s+)?\d+\s*(?:seconds?|secs?|minutes?|mins?)\b/u);
        take(/(?:合并|聚合)/u);
        take(/每\s*\d+\s*(?:秒|分钟)/u);
    }
    take(/(?:do not|don't|never)\s+(?:reply|respond|write|send(?: messages)?)\s+(?:in|to|on)\s+slack|不要回复\s*slack/u);
    return rest.replace(/[\s,:;，；：]/gu, "") === "";
}
/** Bounded supported standing-instruction grammar, not unrestricted natural-language authorization.
 * Fields must be affirmative in the first sentence; later safeguards cannot widen the trigger. */
export function permitsSlackRuleInstruction(text: string, operation: string, definition?: SlackRuleDefinition, label?: string): boolean {
    const value = normalize(text);
    if (text.length > 8000 || /[?？]|```|^\s*>/mu.test(text)
        || /\b(?:do not|don't|never)\s+(?:save|create|enable|activate|update|resume|summariz[es]|run|process)\b|\b(?:not now|forwarded|quoted)\b|不要(?:保存|创建|开启|启用|更新|恢复|整理|总结|运行)|别保存/u.test(value))
        return false;
    const prefix = value.replace(/^please\s+/u, "");
    if (["pause", "resume", "delete"].includes(operation)) {
        const verbs = { pause: "pause|stop", resume: "resume|restart", delete: "delete|remove" };
        const chinese = { pause: "暂停", resume: "恢复|继续", delete: "删除" };
        const key = operation as keyof typeof verbs;
        return new RegExp(`^(?:(?:${verbs[key]})\\s+(?:(?:my|the)\\s+)?(?:slack\\s+)?summary\\s+rule|(?:${chinese[key]})(?:我的)?\\s*(?:slack\\s*)?(?:摘要|总结)?规则)[.。]?$`, "u").test(prefix);
    }
    if (!definition || !/^(?:from now on|whenever|every time|always|summariz[es] (?:every|all) |create (?:a |my |the )?(?:standing |slack |summary )*rule|set (?:up )?(?:a |my |the )?(?:standing |slack |summary )*rule|update (?:my |the )?(?:slack |summary )*rule|以后|从现在起|每当|创建.*规则|更新.*规则)/u.test(prefix))
        return false;
    const sentences = prefix.split(/[.!?。\n]/u).map(sentence => sentence.trim()).filter(Boolean);
    const clause = sentences[0]!;
    const guard = /^(?:(?:do not|don't|never)\s+(?:reply|respond|write|send(?: messages)?)\s+(?:in|to|on)\s+slack|no slack (?:replies|writes|messages)|不要回复\s*slack)$/u;
    if (sentences.slice(1).some(sentence => !guard.test(sentence)))
        return false;
    if (label && !new RegExp(`(?<![\\p{L}\\p{N}_#-])${escape(normalize(label))}(?![\\p{L}\\p{N}_-])`, "u").test(clause))
        return false;
    if(label){
      const marker=clause.search(/\bfocus(?:ing)?\s+|重点/u);
      const sourceClause=marker<0?clause:clause.slice(0,marker);
      const channels=[...sourceClause.matchAll(/#[a-z0-9_-]+/gu)].map(match=>match[0]);
      if(label.startsWith("#") && (!channels.length||channels.some(channel=>channel!==normalize(label))))return false;
      const token=escape(normalize(label));
      if(!new RegExp(`(?:\\b(?:in|from|for)\\s+|把\\s*|在\\s*|来自\\s*)${token}(?![a-z0-9_-])`,"u").test(sourceClause))return false;
      if(new RegExp(`(?:\\b(?:not|except|excluding)\\s+(?:(?:in|from|for)\\s+)?|不在\\s*|排除\\s*)${token}(?![a-z0-9_-])`,"u").test(sourceClause))return false;
    }
    const focus = clause.match(/(?:\bfocus(?:ing)?\s+(?:on\s+)?|重点(?:是|为|在于)?\s*)([^,;，；]+)/u)?.[1]?.trim();
    if (focus !== normalize(definition.focus))
        return false;
    const aliases = definition.language.toLowerCase() === "english" ? ["english", "英文"] : definition.language.toLowerCase() === "chinese" ? ["chinese", "中文"] : [normalize(definition.language)];
    const languages = aliases.map(alias => escape(alias) + (/^[a-z -]+$/u.test(alias) ? "(?![a-z])" : "")).join("|");
    if (new RegExp(`(?:\\b(?:not|never)\\s+|不要\\s*)(?:${languages})`, "u").test(clause))
        return false;
    if (!new RegExp(`(?:\\b(?:in|using)\\s+|用|以)\\s*(?:${languages})|(?:${languages})\\s+(?:summary|summaries|output)`, "u").test(clause))
        return false;
    const ordinary = NEW_MESSAGES.test(clause), mention = OWNER_MENTION.test(clause);
    if (ordinary && mention)
        return false;
    if (definition.trigger === "new_message" ? !ordinary || mention : !mention || ordinary)
        return false;
    if (!label || !affirmativeFields(clause, definition, label)) return false;
    const negatedImmediate = /\b(?:not|never)\s+immediate(?:ly)?\b|不要立即/u.test(clause);
    const positiveCadence = clause.replace(/\b(?:not|never)\s+immediate(?:ly)?\b|不要立即/gu, "");
    if (definition.cadence.kind === "immediate")
        return !negatedImmediate && IMMEDIATE.test(positiveCadence) && !WINDOW.test(clause);
    if (IMMEDIATE.test(positiveCadence) || !WINDOW.test(clause))
        return false;
    const durations = [...clause.matchAll(/\b(\d+)\s*(seconds?|secs?|minutes?|mins?)\b/gu)].map(match => Number(match[1]) * (match[2]!.startsWith("m") ? 60 : 1));
    for (const match of clause.matchAll(/(\d+)\s*(秒|分钟)/gu))
        durations.push(Number(match[1]) * (match[2] === "分钟" ? 60 : 1));
    const seconds=definition.cadence.seconds;
    return durations.length > 0 && durations.every(duration => duration === seconds);
}
