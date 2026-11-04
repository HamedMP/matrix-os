import { z } from "zod/v4";
import {
  BotRoutineIdSchema, BotRoutineCenterQuerySchema, BotRoutineCenterResponseSchema,
  BotRoutineDetailResponseSchema, BotRoutineEditRequestSchema, BotRoutineEditResponseSchema, BotRoutineControlSchema,
  type BotRoutineCenterQuery, type BotRoutineCenterResponse, type BotRoutineDetailResponse,
  type BotRoutineEditRequest, type BotInteraction,
} from "@matrix-os/contracts";

type Control = z.infer<typeof BotRoutineControlSchema>;
export interface BotRoutineClient {
  list(query?: BotRoutineCenterQuery): Promise<BotRoutineCenterResponse>;
  detail(id: string): Promise<BotRoutineDetailResponse>;
  control(id: string, input: Control): Promise<{ routineId: string; status: Control["status"]; revision: number }>;
  review(id: string, input: BotRoutineEditRequest): Promise<{ interaction: BotInteraction }>;
}
const controlReceipt = z.object({ routineId: BotRoutineIdSchema, status: BotRoutineControlSchema.shape.status,
  revision: z.number().int().positive() }).strict();

/** The parent transport supplies authentication, timeouts and safe HTTP errors. */
export function createBotRoutineClient(request: (path: string, method: "GET" | "POST", body?: unknown) => Promise<unknown>): BotRoutineClient {
  const path = (id: string) => `/api/bot-routines/${encodeURIComponent(BotRoutineIdSchema.parse(id))}`;
  async function parsed<T>(schema: z.ZodType<T>, operation: () => Promise<unknown>): Promise<T> {
    const result = schema.safeParse(await operation());
    if (!result.success) throw new Error("Schedules are temporarily unavailable.");
    return result.data;
  }
  return {
    list: (input = {}) => {
      const query = BotRoutineCenterQuerySchema.parse(input);
      const params = new URLSearchParams(query as Record<string, string>);
      return parsed(BotRoutineCenterResponseSchema, () => request(`/api/bot-routines${params.size ? `?${params}` : ""}`, "GET"));
    },
    detail: id => parsed(BotRoutineDetailResponseSchema, () => request(path(id), "GET")),
    control: (id, input) => parsed(controlReceipt, () => request(`${path(id)}/control`, "POST", BotRoutineControlSchema.parse(input))),
    review: (id, input) => parsed(BotRoutineEditResponseSchema, () => request(`${path(id)}/review`, "POST", BotRoutineEditRequestSchema.parse(input))),
  };
}
