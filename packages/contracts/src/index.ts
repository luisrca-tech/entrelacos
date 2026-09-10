import { z } from "zod";

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("entrelacos-api"),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const apiProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
});

export type ApiProblem = z.infer<typeof apiProblemSchema>;
