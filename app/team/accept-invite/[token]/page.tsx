/**
 * /team/accept-invite/[token] — public route (added to PUBLIC_PATHS).
 *
 * Behavior matrix:
 *  - Invalid/expired token         → render error
 *  - Unauthenticated user          → CTA → /login?next=... (já tem conta) E o
 *                                    formulário de primeiro acesso (cria a senha;
 *                                    substitui o /signup removido na auditoria C3)
 *  - Authenticated, email mismatch → render mismatch + sign-out CTA
 *  - Authenticated, email match    → AceitarConviteForm → Server Action aplica o
 *                                    convite (lib/team/aplicar-convite.ts) e
 *                                    redireciona para /app/inbox
 */
import Link from "next/link";

import { verifyInviteToken } from "@/lib/auth/invite-token";
import { authRateLimited, AUTH_LIMITS } from "@/lib/auth/rate-limit";
import { createClient } from "@/lib/supabase/server";
import { AceitarConviteForm } from "@/components/team/AceitarConviteForm";
import { CriarContaPeloConviteForm } from "@/components/team/CriarContaPeloConviteForm";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ token: string }>;
}

export default async function AcceptInvitePage({ params }: PageProps) {
  const { token } = await params;

  // O gargalo de enumeração é AQUI, não no aceite: a rota é pública e cada
  // GET testa um token. Sem teto, varrer o espaço de tokens sai de graça
  // (issue #64). Barrar antes de verificar mantém a resposta indistinguível
  // entre token válido e inválido para quem está varrendo.
  if (await authRateLimited("invite_accept", null, AUTH_LIMITS.invite_accept)) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">Muitas tentativas</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Aguarde alguns minutos e abra o link do convite de novo.
        </p>
      </Shell>
    );
  }

  const payload = verifyInviteToken(token);

  if (!payload) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">Convite inválido ou expirado</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Este link não é válido ou já passou da janela de 24h. Peça um novo convite ao admin do tenant.
        </p>
      </Shell>
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const next = encodeURIComponent(`/team/accept-invite/${token}`);
    return (
      <Shell>
        <h1 className="text-xl font-semibold">Você foi convidado</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Para aceitar o convite como <strong>{payload.role}</strong>, entre com o email{" "}
          <strong>{payload.email}</strong>.
        </p>
        <p className="mt-4 text-sm">Já tem conta?</p>
        <Link
          href={`/login?next=${next}`}
          className="mt-2 inline-flex h-11 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent lg:h-9"
        >
          Fazer login
        </Link>
        <div className="mt-6 border-t pt-6">
          <h2 className="text-base font-semibold">Primeiro acesso</h2>
          <p className="mb-4 mt-1 text-sm text-muted-foreground">
            Crie sua senha para entrar. Ela vale para os próximos acessos.
          </p>
          <CriarContaPeloConviteForm token={token} email={payload.email} />
        </div>
      </Shell>
    );
  }

  const userEmail = (user.email ?? "").trim().toLowerCase();
  if (userEmail !== payload.email.trim().toLowerCase()) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">Email não corresponde</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Você está logado como <strong>{user.email}</strong>, mas o convite foi enviado para{" "}
          <strong>{payload.email}</strong>. Saia e faça login com o email correto.
        </p>
        <form action="/api/auth/signout" method="post" className="mt-4">
          <button
            type="submit"
            className="inline-flex h-11 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent lg:h-9"
          >
            Sair
          </button>
        </form>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-xl font-semibold">Aceitar convite</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Você foi convidado para entrar como <strong>{payload.role}</strong>. Confirme abaixo para
        ativar seu acesso.
      </p>
      <AceitarConviteForm token={token} />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-4 sm:p-6 supports-[height:100dvh]:min-h-dvh">
      <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm sm:p-8">{children}</div>
    </div>
  );
}
