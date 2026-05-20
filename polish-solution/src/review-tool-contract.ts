import {Type} from 'typebox';

export const REVIEW_TOOL_PARAMS = Type.Object({
  baseRef: Type.Optional(
    Type.String({
      description:
        'Optional git base ref to diff against. Defaults to origin/main when available, otherwise main.',
    }),
  ),
});
