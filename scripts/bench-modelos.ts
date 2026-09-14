/**
 * Benchmark de modelos do agente da CEMED — velocidade COM qualidade.
 *
 * Pergunta que responde: dentre os modelos do catálogo (`ai_models` sob
 * `openrouter`), quais respondem ao paciente mais rápido SEM errar a triagem?
 *
 * Qualidade é PORTÃO, velocidade é RANKING. Modelo rápido que não etiqueta o card
 * ou não transfere a urgência é pior que um lento: o erro não dá erro, só uma
 * resposta educada — e ninguém percebe até a equipe reclamar.
 *
 * ## Fidelidade ao turno de produção (inbound-turn.ts), sem enviar nada
 *
 * - system: `loadPlaybook` com a camada tenant = system_prompt da versão PUBLICADA,
 *   + memória da org + índice de skills, via `composeSystemPrompt` — o mesmo prefixo;
 * - tools: `AGENT_TOOL_DEFS`, no conjunto que a CEMED recebe hoje (ver TOOLS_CEMED);
 *   o `execute` é stub que registra a chamada e o instante e devolve o formato real;
 * - abertura: `buildOpeningMessage`, com contato sintético e a mensagem do cenário;
 * - fábrica: `createDefaultRegistry().openrouter` — a MESMA de produção, cache incluso;
 * - maxSteps: o da versão publicada.
 *
 * Só LÊ o banco. Não grava `llm_calls` (chama `generateText` direto, sem o seam de
 * `runModelCall`) e não toca WhatsApp.
 *
 * ## Uso — NA VPS, que tem a mesma rede de produção até a OpenRouter
 *
 *   pnpm exec tsx --env-file=.env scripts/bench-modelos.ts --fase a
 *   pnpm exec tsx --env-file=.env scripts/bench-modelos.ts --fase b --modelos v/m1,v/m2
 *   pnpm exec tsx --env-file=.env scripts/bench-modelos.ts --fase c --modelos v/m1,v/m2,v/m3
 *
 * Knobs: BENCH_OUT (jsonl de saída), BENCH_MAX_USD (teto de gasto, default 30),
 * BENCH_CONCORRENCIA (modelos em paralelo, default 4), BENCH_REPS (repetições por
 * cenário na fase B, default 3), BENCH_CENARIOS (ids, só nas fases B e C), BENCH_ORG,
 * BENCH_AGENTE.
 *
 * O saldo da OpenRouter é o MESMO que mantém o agente respondendo em produção. A
 * OpenRouter recusa a chamada quando o custo MÁXIMO possível passa do saldo — com saldo
 * baixo, gastar no benchmark pode derrubar o atendimento. Confira o saldo antes.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { generateText, stepCountIs, tool, type ToolSet } from 'ai';
import pg from 'pg';

import { AGENT_TOOL_DEFS, buildOpeningMessage } from '@/lib/agent-engine/agent/inbound-turn';
import { renderNotesIndex } from '@/lib/agent-engine/agent/lead-notes';
import { composeSystemPrompt, loadOrgMemory, renderOrgMemory } from '@/lib/agent-engine/agent/org-memory';
import { loadPlaybook } from '@/lib/agent-engine/agent/playbook';
import { skillHasReferences } from '@/lib/agent-engine/agent/skill-references';
import {
  latestInboundSignal,
  loadSkills,
  matchSkills,
  renderMatchedSkillBodies,
  renderSkillIndex,
} from '@/lib/agent-engine/agent/skills';
import type { LeadContext } from '@/lib/agent-engine/edge/crm/get-lead-context';
import { custoInformadoCents } from '@/lib/agent-engine/edge/llm/pricing';
import { createDefaultRegistry } from '@/lib/agent-engine/edge/llm/providers';
import { buildStablePrefix } from '@/lib/agent-engine/edge/llm/stable-prefix';

const ORG = process.env.BENCH_ORG ?? 'ec189eb9-434d-4428-904b-3567d98bced3';
const AGENTE = process.env.BENCH_AGENTE ?? 'f8ba9bad-eafb-48ff-89c9-1fb541d5ca3f';
const MAX_CENTS = Number(process.env.BENCH_MAX_USD ?? '30') * 100;
const CONCORRENCIA = Number(process.env.BENCH_CONCORRENCIA ?? '4');
const TIMEOUT_MS = 120_000;
/** Repetições por cenário na fase B (default 3) — menos repetições, menos crédito. */
const REPS_B = Number(process.env.BENCH_REPS ?? '3');
/** Só estes cenários nas fases B e C (ids separados por vírgula) — para remedir um ponto. */
const SO_CENARIOS = (process.env.BENCH_CENARIOS ?? '').split(',').filter(Boolean);

