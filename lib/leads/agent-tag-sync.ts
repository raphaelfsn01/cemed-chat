/**
 * Etiquetagem do card do CRM pelo agente — a linha de serviço que a triagem
 * identificou.
 *
 * ⚠️ Por que o agente NÃO faz isso pelas tools MCP (`crm_list_leads` +
 * `crm_update_lead`): lá o modelo teria de listar os negócios, escolher o certo e
 * copiar um UUID — quatro passos onde ele falha em SILÊNCIO (a conversa sai
 * perfeita e a tag simplesmente não chega, e ninguém descobre até auditar o
 * funil). Além disso `crm_update_lead` SUBSTITUI o array de tags
 * (`app/api/v1/leads/_handler.ts:373`), então o modelo apagaria a tag que a
 * atendente pôs à mão. Aqui o modelo só diz QUAL linha de serviço é; identificar
 * o card e preservar o que já existe é do servidor.
 *
 * REUSA `resolveActiveLeadForContact` — o mesmo resolvedor do espelho de estágio
 * (`agent-stage-sync.ts`). Um segundo resolvedor de "qual negócio deste contato"
 * seriam duas fontes que começam iguais e divergem no primeiro ajuste. Contato com
 * dois negócios abertos NÃO é etiquetado: marcar o card errado é pior que não
 * marcar, e o rótulo `ambiguo` diz isso a quem lê.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveActiveLeadForContact } from "@/lib/leads/active-lead";

export interface ResultadoDaEtiquetagem {
  etiquetou: boolean;
  /**
   * Cada rótulo diz a verdade sobre o que aconteceu — a mesma disciplina de
   * `ResultadoDaSincronizacao`: estado legítimo do produto (`sem_negocio`,
   * `ambiguo`, `ja_tem`), configuração (`fora_do_vocabulario`) e incidente
   * (`indisponivel`, `falha_de_escrita`) não podem compartilhar rótulo, senão
   * banco fora vira rotina.
   */
  motivo:
    | "etiquetado"
    | "ja_tem"
    | "sem_negocio"
    | "ambiguo"
    | "fora_do_vocabulario"
    | "indisponivel"
    | "falha_de_escrita";
  leadId?: string;
  /** tags do card DEPOIS da operação (união), para o chamador devolver ao modelo. */
  tags?: string[];
  detalhe?: string;
}

/**
 * Aplica tags ao negócio ativo do contato, em UNIÃO com as que já existem.
 *
 * As tags aceitas são as `canonical_tags` do pipeline do card — o vocabulário que
 * o próprio produto já usa para decidir o ponto colorido no Kanban
 * (`lib/kanban/card-state.ts`). Validar contra ele evita a deriva que estraga
 * relatório em silêncio ("exame" vs "exames" vs "Exames"), e mantém UMA fonte do
 * vocabulário em vez de uma cópia no prompt e outra no banco.
 */
export async function etiquetaNegocioDoAgente(
  admin: SupabaseClient,
  input: { organizationId: string; contactId: string; tags: string[] },
): Promise<ResultadoDaEtiquetagem> {
  const pedidas = input.tags.map((t) => t.trim().toLowerCase()).filter((t) => t !== "");
  if (pedidas.length === 0) {
    return { etiquetou: false, motivo: "fora_do_vocabulario", detalhe: "nenhuma tag informada" };
  }

  // O erro do SELECT é LIDO: supabase-js não lança em falha de rede, devolve
  // { data: null, error }. Descartá-lo faria banco fora virar "sem_negocio" —
  // incidente disfarçado de estado normal.
  const { data: leadRows, error: erroLeads } = await admin
    .from("crm_leads")
    .select("id, organization_id, pipeline_id, status, tags, created_at, last_activity_at")
    .eq("organization_id", input.organizationId)
    .eq("contact_id", input.contactId);
  if (erroLeads) {
    return { etiquetou: false, motivo: "indisponivel", detalhe: erroLeads.message };
  }

  const candidatos = (leadRows ?? []) as Array<{
    id: string;
    organization_id: string;
    pipeline_id: string;
    status: string;
    tags: string[] | null;
    created_at: string;
    last_activity_at: string | null;
  }>;

  const rota = resolveActiveLeadForContact(
    candidatos.map((c) => ({
      id: c.id,
      organization_id: c.organization_id,
      pipeline_id: c.pipeline_id,
      status: c.status as "open" | "won" | "lost",
      created_at: c.created_at,
      last_activity_at: c.last_activity_at,
    })),
  );
  if (!rota.routed) {
    return { etiquetou: false, motivo: rota.reason === "no_open_lead" ? "sem_negocio" : "ambiguo" };
  }
  const lead = candidatos.find((c) => c.id === rota.leadId)!;

  const { data: pipeline, error: erroPipeline } = await admin
    .from("crm_pipelines")
    .select("settings")
    .eq("id", lead.pipeline_id)
    .maybeSingle();
  if (erroPipeline) {
    return { etiquetou: false, motivo: "indisponivel", leadId: lead.id, detalhe: erroPipeline.message };
  }

  const vocabulario = lerCanonicalTags(pipeline?.settings);
  // Pipeline sem vocabulário declarado não vira porta aberta: sem lista, não há
  // como saber se "exame" é deriva de "exames", e gravar mesmo assim é o começo
  // da bagunça que este módulo existe para evitar.
  const invalidas = pedidas.filter((t) => !vocabulario.includes(t));
  if (invalidas.length > 0) {
    return {
      etiquetou: false,
      motivo: "fora_do_vocabulario",
      leadId: lead.id,
      detalhe:
        vocabulario.length === 0
          ? "o pipeline não declara canonical_tags — nenhuma tag é aceita até configurá-las"
          : `tags fora do vocabulário: ${invalidas.join(", ")}. Aceitas: ${vocabulario.join(", ")}`,
    };
  }

  const atuais = lead.tags ?? [];
  const novas = pedidas.filter((t) => !atuais.includes(t));
  if (novas.length === 0) {
    return { etiquetou: false, motivo: "ja_tem", leadId: lead.id, tags: atuais };
  }

  // UNIÃO, nunca substituição — o que a atendente marcou à mão sobrevive.
  const uniao = [...atuais, ...novas];
  const { error: erroUpdate } = await admin
    .from("crm_leads")
    .update({ tags: uniao })
    .eq("id", lead.id)
    .eq("organization_id", input.organizationId);
  if (erroUpdate) {
    return { etiquetou: false, motivo: "falha_de_escrita", leadId: lead.id, detalhe: erroUpdate.message };
  }

  return { etiquetou: true, motivo: "etiquetado", leadId: lead.id, tags: uniao };
}

/** `settings.canonical_tags` do pipeline, normalizadas. jsonb não é confiável: valida shape. */
function lerCanonicalTags(settings: unknown): string[] {
  if (typeof settings !== "object" || settings === null) return [];
  const raw = (settings as { canonical_tags?: unknown }).canonical_tags;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t !== "");
}
