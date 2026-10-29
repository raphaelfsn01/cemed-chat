import { describe, expect, it } from 'vitest';
import type { Logger } from '../obs/logger';
import type { ToolSet } from '../edge/llm/run-model-call';
import { logToolCallSummary, wrapToolsWithCallLog } from './tool-call-log';
import { createLogger, withFields } from '../obs/logger';
import { Writable } from 'node:stream';
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

describe('log de tools do turno — linha por chamada + resumo, pelo logger real', () => {
  const EMAIL = 'maria.souza@exemplo.com.br';
  const JOB_ID = '7f1c2d3e-0000-4000-8000-00000000abcd';

  function loggerReal(): { log: Logger; linhas: () => Array<Record<string, unknown>>; bruto: () => string } {
    const pedacos: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        pedacos.push(String(chunk));
        cb();
      },
    });
    const log = withFields(createLogger(stream), { job_id: JOB_ID });
    const bruto = (): string => pedacos.join('');
    const linhas = (): Array<Record<string, unknown>> =>
      bruto()
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    return { log, linhas, bruto };
  }

  function tools2(): ToolSet {
    return {
      send_message: { description: 'x', inputSchema: {}, execute: () => ({ ok: true }) },
      lookup_lead: { description: 'x', inputSchema: {}, execute: () => ({ ok: true, nome: 'Maria Souza' }) },
    } as unknown as ToolSet;
  }
  async function chamaTool(tools: ToolSet, nome: string, input: unknown, step: number): Promise<void> {
    const t = tools[nome] as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> };
    await t.execute(input, { messages: [{ role: 'user' }, ...Array(step - 1).fill({ role: 'tool' })] });
  }

  it('(a) linha por chamada e resumo só têm campos da allowlist, com job_id', async () => {
    const { log, linhas } = loggerReal();
    const called: string[] = [];
    const tools = wrapToolsWithCallLog(tools2(), log, called);

    await chamaTool(tools, 'lookup_lead', {}, 1);
    await chamaTool(tools, 'send_message', {}, 2);
    logToolCallSummary(log, called);

    const [l1, l2, resumo] = linhas();
    const CAMPOS_CHAMADA = ['level', 'msg', 'ts', 'job_id', 'tool', 'ok', 'duration_ms', 'step'];
    expect(l1).toMatchObject({ msg: 'tool chamada', tool: 'lookup_lead', ok: true, step: 1, job_id: JOB_ID });
    expect(l2).toMatchObject({ msg: 'tool chamada', tool: 'send_message', ok: true, step: 2, job_id: JOB_ID });
    for (const l of [l1!, l2!]) {
      for (const campo of Object.keys(l)) expect(CAMPOS_CHAMADA).toContain(campo);
    }
    expect(resumo).toMatchObject({
      msg: 'resumo de tools do turno',
      job_id: JOB_ID,
      tools: ['lookup_lead', 'send_message'],
      tool_calls: 2,
      send_message: true,
    });
  });

  it('(b) argumentos com telefone, e-mail e texto de mensagem NÃO vazam em nenhuma linha', async () => {
    const { log, bruto } = loggerReal();
    const called: string[] = [];
    const tools = wrapToolsWithCallLog(tools2(), log, called);

    await chamaTool(tools, 'send_message', { to: TELEFONE, email: EMAIL, body: CORPO }, 1);
    await chamaTool(tools, 'lookup_lead', { phone: TELEFONE, email: EMAIL, text: CORPO }, 2);
    logToolCallSummary(log, called);

    const saida = bruto();
    expect(saida).not.toBe('');
    for (const segredo of [TELEFONE, EMAIL, 'exemplo.com.br', CORPO, 'Maria', '123.456.789-00']) {
      expect(saida).not.toContain(segredo);
    }
  });

  it('(c) turno sem send_message: resumo com send_message=false; turno sem tools: lista vazia', async () => {
    const { log, linhas } = loggerReal();
    const called: string[] = [];
    const tools = wrapToolsWithCallLog(tools2(), log, called);

    await chamaTool(tools, 'lookup_lead', {}, 1);
    logToolCallSummary(log, called);
    logToolCallSummary(log, []);

    const resumos = linhas().filter((l) => l.msg === 'resumo de tools do turno');
    expect(resumos[0]).toMatchObject({ tools: ['lookup_lead'], tool_calls: 1, send_message: false });
    expect(resumos[1]).toMatchObject({ tools: [], tool_calls: 0, send_message: false });
  });
});
