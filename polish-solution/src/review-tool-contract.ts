import {Type} from 'typebox';

export const REVIEW_TOOL_PARAMS = Type.Object({
  worktreePath: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        'Optional worktree directory to review, absolute or relative to the session directory. Defaults to the session directory; does not move the session. Must be inside a git repository or worktree.',
    }),
  ),
  baseRef: Type.Optional(
    Type.String({
      description:
        'Optional git base ref to diff against. Defaults to origin/main when available, otherwise main.',
    }),
  ),
  largeDiff: Type.Optional(
    Type.Boolean({
      description:
        'Opt in to reviewing diffs up to 10,000 lines or 250 KiB instead of the default 6,000 lines or 150 KiB. Larger reviews cost more, take longer, and may reduce review quality through context dilution.',
    }),
  ),
});
