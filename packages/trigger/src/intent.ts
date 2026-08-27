import { type Assessment, type IntentKind } from './types.js';

/**
 * Deterministic, first-pass intent classifier. It recognizes common Chinese
 * and English action words for read-only work (inspect/explain/review/
 * compare), mutations (change/edit/update), and destructive actions
 * (delete/publish). It is deliberately a straight lexer + weighted vote with
 * confidence/risk/rationale strings, NOT an LLM called per click. A future
 * classifier only needs to implement `IntentClassifier`.
 */
export interface IntentClassifier {
  classify(text: string): Assessment;
}

export interface IntentSample {
  kind: IntentKind;
  weight: number;
}

/** family -> human intent labels for rationale strings. */
const FAMILY_LABEL: Record<string, string> = {
  inspect: 'inspect',
  explain: 'explain',
  review: 'review',
  compare: 'compare',
  change: 'change/edit',
  destructive: 'destructive',
};

/**
 * Lexicon of (signal -> intent family). Signals are lower-cased English words
 * or literal Chinese phrases. Keep phrases longer than single words so whole
 * expressions ("how many", "为什么") match before their parts.
 */
const LEXICON: Array<{ text: string; kind: IntentKind }> = [
  // inspect (read-only)
  { text: 'inspect', kind: 'inspect' },
  { text: 'look', kind: 'inspect' },
  { text: 'see', kind: 'inspect' },
  { text: 'read', kind: 'inspect' },
  { text: 'show', kind: 'inspect' },
  { text: 'list', kind: 'inspect' },
  { text: 'browse', kind: 'inspect' },
  { text: 'display', kind: 'inspect' },
  { text: 'how many', kind: 'inspect' },
  { text: 'what is', kind: 'inspect' },
  { text: 'which', kind: 'inspect' },
  { text: '查看', kind: 'inspect' },
  { text: '看看', kind: 'inspect' },
  { text: '看', kind: 'inspect' },
  { text: '读', kind: 'inspect' },
  { text: '展示', kind: 'inspect' },
  { text: '浏览', kind: 'inspect' },
  { text: '有哪些', kind: 'inspect' },
  { text: '多少', kind: 'inspect' },

  // explain (read-only)
  { text: 'explain', kind: 'explain' },
  { text: 'why', kind: 'explain' },
  { text: 'meaning', kind: 'explain' },
  { text: 'understand', kind: 'explain' },
  { text: 'explain why', kind: 'explain' },
  { text: '解释', kind: 'explain' },
  { text: '说明', kind: 'explain' },
  { text: '为什么', kind: 'explain' },
  { text: '是什么意思', kind: 'explain' },
  { text: '怎么理解', kind: 'explain' },
  { text: '含义', kind: 'explain' },

  // review (read-only but leads to a decision)
  { text: 'review', kind: 'review' },
  { text: 'check', kind: 'review' },
  { text: 'audit', kind: 'review' },
  { text: 'verify', kind: 'review' },
  { text: 'assess', kind: 'review' },
  { text: 'sanity', kind: 'review' },
  { text: '审核', kind: 'review' },
  { text: '检查', kind: 'review' },
  { text: '审查', kind: 'review' },
  { text: '核实', kind: 'review' },
  { text: '验证', kind: 'review' },
  { text: '评估', kind: 'review' },

  // compare (read-only)
  { text: 'compare', kind: 'compare' },
  { text: 'diff', kind: 'compare' },
  { text: 'versus', kind: 'compare' },
  { text: 'between', kind: 'compare' },
  { text: '对比', kind: 'compare' },
  { text: '比较', kind: 'compare' },
  { text: '区别', kind: 'compare' },
  { text: '差别', kind: 'compare' },
  { text: '差异', kind: 'compare' },

  // change / edit / update (mutation)
  { text: 'change', kind: 'change' },
  { text: 'edit', kind: 'change' },
  { text: 'update', kind: 'change' },
  { text: 'modify', kind: 'change' },
  { text: 'add', kind: 'change' },
  { text: 'insert', kind: 'change' },
  { text: 'set', kind: 'change' },
  { text: 'rename', kind: 'change' },
  { text: 'fix', kind: 'change' },
  { text: 'tune', kind: 'change' },
  { text: 'adjust', kind: 'change' },
  { text: 'sort', kind: 'change' },
  { text: 'mark', kind: 'change' },
  { text: 'annotate', kind: 'change' },
  { text: '修改', kind: 'change' },
  { text: '编辑', kind: 'change' },
  { text: '更新', kind: 'change' },
  { text: '改', kind: 'change' },
  { text: '调整', kind: 'change' },
  { text: '新增', kind: 'change' },
  { text: '添加', kind: 'change' },
  { text: '加', kind: 'change' },
  { text: '设置', kind: 'change' },
  { text: '重命名', kind: 'change' },
  { text: '修正', kind: 'change' },
  { text: '排序', kind: 'change' },
  { text: '标注', kind: 'change' },

  // destructive (consequential)
  { text: 'delete', kind: 'destructive' },
  { text: 'remove', kind: 'destructive' },
  { text: 'clear', kind: 'destructive' },
  { text: 'reset', kind: 'destructive' },
  { text: 'wipe', kind: 'destructive' },
  { text: 'publish', kind: 'destructive' },
  { text: 'release', kind: 'destructive' },
  { text: 'approve', kind: 'destructive' },
  { text: 'reject', kind: 'destructive' },
  { text: 'submit', kind: 'destructive' },
  { text: '删除', kind: 'destructive' },
  { text: '移除', kind: 'destructive' },
  { text: '清空', kind: 'destructive' },
  { text: '重置', kind: 'destructive' },
  { text: '发布', kind: 'destructive' },
  { text: '上线', kind: 'destructive' },
  { text: '提交', kind: 'destructive' },
  { text: '通过', kind: 'destructive' },
  { text: '拒绝', kind: 'destructive' },
];