function arg(nome: string): string | undefined {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const FASE = arg('fase') ?? 'a';
const OUT = process.env.BENCH_OUT ?? path.join(os.tmpdir(), `bench-modelos-${FASE}-${Date.now()}.jsonl`);

/**
 * O conjunto que o turno monta HOJE para a CEMED (inbound-turn.ts, rawTools):
 * - `send_template` sai: canal WAHA não exige template;
 * - `search_knowledge` sai: o agente não tem base de conhecimento ativa;
 * - `open_human_case`/`provide_case_update` não entram: casos desligados na versão;
 * - `read_skill_reference` não entra: só entra quando uma skill CASADA tem referências, e as
 *   skills ativas (de plataforma) não têm — `executar` aborta se isso mudar;
 * - `schedule_followup` entra: o worker sempre monta `knobs.followup` (main.ts).
 * Se a configuração mudar, esta lista mente — `conferirPremissas` aborta antes.
 */
const TOOLS_CEMED = [
  'get_lead_context',
  'send_message',
  'update_lead_state',
  'set_lead_tags',
  'schedule_followup',
  'save_lead_note',
  'get_lead_note',
  'request_human_handoff',
] as const;

interface Cenario {
  id: string;
  texto: string;
  /** etiqueta que TEM de aparecer em set_lead_tags */
  tag?: string;
  /** tem de perguntar e NÃO etiquetar exames/medicina_trabalho (prompt §5) */
  ambiguo?: boolean;
  /** request_human_handoff obrigatório já neste turno */
  transferir?: boolean;
  /** tem de avisar que não atende Unimed (prompt §3.1) */
  unimed?: boolean;
  /** urgência: nenhuma orientação de para onde ir (prompt §4) */
  urgencia?: boolean;
  /** não pode oferecer nem confirmar horário (prompt §3.4 — a clínica é por ordem de chegada) */
  semHorario?: boolean;
}

/** Derivados do prompt publicado (v4). A fase A usa só os três primeiros ids. */
const CENARIOS: Cenario[] = [
  { id: 'oi', texto: 'Oi' },
  { id: 'aso', texto: 'Boa tarde! Preciso fazer o ASO admissional de um funcionário novo da minha empresa.', tag: 'medicina_trabalho' },
  { id: 'preco', texto: 'Quanto custa a consulta de psiquiatria?', tag: 'especialidades' },
  { id: 'cardio', texto: 'Queria marcar uma consulta com cardiologista.', tag: 'especialidades' },
  { id: 'ecg_paciente', texto: 'Meu médico pediu um eletrocardiograma, vocês fazem?', tag: 'exames' },
  { id: 'ecg_ambiguo', texto: 'Preciso de um ECG.', ambiguo: true },
  { id: 'unimed', texto: 'Vocês atendem Unimed?', unimed: true },
  { id: 'urgencia', texto: 'Estou com dor no peito e falta de ar desde cedo', transferir: true, urgencia: true },
  { id: 'curriculo', texto: 'Boa tarde, queria enviar meu currículo para a vaga de recepcionista.', tag: 'outros' },
  { id: 'cabelo', texto: 'Estou perdendo muito cabelo, vocês tratam isso?', tag: 'estetica' },
  { id: 'acupuntura', texto: 'Vocês fazem acupuntura?', tag: 'espaco_integrar' },
  // Casa com a skill de PLATAFORMA `agendamento`, cujo corpo entra na abertura e ensina a
  // oferecer e confirmar horário — o oposto do §3.4 da CEMED. Mede quem obedece a quem.
  {
    id: 'agendar',
    texto: 'Quero agendar uma consulta com o clínico geral para amanhã.',
    tag: 'especialidades',
    semHorario: true,
  },
];
const CENARIOS_FASE_A = ['oi', 'aso', 'preco'];

type Roteamento = 'padrao' | 'latency' | 'throughput';

interface Execucao {
  fase: string;
  modelo: string;
  roteamento: Roteamento;
  cenario: string;
  rep: number;
  executou: boolean;
  erro?: string;
  msPrimeiraMensagem: number | null;
  msTotal: number;
  passos: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  custoCents: number | null;
  mensagens: string[];
  tags: string[];
  transferiu: boolean;
  /** skills cujo corpo foi anexado à abertura neste cenário */
  skillsCasadas: string[];
  /** mensagens tentadas DEPOIS da transferência — o gate de produção as recusa */
  enviosBloqueados: number;
  duras: Record<string, boolean>;
  moles: Record<string, boolean>;
}

interface Ambiente {
  pool: pg.Pool;
  system: string;
  /** plataforma + org, como no turno: índice no system, corpo das casadas na abertura */
  skills: Awaited<ReturnType<typeof loadSkills>>;
  maxSteps: number;
  tagsValidas: string[];
  apiKey: string;
}

async function conferirPremissas(pool: pg.Pool): Promise<{ systemPrompt: string; maxSteps: number }> {
  const { rows } = await pool.query<{
    system_prompt: string;
    max_steps: number | null;
    cases_enabled: boolean;
    handoff_tool_enabled: boolean;
    tool_ids: string[];
    tem_kb: boolean;
  }>(
    `select v.system_prompt, v.max_steps, v.cases_enabled, v.handoff_tool_enabled, v.tool_ids,
            a.active_kb_version_id is not null as tem_kb
       from ai_agents a join ai_agent_versions v on v.id = a.published_version_id
      where a.id = $1 and a.organization_id = $2`,
    [AGENTE, ORG],
  );
  const r = rows[0];
  if (r === undefined) throw new Error('agente sem versão publicada nesta org');
  const quebradas = [
    r.cases_enabled && 'casos ligados (open_human_case/provide_case_update entrariam)',
    !r.handoff_tool_enabled && 'handoff desligado (request_human_handoff sairia)',
    r.tool_ids.length > 0 && 'tools MCP configuradas',
    r.tem_kb && 'base de conhecimento ativa (search_knowledge entraria)',
  ].filter((x): x is string => typeof x === 'string');
  if (quebradas.length > 0) {
    throw new Error(`premissas de TOOLS_CEMED não batem mais: ${quebradas.join('; ')} — atualize a lista`);
  }
  return { systemPrompt: r.system_prompt, maxSteps: r.max_steps ?? 10 };
}

async function montarAmbiente(): Promise<Ambiente> {
  const dbUrl = process.env.SUPABASE_DB_URL;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!dbUrl) throw new Error('SUPABASE_DB_URL ausente — rode com --env-file=.env');
  if (!apiKey) throw new Error('OPENROUTER_API_KEY ausente — rode com --env-file=.env');
  const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });

  const { systemPrompt, maxSteps } = await conferirPremissas(pool);
  // Inclui as skills de PLATAFORMA: loadSkills junta as globais com as da org.
  const skills = await loadSkills(pool, ORG);

  // Mesma montagem de inbound-turn.ts: playbook (camada tenant = prompt publicado)
  // → memória da org → índice de skills.
  const playbook = await loadPlaybook(pool, ORG, { agentLayer: systemPrompt });
  const system = composeSystemPrompt({
    playbookPrompt: playbook.prompt,
    orgMemoryBlock: renderOrgMemory(await loadOrgMemory(pool, ORG)),
    skillIndex: renderSkillIndex(skills),
  });

  const { rows } = await pool.query<{ tags: string[] | null }>(
    `select array(select jsonb_array_elements_text(settings->'canonical_tags')) as tags
       from crm_pipelines where organization_id = $1 and settings ? 'canonical_tags' limit 1`,
    [ORG],
  );
  const tagsValidas = rows[0]?.tags ?? [];
  if (tagsValidas.length === 0) throw new Error('pipeline sem canonical_tags — set_lead_tags não teria o que validar');

  return { pool, system, skills, maxSteps, tagsValidas, apiKey };
}

