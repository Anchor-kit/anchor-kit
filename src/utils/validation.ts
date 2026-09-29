export * from './validation-helpers.ts';

export const SecurityConfigSchema = z.object({
  sep10SigningKey: z.string().trim().min(1),
  interactiveJwtSecret: z.string().trim().min(1),
  distributionAccountSecret: z.string().trim().min(1),
});