function riskOf(kind: IntentKind): Assessment['risk'] {
  switch (kind) {
    case 'inspect':
    case 'explain':
    case 'review':
    case 'compare':
      return 'low';
    case 'change':
      return 'medium';
    case 'destructive':
      return 'high';
    default:
      return 'none';
  }
}

/** Split into matching units: English words/phrases and Chinese phrases. */
export function tokenize(text: string): string[] {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalized === '') return [];
  // Latin words + Chinese character runs.
  const latin = normalized.match(/[a-z][a-z0-9]*/g) ?? [];
  // Chinese phrase candidates: longest-first greedy via lexicon order is
  // handled by the matcher; here we grab contiguous CJK runs.
  const cjkRuns = normalized.match(/[\u4e00-\u9fff]+/g) ?? [];
  const tokens: string[] = [];
  // Re-add logical multi-word phrases like "how many", "what is".
  for (const phrase of ['how many', 'what is', 'explain why']) {
    const pattern = phrase.replace(/\s+/g, '\\s+');
    if (new RegExp(`(?<![a-z0-9])${pattern}(?![a-z0-9])`, 'i').test(normalized)) {
      tokens.push(phrase);
    }
  }
  tokens.push(...latin.filter((w) => w.length > 0));
  tokens.push(...cjkRuns);
  return tokens;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find all occurrences of a signal without matching it inside an English
 * word. CJK does not have mandatory word separators, so CJK signals are
 * intentionally matched as substrings (for example, "请检查这些").
 */
function signalPositions(text: string, signal: string): number[] {
  const normalizedSignal = signal.trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalizedSignal === '') return [];
  if (/[a-z0-9]/i.test(normalizedSignal)) {
    const words = normalizedSignal.split(/\s+/).map(escapeRegExp).join('\\s+');
    const expression = new RegExp(`(?<![a-z0-9])${words}(?![a-z0-9])`, 'gi');
    return [...text.matchAll(expression)].map((match) => match.index ?? -1).filter((index) => index >= 0);
  }

  const positions: number[] = [];
  let from = 0;
  while (from < text.length) {
    const index = text.indexOf(normalizedSignal, from);
    if (index < 0) break;
    positions.push(index);
    // Advance by one so overlapping CJK signals ("看看" and "看") are seen.
    from = index + 1;
  }
  return positions;
}

/**
 * A short, immediately preceding negation cancels a signal. This is a
 * conservative guard: an uncertain negation must never turn into an
 * automatic read or mutation request.
 */
