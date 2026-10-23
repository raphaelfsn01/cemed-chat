import { describe, expect, it } from 'vitest';
import type { Logger } from '../obs/logger';
import type { ToolSet } from '../edge/llm/run-model-call';
import { wrapToolsWithCallLog } from './tool-call-log';
import { wrapToolsWithBreaker } from './tool-breaker';

interface Linha {
  msg: string;
  fields: Record<string, unknown>;
}

function loggerEspiao(): { log: Logger; linhas: Linha[] } {
  const linhas: Linha[] = [];
  const grava = (msg: string, fields: Record<string, unknown> = {}): void => {
    linhas.push({ msg, fields });
  };
  return { log: { info: grava, warn: grava, error: grava }, linhas };
}

const CORPO = 'Olá, sou a Maria Souza, meu CPF é 123.456.789-00 e quero marcar consulta';
const REASON = 'paciente relatou dor no peito e pediu para falar com a Dra. Ana';
const TELEFONE = '5522999887766';
const MESSAGE_LIVRE = `não foi possível enviar para ${TELEFONE}: ${CORPO}`;

function toolSet(execute: (input: unknown) => unknown): ToolSet {
  return { send_message: { description: 'x', inputSchema: {}, execute } } as unknown as ToolSet;
}

async function chama(tools: ToolSet, input: unknown, options: unknown = {}): Promise<unknown> {
  const t = tools.send_message as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> };
  return t.execute(input, options);
}

describe('wrapToolsWithCallLog', () => {
  it('tool com sucesso: uma linha info com tool, ok, duração e passo', async () => {
    const { log, linhas } = loggerEspiao();
    const tools = wrapToolsWithCallLog(toolSet(() => ({ ok: true, id: 'abc' })), log);
    const messages = [{ role: 'user' }, { role: 'assistant' }, { role: 'tool' }, { role: 'assistant' }, { role: 'tool' }];

    const result = await chama(tools, { body: CORPO }, { messages });

    expect(result).toEqual({ ok: true, id: 'abc' });
    expect(linhas).toHaveLength(1);
    expect(linhas[0]!.msg).toBe('tool chamada');
    expect(linhas[0]!.fields).toMatchObject({ tool: 'send_message', ok: true, step: 3 });
    expect(linhas[0]!.fields).not.toHaveProperty('error_code');
    expect(typeof linhas[0]!.fields.duration_ms).toBe('number');
  });

  it('tool com erro: ok=false e só o CÓDIGO do erro; resultado passa intocado', async () => {
    const { log, linhas } = loggerEspiao();
    const erro = { ok: false, error: { code: 'avise_antes', message: MESSAGE_LIVRE } };
    const tools = wrapToolsWithCallLog(toolSet(() => erro), log);

    const result = await chama(tools, { reason: REASON }, { messages: [{ role: 'user' }] });

    expect(result).toBe(erro);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]!.fields).toMatchObject({ tool: 'send_message', ok: false, error_code: 'avise_antes', step: 1 });
  });

  it('código de erro fora do formato de código não vaza texto livre', async () => {
    const { log, linhas } = loggerEspiao();
    const tools = wrapToolsWithCallLog(toolSet(() => ({ ok: false, error: { code: MESSAGE_LIVRE } })), log);

    await chama(tools, {});

    expect(linhas[0]!.fields.error_code).toBe('codigo_invalido');
  });

  it('falha sem código vira sem_codigo', async () => {
    const { log, linhas } = loggerEspiao();
    const tools = wrapToolsWithCallLog(toolSet(() => ({ ok: false, error: MESSAGE_LIVRE })), log);

    await chama(tools, {});

    expect(linhas[0]!.fields.error_code).toBe('sem_codigo');
  });

  it('tool que lança: loga ok=false/excecao e RELANÇA a mesma exceção', async () => {
    const { log, linhas } = loggerEspiao();
    const boom = new Error(MESSAGE_LIVRE);
    const tools = wrapToolsWithCallLog(
      toolSet(() => {
        throw boom;
      }),
      log,
    );

    await expect(chama(tools, {})).rejects.toBe(boom);

    expect(linhas).toHaveLength(1);
    expect(linhas[0]!.fields).toMatchObject({ tool: 'send_message', ok: false, error_code: 'excecao' });
  });

  it('a linha NÃO contém corpo da mensagem, reason do handoff, telefone nem message do erro', async () => {
    const { log, linhas } = loggerEspiao();
    const tools = wrapToolsWithCallLog(
      toolSet(() => ({ ok: false, error: { code: 'contato_bloqueado', message: MESSAGE_LIVRE } })),
      log,
    );
    const lancando = wrapToolsWithCallLog(
      toolSet(() => {
        throw new Error(MESSAGE_LIVRE);
      }),
      log,
    );

    await chama(tools, { body: CORPO, reason: REASON, phone: TELEFONE });
    await chama(lancando, { body: CORPO, reason: REASON, phone: TELEFONE }).catch(() => undefined);

    expect(linhas).toHaveLength(2);
    const saida = JSON.stringify(linhas);
    for (const segredo of [CORPO, 'Maria', '123.456.789-00', REASON, 'dor no peito', TELEFONE, 'não foi possível']) {
      expect(saida).not.toContain(segredo);
    }
  });

  it('logger que lança não afeta a tool (resultado e exceção seguem iguais)', async () => {
    const quebrado: Logger = {
      info: () => {
        throw new Error('stdout fechado');
      },
      warn: () => undefined,
      error: () => undefined,
    };
    const ok = wrapToolsWithCallLog(toolSet(() => ({ ok: true })), quebrado);
    const boom = new Error('da tool');
    const lanca = wrapToolsWithCallLog(
      toolSet(() => {
        throw boom;
      }),
      quebrado,
    );

    await expect(chama(ok, {})).resolves.toEqual({ ok: true });
    await expect(chama(lanca, {})).rejects.toBe(boom);
  });

  it('sem messages nas options o passo é omitido, e tool sem execute passa direto', async () => {
    const { log, linhas } = loggerEspiao();
    const semExecute = { description: 'x', inputSchema: {} };
    const tools = wrapToolsWithCallLog(
      { ...toolSet(() => ({ ok: true })), so_schema: semExecute } as unknown as ToolSet,
      log,
    );

    await chama(tools, {}, undefined);

    expect(linhas[0]!.fields.step).toBeUndefined();
    expect(tools.so_schema).toBe(semExecute);
  });

  it('por fora do breaker: chamada bloqueada por ele também é logada com o código circuit_breaker_*', async () => {
    const { log, linhas } = loggerEspiao();
    const falha = { ok: false, error: { code: 'avise_antes', message: 'x' } };
    const breaker = wrapToolsWithBreaker(toolSet(() => falha), {
      thresholds: {
        exactFailureWarn: 1,
        exactFailureBlock: 1,
        sameToolFailureWarn: 9,
        sameToolFailureHalt: 9,
        noProgressWarn: 9,
        noProgressBlock: 9,
      },
      readOnlyTools: [],
      log,
    });
    const tools = wrapToolsWithCallLog(breaker, log);

    await chama(tools, { a: 1 });
    await chama(tools, { a: 1 });

    const chamadas = linhas.filter((l) => l.msg === 'tool chamada');
    expect(chamadas.map((l) => l.fields.error_code)).toEqual(['avise_antes', 'circuit_breaker_exact_failure']);
  });
});
