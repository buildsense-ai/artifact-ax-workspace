import { describe, expect, it } from 'vitest';
import { LexicalIntentClassifier } from './intent.js';

const classifier = new LexicalIntentClassifier();

describe('LexicalIntentClassifier', () => {
  it('returns collect for empty / whitespace intent', () => {
    for (const t of ['', '   ', '\n\t']) {
      const a = classifier.classify(t);
      expect(a.intent_kind).toBe('collect');
      expect(a.risk).toBe('none');
      expect(a.complete).toBe(true);
      expect(a.confidence).toBe(1);
    }
  });

  describe('English read-only families', () => {
    it.each([
      ['inspect them', 'inspect', 'low'],
      ['explain why these pending', 'explain', 'low'],
      ['review the selected rows', 'review', 'low'],
      ['compare the two topics', 'compare', 'low'],
    ])('classifies "%s" as %s/%s', (text, kind, risk) => {
      const a = classifier.classify(text);
      expect(a.intent_kind).toBe(kind);
      expect(a.risk).toBe(risk);
    });
  });

  describe('Chinese read-only families', () => {
    it.each([
      ['查看这些', 'inspect', 'low'],
      ['解释一下为什么', 'explain', 'low'],
      ['检查这几行', 'review', 'low'],
      ['对比一下', 'compare', 'low'],
    ])('classifies "%s" as %s/%s', (text, kind, risk) => {
      const a = classifier.classify(text);
      expect(a.intent_kind).toBe(kind);
      expect(a.risk).toBe(risk);
    });
  });

  describe('English mutation families', () => {
    it.each([
      ['change the status', 'change', 'medium'],
      ['edit these rows', 'change', 'medium'],
      ['update the filter', 'change', 'medium'],
    ])('classifies "%s" as %s/%s', (text, kind, risk) => {
      const a = classifier.classify(text);
      expect(a.intent_kind).toBe(kind);
      expect(a.risk).toBe(risk);
    });
  });

  describe('Chinese mutation families', () => {
    it.each([
      ['修改选中行', 'change', 'medium'],
      ['更新状态', 'change', 'medium'],
      ['添加一列', 'change', 'medium'],
    ])('classifies "%s" as %s/%s', (text, kind, risk) => {
      const a = classifier.classify(text);
      expect(a.intent_kind).toBe(kind);
      expect(a.risk).toBe(risk);
    });
  });

  describe('destructive families', () => {
    it.each([
      ['delete these rows', 'destructive', 'high'],
      ['publish the report', 'destructive', 'high'],
      ['清空表格', 'destructive', 'high'],
      ['发布', 'destructive', 'high'],
    ])('classifies "%s" as %s/%s', (text, kind, risk) => {
      const a = classifier.classify(text);
      expect(a.intent_kind).toBe(kind);
      expect(a.risk).toBe(risk);
    });
  });

  describe('ambiguity and confidence', () => {
    it('marks a mix of families ambiguous with the worst risk', () => {
      const a = classifier.classify('delete and review pending rows');
      expect(a.intent_kind).toBe('ambiguous');
      expect(a.risk).toBe('high');
      expect(a.complete).toBe(false);
      expect(a.confidence).toBeLessThan(0.8);
    });

    it('marks unrecognized text ambiguous and incomplete', () => {
      const a = classifier.classify('quantum flux orb');
      expect(a.intent_kind).toBe('ambiguous');
      expect(a.complete).toBe(false);
      expect(a.confidence).toBeLessThan(0.8);
    });

    it('gives a strong single read intent high, complete confidence', () => {
      const a = classifier.classify('review these rows');
      expect(a.intent_kind).toBe('review');
      expect(a.confidence).toBeGreaterThanOrEqual(0.8);
      expect(a.complete).toBe(true);
    });

    it('never exceeds 0.98 confidence', () => {
      const a = classifier.classify('compare compare compare compare');
      expect(a.confidence).toBeLessThanOrEqual(0.98);
    });
  });

  it('returns rationale reasons', () => {
    const a = classifier.classify('delete these');
    expect(a.rationale.length).toBeGreaterThan(0);
    expect(a.rationale.join(' ')).toContain('delete');
  });

  it('matches action words inside ordinary sentences but not inside English words', () => {
    expect(classifier.classify('please review these').intent_kind).toBe('review');
    const chinese = classifier.classify('请检查这些');
    expect(chinese.intent_kind).toBe('review');
    expect(chinese.rationale.join(' ')).not.toContain('unmatched tokens: 请检查这些');
    expect(classifier.classify('address this').intent_kind).toBe('ambiguous');
    expect(classifier.classify('bread these').intent_kind).toBe('ambiguous');
  });

  it('treats a negated action as no-op context rather than an instruction', () => {
    const a = classifier.classify('不要删除这些');
    expect(a.intent_kind).toBe('ambiguous');
    expect(a.risk).toBe('none');
    expect(a.rationale.join(' ')).toContain('negated');
    expect(classifier.classify("don't review this").intent_kind).toBe('ambiguous');
  });

  it('keeps an unnegated signal when another signal is negated', () => {
    const a = classifier.classify('不要删除，先检查这些');
    expect(a.intent_kind).toBe('review');
    expect(a.rationale.join(' ')).toContain('negated signals ignored');
  });

  it('propagates negation across a compound signal without crossing a new clause', () => {
    expect(classifier.classify("don't explain why").intent_kind).toBe('ambiguous');
    expect(classifier.classify('不要解释为什么').intent_kind).toBe('ambiguous');
    expect(classifier.classify("don't explain, review this").intent_kind).toBe('review');
  });
});
