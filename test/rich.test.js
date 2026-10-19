import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RICH_BLOCK_LIMIT,
  RICH_LIMIT,
  cleanMarkdown,
  cutMarkdown,
  escapeRich,
  estimateBlocks,
  foldMarkdown,
  hasRichMention,
  richBody,
  richJoin,
  splitAtHeadings,
  withHardBreaks,
} from '../src/rich.js';
import { validateRichMarkdown } from './fakes/telegram.js';

const BASE = 'https://paperclip.example.com';
// A character outside the BMP: one code point, two UTF-16 units.
const ASTRAL = '\u{20000}';
const FULL = `${BASE}/TST/issues/TST-1#comment-c1`;
const body = (markdown, max = 4000) => richBody(markdown, max, { uiBaseUrl: BASE, fullUrl: FULL });
const rows = (count, prefix = 'row') => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);

test('escapeRich escapes HTML and the characters Markdown reads', () => {
  assert.equal(escapeRich('Fix * _ [ ] # now'), 'Fix \\* \\_ \\[ \\] \\# now');
  assert.equal(escapeRich('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
  assert.equal(escapeRich('`code` ~strike~ a|b $5 ==mark== \\'), '\\`code\\` \\~strike\\~ a\\|b \\$5 \\=\\=mark\\=\\= \\\\');
  assert.equal(escapeRich('- not a list'), '\\- not a list');
  assert.equal(escapeRich('1. not a list'), '1\\. not a list');
  assert.equal(escapeRich('> not a quote'), '&gt; not a quote');
  assert.equal(escapeRich('plain words'), 'plain words');
});

test('richJoin separates blocks with a blank line and skips empty ones', () => {
  assert.equal(richJoin(['a', '', 'b', null, 'c']), 'a\n\nb\n\nc');
});

test('cleanMarkdown makes links absolute and turns other links and images into text or plain links', () => {
  const clean = (text) => cleanMarkdown(text, BASE);
  assert.equal(clean('[task](/TST/issues/TST-2)'), `[task](${BASE}/TST/issues/TST-2)`);
  assert.equal(clean('[site](https://example.com/a?b=c "title")'), '[site](https://example.com/a?b=c)');
  assert.equal(clean('[Dev](agent://abc) and [mail](mailto:a@example.com) and [x](#local)'), 'Dev and mail and x');
  assert.equal(clean('![diagram](/api/assets/1/content)'), `[diagram](${BASE}/api/assets/1/content)`);
  assert.equal(clean('![](https://example.com/a.png)'), '[image](https://example.com/a.png)');
  assert.equal(clean('![gone](agent://x)'), 'gone');
  assert.equal(clean('<https://example.com/x>'), '[https://example.com/x](https://example.com/x)');
  assert.equal(clean('[a link with (parens)](https://example.com/a_(b))'), '[a link with (parens)](https://example.com/a_%28b%29)');
  assert.equal(clean('[ref]: /TST/issues/TST-3\n[bad]: agent://x\ntext [ref]'), `[ref]: ${BASE}/TST/issues/TST-3\ntext [ref]`);
});

test('cleanMarkdown escapes raw HTML and loose ampersands but not code or known entities', () => {
  const clean = (text) => cleanMarkdown(text, BASE);
  assert.equal(clean('a <b>bold</b> <script>x</script>'), 'a &lt;b>bold&lt;/b> &lt;script>x&lt;/script>');
  assert.equal(clean('AT&T &amp; &lt; &#65; &copy;'), 'AT&amp;T &amp; &lt; &#65; &amp;copy;');
  assert.equal(clean('costs $5 and `$x <y> & z`'), 'costs \\$5 and `$x <y> & z`');
  assert.equal(clean('```html\n<b>&</b>\n![x](y)\n```\n<i>'), '```html\n<b>&</b>\n![x](y)\n```\n&lt;i>');
  assert.equal(clean('~~~\n```\n<b>\n~~~\n<b>'), '~~~\n```\n<b>\n~~~\n&lt;b>');
  assert.equal(clean('a \\<b> c'), 'a &lt;b> c');
});

test('cleanMarkdown never leaves an image, not even a reference-style one', () => {
  const clean = (text) => cleanMarkdown(text, BASE);
  assert.equal(clean('![alt][ref]\n\n[ref]: /a.png'), `\\![alt][ref]\n\n[ref]: ${BASE}/a.png`);
  assert.equal(clean('see ![alt] and ![](x'), 'see \\![alt] and \\![](x');
  for (const text of ['![a](/b.png)', '![a][b]', '![a](c "d")', '![a](<c d>)', '![](x) ![b][]']) {
    assert.equal(validateRichMarkdown(clean(text)), null, text);
  }
});

test('cleanMarkdown cleans a line that looks like a code fence but is a code span', () => {
  assert.equal(cleanMarkdown('```a``` <b> & ```', BASE), '```a``` &lt;b> &amp; ```');
  assert.equal(cleanMarkdown('``` x ``` and <i>', BASE), '``` x ``` and &lt;i>');
  assert.equal(cleanMarkdown('```js\n<i>\n```\n<i>', BASE), '```js\n<i>\n```\n&lt;i>');
});

test('cleanMarkdown keeps text it cannot read as a link', () => {
  const clean = (text) => cleanMarkdown(text, BASE);
  assert.equal(clean('[not a link] and [also](no close'), '[not a link] and [also](no close');
  assert.equal(clean('line one\r\nline two'), 'line one\nline two');
  assert.equal(clean(''), '');
  assert.equal(clean(null), '');
});

test('cutMarkdown keeps whole lines, closes an open code block and ends with a link to the full text', () => {
  assert.equal(cutMarkdown('short', 100, FULL), 'short');
  assert.equal(cutMarkdown('one\ntwo\nthree\nfour', 12, FULL), `one\ntwo\n\n[Full text in Paperclip](${FULL})`);
  assert.equal(cutMarkdown('one\ntwo\nthree\nfour', 12), 'one\ntwo\n\n…');
  const cut = cutMarkdown(['```', ...rows(20), '```'].join('\n'), 50, FULL);
  assert.equal(cut, `\`\`\`\nrow 1\nrow 2\nrow 3\nrow 4\nrow 5\nrow 6\nrow 7\n\`\`\`\n\n[Full text in Paperclip](${FULL})`);
  assert.equal(cutMarkdown('~~~\ncode', 100), '~~~\ncode\n~~~');
  assert.equal(cutMarkdown('```\ncode', 100), '```\ncode\n```');
  const wide = cutMarkdown(`${'word '.repeat(40)}end`, 60, FULL);
  assert.ok(wide.startsWith('word word') && Array.from(wide.split('\n\n')[0]).length <= 60, wide);
  assert.ok(!/&\w*$/.test(wide.split('\n\n')[0]));
});

test('the indent of an indented code block survives cutting and folding', () => {
  assert.equal(body('    code line\nsecond\nthird\nfourth'), '<details><summary>Show all</summary>\n\n    code line\nsecond\nthird\nfourth\n\n</details>');
  assert.equal(body('\n\n   \n    code'), '>     code');
});

test('a cut inside a code span closes the span', () => {
  const cut = body('`' + 'word '.repeat(40) + '`', 60);
  assert.ok(/^> `word( word)+ `\n>\n> \[Full text in Paperclip\]/.test(cut), cut);
  assert.equal(validateRichMarkdown(cut), null);
  const html = body('use `<script>' + ' x'.repeat(100) + '</script>`', 40);
  assert.equal(validateRichMarkdown(html), null, html);
  assert.ok(!/<script>[^`]*$/.test(html.split('\n\n')[0].replace(/`[^`]*`/g, '')), 'the tag stays inside the code span');
});

test('a body of up to 3 lines and 300 characters is a quote', () => {
  assert.equal(foldMarkdown('one\ntwo\nthree'), '> one\n> two\n> three');
  assert.equal(foldMarkdown('one\n\ntwo\n\nthree'), '> one\n>\n> two\n>\n> three');
  assert.equal(foldMarkdown('x'.repeat(300)), `> ${'x'.repeat(300)}`);
  assert.ok(foldMarkdown('x'.repeat(301)).startsWith('<details>'));
  assert.ok(foldMarkdown('1\n2\n3\n4').startsWith('<details>'));
});

test('a longer body folds under its first line as plain text, cut to 80 characters', () => {
  assert.equal(foldMarkdown('# Report on *the* `run`\nb\nc\nd'), '<details><summary>Report on the run</summary>\n\nb\nc\nd\n\n</details>');
  const long = `${'word '.repeat(30)}end\nb\nc\nd`;
  const folded = foldMarkdown(long);
  const summary = /<summary>(.*)<\/summary>/.exec(folded)[1];
  assert.ok(Array.from(summary).length <= 80 && summary.endsWith('…'), summary);
  assert.ok(folded.includes(`\n\n${'word '.repeat(30)}end\nb\nc\nd\n\n</details>`), 'a first line cut for the summary stays whole inside');
  assert.equal(foldMarkdown('see [the task](https://example.com/a) now\nb\nc\nd'), '<details><summary>see the task now</summary>\n\nsee [the task](https://example.com/a) now\nb\nc\nd\n\n</details>');
  assert.equal(body('a_b *c* & <d>\nb\nc\nd'), '<details><summary>a\\_b c &amp; &lt;d&gt;</summary>\n\nb\nc\nd\n\n</details>');
});

test('withHardBreaks ends a line that a text line follows with two spaces', () => {
  assert.equal(withHardBreaks('Cause: a\nDid: b\nBack to Lead'), 'Cause: a  \nDid: b  \nBack to Lead');
  assert.equal(withHardBreaks('one\n\ntwo\nthree\n\nfour'), 'one\n\ntwo  \nthree\n\nfour');
  assert.equal(withHardBreaks('- one\n- two\n- three'), '- one  \n- two  \n- three');
  assert.equal(withHardBreaks('# Title\ntext'), '# Title  \ntext');
  assert.equal(withHardBreaks('single line'), 'single line');
  assert.equal(withHardBreaks(''), '');
});

test('withHardBreaks leaves a line that already breaks alone and tidies other trailing blanks', () => {
  assert.equal(withHardBreaks('a  \nb'), 'a  \nb');
  assert.equal(withHardBreaks('a\\\nb'), 'a\\\nb');
  assert.equal(withHardBreaks('a\\\\\nb'), 'a\\\\  \nb');
  assert.equal(withHardBreaks('a \nb'), 'a  \nb');
  assert.equal(withHardBreaks('a\t\nb'), 'a  \nb');
});

test('withHardBreaks adds nothing inside fenced or indented code', () => {
  assert.equal(withHardBreaks('```js\nconst a = 1;\nconst b = 2;\n```\nafter'), '```js\nconst a = 1;\nconst b = 2;\n```\nafter');
  assert.equal(withHardBreaks('intro\n~~~\nx\ny\n~~~\nafter\nmore'), 'intro  \n~~~\nx\ny\n~~~\nafter  \nmore');
  assert.equal(withHardBreaks('text\n\n    code one\n    code two\n\nafter'), 'text\n\n    code one\n    code two\n\nafter');
  assert.equal(withHardBreaks('\tcode one\n\tcode two'), '\tcode one\n\tcode two');
  assert.equal(withHardBreaks('- item\n    continued\nnext'), '- item  \n    continued  \nnext');
  assert.equal(withHardBreaks('```\nnever closed\nstill code'), '```\nnever closed\nstill code');
  assert.equal(withHardBreaks('a ```x``` b\nnext'), 'a ```x``` b  \nnext');
});

test('withHardBreaks leaves the end of a line inside a code span that runs over lines', () => {
  assert.equal(withHardBreaks('use `first\nsecond` here\nnext'), 'use `first\nsecond` here  \nnext');
  assert.equal(withHardBreaks('a `x\ny` b `z`\nnext'), 'a `x\ny` b `z`  \nnext');
  assert.equal(withHardBreaks('a ``x ` \ny`` b\nnext'), 'a ``x ` \ny`` b  \nnext');
  assert.equal(withHardBreaks('an `open one\nsecond\nthird'), 'an `open one  \nsecond  \nthird');
  assert.equal(withHardBreaks('one \\`two\nthree'), 'one \\`two  \nthree');
});

test('withHardBreaks breaks the lines of a paragraph that is indented inside a list item', () => {
  assert.equal(withHardBreaks('- item\n\n    Cause: a\n    Did: b'), '- item\n\n    Cause: a  \n    Did: b');
  assert.equal(withHardBreaks('1. item\n\n   Cause: a\n   Did: b'), '1. item\n\n   Cause: a  \n   Did: b');
  assert.equal(withHardBreaks('- a\n  - b\n  - c'), '- a  \n  - b  \n  - c');
  assert.equal(withHardBreaks('- item\n\n      code a\n      code b'), '- item\n\n      code a\n      code b');
  assert.equal(withHardBreaks('- item\n\ntext\n\n    code a\n    code b'), '- item\n\ntext\n\n    code a\n    code b');
  assert.equal(withHardBreaks('- a\n  - b\n\n  para one\n  para two\n\n      code'), '- a  \n  - b\n\n  para one  \n  para two\n\n      code');
});

test('foldMarkdown with hard breaks breaks the lines of a quote and of the folded text, not the summary', () => {
  assert.equal(foldMarkdown('one\ntwo\nthree', true), '> one  \n> two  \n> three');
  assert.equal(foldMarkdown('one\n\ntwo\nthree', true), '> one\n>\n> two  \n> three');
  assert.equal(foldMarkdown('# Report\nb\nc\nd', true), '<details><summary>Report</summary>\n\nb  \nc  \nd\n\n</details>');
  assert.equal(
    foldMarkdown('see [the task](https://example.com/a) now\nb\nc\nd', true),
    '<details><summary>see the task now</summary>\n\nsee [the task](https://example.com/a) now  \nb  \nc  \nd\n\n</details>',
  );
  assert.equal(foldMarkdown('```\na\nb\n```\nafter\nmore', true), '<details><summary>Show all</summary>\n\n```\na\nb\n```\nafter  \nmore\n\n</details>');
});

test('the breaks do not move a body over the fold thresholds', () => {
  const lines = Array.from({ length: 3 }, () => 'x'.repeat(98));
  assert.equal(lines.join('\n').length, 296);
  assert.equal(foldMarkdown(lines.join('\n'), true), lines.map((line, i) => `> ${line}${i < 2 ? '  ' : ''}`).join('\n'));
});

test('richBody breaks lines only when asked to', () => {
  const text = 'Cause: a\nDid: b';
  assert.equal(body(text), '> Cause: a\n> Did: b');
  assert.equal(richBody(text, 4000, { uiBaseUrl: BASE, fullUrl: FULL, hardBreaks: true }), '> Cause: a  \n> Did: b');
  const cut = richBody(['intro', ...rows(500)].join('\n'), 400, { uiBaseUrl: BASE, fullUrl: FULL, hardBreaks: true });
  assert.ok(cut.startsWith('<details><summary>intro</summary>\n\nrow 1  \nrow 2  \n'), cut);
  assert.ok(cut.endsWith(`\n\n[Full text in Paperclip](${FULL})\n\n</details>`), 'the link stands apart');
  assert.equal(validateRichMarkdown(cut), null);
});

test('a body that opens with a code block, a table or a list folds under Show all with the whole body inside', () => {
  for (const first of ['```js', '| a | b |\n|---|---|', '- item', '1. item', '    indented code']) {
    const text = `${first}\nrest\nmore\nlines`;
    assert.equal(foldMarkdown(text), `<details><summary>Show all</summary>\n\n${text}\n\n</details>`, first);
  }
});

test('richBody cleans, cuts and folds; an empty text or a budget of 0 gives nothing', () => {
  assert.equal(body('A [link](/x)'), `> A [link](${BASE}/x)`);
  assert.equal(body('   \n  '), '');
  assert.equal(body('text', 0), '');
  assert.equal(body(undefined), '');
  const cut = body(['intro', ...rows(500)].join('\n'), 400);
  assert.ok(cut.startsWith('<details><summary>intro</summary>'));
  assert.ok(cut.endsWith(`[Full text in Paperclip](${FULL})\n\n</details>`));
  assert.equal(validateRichMarkdown(cut), null);
});

test('hasRichMention finds a text mention of the user anywhere in a returned rich message', () => {
  const mention = (id) => ({ type: 'text_mention', text: 'Question', user: { id, is_bot: false } });
  const message = { blocks: [{ type: 'paragraph', text: ['x ', mention(7), ' y'] }] };
  assert.equal(hasRichMention(message, 7), true);
  assert.equal(hasRichMention(message, 8), false);
  assert.equal(hasRichMention({ blocks: [{ type: 'list', items: [{ blocks: [{ type: 'paragraph', text: mention(7) }] }] }] }, 7), true);
  assert.equal(hasRichMention(undefined, 7), false);
  assert.equal(hasRichMention({ blocks: [] }, 7), false);
  assert.equal(hasRichMention('plain', 7), false);
});

test('estimateBlocks counts paragraphs, list and quote items and code blocks', () => {
  assert.equal(estimateBlocks('a\n\nb\n\nc'), 3);
  assert.equal(estimateBlocks('- a\n- b'), 4);
  assert.equal(estimateBlocks('> a\n> b'), 4);
  assert.equal(estimateBlocks('```\na\nb\nc\n```\ntext'), 2);
});

test('splitAtHeadings keeps a short document whole', () => {
  const text = '# One\n\nfirst\n\n## Two\n\nsecond';
  assert.deepEqual(splitAtHeadings(text), { parts: [text], cut: false });
});

test('splitAtHeadings cuts a long document at headings and keeps every part within the limits', () => {
  const section = (title) => `## ${title}\n\n${Array.from({ length: 200 }, (_, i) => `${title} paragraph ${i} ${'x'.repeat(80)}`).join('\n\n')}`;
  const text = ['Intro text', section('Alpha'), section('Beta'), section('Gamma')].join('\n\n');
  const { parts, cut } = splitAtHeadings(text, { room: 100 });
  assert.equal(cut, false);
  assert.ok(parts.length >= 3, `${parts.length} parts`);
  for (const part of parts) {
    assert.ok(Array.from(part).length <= RICH_LIMIT - 200, 'within the character limit');
    assert.ok(estimateBlocks(part) <= RICH_BLOCK_LIMIT - 50, 'within the block limit');
    assert.equal(validateRichMarkdown(part), null);
  }
  assert.ok(Array.from(parts[0]).length <= RICH_LIMIT - 300, 'the first part leaves room for its title');
  assert.ok(parts.slice(1).every((part) => /^## (Alpha|Beta|Gamma)\n/.test(part) || part.includes('paragraph')), 'later parts start at a heading or a paragraph');
  assert.ok(parts.some((part) => part.startsWith('## Beta')), 'Beta starts a part');
  assert.ok(parts.some((part) => part.startsWith('## Gamma')), 'Gamma starts a part');
  assert.equal(parts.join('\n\n').replaceAll('\n\n', '\n'), text.replaceAll('\n\n', '\n'), 'nothing is lost');
});

test('splitAtHeadings does not take a # line in a code block for a heading and reopens a code block it cuts', () => {
  const code = ['```', ...Array.from({ length: 300 }, (_, i) => `# not a heading ${i} ${'y'.repeat(120)}`), '```'].join('\n');
  const { parts } = splitAtHeadings(`## Code\n\n${code}`, { chars: 20000 });
  assert.ok(parts.length >= 2);
  for (const part of parts) {
    assert.equal(validateRichMarkdown(part), null, 'every part closes its code block');
    assert.ok(Array.from(part).length <= 20000);
  }
  assert.ok(parts[1].startsWith('```\n# not a heading'), 'the next part opens the code block again');
});

test('splitAtHeadings closes a code block that the document leaves open', () => {
  const { parts } = splitAtHeadings('## Code\n\n```\nnever closed\nstill code');
  assert.deepEqual(parts, ['## Code\n\n```\nnever closed\nstill code\n```']);
});

test('splitAtHeadings keeps room for the lines it closes and opens a code block around', () => {
  const code = ['```', ...Array.from({ length: 200 }, (_, i) => `line ${i} ${'z'.repeat(50)}`), '```'].join('\n');
  for (const part of splitAtHeadings(code, { chars: 700 }).parts) {
    assert.ok(Array.from(part).length <= 700, `${Array.from(part).length} characters`);
    assert.equal(validateRichMarkdown(part), null);
  }
});

test('splitAtHeadings splits by blocks when a document has many short lines', () => {
  const text = Array.from({ length: 1200 }, (_, i) => `line ${i}`).join('\n\n');
  const { parts } = splitAtHeadings(text);
  assert.ok(parts.length >= 3);
  for (const part of parts) assert.ok(estimateBlocks(part) <= RICH_BLOCK_LIMIT - 50);
});

test('splitAtHeadings reports a line too long for a message and drops its end', () => {
  const line = 'word '.repeat(8000);
  const { parts, cut } = splitAtHeadings(`# Title\n\n${line}`);
  assert.equal(cut, true);
  assert.ok(parts.length >= 1);
  for (const part of parts) {
    assert.ok(part.length <= RICH_LIMIT - 200, `${part.length} units`);
    assert.equal(validateRichMarkdown(part), null);
  }
  assert.ok(parts.join('\n\n').length < line.length, 'the end of the line is gone');
  assert.equal(splitAtHeadings('# Title\n\nshort').cut, false);
});

test('splitAtHeadings counts UTF-16 units, so a part with many astral characters still fits a message', () => {
  const text = Array.from({ length: 400 }, () => ASTRAL.repeat(80)).join('\n');
  assert.equal(Array.from(text).length, 400 * 80 + 399);
  const { parts, cut } = splitAtHeadings(text, { room: 40 });
  assert.equal(cut, false);
  assert.ok(parts.length >= 2, `${parts.length} parts`);
  assert.ok(parts[0].length <= RICH_LIMIT - 200 - 40, `${parts[0].length} units`);
  for (const part of parts) assert.ok(part.length <= RICH_LIMIT - 200, `${part.length} units`);
  assert.equal(parts.join('\n').length, text.length, 'nothing is lost');
});

test('a line of astral characters is cut at a whole character', () => {
  const { parts } = splitAtHeadings(ASTRAL.repeat(40000), { chars: 1001 });
  assert.equal(parts.length, 1);
  assert.ok(parts[0].length <= 991, `${parts[0].length} units`);
  assert.equal(parts[0], ASTRAL.repeat(parts[0].length / 2));
});
