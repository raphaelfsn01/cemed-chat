/**
 * Fechamento do turno tolerante a falha: o checkpoint não pode derrubar um
 * turno que já respondeu.
 *
 * ## O defeito que fez esta função existir (produção, 14/09)
 *
 * Depois de responder ao lead, o runtime faz uma 2ª chamada pedindo o checkpoint
 * em JSON. Quando o modelo devolvia JSON malformado, `parseCheckpointText`
 * lançava, o job falhava e a FILA refazia o turno inteiro — classificadores,
 * turno, tudo — com a resposta já entregue. Custou ~2 min e travou a mensagem
 * seguinte do mesmo contato atrás da repetição: 1ª resposta em 34 s, 2ª em
 * 2 min 13 s. Aconteceu em 1 de 3 turnos.
 *
 * ## A regra
 *
 * - Até `tentativas` chamadas (default 2), aqui mesmo, sem voltar à fila.
 * - Esgotou: devolve `null` e o chamador segue SEM gravar checkpoint. O próximo
 *   turno lê o checkpoint anterior (`latestCheckpoint`), então a memória fica um
 *   turno defasada — não perdida. É o custo menor: refazer o turno gasta tokens,
 *   atrasa o próximo atendimento e reexecuta efeitos colaterais.
 *
 * Erro de provider conta como tentativa falha do mesmo jeito que JSON inválido:
 * nos dois casos a resposta já saiu e refazer o turno custaria o mesmo.
 *
 * ## Por que módulo separado
 *
 * Mesmo motivo de `aux-model-args.ts`: dentro de `runAgentTurn` a regra precisa
 * de banco, job e registry para rodar. Aqui ela é exercitada por unit, com a
 * chamada e o parser injetados — o que também evita import circular com
 * `inbound-turn.ts`, que é quem usa esta função.
 */

export interface Fechamento<C> {
  content: C;
  /** `llm_calls.id` da chamada que produziu o checkpoint — lastro da timeline. */
  callId: string | null;
}

export async function fecharCheckpoint<C>(args: {
  chamar: () => Promise<{ text: string; callId: string | null }>;
  interpretar: (text: string) => C;
  tentativas?: number;
  aoFalhar?: (tentativa: number, err: Error) => void;
}): Promise<Fechamento<C> | null> {
  const tentativas = args.tentativas ?? 2;
  for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
    try {
      const { text, callId } = await args.chamar();
      return { content: args.interpretar(text), callId };
    } catch (err) {
      args.aoFalhar?.(tentativa, err instanceof Error ? err : new Error(String(err)));
    }
  }
  return null;
}
