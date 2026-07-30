import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownContent } from './MarkdownContent.js';

describe('MarkdownContent', () => {
  it('renders GitHub-flavored Markdown as structured HTML', () => {
    const markup = renderToStaticMarkup(
      <MarkdownContent content={'# 需求规格\n\n- [x] 已确认\n\n| 端 | 状态 |\n| --- | --- |\n| 微信 | 支持 |\n\n`pnpm dev`'} />,
    );

    expect(markup).toContain('<h1>需求规格</h1>');
    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain('<table>');
    expect(markup).toContain('<code>pnpm dev</code>');
  });

  it('does not execute raw HTML from model-generated artifacts', () => {
    const markup = renderToStaticMarkup(
      <MarkdownContent content={'安全内容\n\n<script>alert("unsafe")</script>'} />,
    );

    expect(markup).toContain('安全内容');
    expect(markup).not.toContain('<script>');
  });
});
