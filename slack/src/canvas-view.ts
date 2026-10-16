import {parseFragment, type DefaultTreeAdapterMap} from 'parse5';
import type {CanvasSnapshot} from './canvas.ts';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
interface Link {
  text: string;
  url: string;
}
export interface CanvasBlock {
  id?: string;
  type: string;
  headingPath: string[];
  text: string;
  textTruncated: boolean;
  links: Link[];
  linksTruncated: boolean;
  table?: {number: number; row: number; column: number};
}
interface Section {
  block: CanvasBlock;
  start?: number;
  end?: number;
}
interface Position {
  number: number;
  row: number;
  column: number;
}
const BLOCK_TAGS = new Set([
  'h1',
  'h2',
  'h3',
  'p',
  'li',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'table',
]);
const CONTAINERS = new Set(['div', 'ul', 'ol', 'table', 'blockquote']);
const IGNORED = new Set(['script', 'style', 'template']);
function element(node: Node): node is Element {
  return 'tagName' in node;
}
function children(node: Node): Node[] {
  return 'childNodes' in node ? node.childNodes : [];
}
function attribute(node: Element, name: string): string | undefined {
  return node.attrs.find(attr => attr.name === name)?.value;
}
function text(node: Node): string {
  if (node.nodeName === '#text')
    return (node as DefaultTreeAdapterMap['textNode']).value;
  if (element(node) && IGNORED.has(node.tagName)) return '';
  if (element(node) && node.tagName === 'br') return '\n';
  if (element(node) && node.tagName === 'img')
    return attribute(node, 'alt') ?? '[image]';
  const value = children(node).map(text).join('');
  return (
    value +
    (element(node) && ['p', 'li', 'tr', 'pre'].includes(node.tagName)
      ? '\n'
      : '')
  );
}
function readable(node: Node): string {
  return text(node)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function descendantsHaveId(node: Node): boolean {
  return children(node).some(
    child =>
      (element(child) && Boolean(attribute(child, 'id'))) ||
      descendantsHaveId(child),
  );
}
function links(node: Node): Link[] {
  const result: Link[] = [];
  function visit(child: Node): void {
    if (element(child)) {
      if (IGNORED.has(child.tagName)) return;
      const href = attribute(child, 'href');
      if (href && /^(https?:\/\/|slack:\/\/)/i.test(href))
        result.push({text: readable(child).slice(0, 100), url: href});
    }
    for (const nested of children(child)) visit(nested);
  }
  visit(node);
  return result;
}

// Read-only presentation. Never convert these previews back into replacement Markdown.
export function canvasView(snapshot: CanvasSnapshot) {
  const root = parseFragment(snapshot.html, {sourceCodeLocationInfo: true});
  const blocks: CanvasBlock[] = [];
  const sections = new Map<string, Section>();
  const ambiguousIds = new Set<string>();
  const headings: string[] = [];
  let tableNumber = 0;
  function visit(
    node: Node,
    tableState?: Position,
    cell?: Position,
    parentShown = false,
  ): void {
    if (!element(node)) {
      for (const child of children(node))
        visit(child, tableState, cell, parentShown);
      return;
    }
    if (IGNORED.has(node.tagName)) return;
    const id = attribute(node, 'id');
    const heading = /^h([123])$/.exec(node.tagName);
    if (heading) {
      const level = Number(heading[1]);
      headings.length = level;
      headings[level - 1] = readable(node).slice(0, 200);
    }
    if (node.tagName === 'table') {
      tableState = {number: ++tableNumber, row: 0, column: 0};
      cell = undefined;
    }
    if (node.tagName === 'tr' && tableState) {
      tableState.row++;
      tableState.column = 0;
    }
    if (['td', 'th'].includes(node.tagName) && tableState) {
      tableState.column++;
      cell = {...tableState};
    }
    const hasNestedIds = descendantsHaveId(node);
    let shown = false;
    if (id || (BLOCK_TAGS.has(node.tagName) && !hasNestedIds && !parentShown)) {
      const content = readable(node);
      const references = links(node);
      const block: CanvasBlock = {
        ...(id ? {id} : {}),
        type: cell
          ? 'table_cell'
          : heading
            ? node.tagName
            : node.tagName === 'li'
              ? 'list_item'
              : node.tagName === 'p'
                ? 'paragraph'
                : node.tagName,
        headingPath: headings.filter(Boolean),
        text: content.slice(0, 1000),
        textTruncated: content.length > 1000,
        links: references.filter(link => link.url.length <= 500).slice(0, 5),
        linksTruncated:
          references.length > 5 ||
          references.some(link => link.url.length > 500),
        ...(cell ? {table: {...cell}} : {}),
      };
      // Slack repeats list-item IDs on inner spans; keep the outermost exact block.
      const duplicate = id && sections.has(id);
      if (id && duplicate) {
        const prior = sections.get(id)!;
        const start = node.sourceCodeLocation?.startOffset;
        const end = node.sourceCodeLocation?.endOffset;
        if (
          start === undefined ||
          end === undefined ||
          prior.start === undefined ||
          prior.end === undefined ||
          start < prior.start ||
          end > prior.end
        )
          ambiguousIds.add(id);
      }
      if (id && !duplicate)
        sections.set(id, {
          block,
          start: node.sourceCodeLocation?.startOffset,
          end: node.sourceCodeLocation?.endOffset,
        });
      if (
        !duplicate &&
        content &&
        !(CONTAINERS.has(node.tagName) && hasNestedIds)
      ) {
        blocks.push(block);
        shown = true;
      }
    }
    for (const child of children(node))
      visit(child, tableState, cell, parentShown || shown);
  }
  visit(root);
  if (!blocks.length) {
    const content = readable(root);
    if (content)
      blocks.push({
        type: 'unmapped',
        headingPath: [],
        text: content.slice(0, 1000),
        textTruncated: content.length > 1000,
        links: [],
        linksTruncated: false,
      });
  }
  return {blocks, sections, ambiguousIds};
}

export function canvasBlockPage(
  snapshot: CanvasSnapshot,
  offset = 0,
  limit = 50,
) {
  const {blocks} = canvasView(snapshot);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > blocks.length)
    throw new Error('blockOffset must be a valid Canvas block offset.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
    throw new Error('blockLimit must be 1–50.');
  const page: CanvasBlock[] = [];
  let bytes = 0;
  for (const block of blocks.slice(offset, offset + limit)) {
    const size = Buffer.byteLength(JSON.stringify(block, null, 2));
    if (page.length && bytes + size > 30000) break;
    page.push(block);
    bytes += size;
  }
  const end = offset + page.length;
  return {
    canvasId: snapshot.canvasId,
    title: snapshot.title,
    revision: snapshot.revision,
    format: 'blocks',
    blockOffset: offset,
    totalBlocks: blocks.length,
    nextBlockOffset: end < blocks.length ? end : undefined,
    hasMore: end < blocks.length,
    isPartial: offset > 0 || end < blocks.length,
    contentTruncated: page.some(
      block => block.textTruncated || block.linksTruncated,
    ),
    note: 'Readable previews, not replacement Markdown. For complete content/links of a clipped block use format=html and sectionId with this expectedRevision.',
    blocks: page,
  };
}

export function canvasSectionHtml(
  snapshot: CanvasSnapshot,
  sectionId: string,
): string {
  const section = canvasView(snapshot).sections.get(sectionId);
  if (!section || section.start === undefined || section.end === undefined)
    throw new Error(
      'Section not found in this Canvas export. Read/lookup again before editing.',
    );
  return snapshot.html.slice(section.start, section.end);
}

export function enrichSectionMatches(
  snapshot: CanvasSnapshot,
  ids: {id: string}[],
) {
  const {sections} = canvasView(snapshot);
  return ids.map(({id}) => {
    const section = sections.get(id);
    if (!section) return {id, foundInSnapshot: false};
    const {block} = section;
    return {
      id,
      foundInSnapshot: true,
      type: block.type,
      headingPath: block.headingPath,
      ...(block.table ? {table: block.table} : {}),
      preview: block.text.slice(0, 500),
      previewTruncated: block.textTruncated || block.text.length > 500,
    };
  });
}
