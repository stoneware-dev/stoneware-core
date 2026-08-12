/**
 * Server-side syntax highlighting.
 *
 * Returns elements, not an HTML string. Every token's text travels the normal
 * escaping path, so highlighting code that contains `<script>` is no more
 * dangerous than printing it - and the whole feature costs zero bytes of client
 * JavaScript, which is the point of the framework it is documenting.
 */

import type { Child } from "stoneware";

export type Language = "tsx" | "ts" | "sh" | "txt";

const KEYWORDS =
  "import|from|export|default|function|return|const|let|var|await|async|new|type|" +
  "interface|extends|implements|class|if|else|for|of|in|while|try|catch|throw|" +
  "typeof|instanceof|as|true|false|null|undefined|void|this";

/**
 * One pass, one regex. Alternation order is the precedence: comments win over
 * strings so a `//` inside a comment is not read as an unterminated string, and
 * strings win over keywords so `"export"` stays a string.
 */
const SCRIPT_TOKENS = new RegExp(
  [
    "(?<com>\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)",
    "(?<str>\"(?:[^\"\\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\\n]|\\\\.)*'|`(?:[^`\\\\]|\\\\.)*`)",
    "(?<tag><\\/?[A-Za-z][\\w.]*)",
    `(?<key>\\b(?:${KEYWORDS})\\b)`,
    "(?<num>\\b\\d[\\d_.]*\\b)",
    "(?<fn>\\b[A-Za-z_$][\\w$]*(?=\\())",
  ].join("|"),
  "g",
);

const SHELL_TOKENS = new RegExp(
  ["(?<com>#[^\\n]*)", "(?<str>\"[^\"\\n]*\"|'[^'\\n]*')", "(?<key>^\\s*[a-z][\\w-]*)"].join("|"),
  "gm",
);

const CLASS_FOR: Record<string, string> = {
  com: "t-com",
  str: "t-str",
  key: "t-key",
  num: "t-num",
  fn: "t-fn",
  tag: "t-tag",
};

function tokenize(code: string, pattern: RegExp): Child[] {
  const out: Child[] = [];
  let last = 0;

  pattern.lastIndex = 0;
  for (const match of code.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) out.push(code.slice(last, index));

    const groups = match.groups ?? {};
    const kind = Object.keys(CLASS_FOR).find((name) => groups[name] !== undefined);

    out.push(kind ? <span class={CLASS_FOR[kind]}>{match[0]}</span> : match[0]);
    last = index + match[0].length;
  }

  if (last < code.length) out.push(code.slice(last));
  return out;
}

export function highlight(code: string, language: Language = "tsx"): Child {
  if (language === "txt") return code;
  return tokenize(code, language === "sh" ? SHELL_TOKENS : SCRIPT_TOKENS);
}

export interface CodeBlockProps {
  code: string;
  language?: Language;
  label?: string;
}

export function CodeBlock({ code, language = "tsx", label }: CodeBlockProps) {
  return (
    <div class="code">
      {label && (
        <div class="code__label">
          <span>{label}</span>
          <span>{language}</span>
        </div>
      )}
      <pre>
        <code>{highlight(code.trim(), language)}</code>
      </pre>
    </div>
  );
}