function contexto(texto: string): LeadContext {
  return {
    lead_id: '00000000-0000-4000-8000-00000000be0c',
    contact: { name: 'Cliente', phone: '5522999990000', email: null, tags: [], is_blocked: false },
    conversation_id: '00000000-0000-4000-8000-00000000c0be',
    last_human_decision: null,
    // Terça, 10h de Brasília: dentro do expediente, para não misturar a regra de
    // "fora do horário" com a triagem que está sendo medida.
    messages: [{ direction: 'inbound', body: texto, sent_at: '2026-09-15T13:00:00.000Z' }],
  };
}

function montarTools(
  registrar: (nome: string, input: unknown) => void,
  ctx: LeadContext,
  tagsValidas: readonly string[],
): ToolSet {
  const d = AGENT_TOOL_DEFS;
  let seq = 0;
  let transferido = false;
  const tools: ToolSet = {
    get_lead_context: tool({
      ...d.get_lead_context,
      execute: (input) => {
        registrar('get_lead_context', input);
        return { ok: true, context: ctx, tokenCount: 0 };
      },
    }),
    send_message: tool({
      ...d.send_message,
      execute: (input) => {
        // Igual a produção: a transferência marca force_human, e o gate de envio (stop, em
        // before-send.ts) recusa QUALQUER mensagem depois dela — inclusive o "aviso" que o
        // texto da própria tool de transferência convida a mandar. Não conta como enviada.
        if (transferido) {
          registrar('send_message_bloqueada', input);
          return {
            ok: false,
            error: {
              code: 'contato_bloqueado',
              message:
                'o contato optou por não receber mensagens (bloqueio irrevogável) — não envie mais nada e encerre o turno.',
            },
          };
        }
        registrar('send_message', input);
        seq += 1;
        return { ok: true, status: 'enviada', message_id: `bench-${seq}` };
      },
    }),
    update_lead_state: tool({
      ...d.update_lead_state,
      execute: (input) => {
        registrar('update_lead_state', input);
        return { ok: true, status: 'estado_atualizado', stage: input.stage ?? 'contacted', message: 'estado atualizado' };
      },
    }),
    set_lead_tags: tool({
      ...d.set_lead_tags,
      execute: (input) => {
        registrar('set_lead_tags', input);
        // Igual a produção: valor fora da lista é recusado COM a lista correta.
        const fora = input.tags.filter((t) => !tagsValidas.includes(t));
        if (fora.length > 0) {
          return { ok: false, error: { code: 'tag_fora_da_lista', message: `valores aceitos: ${tagsValidas.join(', ')}` } };
        }
        return { ok: true, tags: input.tags };
      },
    }),
    schedule_followup: tool({
      ...d.schedule_followup,
      execute: (input) => {
        registrar('schedule_followup', input);
        return { ok: true, status: 'agendado', agendado_para: input.promised_at, message: 'retorno agendado' };
      },
    }),
    save_lead_note: tool({
      ...d.save_lead_note,
      execute: (input) => {
        registrar('save_lead_note', input);
        return { ok: true, status: 'nota_salva', superseded: [], message: 'nota salva' };
      },
    }),
    get_lead_note: tool({
      ...d.get_lead_note,
      execute: (input) => {
        registrar('get_lead_note', input);
        return { ok: false, error: { code: 'nota_inexistente', message: 'nota não encontrada' } };
      },
    }),
    request_human_handoff: tool({
      ...d.request_human_handoff,
      execute: (input) => {
        registrar('request_human_handoff', input);
        transferido = true;
        // Texto de produção (human-handoff.ts), com a frase de disponibilidade de um
        // expediente com gente livre (lib/escalacao/disponibilidade.ts).
        return {
          ok: true,
          status: 'handoff_solicitado',
          message:
            'Handoff humano acionado; a conversa saiu do atendimento automático. ' +
            'Há 2 pessoas da equipe podendo assumir agora — pode dizer ao cliente que alguém continua o atendimento em seguida. ' +
            'Encerre o turno AGORA, sem enviar mais mensagens ao lead além do aviso.',
        };
      },
    }),
  };
  const sobrando = Object.keys(tools).filter((k) => !(TOOLS_CEMED as readonly string[]).includes(k));
  if (sobrando.length > 0) throw new Error(`tools fora de TOOLS_CEMED: ${sobrando.join(', ')}`);
  return tools;
}

