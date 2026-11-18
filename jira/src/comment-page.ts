import {Type} from 'typebox';
import {adfToText, type JiraComment} from './jira.ts';

const PAGE_BYTES = 40 * 1024;

export const commentPageSchema = Type.Object({
  startAt: Type.Integer(),
  total: Type.Optional(Type.Integer()),
  nextStartAt: Type.Optional(Type.Integer()),
  truncated: Type.Boolean(),
  comments: Type.Array(
    Type.Object({
      id: Type.Optional(Type.String()),
      author: Type.Optional(Type.String()),
      created: Type.Optional(Type.String()),
      updated: Type.Optional(Type.String()),
      bodyText: Type.String(),
      bodyTruncated: Type.Boolean(),
    }),
  ),
});

export function buildCommentPage(
  response: {comments?: JiraComment[]; total?: number},
  startAt: number,
  requested: number,
) {
  const source = response.comments ?? [];
  const comments = [];
  let bytes = 0;
  for (const raw of source) {
    const body = adfToText(raw.body).trimEnd();
    let bodyText = body.slice(0, 6000);
    if (/[\uD800-\uDBFF]$/.test(bodyText)) bodyText = bodyText.slice(0, -1);
    const row = {
      ...(raw.id === undefined ? {} : {id: raw.id}),
      ...(raw.author?.displayName === undefined
        ? {}
        : {author: raw.author.displayName}),
      ...(raw.created === undefined ? {} : {created: raw.created}),
      ...(raw.updated === undefined ? {} : {updated: raw.updated}),
      bodyText,
      bodyTruncated: bodyText.length < body.length,
    };
    bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
    if (comments.length && bytes > PAGE_BYTES) break;
    comments.push(row);
  }
  const end = startAt + comments.length;
  const truncated =
    comments.length < source.length ||
    comments.some(comment => comment.bodyTruncated);
  const hasNext =
    comments.length > 0 &&
    (comments.length < source.length ||
      (response.total !== undefined
        ? end < response.total
        : source.length >= requested));
  return {
    startAt,
    ...(response.total === undefined ? {} : {total: response.total}),
    ...(hasNext ? {nextStartAt: end} : {}),
    truncated,
    comments,
  };
}
