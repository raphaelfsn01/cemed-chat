/**
 * Registro mínimo das tools chamadas no turno do agente: UMA linha de log info por
 * chamada, para diagnosticar pelo log do worker o que o modelo chamou em cada passo
 * (a tabela ai_agent_runs não guarda isso).
 *
 * Ponto único: o wrapper envolve o ToolSet final do run (por fora do circuit
 * breaker, então chamadas BLOQUEADAS por ele também aparecem, com o código
 * `circuit_breaker_*`). Nenhuma tool é editada e o resultado devolvido ao modelo
 * passa intocado — exceção da tool é relançada como veio.
 *
 * Resumo do turno (`logToolCallSummary`): lista dos nomes chamados, contagem e se houve
 * `send_message`. Permite provar a posteriori que um turno terminou sem enviar nada.
 *
 * PII: a linha leva SÓ nome da tool, ok, código do erro, duração e passo. Argumentos,
 * texto de mensagem, `reason` do handoff e `error.message` (texto livre) jamais entram.
 * O job_id/tenant_id/lead_id vêm carimbados pelo logger do run (`withFields`). O código
 * do erro só é copiado se tiver cara de código (`[a-z0-9_.:-]`); qualquer outra coisa
 * vira `codigo_invalido` em vez de vazar texto livre.
 */
import type { Logger } from '../obs/logger';
import type { ToolSet } from '../edge/llm/run-model-call';

type AnyExecute = (input: unknown, options: unknown) => unknown;
interface WrappableTool {
  execute?: AnyExecute;
}

const CODIGO_VALIDO = /^[a-z0-9_.:-]{1,64}$/i;

/** Código do erro de um resultado `{ ok: false, error: { code } }` — nunca a message. */
function extractErrorCode(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null || (result as { ok?: unknown }).ok !== false) {
    return undefined;
  }
  const error = (result as { error?: unknown }).error;
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === undefined) return 'sem_codigo';
  return typeof code === 'string' && CODIGO_VALIDO.test(code) ? code : 'codigo_invalido';
}

/**
 * Passo do turno (1-based). O AI SDK não passa o índice ao `execute`, mas passa o
 * histórico: cada passo anterior que chamou tools deixou uma mensagem `tool` ali, e
 * o turno abre só com mensagens `user`. Sem `messages` legível, devolve undefined.
 */
function stepNumber(options: unknown): number | undefined {
  const messages = typeof options === 'object' && options !== null ? (options as { messages?: unknown }).messages : undefined;
  if (!Array.isArray(messages)) return undefined;
  return messages.filter((m) => (m as { role?: unknown } | null)?.role === 'tool').length + 1;
}

const nowMs = (): number => performance.now();

/**
 * `called` (opcional) recebe o nome de cada tool chamada, na ordem — insumo do
 * `logToolCallSummary` no fim do turno.
 */
export function wrapToolsWithCallLog(tools: ToolSet, log: Logger, called?: string[]): ToolSet {
  // Falha do logger NUNCA quebra nem atrasa a tool.
  const emit = (
    tool: string,
    started: number,
    options: unknown,
    outcome: { ok: boolean; error_code?: string },
  ): void => {
    try {
      log.info('tool chamada', {
        tool,
        ok: outcome.ok,
        ...(outcome.error_code !== undefined ? { error_code: outcome.error_code } : {}),
        duration_ms: Math.round(nowMs() - started),
        step: stepNumber(options),
      });
    } catch {
      // intencional: observabilidade não derruba o turno
    }
  };

  const wrapped: ToolSet = {};
  for (const [name, def] of Object.entries(tools)) {
    const tool = def as WrappableTool;
    if (tool.execute === undefined) {
      wrapped[name] = def;
      continue;
    }
    const execute = tool.execute.bind(def) as AnyExecute;
    const loggedExecute: AnyExecute = async (input, options) => {
      called?.push(name);
      const started = nowMs();
      let result: unknown;
      try {
        result = await execute(input, options);
      } catch (err) {
        emit(name, started, options, { ok: false, error_code: 'excecao' });
        throw err;
      }
      const errorCode = extractErrorCode(result);
      emit(name, started, options, errorCode === undefined ? { ok: true } : { ok: false, error_code: errorCode });
      return result;
    };
    wrapped[name] = { ...def, execute: loggedExecute } as typeof def;
  }
  return wrapped;
}

/** Fim do turno: UMA linha com os nomes das tools chamadas, a contagem e se houve send_message. */
export function logToolCallSummary(log: Logger, called: readonly string[]): void {
  try {
    log.info('resumo de tools do turno', {
      tools: [...called],
      tool_calls: called.length,
      send_message: called.includes('send_message'),
    });
  } catch {
    // intencional: observabilidade não derruba o turno
  }
}
