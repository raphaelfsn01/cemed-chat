/**
 * Garante que todo contato atendido tenha um card no funil — a condição para a
 * triagem do agente ficar registrada em algum lugar.
 *
 * ⚠️ Por que NÃO pela regra de automação `create_or_move_lead`, que já existe:
 * naquela ação, contato COM lead cai no ramo de MOVER
 * (`lib/automation/actions/create-or-move-lead.ts:39`). Numa regra em
 * `message.received` isso arrastaria o card de volta ao estágio inicial a cada
 * mensagem que o paciente mandasse, desfazendo a triagem. E não há como
 * condicionar a regra a "só quando não existe lead": os operadores são
 * `eq`/`neq`/`contains` e, pelo tratamento de nulo em `conditions.ts:25`, a
 * condição dispararia nos dois casos ou em nenhum. Medido, não suposto.
 *
 * Aqui é criar-se-não-existe, sem mover nada — e roda dentro do turno do engine,
 * que é o processo que já está de pé, em vez de depender do dispatcher do
 * event_log (que neste ambiente não roda: os eventos ficam `pending`).
 *
 * Reusa `createLeadHandler` (o mesmo caminho de REST/MCP/automação), então audit,
 * eventos e validação vêm de graça em vez de duplicados aqui.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { createLeadHandler } from "@/app/api/v1/leads/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { resolveActiveLeadForContact } from "@/lib/leads/active-lead";

export interface ResultadoGarantia {
  /** id do negócio ativo — criado agora ou o que já existia. null = não deu. */
  leadId: string | null;
  motivo: "ja_existia" | "criado" | "ambiguo" | "sem_funil" | "indisponivel" | "falha_de_escrita";
  detalhe?: string;
}

/**
 * Devolve o negócio ativo do contato, criando um no funil padrão se não houver.
 *
 * Contato com DOIS negócios abertos não ganha um terceiro: devolve `ambiguo` sem
 * escrever. Criar mais um só pioraria a ambiguidade que já existe, e a decisão de
 * qual vale é humana.
 */
export async function garanteNegocioDoContato(
  admin: SupabaseClient,
  input: { organizationId: string; contactId: string; requestId: string; agentId: string },
): Promise<ResultadoGarantia> {
  // O erro é LIDO: supabase-js devolve { data: null, error } em falha de rede.
  // Descartá-lo faria banco fora virar "não tem lead" → criaria um DUPLICADO a
  // cada mensagem enquanto o banco oscilasse.
  const { data: leadRows, error: erroLeads } = await admin
    .from("crm_leads")
    .select("id, organization_id, pipeline_id, status, created_at, last_activity_at")
    .eq("organization_id", input.organizationId)
    .eq("contact_id", input.contactId);
  if (erroLeads) {
    return { leadId: null, motivo: "indisponivel", detalhe: erroLeads.message };
  }

  const rota = resolveActiveLeadForContact(
    ((leadRows ?? []) as Array<{
      id: string;
      organization_id: string;
      pipeline_id: string;
      status: string;
      created_at: string;
      last_activity_at: string | null;
    }>).map((c) => ({
      id: c.id,
      organization_id: c.organization_id,
      pipeline_id: c.pipeline_id,
      status: c.status as "open" | "won" | "lost",
      created_at: c.created_at,
      last_activity_at: c.last_activity_at,
    })),
  );
  if (rota.routed) return { leadId: rota.leadId, motivo: "ja_existia" };
  if (rota.reason !== "no_open_lead") {
    return { leadId: null, motivo: "ambiguo" };
  }

  const destino = await resolveFunilDeEntrada(admin, input.organizationId);
  if (destino === null) {
    return { leadId: null, motivo: "sem_funil", detalhe: "organização sem pipeline padrão com estágios" };
  }

  const { data: contato } = await admin
    .from("contacts")
    .select("display_name, name, phone_number")
    .eq("organization_id", input.organizationId)
    .eq("id", input.contactId)
    .maybeSingle();
  const c = (contato ?? {}) as { display_name?: string | null; name?: string | null; phone_number?: string | null };

  const ctx: HandlerCtx = {
    organization_id: input.organizationId,
    // `id` = quem agiu (correlação no audit); `agent_id` = a FK do agente na
    // timeline. São campos diferentes de propósito — ver o comentário em `Actor`.
    actor: { type: "ai_agent", id: input.agentId, role: "agent", agent_id: input.agentId },
    requestId: input.requestId,
  };
  try {
    const criado = await createLeadHandler(admin as never, ctx, {
      pipeline_id: destino.pipelineId,
      stage_id: destino.stageId,
      // Sem nome ainda (contato novo do WhatsApp) o telefone é o melhor rótulo —
      // é o que a atendente usa para reconhecer quem é.
      title: c.display_name ?? c.name ?? c.phone_number ?? "Contato do WhatsApp",
      contact_id: input.contactId,
      source: "ai_agent",
    } as Parameters<typeof createLeadHandler>[2]);
    return { leadId: String(criado.id), motivo: "criado" };
  } catch (err) {
    return {
      leadId: null,
      motivo: "falha_de_escrita",
      detalhe: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Funil de entrada da org: o pipeline `is_default` não arquivado, e nele o estágio
 * de menor `position` que não seja de ganho/perda — entrar direto num terminal
 * marcaria como fechado quem acabou de escrever.
 */
async function resolveFunilDeEntrada(
  admin: SupabaseClient,
  organizationId: string,
): Promise<{ pipelineId: string; stageId: string } | null> {
  const { data: pipe } = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("is_default", true)
    .eq("is_archived", false)
    .maybeSingle();
  if (!pipe) return null;

  const { data: stages } = await admin
    .from("crm_stages")
    .select("id, position, is_won, is_lost, is_archived")
    .eq("pipeline_id", (pipe as { id: string }).id)
    .order("position", { ascending: true });

  const entrada = ((stages ?? []) as Array<{
    id: string;
    is_won: boolean;
    is_lost: boolean;
    is_archived: boolean;
  }>).find((s) => !s.is_won && !s.is_lost && !s.is_archived);
  if (!entrada) return null;

  return { pipelineId: (pipe as { id: string }).id, stageId: entrada.id };
}
