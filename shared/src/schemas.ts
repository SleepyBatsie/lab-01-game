import { z } from 'zod';
import { asRoomId, asSeqNumber } from './types.ts';

export const JoinMessageSchema = z.object({
  type: z.literal('join'),
  roomId: z.string().trim().min(1).max(32).transform(asRoomId),
  nickname: z.string().trim().max(20).optional()
});

export const InputMessageSchema = z.object({
  type: z.literal('input'),
  seq: z.number().int().nonnegative().transform(asSeqNumber),
  left: z.boolean(),
  right: z.boolean(),
  thrust: z.boolean(),
  fire: z.boolean(),
  clientTs: z.number().optional()
});

export const ProtocolModeMessageSchema = z.object({
  type: z.literal('protocol_mode'),
  binary: z.boolean()
});

export const PingRttMessageSchema = z.object({
  type: z.literal('ping_rtt'),
  clientTs: z.number()
});

export const ChatMessageSchema = z.object({
  type: z.literal('chat'),
  text: z.string().trim().min(1).max(500)
});

export const LeaveMessageSchema = z.object({
  type: z.literal('leave')
});

export const ClientMessageSchema = z.discriminatedUnion('type', [
  JoinMessageSchema,
  InputMessageSchema,
  ProtocolModeMessageSchema,
  PingRttMessageSchema,
  ChatMessageSchema,
  LeaveMessageSchema
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export type ParseResult =
  | { readonly ok: true; readonly data: ClientMessage }
  | { readonly ok: false; readonly reason: string };

// Приймає unknown, не кидає винятків при битому JSON або невалідній схемі
export function parseClientMessage(raw: unknown): ParseResult {
  let parsedJson: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return { ok: false, reason: 'Invalid JSON' };
    }
  }

  const result = ClientMessageSchema.safeParse(parsedJson);
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      ok: false,
      reason: issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid message schema'
    };
  }

  return { ok: true, data: result.data };
}