function isNegated(text: string, start: number): boolean {
  // Limit the look-back to the current clause. This catches compound
  // signals such as "don't explain why" / "不要解释为什么", while a
  // comma or conjunction starts a new intent clause.
  const prefix = text.slice(Math.max(0, start - 40), start);
  const clause = prefix.split(/[,.!?;:，。！？；：]/u).at(-1) ?? prefix;

  const english = /(?:^|\s)(not|never|don't|dont|do not|no need to|without)(?=\s|$)/gi;
  let englishMatch: RegExpExecArray | null = null;
  for (const match of clause.matchAll(english)) englishMatch = match;
  if (englishMatch && englishMatch.index !== undefined) {
    const after = clause.slice(englishMatch.index + englishMatch[0].length);
    if (!/(?:\b(?:and|but|then|instead|or)\b)/i.test(after) && after.trim().split(/\s+/).length <= 3) {
      return true;
    }
  }

  const chinese = /不|没|不要|别|勿|无需|不用|不必|无须|不想/g;
  let chineseMatch: RegExpExecArray | null = null;
  for (const match of clause.matchAll(chinese)) chineseMatch = match;
  if (chineseMatch && chineseMatch.index !== undefined) {
    const after = clause.slice(chineseMatch.index + chineseMatch[0].length);
    if (!/(?:和|但|然后|而是|先|再)/u.test(after) && after.trim().length <= 8) return true;
  }
  return false;
}

/**
 * The default deterministic classifier. It also accepts an optional
 * user-supplied lexicon for extendability; without one it uses the built-in.
 */
export class LexicalIntentClassifier implements IntentClassifier {
  private readonly lexicon: Array<{ text: string; kind: IntentKind }>;

  constructor(lexicon: Array<{ text: string; kind: IntentKind }> = LEXICON) {
    this.lexicon = lexicon;
  }

  classify(text: string): Assessment {
    const trimmed = (text ?? '').trim();
    if (trimmed === '') {
      return {
        intent_kind: 'collect',
        confidence: 1,
        risk: 'none',
        rationale: ['no intent text: collecting context only, nothing is sent'],
        complete: true,
      };
    }

    const hay = trimmed.toLowerCase().replace(/\s+/g, ' ');
    const votes = new Map<IntentKind, number>();
    const matched: string[] = [];
    const negated: string[] = [];
    for (const sig of this.lexicon) {
      const positions = signalPositions(hay, sig.text);
      if (positions.length === 0) continue;
      const positive = positions.some((position) => !isNegated(hay, position));
      if (positive) {
        votes.set(sig.kind, (votes.get(sig.kind) ?? 0) + 1);
        matched.push(sig.text);
      } else {
        negated.push(sig.text);
      }
    }

    if (matched.length === 0) {
      return {
        intent_kind: 'ambiguous',
        confidence: 0.2,
        // Unknown language is still a low-impact ambiguity; an explicitly
        // negated action is a no-op and therefore carries no action risk.
        risk: negated.length > 0 ? 'none' : 'low',
        rationale:
          negated.length > 0
            ? [`negated action words: ${negated.join(', ')}; treating as no-op context`]
            : ['no recognized action word; treating as ambiguous, leaning toward collect'],
        complete: false,
      };
    }

    const families = [...votes.entries()];
    families.sort((a, b) => b[1] - a[1]);
    const dominant = families[0]!;
    const total = families.reduce((acc, [, n]) => acc + n, 0);
    const dominantRatio = dominant[1] / total;

    // Unmatched tokens (nouns, stop-words, domain labels) do not penalize a
    // clear single action family; they only appear in the rationale. Ambiguity
    // is judged by action-family mixing, not by unknown nouns, so a plain
    // "review these rows" stays a complete, high-confidence read intent.
    const tokens = tokenize(trimmed);
    const matchedWords = new Set(matched.flatMap((m) => tokenize(m)));
    const unmatched = tokens.filter((t) => {
      if (t.length <= 1 || matchedWords.has(t)) return false;
      // CJK tokenization intentionally keeps a contiguous run. Do not report
      // the whole run as "unmatched" when it contains a matched action.
      return !matched.some((signal) => !/[a-z0-9]/i.test(signal) && t.includes(signal));
    });

    const single = dominantRatio >= 0.8;
    const kind: IntentKind = single ? dominant[0] : 'ambiguous';
    const confidence = single
      ? Math.min(0.98, 0.85 + Math.min(0.1, 0.02 * total))
      : Math.max(0.2, dominantRatio * 0.8);
    const complete = single && confidence >= 0.8;

    const risk = (() => {
      if (kind === 'ambiguous') {
        const worst = Math.max(...families.map(([k]) => RISK_ORDER.indexOf(riskOf(k))));
        return RISK_LEVELS[worst]!;
      }
      return riskOf(kind);
    })();

    return {
      intent_kind: kind,
      confidence,
      risk,
      rationale: [
        `matched: ${matched.join(', ')}`,
        single
          ? `dominant intent: ${FAMILY_LABEL[dominant[0]] ?? dominant[0]} (${dominant[1]} signal${dominant[1] > 1 ? 's' : ''})`
          : 'mixed action words: treating as ambiguous',
        ...(unmatched.length > 0 ? [`unmatched tokens: ${unmatched.join(', ')}`] : []),
        ...(negated.length > 0 ? [`negated signals ignored: ${negated.join(', ')}`] : []),
        `risk: ${risk}`,
      ],
      complete,
    };
  }
}

const RISK_LEVELS = ['none', 'low', 'medium', 'high'] as const;
const RISK_ORDER = ['none', 'low', 'medium', 'high'];

export const DEFAULT_INTENT_CLASSIFIER: IntentClassifier = new LexicalIntentClassifier();
