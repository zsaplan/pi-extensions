// Adapted from slack/src/message-layout.ts at 1f86b56; frozen with this runtime.
import {Type, type Static} from 'typebox';
import {Check} from 'typebox/value';

const closed = {additionalProperties: false};
const textObject = (maxLength: number) =>
  Type.Object(
    {
      type: Type.Union([Type.Literal('plain_text'), Type.Literal('mrkdwn')]),
      text: Type.String({minLength: 1, maxLength}),
      verbatim: Type.Optional(Type.Literal(true)),
    },
    closed,
  );

// A deliberately small, static subset. Markdown handles narrative formatting;
// these blocks add dashboard fields and explicitly aligned table columns.
export const MESSAGE_BLOCKS_SCHEMA = Type.Array(
  Type.Union([
    Type.Object(
      {
        type: Type.Literal('header'),
        text: Type.Object(
          {
            type: Type.Literal('plain_text'),
            text: Type.String({minLength: 1, maxLength: 150}),
          },
          closed,
        ),
      },
      closed,
    ),
    Type.Object(
      {
        type: Type.Literal('section'),
        text: Type.Optional(textObject(3000)),
        fields: Type.Optional(
          Type.Array(textObject(2000), {minItems: 1, maxItems: 10}),
        ),
      },
      closed,
    ),
    Type.Object({type: Type.Literal('divider')}, closed),
    Type.Object(
      {
        type: Type.Literal('context'),
        elements: Type.Array(textObject(3000), {minItems: 1, maxItems: 10}),
      },
      closed,
    ),
    Type.Object(
      {
        type: Type.Literal('table'),
        rows: Type.Array(
          Type.Array(
            Type.Union([
              Type.Object(
                {
                  type: Type.Literal('raw_text'),
                  text: Type.String({maxLength: 10000}),
                },
                closed,
              ),
              Type.Object(
                {
                  type: Type.Literal('raw_number'),
                  value: Type.Number(),
                  text: Type.String({minLength: 1, maxLength: 10000}),
                },
                closed,
              ),
            ]),
            {minItems: 1, maxItems: 20},
          ),
          {minItems: 1, maxItems: 100},
        ),
        column_settings: Type.Optional(
          Type.Array(
            Type.Union([
              Type.Null(),
              Type.Object(
                {
                  align: Type.Optional(
                    Type.Union([
                      Type.Literal('left'),
                      Type.Literal('center'),
                      Type.Literal('right'),
                    ]),
                  ),
                  is_wrapped: Type.Optional(Type.Boolean()),
                },
                closed,
              ),
            ]),
            {maxItems: 20},
          ),
        ),
      },
      closed,
    ),
  ]),
  {
    minItems: 1,
    maxItems: 50,
    description:
      'Static Slack blocks for dashboards: header, section (text/metric fields), divider, context, or table (raw_text/raw_number cells). Mutually exclusive with markdown. No interactive elements. Supply all essential content in text too.',
  },
);

export const RICH_MESSAGE_PROPERTIES = {
  markdown: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 12000,
      description:
        'Standard Markdown rendered by Slack, including headings, lists, dividers and tables. Mutually exclusive with blocks. text is the accessible fallback and must include all essential information. Rich messages cannot be split.',
    }),
  ),
  blocks: Type.Optional(MESSAGE_BLOCKS_SCHEMA),
};

export type StaticBlocks = Static<typeof MESSAGE_BLOCKS_SCHEMA>;
export type MessageBlocks =
  | StaticBlocks
  | Array<{type: 'markdown'; text: string}>;

interface LayoutOptions {
  text: string;
  markdown?: string;
  blocks?: StaticBlocks;
  mrkdwn?: boolean;
  longTextMode?: string;
  clearBlocks?: boolean;
}

export function prepareMessageLayout(options: LayoutOptions):
  | {
      blocks: MessageBlocks;
      format: 'markdown' | 'blocks';
      preview: string;
    }
  | undefined {
  const {markdown, blocks} = options;
  if (markdown === undefined && blocks === undefined) return undefined;
  if (markdown !== undefined && blocks !== undefined) {
    throw new Error('Supply markdown or blocks, not both.');
  }
  if (options.clearBlocks) {
    throw new Error('clearBlocks cannot be combined with markdown or blocks.');
  }
  if (options.mrkdwn === false) {
    throw new Error('mrkdwn=false cannot be combined with a rich layout.');
  }
  if (options.longTextMode?.trim().toLowerCase() === 'split') {
    throw new Error(
      'Rich messages cannot be split. Shorten the report instead.',
    );
  }
  if (!options.text.trim() || options.text.length > 4000) {
    throw new Error(
      'Rich messages require a nonblank text fallback of at most 4000 characters containing all essential information.',
    );
  }

  let prepared: MessageBlocks;
  if (markdown !== undefined) {
    if (!markdown.trim() || markdown.length > 12000) {
      throw new Error('markdown must contain 1–12000 characters.');
    }
    prepared = [{type: 'markdown', text: markdown}];
  } else {
    if (!Check(MESSAGE_BLOCKS_SCHEMA, blocks)) {
      throw new Error(
        'Invalid static blocks. Use the supported schema and limits; interactive elements are not allowed.',
      );
    }
    let tableCharacters = 0;
    let characters = 0;
    for (const block of blocks) {
      switch (block.type) {
        case 'header':
          characters += block.text.text.length;
          break;
        case 'section':
          if (!block.text && !block.fields?.length) {
            throw new Error('A section requires text or fields.');
          }
          characters +=
            (block.text?.text.length ?? 0) +
            (block.fields ?? []).reduce(
              (sum, field) => sum + field.text.length,
              0,
            );
          break;
        case 'context':
          characters += block.elements.reduce(
            (sum, element) => sum + element.text.length,
            0,
          );
          break;
        case 'table': {
          const columns = block.rows[0].length;
          if (block.rows.some(row => row.length !== columns)) {
            throw new Error('Table rows must have the same number of cells.');
          }
          const size = block.rows
            .flat()
            .reduce((sum, cell) => sum + cell.text.length, 0);
          tableCharacters += size;
          characters += size;
          break;
        }
      }
    }
    if (tableCharacters > 10000 || characters > 12000) {
      throw new Error(
        'Rich layouts allow 12000 content characters, including at most 10000 across all table cells.',
      );
    }
    if (JSON.stringify(blocks, null, 2).length > 50000) {
      throw new Error(
        'Static block JSON exceeds the 50000-character preview limit.',
      );
    }
    prepared = structuredClone(blocks);
  }
  return {
    blocks: prepared,
    format: markdown !== undefined ? 'markdown' : 'blocks',
    // Never approve just a short fallback while hiding the actual rich payload.
    preview: `Accessible fallback:\n${options.text}\n\nRich content source (not a Slack visual preview):\n${markdown ?? JSON.stringify(prepared, null, 2)}`,
  };
}
