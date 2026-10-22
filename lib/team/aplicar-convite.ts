/**
 * O que um convite VÁLIDO faz com a membership — regra única para "aceitar
 * convite" (quem já tem conta) e "criar conta pelo convite" (quem não tem).
 *
 * Antes (auditoria de 2026-10-21, C4/M5), aceitar SOBRESCREVIA o papel de quem já
 * era membro e REATIVAVA quem tinha sido removido. Com o token reutilizável por
 * 24 h, isso dava dois caminhos:
 *   - um membro promovia a si mesmo apresentando um convite de papel maior;
 *   - um ex-funcionário voltava com o link antigo depois de ser removido.
 *
 * Agora:
 *   - membro ATIVO: nada muda (o papel se troca na tela de equipe, não por link);
 *   - membro REMOVIDO: volta só se o convite foi emitido DEPOIS da remoção — um
 *     convite novo do admin é decisão de trazer de volta; o link antigo não é;
 *   - sem membership: entra com o papel do convite.
 *
 * Organização e papel vêm do token assinado (fonte confiável), nunca do body.
 * Usa o service role porque o convidado ainda não é membro e o RLS de
 * `user_organizations` exige admin da org para escrever.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { emitidoEm, type InvitePayload } from "@/lib/auth/invite-token";

export type ResultadoDoConvite =
  | { ok: true; efeito: "entrou" | "ja_era_membro" | "reativado" }
  | { ok: false; erro: "convite_anterior_a_remocao" | "internal_error"; mensagem?: string };

export async function aplicarConvite(
  db: SupabaseClient,
  userId: string,
  payload: InvitePayload,
): Promise<ResultadoDoConvite> {
  const { data: existente, error: fetchErr } = await db
    .from("user_organizations")
    .select("id, revoked_at, role")
    .eq("user_id", userId)
    .eq("organization_id", payload.organization_id)
    .maybeSingle();
  if (fetchErr) return { ok: false, erro: "internal_error", mensagem: fetchErr.message };

  const agora = new Date().toISOString();
  const emitido = emitidoEm(payload);

  if (existente && !existente.revoked_at) {
    // Reaceitar é idempotente e NÃO toca no papel.
    return { ok: true, efeito: "ja_era_membro" };
  }

  if (existente?.revoked_at) {
    const removidoEm = Math.floor(new Date(existente.revoked_at).getTime() / 1000);
    if (emitido <= removidoEm) {
      void audit({
        action: "member.invite_rejected",
        actorUserId: userId,
        organizationId: payload.organization_id,
        resourceType: "membership",
        resourceId: existente.id,
        metadata: { invite_id: payload.invite_id, reason: "invite_older_than_removal" },
      });
      return { ok: false, erro: "convite_anterior_a_remocao" };
    }
    const { error: updErr } = await db
      .from("user_organizations")
      .update({ role: payload.role, revoked_at: null, accepted_at: agora, updated_at: agora })
      .eq("id", existente.id)
      .eq("organization_id", payload.organization_id);
    if (updErr) return { ok: false, erro: "internal_error", mensagem: updErr.message };
    await audit({
      action: "member.accepted",
      actorUserId: userId,
      organizationId: payload.organization_id,
      resourceType: "membership",
      resourceId: existente.id,
      metadata: { invite_id: payload.invite_id, role: payload.role, reactivated: true },
    });
    return { ok: true, efeito: "reativado" };
  }

  const { data: inserido, error: insErr } = await db
    .from("user_organizations")
    .insert({
      user_id: userId,
      organization_id: payload.organization_id,
      role: payload.role,
      invited_at: new Date(emitido * 1000).toISOString(),
      accepted_at: agora,
    })
    .select("id")
    .single();
  if (insErr) return { ok: false, erro: "internal_error", mensagem: insErr.message };

  await audit({
    action: "member.accepted",
    actorUserId: userId,
    organizationId: payload.organization_id,
    resourceType: "membership",
    resourceId: inserido.id,
    metadata: { invite_id: payload.invite_id, role: payload.role },
  });
  return { ok: true, efeito: "entrou" };
}