function avaliar(c: Cenario, mensagens: string[], tags: string[], transferiu: boolean) {
  const texto = mensagens.join('\n');
  const duras: Record<string, boolean> = { enviou: mensagens.length > 0 };
  if (c.tag !== undefined) duras.etiqueta = tags.includes(c.tag);
  if (c.ambiguo) {
    duras.perguntou_sem_chutar =
      mensagens.some((m) => m.includes('?')) && !tags.some((t) => t === 'exames' || t === 'medicina_trabalho');
  }
  if (c.transferir) duras.transferiu = transferiu;
  if (c.unimed) duras.avisou_unimed = /n[ãa]o (atendemos|aceitamos|trabalhamos)[^.?!]*unimed/i.test(texto);
  if (c.urgencia) {
    duras.sem_orientacao = !/\b(192|193|samu|upa|pronto[- ]?socorro|hospital)\b/i.test(texto);
  }
  if (c.semHorario) {
    // Oferta de vaga ("temos horário disponível amanhã") ou de horário ("quinta às 15h").
    // Não pega o expediente ("de segunda a sexta, das 8h às 17h"), que é permitido.
    duras.sem_horario_oferecido =
      !/(tenho|temos)\s+(hor[áa]rios?|vagas?)\s+(dispon[íi]ve(l|is)|livres?|para|pra|amanh|hoje|às|as)/i.test(texto) &&
      !/(amanh[ãa]|hoje|segunda|ter[çc]a|quarta|quinta|sexta)(-feira)?\s+(às|as)\s+\d{1,2}(h|:)/i.test(texto);
  }
  duras.sem_preco = !/R\$\s*\d|\b\d+,\d{2}\b|\breais\b/i.test(texto);
  duras.sem_emoji = !/\p{Extended_Pictographic}/u.test(texto);
  duras.sem_senhor = !/\b(senhor|senhora|sr\.|sra\.)/i.test(texto);
  duras.sem_unidade_macae =
    !/unidade (em|de|no) maca[ée]/i.test(texto) || /n[ãa]o (temos|existe|h[áa])[^.]*unidade[^.]*maca[ée]/i.test(texto);
  const moles: Record<string, boolean> = {
    uma_pergunta_por_mensagem: mensagens.every((m) => (m.match(/\?/g) ?? []).length <= 1),
    ate_400_caracteres: mensagens.every((m) => m.length <= 400),
  };
  return { duras, moles };
}

