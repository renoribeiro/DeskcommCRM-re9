/**
 * POST /api/internal/agents/run — runtime entrypoint for ai_agent_runs (S-13.08).
 *
 * Auth:
 *   - Header `x-internal-secret: <INTERNAL_SECRET>` (preferred), OR
 *   - Header `authorization: Bearer <INTERNAL_SECRET>` (legacy compat).
 *
 * Body: { run_id: uuid, sample_message?, sample_contact? }
 *   sample_message/sample_contact only honored when the run row is_dry_run=true.
 *
 * `maxDuration=300` is declared below (`export const maxDuration`) and nowhere
 * else for this route — agent loops with multiple tool calls can stretch close
 * to that budget. To check instead of trusting this line:
 * `git grep -n maxDuration -- app/api/internal`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { runAgent } from "@/lib/ai/runtime/agent";
import { ok, fail } from "@/lib/api/wrappers";
import { timingSafeStringEqual } from "@/lib/auth/cron-auth";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const bodySchema = z.object({
  run_id: z.string().uuid(),
  sample_message: z.string().min(1).max(4000).optional(),
  sample_contact: z
    .object({
      name: z.string().max(120).optional(),
      phone: z.string().max(40).optional(),
    })
    .optional(),
});

/**
 * Comparação pelo helper compartilhado (auditoria P10): a versão à mão daqui
 * saía cedo quando os tamanhos diferiam — o tempo de resposta contava o tamanho
 * do segredo. `timingSafeStringEqual` compara os SHA-256 dos dois lados, de
 * tamanho fixo.
 */
function authorize(req: NextRequest): boolean {
  const expected = env.INTERNAL_SECRET;
  if (!expected) return false;
  const headerSecret = req.headers.get("x-internal-secret");
  if (headerSecret && timingSafeStringEqual(headerSecret, expected)) return true;
  const authz = req.headers.get("authorization");
  if (authz) {
    const match = /^Bearer\s+(.+)$/i.exec(authz.trim());
    if (match && timingSafeStringEqual(match[1]!.trim(), expected)) return true;
  }
  return false;
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!authorize(req)) {
    return fail("unauthenticated", "Internal secret missing or invalid.", 401, {
      requestId,
      details: { meta: { requestId } },
    });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, {
      requestId,
      details: { meta: { requestId } },
    });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: { meta: { requestId }, errors: parsed.error.flatten() },
    });
  }

  try {
    const result = await runAgent({
      runId: parsed.data.run_id,
      override: {
        sampleMessage: parsed.data.sample_message,
        sampleContact: parsed.data.sample_contact,
      },
    });
    return ok(result, { requestId, meta: { requestId } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown_error";
    return fail("internal_error", message, 500, {
      requestId,
      details: { meta: { requestId } },
    });
  }
}
