import { z } from "zod";

export const SessionTokenSchema = z.string().min(1);
export const RequestIdSchema = z.string().min(1);

const BoundsSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
  })
  .strict();

const TransformSchema = z
  .object({
    translateX: z.number().optional(),
    translateY: z.number().optional(),
    width: z.number().nonnegative().optional(),
    height: z.union([z.number().nonnegative(), z.literal("auto")]).optional(),
  })
  .strict();

const TextStyleSchema = z
  .object({
    fontSize: z.string().optional(),
    color: z.string().optional(),
    fontWeight: z.string().optional(),
    textAlign: z.enum(["left", "center", "right"]).optional(),
  })
  .strict();

const SelectionPayloadSchema = z
  .object({
    targetId: z.string(),
    path: z.array(z.string()),
    bounds: BoundsSchema,
    kind: z.enum(["text", "image", "svg", "container"]),
    transform: z
      .object({
        translateX: z.number(),
        translateY: z.number(),
      })
      .strict()
      .optional(),
    snapTargets: z
      .array(
        z
          .object({
            axis: z.enum(["x", "y"]),
            value: z.number(),
            kind: z.string(),
          })
          .strict(),
      )
      .optional(),
    text: z.string().nullable().optional(),
    styles: TextStyleSchema.nullable().optional(),
  })
  .strict();

export const ElementPatchSchema = TransformSchema.extend({
  text: z.string().optional(),
  fontSize: z.string().optional(),
  color: z.string().optional(),
  fontWeight: z.string().optional(),
  textAlign: z.enum(["left", "center", "right"]).optional(),
}).strict();

export const SerializableEditCommandSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    kind: z.enum([
      "patch",
      "duplicate-object",
      "delete-object",
      "reorder-slide",
      "duplicate-slide",
      "delete-slide",
    ]),
    targetId: z.string().min(1),
    before: z.json(),
    after: z.json(),
  })
  .strict();

export const ElementOverrideTableSchema = z.record(
  z.string(),
  z.record(z.string(), z.string()),
);

const MutationSuccessSchema = z
  .object({
    type: z.literal("hse:mutation-ack"),
    token: SessionTokenSchema,
    requestId: RequestIdSchema,
    status: z.literal("success"),
    result: z
      .object({
        command: SerializableEditCommandSchema,
        overrides: ElementOverrideTableSchema,
        checkpointHtml: z.string().min(1),
        slideCount: z.number().int().nonnegative(),
        activeSlideIndex: z.number().int().nonnegative(),
        selection: SelectionPayloadSchema.nullable(),
      })
      .strict(),
  })
  .strict();

const MutationErrorSchema = z
  .object({
    type: z.literal("hse:mutation-ack"),
    token: SessionTokenSchema,
    requestId: RequestIdSchema,
    status: z.literal("error"),
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export const FrameToParentMessageSchema = z.union([
  z
    .object({
      type: z.literal("hse:ready"),
      token: SessionTokenSchema,
      slideCount: z.number().int(),
    })
    .strict(),
  SelectionPayloadSchema.extend({
    type: z.literal("hse:selection"),
    token: SessionTokenSchema,
  }).strict(),
  z
    .object({
      type: z.literal("hse:editor-key"),
      token: SessionTokenSchema,
      key: z.string(),
      altKey: z.boolean(),
      ctrlKey: z.boolean(),
      metaKey: z.boolean(),
      shiftKey: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("hse:inline-text-commit"),
      token: SessionTokenSchema,
      targetId: z.string().min(1),
      before: z.string(),
      after: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("hse:inline-text-flush"),
      token: SessionTokenSchema,
      requestId: RequestIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("hse:document"),
      token: SessionTokenSchema,
      requestId: RequestIdSchema,
      html: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("hse:error"),
      token: SessionTokenSchema,
      kind: z.enum(["error", "unhandledrejection"]),
      message: z.string(),
      slideIndex: z.number().int().nonnegative().nullable(),
    })
    .strict(),
  MutationSuccessSchema,
  MutationErrorSchema,
]);

const MutationRequestFields = {
  token: SessionTokenSchema,
  requestId: RequestIdSchema,
  commandId: z.string().min(1),
  label: z.string().min(1),
};

export const ParentToFrameMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("hse:select-depth"),
      token: SessionTokenSchema,
      depth: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("hse:select-slide"),
      token: SessionTokenSchema,
      slideIndex: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("hse:commit-inline-edit"),
      token: SessionTokenSchema,
      requestId: RequestIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("hse:edit-at-point"),
      token: SessionTokenSchema,
      x: z.number(),
      y: z.number(),
    })
    .strict(),
  z
    .object({
      type: z.literal("hse:apply-patch"),
      ...MutationRequestFields,
      targetId: z.string().min(1),
      patch: ElementPatchSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("hse:duplicate-object"),
      ...MutationRequestFields,
      targetId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("hse:delete-object"),
      ...MutationRequestFields,
      targetId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("hse:reorder-slide"),
      ...MutationRequestFields,
      fromIndex: z.number().int().nonnegative(),
      toIndex: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("hse:duplicate-slide"),
      ...MutationRequestFields,
      slideIndex: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("hse:delete-slide"),
      ...MutationRequestFields,
      slideIndex: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("hse:apply-history"),
      token: SessionTokenSchema,
      requestId: RequestIdSchema,
      direction: z.enum(["before", "after"]),
      command: SerializableEditCommandSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("hse:request-document"),
      token: SessionTokenSchema,
      requestId: RequestIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("hse:reset"),
      token: SessionTokenSchema,
    })
    .strict(),
]);

export type FrameToParentMessage = z.infer<
  typeof FrameToParentMessageSchema
>;
export type ParentToFrameMessage = z.infer<
  typeof ParentToFrameMessageSchema
>;
export type MutationAck = Extract<
  FrameToParentMessage,
  { type: "hse:mutation-ack" }
>;
export type MutationSuccess = Extract<MutationAck, { status: "success" }>;