async function executar(
  amb: Ambiente,
  modelo: string,
  roteamento: Roteamento,
  c: Cenario,
  rep: number,
): Promise<Execucao> {
  const eventos: Array<{ nome: string; input: unknown; ms: number }> = [];
  const t0 = performance.now();
  const ctx = contexto(c.texto);
  // Igual ao turno (inbound-turn.ts, skillMatch): casa as skills contra a última inbound
  // e anexa o corpo das casadas à abertura, como sufixo por-lead.
  const casadas = matchSkills(amb.skills, latestInboundSignal(ctx.messages)).matched;
  if (casadas.some((s) => skillHasReferences(s))) {
    throw new Error('skill casada com referências — read_skill_reference entraria; atualize TOOLS_CEMED');
  }
  const blocoSkills = renderMatchedSkillBodies(casadas);
  const abertura = buildOpeningMessage(null, null, ctx, renderNotesIndex([]));
  const aberturaCompleta = blocoSkills === '' ? abertura : `${abertura}\n\n${blocoSkills}`;
  const tools = montarTools((nome, input) => eventos.push({ nome, input, ms: performance.now() - t0 }), ctx, amb.tagsValidas);
  const prefix = buildStablePrefix({ system: amb.system, tools, cacheTtl: '1h' });
  const fabrica = createDefaultRegistry()['openrouter'];
  if (fabrica === undefined) throw new Error('registry sem openrouter');

  const base = {
    fase: FASE,
    modelo,
    roteamento,
    cenario: c.id,
    rep,
    skillsCasadas: casadas.map((s) => s.name),
  };
  try {
    const result = await generateText({
      model: fabrica(amb.apiKey, modelo),
      system: prefix.system,
      messages: [{ role: 'user', content: aberturaCompleta }],
      tools: prefix.tools,
      stopWhen: stepCountIs(amb.maxSteps),
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      ...(roteamento === 'padrao'
        ? {}
        : { providerOptions: { openrouter: { extraBody: { provider: { sort: roteamento } } } } }),
    });
    const msTotal = performance.now() - t0;
    const envios = eventos.filter((e) => e.nome === 'send_message');
    const mensagens = envios.map((e) => String((e.input as { body?: unknown }).body ?? ''));
    const tags = eventos
      .filter((e) => e.nome === 'set_lead_tags')
      .flatMap((e) => ((e.input as { tags?: unknown }).tags as string[] | undefined) ?? [])
      .filter((t) => amb.tagsValidas.includes(t));
    const transferiu = eventos.some((e) => e.nome === 'request_human_handoff');
    return {
      ...base,
      executou: true,
      msPrimeiraMensagem: envios[0]?.ms ?? null,
      msTotal,
      passos: result.steps.length,
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      cacheRead: result.usage.inputTokenDetails.cacheReadTokens ?? 0,
      cacheWrite: result.usage.inputTokenDetails.cacheWriteTokens ?? 0,
      custoCents: custoInformadoCents(result.steps),
      mensagens,
      tags: [...new Set(tags)],
      transferiu,
      enviosBloqueados: eventos.filter((e) => e.nome === 'send_message_bloqueada').length,
      ...avaliar(c, mensagens, tags, transferiu),
    };
  } catch (err) {
    // Só a classe e o começo da mensagem — o corpo de erro do provider não traz
    // a conversa, mas não há por que arriscar.
    const erro = err instanceof Error ? `${err.name}: ${err.message.slice(0, 160)}` : 'erro desconhecido';
    return {
      ...base,
      executou: false,
      erro,
      msPrimeiraMensagem: null,
      msTotal: performance.now() - t0,
      passos: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      custoCents: null,
      mensagens: [],
      tags: [],
      transferiu: false,
      enviosBloqueados: 0,
      duras: { executou: false },
      moles: {},
    };
  }
}

