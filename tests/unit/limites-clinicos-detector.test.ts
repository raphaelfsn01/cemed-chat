import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { detectarLimiteClinico } from "@/lib/agent-engine/guardrails/limites-clinicos";

/**
 * Calibração do detector de LIMITES CLÍNICOS (M7 da auditoria): preço e orientação
 * médica na fala do agente, os dois "nunca" da spec da clínica (§4.3 e §8.2).
 *
 * Três listas, no molde de `vazamento-interno-detector.test.ts`:
 *   - FALA_LEGITIMA: não pode barrar. Inclui TODA fala-modelo citada na spec da clínica
 *     (lida do arquivo, não copiada: se a spec ganhar uma fala nova, ela entra aqui sozinha);
 *   - PRECO: deve barrar como `preco`;
 *   - ORIENTACAO_MEDICA: deve barrar como `orientacao_medica`.
 */

/** Falas-modelo da spec: linhas `> "..."` (citação que começa com aspas). */
function falasDaSpec(): string[] {
  const spec = fs.readFileSync(path.join(process.cwd(), "docs/cemed/spec-crm-cemed.md"), "utf8");
  return spec
    .split("\n")
    .filter((l) => l.startsWith('> "'))
    .map((l) => l.slice(2).replace(/\*\*/g, ""));
}

const FALA_LEGITIMA: readonly string[] = [
  // NAP e horário (§2): número, CEP, telefone e hora não são preço.
  "Atendemos de segunda a sexta, das 8h às 17h.",
  "Estamos na Rua Mayer, 152 — Centro, Rio das Ostras, atrás do Supermercado Avistão.",
  "O endereço é Rua Mayer, 152, CEP 28890-000.",
  "Pode chamar a equipe no (22) 99946-6060, de segunda a sexta, das 8h às 17h.",
  "O valor você confirma com a equipe pelo (22) 99946-6060.",
  "A partir de segunda, das 8h às 17h, a equipe te responde.",
  "A partir de 8h a equipe já está atendendo.",
  "O MAPA 24h monitora a pressão arterial por 24 horas.",
  "O Holter 24h registra o ritmo cardíaco durante 24 horas.",
  "Temos clínico geral e mais sete especialidades na clínica.",
  "Fica pronto em 2 dias úteis, a equipe te confirma.",

  // A recusa correta (§4.3, §8.3) — falar SOBRE preço e SOBRE orientação, sem dar.
  "Os valores variam conforme o procedimento e a forma de atendimento. Vou passar sua conversa para a nossa equipe, que te informa certinho.",
  "Não consigo te passar valores por aqui, mas a equipe informa certinho.",
  "Não consigo dizer se você tem virose ou não: isso só o médico avalia na consulta.",
  "Não posso indicar remédio por aqui. Quer que eu encaminhe você para a equipe marcar uma consulta?",
  "Não se preocupe, a equipe já recebeu sua mensagem.",
  "Sinto muito que você esteja com dor. Posso pedir que a equipe avalie seu caso com prioridade.",

  // Catálogo (§3): descrever serviço não é diagnosticar nem receitar.
  "Clínico Geral: avaliação completa da saúde, diagnósticos e orientações preventivas.",
  "A Neurologia faz diagnóstico e tratamento de doenças do sistema nervoso.",
  "A acupuntura usa agulhas em pontos estratégicos para tratar dores, ansiedade, insônia e diversas condições.",
  "A auriculoterapia é um tratamento complementar de ansiedade, tabagismo e dores.",
  "A polissonografia estuda o sono, para distúrbios respiratórios.",
  "Para o exame admissional preciso do nome da empresa e do colaborador.",
  "Você gostaria de marcar com a Cardiologia?",
  "Temos Cardiologia, Neurologia, Psiquiatria, Psicologia, Urologia, Geriatria, Nutrição e Clínico Geral.",

  // Fala comum de atendimento.
  "Olá! Que bom te ver por aqui.",
  "Use o link do WhatsApp para falar com a equipe.",
  "Pode me confirmar seu nome?",
];

const PRECO: readonly string[] = [
  "A consulta custa R$ 250,00.",
  "O exame sai por R$250.",
  "A consulta particular fica em 200 reais.",
  "O valor da consulta é 180.",
  "Os valores ficam entre 150 e 300 reais.",
  "A partir de 150 você já consegue a consulta.",
  "O preço do eletrocardiograma é 90,00.",
  "Cobramos 120 pela avaliação.",
  "Por apenas 99 você faz o exame.",
  "A primeira consulta é gratuita.",
  "O retorno é sem custo.",
  "Dá pra parcelar em até 3x no cartão.",
  "Temos 10% de desconto no particular.",
];

const ORIENTACAO_MEDICA: readonly string[] = [
  // diagnóstico
  "Provavelmente é uma virose.",
  "Pelo que você conta, parece ser enxaqueca.",
  "Isso pode ser sinusite.",
  "Você deve estar com gastrite.",
  "Esses sintomas são típicos de ansiedade.",
  "Não se preocupe, provavelmente é só uma virose.",
  // remédio, dose e conduta
  "Tome uma dipirona e descanse.",
  "Pode tomar paracetamol de 6 em 6 horas.",
  "Recomendo um anti-inflamatório até a consulta.",
  "Tome 500 mg à noite.",
  "Use 20 gotas 3 vezes ao dia.",
  "Faça repouso e beba bastante água.",
  "Passe uma pomada no local.",
  // prognóstico tranquilizador
  "Não é nada grave, isso vai passar logo.",
  "É normal sentir isso depois do exercício.",
  // escolher especialista pela queixa (§8.2)
  "Para essa dor de cabeça, o ideal é o neurologista.",
  "Pelo que você descreveu, recomendo o cardiologista.",
];

describe("detector de limites clínicos — calibração", () => {
  it("as falas-modelo da spec da clínica estão no corpus (a leitura não voltou vazia)", () => {
    expect(falasDaSpec().length).toBeGreaterThanOrEqual(10);
  });

  it.each([...falasDaSpec(), ...FALA_LEGITIMA])("NÃO barra: %s", (body) => {
    expect(detectarLimiteClinico(body)).toEqual({ achou: false, tipos: [], regras: [] });
  });

  it.each(PRECO)("barra como preço: %s", (body) => {
    const r = detectarLimiteClinico(body);
    expect(r.achou).toBe(true);
    expect(r.tipos).toEqual(["preco"]);
  });

  it.each(ORIENTACAO_MEDICA)("barra como orientação médica: %s", (body) => {
    const r = detectarLimiteClinico(body);
    expect(r.achou).toBe(true);
    expect(r.tipos).toEqual(["orientacao_medica"]);
  });

  it("os dois na mesma mensagem: orientação médica vem primeiro (o risco maior)", () => {
    const r = detectarLimiteClinico("Provavelmente é virose. A consulta custa R$ 200.");
    expect(r.tipos).toEqual(["orientacao_medica", "preco"]);
  });

  it("as regras devolvidas são rótulos nossos, nunca trecho do texto", () => {
    const r = detectarLimiteClinico("Tome 500 mg de dipirona. A consulta custa R$ 200.");
    for (const regra of r.regras) expect(regra).toMatch(/^[a-z_]+$/);
    expect(r.regras.join(" ")).not.toMatch(/dipirona|500|200/);
  });

  it("acento e caixa não escondem nada", () => {
    expect(detectarLimiteClinico("PROVAVELMENTE É UMA VIROSE").achou).toBe(true);
    expect(detectarLimiteClinico("a consulta CUSTA 200 REAIS").achou).toBe(true);
  });
});
