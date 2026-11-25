function readGroup(text, start) {
  if (text[start] !== "{") return null;
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    if (text[index] === "}") depth -= 1;
    if (depth === 0) return { value: text.slice(start + 1, index), end: index + 1 };
  }
  return null;
}

function replaceGroupedCommand(text, command, groupCount, formatter) {
  let output = text;
  for (let attempts = 0; attempts < 50; attempts += 1) {
    const commandIndex = output.lastIndexOf(command);
    if (commandIndex === -1) break;
    let cursor = commandIndex + command.length;
    const groups = [];
    let valid = true;
    for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
      while (output[cursor] === " ") cursor += 1;
      const group = readGroup(output, cursor);
      if (!group) { valid = false; break; }
      groups.push(group.value);
      cursor = group.end;
    }
    if (!valid) {
      output = output.slice(0, commandIndex) + command.slice(1) + output.slice(commandIndex + command.length);
      continue;
    }
    output = output.slice(0, commandIndex) + formatter(...groups) + output.slice(cursor);
  }
  return output;
}

function formatScript(value, superscript) {
  const source = latexToDisplayText(value);
  const maps = superscript
    ? { "0":"⁰", "1":"¹", "2":"²", "3":"³", "4":"⁴", "5":"⁵", "6":"⁶", "7":"⁷", "8":"⁸", "9":"⁹", "+":"⁺", "-":"⁻", "=":"⁼", "(":"⁽", ")":"⁾", "n":"ⁿ" }
    : { "0":"₀", "1":"₁", "2":"₂", "3":"₃", "4":"₄", "5":"₅", "6":"₆", "7":"₇", "8":"₈", "9":"₉", "+":"₊", "-":"₋", "=":"₌", "(":"₍", ")":"₎" };
  const converted = [...source].map(character => maps[character] || "").join("");
  if (converted.length === source.length) return converted;
  return superscript ? `^(${source})` : `_(${source})`;
}

function replaceScripts(text, marker, superscript) {
  let output = text;
  for (let attempts = 0; attempts < 50; attempts += 1) {
    const index = output.indexOf(marker + "{");
    if (index === -1) break;
    const group = readGroup(output, index + 1);
    if (!group) break;
    output = output.slice(0, index) + formatScript(group.value, superscript) + output.slice(group.end);
  }
  return output;
}

function latexToDisplayText(value) {
  let text = String(value ?? "");
  const symbols = [
    [/\\pi\b/g, "π"], [/\\theta\b/g, "θ"], [/\\alpha\b/g, "α"], [/\\beta\b/g, "β"],
    [/\\gamma\b/g, "γ"], [/\\Delta\b/g, "Δ"], [/\\infty\b/g, "∞"], [/\\cdot\b/g, "·"],
    [/\\times\b/g, "×"], [/\\pm\b/g, "±"], [/\\leq?\b/g, "≤"], [/\\geq?\b/g, "≥"],
    [/\\neq\b/g, "≠"], [/\\approx\b/g, "≈"], [/\\rightarrow\b/g, "→"], [/\\int\b/g, "∫"],
    [/\\sum\b/g, "Σ"], [/\\sqrt\b/g, "√"], [/\\sin\b/g, "sin"], [/\\cos\b/g, "cos"],
    [/\\tan\b/g, "tan"], [/\\ln\b/g, "ln"], [/\\log\b/g, "log"], [/\\,|\\;|\\!/g, " "],
    [/\\left|\\right/g, ""]
  ];
  for (const [pattern, replacement] of symbols) text = text.replace(pattern, replacement);
  text = text.replace(/\\[()[\]]/g, "");
  text = replaceGroupedCommand(text, "\\frac", 2, (top, bottom) => `(${latexToDisplayText(top)}) / (${latexToDisplayText(bottom)})`);
  text = replaceGroupedCommand(text, "√", 1, content => `√(${latexToDisplayText(content)})`);
  text = replaceScripts(text, "^", true);
  text = replaceScripts(text, "_", false);
  text = text.replace(/\\(?:mathrm|text|operatorname)\s*\{([^{}]*)\}/g, "$1");
  text = text.replace(/\\([A-Za-z]+)/g, "$1");
  text = text.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
  return text;
}

function sanitizeDisplayValue(value) {
  if (typeof value === "string") return latexToDisplayText(value);
  if (Array.isArray(value)) return value.map(sanitizeDisplayValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitizeDisplayValue(child)]));
  }
  return value;
}

module.exports = { latexToDisplayText, sanitizeDisplayValue };