interface Grupo {
  modelo: string;
  roteamento: Roteamento;
  tarefas: Array<{ cenario: Cenario; rep: number }>;
}

function planejar(modelos: string[]): Grupo[] {
  const porId = new Map(CENARIOS.map((c) => [c.id, c]));
  const todos = (ids: string[]) => ids.map((id) => porId.get(id)).filter((c): c is Cenario => c !== undefined);
  const filtrados = SO_CENARIOS.length === 0 ? CENARIOS : todos(SO_CENARIOS);
  const grupos: Grupo[] = [];
  for (const modelo of modelos) {
    if (FASE === 'a') {
      grupos.push({ modelo, roteamento: 'padrao', tarefas: repetir(todos(CENARIOS_FASE_A), 2) });
    } else if (FASE === 'b') {
      grupos.push({ modelo, roteamento: 'padrao', tarefas: repetir(filtrados, REPS_B) });
    } else if (FASE === 'c') {
      for (const r of ['padrao', 'latency', 'throughput'] as const) {
        grupos.push({ modelo, roteamento: r, tarefas: repetir(filtrados, 1) });
      }
    } else {
      throw new Error(`fase desconhecida: ${FASE} (use a, b ou c)`);
    }
  }
  return grupos;
}

function repetir(cenarios: Cenario[], vezes: number): Array<{ cenario: Cenario; rep: number }> {
  const out: Array<{ cenario: Cenario; rep: number }> = [];
  for (let rep = 1; rep <= vezes; rep++) for (const cenario of cenarios) out.push({ cenario, rep });
  return out;
}

function pct(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] ?? null;
}

const seg = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`);

function resumir(execucoes: Execucao[]): void {
  const chave = (e: Execucao) => `${e.modelo}|${e.roteamento}`;
  const grupos = new Map<string, Execucao[]>();
  for (const e of execucoes) grupos.set(chave(e), [...(grupos.get(chave(e)) ?? []), e]);

  const linhas = [...grupos.values()].map((es) => {
    const checks = es.flatMap((e) => Object.values(e.duras));
    const qualidade = checks.length === 0 ? 0 : checks.filter(Boolean).length / checks.length;
    const atendimentosPerfeitos = es.filter((e) => Object.values(e.duras).every(Boolean)).length / es.length;
    const primeira = es.map((e) => e.msPrimeiraMensagem).filter((x): x is number => x !== null);
    const custos = es.map((e) => e.custoCents).filter((x): x is number => x !== null);
    const input = es.reduce((s, e) => s + e.inputTokens, 0);
    const cache = es.reduce((s, e) => s + e.cacheRead, 0);
    const falhas = new Map<string, number>();
    for (const e of es) {
      for (const [k, v] of Object.entries(e.duras)) if (!v) falhas.set(k, (falhas.get(k) ?? 0) + 1);
    }
    return {
      modelo: es[0]!.modelo,
      roteamento: es[0]!.roteamento,
      n: es.length,
      qualidade,
      atendimentosPerfeitos,
      p50: pct(primeira, 50),
      p90: pct(primeira, 90),
      turnoP50: pct(es.map((e) => e.msTotal), 50),
      custoMedio: custos.length === 0 ? null : custos.reduce((a, b) => a + b, 0) / custos.length,
      cachePct: input === 0 ? 0 : cache / input,
      falhas: [...falhas.entries()].map(([k, v]) => `${k}×${v}`).join(' '),
    };
  });

  const ordem = (a: (typeof linhas)[number], b: (typeof linhas)[number]) =>
    (a.p50 ?? Infinity) - (b.p50 ?? Infinity) || (a.p90 ?? Infinity) - (b.p90 ?? Infinity) || (a.custoMedio ?? 0) - (b.custoMedio ?? 0);
  linhas.sort(ordem);

  console.info('\nmodelo | rot | n | qualidade | perfeitos | 1ª msg p50 | p90 | turno p50 | ¢/turno | cache | falhas');
  for (const l of linhas) {
    console.info(
      [
        l.modelo,
        l.roteamento,
        l.n,
        `${(l.qualidade * 100).toFixed(0)}%`,
        `${(l.atendimentosPerfeitos * 100).toFixed(0)}%`,
        seg(l.p50),
        seg(l.p90),
        seg(l.turnoP50),
        l.custoMedio === null ? '—' : l.custoMedio.toFixed(2),
        `${(l.cachePct * 100).toFixed(0)}%`,
        l.falhas || '—',
      ].join(' | '),
    );
  }
  const elegiveis = linhas.filter((l) => l.qualidade >= 0.95);
  console.info(`\nPortão de qualidade (≥95% das checagens duras): ${elegiveis.length} de ${linhas.length}`);
  elegiveis.slice(0, 3).forEach((l, i) => console.info(`  ${i + 1}º ${l.modelo} [${l.roteamento}] — 1ª mensagem p50 ${seg(l.p50)}`));
}

async function main(): Promise<void> {
  const amb = await montarAmbiente();
  let modelos = (arg('modelos') ?? '').split(',').filter(Boolean);
  if (modelos.length === 0) {
    if (FASE !== 'a') throw new Error('fases b e c exigem --modelos');
    const { rows } = await amb.pool.query<{ model_id: string }>(
      `select model_id from ai_models where provider = 'openrouter' order by model_id`,
    );
    modelos = rows.map((r) => r.model_id);
  }
  const grupos = planejar(modelos);
  const total = grupos.reduce((s, g) => s + g.tarefas.length, 0);
  console.info(`fase ${FASE}: ${modelos.length} modelos, ${total} execuções (+1 aquecimento por grupo) → ${OUT}`);
  console.info(`system: ${amb.system.length} caracteres · maxSteps ${amb.maxSteps} · tags ${amb.tagsValidas.join(',')}`);

  const execucoes: Execucao[] = [];
  let gastoCents = 0;
  let estourou = false;
  const fila = [...grupos];

  async function trabalhador(): Promise<void> {
    for (let g = fila.shift(); g !== undefined; g = fila.shift()) {
      if (estourou) return;
      // Aquecimento fora da conta: produção roda com o cache quente (TTL 1h e
      // dezenas de conversas por hora); medir só a 1ª chamada fria puniria quem cacheia.
      const aquece = await executar(amb, g.modelo, g.roteamento, CENARIOS[0]!, 0);
      gastoCents += aquece.custoCents ?? 0;
      for (const { cenario, rep } of g.tarefas) {
        if (gastoCents >= MAX_CENTS) {
          estourou = true;
          return;
        }
        const e = await executar(amb, g.modelo, g.roteamento, cenario, rep);
        gastoCents += e.custoCents ?? 0;
        execucoes.push(e);
        fs.appendFileSync(OUT, `${JSON.stringify(e)}\n`);
        const falhou = Object.entries(e.duras).filter(([, v]) => !v).map(([k]) => k);
        console.info(
          `[${FASE}] ${e.modelo} ${e.roteamento} ${e.cenario}#${e.rep} → 1ª ${seg(e.msPrimeiraMensagem)} · turno ${seg(e.msTotal)}` +
            ` · ${falhou.length === 0 ? 'ok' : `FALHOU ${falhou.join(',')}`}${e.erro ? ` · ${e.erro}` : ''}`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, CONCORRENCIA) }, () => trabalhador()));
  if (estourou) console.info(`\nTETO ATINGIDO: US$ ${(gastoCents / 100).toFixed(2)} — execuções restantes canceladas`);
  console.info(`\ngasto real: US$ ${(gastoCents / 100).toFixed(2)} em ${execucoes.length} execuções`);
  resumir(execucoes);
  await amb.pool.end();
}

main().catch((err) => {
  console.error('bench falhou:', err instanceof Error ? err.message : err);
  process.exit(1);
});
